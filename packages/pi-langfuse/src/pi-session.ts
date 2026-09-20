import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveGitMetadata } from "./git.js";
import { getLangfuseRuntimeInternal, type LangfuseRuntime } from "./runtime-core.js";
import {
  type ContextSnapshot,
  type GitMetadata,
  sanitizeTraceValue,
  TraceRecorder,
  type TraceRecorderOptions,
} from "./tracing.js";

export interface PiLangfuseSessionOptions {
  traceName?: string;
  sessionId?: string;
  userId?: string;
  tags?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  captureContent?: boolean;
  onTraceId?: (traceId: string) => void;
}

export interface PiLangfuseSession {
  readonly extension: ExtensionFactory;
  setRequestId(requestId?: string): void;
  dispose(): Promise<void>;
}

interface ResolvedSession {
  runtime: LangfuseRuntime;
  options?: PiLangfuseSessionOptions;
  releaseIfStale?(reason: string): Promise<void>;
}

interface PiLangfuseSessionControllerOptions {
  resolveSession(ctx: ExtensionContext, isCurrent: () => boolean): Promise<ResolvedSession | undefined>;
  resolveGitMetadata?(pi: ExtensionAPI, cwd: string): Promise<GitMetadata | undefined>;
  onSessionStart?(): void;
  onSessionShutdown?(): void;
  onSessionReady?(session: ResolvedSession): void;
  onSessionUnavailable?(): void;
  onInitializationError?(error: unknown, ctx: ExtensionContext): void;
  beforeSessionDispose?(): Promise<void>;
  onShutdownError?(error: unknown, ctx: ExtensionContext): void;
  flushOnReplacement?: boolean;
  shutdownRuntimeOnQuit?: boolean;
}

type Registration = object;

type InitializationResult = { ok: true } | { ok: false; error: unknown };

interface PendingInitialization {
  current: boolean;
  reason?: string;
  completion: Promise<InitializationResult>;
  complete(result: InitializationResult): void;
}

interface PendingProviderGeneration {
  startedAt: number;
  payload: unknown;
  model?: { provider: string; id: string; api: string };
  thinkingLevel?: string;
  responses: Array<{ status: number; headers: Record<string, string> }>;
}

interface ActiveBinding {
  registration: Registration;
  recorder: TraceRecorder;
  runtime: LangfuseRuntime;
  releaseRuntime: () => void;
}

export interface PiLangfuseSessionController extends PiLangfuseSession {
  readonly active: boolean;
  readonly runtime: LangfuseRuntime | undefined;
  flush(): Promise<void>;
}

export function createPiLangfuseSession(
  runtime: LangfuseRuntime,
  options: PiLangfuseSessionOptions = {},
): PiLangfuseSession {
  const sessionOptions = snapshotSessionOptions(options);
  return createPiLangfuseSessionController({
    resolveSession: async () => ({ runtime, options: sessionOptions }),
  });
}

export function createPiLangfuseSessionController(
  options: PiLangfuseSessionControllerOptions,
): PiLangfuseSessionController {
  let binding: ActiveBinding | undefined;
  let runtimeForShutdown: LangfuseRuntime | undefined;
  let ownerRegistration: Registration | undefined;
  let pendingInitialization: PendingInitialization | undefined;
  const outstandingInitializations = new Set<PendingInitialization>();
  let disposePromise: Promise<void> | undefined;
  let disposed = false;
  let sessionGeneration = 0;
  let requestId: string | undefined;
  let requestIdRevision = 0;
  let nextAttemptReason: string | undefined;
  let lastSnapshot: ContextSnapshot | undefined;
  let pendingProviderGeneration: PendingProviderGeneration | undefined;

  const controller: PiLangfuseSessionController = {
    extension(pi) {
      if (disposed) throw new Error("A disposed Pi Langfuse session controller cannot be bound.");
      registerHooks(pi);
    },
    setRequestId(value) {
      requestId = normalizeOptionalString(value);
      requestIdRevision += 1;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      const initializations = invalidateAllInitializations("disposed");
      ownerRegistration = undefined;
      sessionGeneration += 1;
      closeBinding(binding, "Pi Langfuse session controller was disposed.", lastSnapshot);
      runtimeForShutdown = undefined;
      disposePromise = joinInitializations(initializations);
      return disposePromise;
    },
    get active() {
      return binding !== undefined;
    },
    get runtime() {
      return binding?.runtime;
    },
    async flush() {
      const runtime = binding?.runtime;
      if (!runtime) throw new Error("Langfuse tracing is not enabled for this session.");
      await runtime.flush();
    },
  };

  function closeBinding(target: ActiveBinding | undefined, statusMessage: string, snapshot?: ContextSnapshot): void {
    if (!target) return;
    const wasCurrent = binding === target;
    if (wasCurrent) {
      binding = undefined;
      pendingProviderGeneration = undefined;
    }
    target.releaseRuntime();
    target.recorder.dispose(statusMessage, snapshot);
    if (wasCurrent) nextAttemptReason = undefined;
  }

  function invalidatePendingInitialization(reason: string): void {
    if (!pendingInitialization) return;
    pendingInitialization.current = false;
    pendingInitialization.reason = reason;
    pendingInitialization = undefined;
  }

  function invalidateAllInitializations(reason: string): PendingInitialization[] {
    const initializations = [...outstandingInitializations];
    for (const initialization of initializations) {
      initialization.current = false;
      initialization.reason = reason;
    }
    pendingInitialization = undefined;
    return initializations;
  }

  function createPendingInitialization(): PendingInitialization {
    let complete!: (result: InitializationResult) => void;
    const completion = new Promise<InitializationResult>((resolve) => {
      complete = resolve;
    });
    const initialization = { current: true, completion, complete };
    outstandingInitializations.add(initialization);
    return initialization;
  }

  async function joinInitializations(initializations: readonly PendingInitialization[]): Promise<void> {
    const results = await Promise.all(initializations.map(({ completion }) => completion));
    const errors = results.flatMap((result) => (result.ok ? [] : [result.error]));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Pi Langfuse session initialization cleanup failed.");
  }

  async function initializeSession(
    registration: Registration,
    initialization: PendingInitialization,
    ctx: ExtensionContext,
  ): Promise<void> {
    const generation = ++sessionGeneration;
    closeBinding(binding, "Pi session was replaced before shutdown completed.", lastSnapshot);
    lastSnapshot = contextSnapshot(ctx);
    nextAttemptReason = undefined;
    options.onSessionStart?.();

    const isCurrent = () =>
      !disposed && initialization.current && ownerRegistration === registration && generation === sessionGeneration;
    let resolved: ResolvedSession | undefined;
    try {
      resolved = await options.resolveSession(ctx, isCurrent);
    } catch (error) {
      if (isCurrent()) options.onInitializationError?.(error, ctx);
      return;
    }
    if (!isCurrent()) {
      const reason = initialization.reason ?? "replaced";
      if (
        resolved &&
        options.shutdownRuntimeOnQuit &&
        reason !== "quit" &&
        reason !== "disposed" &&
        (!runtimeForShutdown || runtimeForShutdown.closed)
      ) {
        runtimeForShutdown = resolved.runtime;
      }
      await resolved?.releaseIfStale?.(reason);
      return;
    }
    if (!resolved) {
      options.onSessionUnavailable?.();
      return;
    }

    try {
      const internal = getLangfuseRuntimeInternal(resolved.runtime);
      const recorderOptions = createRecorderOptions(ctx, resolved.options);
      const recorder = new TraceRecorder(internal.backend, recorderOptions);
      const nextBinding = {} as ActiveBinding;
      const releaseRuntime = internal.registerSession((statusMessage) => {
        closeBinding(nextBinding, statusMessage, lastSnapshot);
      });
      Object.assign(nextBinding, { registration, recorder, runtime: resolved.runtime, releaseRuntime });
      if (!isCurrent()) {
        releaseRuntime();
        return;
      }
      binding = nextBinding;
      if (options.shutdownRuntimeOnQuit) runtimeForShutdown = resolved.runtime;
      options.onSessionReady?.(resolved);
    } catch (error) {
      if (isCurrent()) options.onInitializationError?.(error, ctx);
    }
  }

  function registerHooks(pi: ExtensionAPI): void {
    const registration: Registration = {};
    const activeRecorder = () => activeRecorderFor(registration);

    pi.on("session_start", async (_event, ctx) => {
      if (disposed) return;
      pendingProviderGeneration = undefined;
      if (ownerRegistration && ownerRegistration !== registration) {
        options.onInitializationError?.(
          new Error("A Pi Langfuse session controller cannot manage multiple active Pi sessions."),
          ctx,
        );
        return;
      }

      invalidatePendingInitialization("replaced");
      ownerRegistration = registration;
      const initialization = createPendingInitialization();
      pendingInitialization = initialization;
      let result: InitializationResult = { ok: true };
      try {
        await initializeSession(registration, initialization, ctx);
      } catch (error) {
        result = { ok: false, error };
        throw error;
      } finally {
        initialization.complete(result);
        outstandingInitializations.delete(initialization);
        if (pendingInitialization === initialization) pendingInitialization = undefined;
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      // Cache warming emits provider hooks without assistant lifecycle events. Unclaimed
      // metadata is discarded at the next real run rather than classified by timing.
      pendingProviderGeneration = undefined;
      const active = ownerRegistration === registration ? binding : undefined;
      if (!active || active.runtime.closed) return;
      nextAttemptReason = undefined;
      const git = await (options.resolveGitMetadata
        ? options.resolveGitMetadata(pi, ctx.cwd)
        : resolveGitMetadata((command, args, execOptions) => pi.exec(command, args, execOptions), ctx.cwd)
      ).catch(() => undefined);
      if (ownerRegistration !== registration || binding !== active || active.runtime.closed) return;
      lastSnapshot = contextSnapshot(ctx);
      startRootTrace((nextRequestId) => {
        active.recorder.beginAgent({
          prompt: event.prompt,
          images: event.images,
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
          git,
          snapshot: lastSnapshot,
          ...(nextRequestId ? { requestId: nextRequestId } : {}),
        });
      });
    });

    pi.on("agent_start", () => {
      const recorder = activeRecorder();
      if (!recorder) return;
      recorder.beginAttempt(nextAttemptReason ? { reason: nextAttemptReason } : undefined);
      nextAttemptReason = undefined;
    });

    pi.on("turn_start", (event, ctx) => {
      const recorder = activeRecorder();
      if (!recorder) return;
      lastSnapshot = contextSnapshot(ctx);
      ensureActiveRun(recorder, ctx, startRootTrace);
      recorder.beginTurn(event.turnIndex);
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!activeRecorder()) return;
      lastSnapshot = contextSnapshot(ctx);
      pendingProviderGeneration = {
        startedAt: Date.now(),
        payload: event.payload,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        thinkingLevel: pi.getThinkingLevel(),
        responses: [],
      };
    });

    pi.on("after_provider_response", (event) => {
      pendingProviderGeneration?.responses.push({ status: event.status, headers: event.headers });
    });

    pi.on("message_start", (event, ctx) => {
      if (event.message.role === "assistant") claimPendingProviderGeneration(ctx, activeRecorder());
    });

    pi.on("message_update", (event, ctx) => {
      if (!isRealOutputDelta(event.assistantMessageEvent)) return;
      const recorder = activeRecorder();
      claimPendingProviderGeneration(ctx, recorder);
      recorder?.markGenerationFirstOutput();
    });

    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const recorder = activeRecorder();
      claimPendingProviderGeneration(ctx, recorder);
      recorder?.markGenerationEnd();
    });

    pi.on("turn_end", (event, ctx) => {
      const recorder = activeRecorder();
      if (!recorder) return;
      if (event.message.role === "assistant") claimPendingProviderGeneration(ctx, recorder);
      lastSnapshot = contextSnapshot(ctx);
      if (event.message.role === "assistant") recorder.finishAssistant(event.message);
      recorder.finishTurn(event.turnIndex, {
        message: event.message,
        toolResultCount: event.toolResults.length,
      });
    });

    pi.on("tool_execution_start", (event) => {
      activeRecorder()?.beginTool(event.toolCallId, event.toolName, event.args);
    });

    pi.on("tool_execution_update", (event) => {
      activeRecorder()?.recordToolProgress(event.toolCallId);
    });

    pi.on("tool_result", (event) => {
      activeRecorder()?.recordToolInput(event.toolCallId, event.input);
    });

    pi.on("tool_execution_end", (event) => {
      activeRecorder()?.finishTool(event.toolCallId, {
        content: event.result.content,
        details: event.result.details,
        isError: event.isError,
      });
    });

    pi.on("agent_end", (event) => {
      const message = findLastAssistant(event.messages);
      activeRecorder()?.finishAttempt(message);
    });

    pi.on("session_before_compact", (event) => {
      activeRecorder()?.beginCompaction({
        reason: event.reason,
        willRetry: event.willRetry,
        tokensBefore: event.preparation.tokensBefore,
        messagesToSummarize: event.preparation.messagesToSummarize.length,
        turnPrefixMessages: event.preparation.turnPrefixMessages.length,
        branchEntries: event.branchEntries.length,
        isSplitTurn: event.preparation.isSplitTurn,
      });
    });

    pi.on("session_compact", (event) => {
      const recorder = activeRecorder();
      const entry = event.compactionEntry as typeof event.compactionEntry & {
        usage?: Parameters<TraceRecorder["finishCompaction"]>[0]["usage"];
      };
      recorder?.finishCompaction({
        reason: event.reason,
        willRetry: event.willRetry,
        fromExtension: event.fromExtension,
        tokensBefore: entry.tokensBefore,
        details: entry.details,
        usage: entry.usage,
      });
      if (event.willRetry && recorder?.hasActiveTrace()) nextAttemptReason = "post_compaction";
    });

    pi.on("agent_settled", (_event, ctx) => {
      const recorder = activeRecorder();
      if (!recorder) return;
      lastSnapshot = contextSnapshot(ctx);
      recorder.settle(lastSnapshot);
      pendingProviderGeneration = undefined;
      nextAttemptReason = undefined;
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (ownerRegistration !== registration) return;
      const initializations = invalidateAllInitializations(event.reason);
      ownerRegistration = undefined;
      const generation = ++sessionGeneration;
      options.onSessionShutdown?.();
      const active = binding?.registration === registration ? binding : undefined;
      const runtime = active?.runtime ?? runtimeForShutdown;
      lastSnapshot = active ? contextSnapshot(ctx) : lastSnapshot;
      closeBinding(
        active,
        event.reason === "quit"
          ? "Pi shut down before the active trace settled."
          : `Pi session ended before settlement (${event.reason}).`,
        lastSnapshot,
      );

      let beforeDisposeFailure: { error: unknown } | undefined;
      try {
        await options.beforeSessionDispose?.();
      } catch (error) {
        beforeDisposeFailure = { error };
      }

      try {
        await joinInitializations(initializations);
        if (disposed || generation !== sessionGeneration) return;
        if (beforeDisposeFailure) throw beforeDisposeFailure.error;
        if (runtime) {
          if (event.reason === "quit" && options.shutdownRuntimeOnQuit) await runtime.shutdown();
          else if (options.flushOnReplacement) await runtime.flush();
        }
      } catch (error) {
        if (!disposed && generation === sessionGeneration) options.onShutdownError?.(error, ctx);
      }
    });
  }

  function claimPendingProviderGeneration(ctx: ExtensionContext, recorder: TraceRecorder | undefined): void {
    const pending = pendingProviderGeneration;
    if (!pending || !recorder) return;
    pendingProviderGeneration = undefined;
    ensureActiveRun(recorder, ctx, startRootTrace);
    recorder.beginGeneration({
      startedAt: pending.startedAt,
      payload: pending.payload,
      payloadStage: "before_provider_request",
      model: pending.model,
      thinkingLevel: pending.thinkingLevel,
    });
    for (const response of pending.responses) recorder.recordProviderResponse(response.status, response.headers);
  }

  function startRootTrace(start: (nextRequestId: string | undefined) => void): void {
    const revision = requestIdRevision;
    const nextRequestId = requestId;
    start(nextRequestId);
    if (requestIdRevision === revision) requestId = undefined;
  }

  function activeRecorderFor(registration: Registration): TraceRecorder | undefined {
    return ownerRegistration === registration && binding?.registration === registration && !binding.runtime.closed
      ? binding.recorder
      : undefined;
  }

  return controller;
}

function createRecorderOptions(ctx: ExtensionContext, options: PiLangfuseSessionOptions = {}): TraceRecorderOptions {
  const userId = normalizeUserId(options.userId);
  return {
    sessionId: normalizeOptionalString(options.sessionId) ?? ctx.sessionManager.getSessionId(),
    ...(userId ? { userId } : {}),
    cwd: ctx.cwd,
    mode: ctx.mode,
    captureContent: options.captureContent ?? true,
    ...(normalizeOptionalString(options.traceName) ? { traceName: normalizeOptionalString(options.traceName) } : {}),
    ...(options.tags ? { tags: [...options.tags] } : {}),
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    ...(options.onTraceId ? { onTraceId: options.onTraceId } : {}),
  };
}

function snapshotSessionOptions(options: PiLangfuseSessionOptions): PiLangfuseSessionOptions {
  normalizeUserId(options.userId);
  return {
    ...options,
    ...(options.tags ? { tags: [...options.tags] } : {}),
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
  };
}

function ensureActiveRun(
  recorder: TraceRecorder,
  ctx: ExtensionContext,
  startRootTrace: (start: (nextRequestId: string | undefined) => void) => void,
): void {
  if (!recorder.hasActiveTrace()) {
    startRootTrace((nextRequestId) => {
      recorder.beginAgent({
        prompt: "[automatic continuation]",
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        snapshot: contextSnapshot(ctx),
        ...(nextRequestId ? { requestId: nextRequestId } : {}),
      });
    });
  }
  if (!recorder.hasActiveAttempt()) recorder.beginAttempt();
}

function contextSnapshot(ctx: ExtensionContext): ContextSnapshot {
  return {
    leafId: typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() : undefined,
    contextUsage: ctx.getContextUsage(),
  };
}

function findLastAssistant<T extends { role?: string }>(messages: readonly T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function isRealOutputDelta(event: { type: string; delta?: unknown }): boolean {
  return (
    (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
    typeof event.delta === "string" &&
    event.delta.length > 0
  );
}

function normalizeUserId(value: unknown): string | undefined {
  const userId = normalizeOptionalString(value);
  if (userId && userId.length > 200) throw new Error("Langfuse userId must be at most 200 characters.");
  return userId;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const sanitized = sanitizeTraceValue(value.trim());
  return typeof sanitized === "string" && sanitized.trim() ? sanitized.trim() : undefined;
}
