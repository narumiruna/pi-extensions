import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveGitMetadata } from "./git.js";
import { getLangfuseRuntimeInternal, type LangfuseRuntime } from "./runtime-core.js";
import { type ContextSnapshot, type GitMetadata, TraceRecorder, type TraceRecorderOptions } from "./tracing.js";

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

interface PendingInitialization {
  current: boolean;
  reason?: string;
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
  let ownerRegistration: Registration | undefined;
  let pendingInitialization: PendingInitialization | undefined;
  let disposed = false;
  let sessionGeneration = 0;
  let requestId: string | undefined;
  let nextAttemptReason: string | undefined;
  let lastSnapshot: ContextSnapshot | undefined;

  const controller: PiLangfuseSessionController = {
    extension(pi) {
      if (disposed) throw new Error("A disposed Pi Langfuse session controller cannot be bound.");
      registerHooks(pi);
    },
    setRequestId(value) {
      requestId = normalizeOptionalString(value);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      invalidatePendingInitialization("disposed");
      ownerRegistration = undefined;
      sessionGeneration += 1;
      closeBinding(binding, "Pi Langfuse session controller was disposed.", lastSnapshot);
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
    if (wasCurrent) binding = undefined;
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

  function registerHooks(pi: ExtensionAPI): void {
    const registration: Registration = {};
    const activeRecorder = () => activeRecorderFor(registration);

    pi.on("session_start", async (_event, ctx) => {
      if (disposed) return;
      if (ownerRegistration && ownerRegistration !== registration) {
        options.onInitializationError?.(
          new Error("A Pi Langfuse session controller cannot manage multiple active Pi sessions."),
          ctx,
        );
        return;
      }

      invalidatePendingInitialization("replaced");
      ownerRegistration = registration;
      const initialization: PendingInitialization = { current: true };
      pendingInitialization = initialization;
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
        if (isCurrent()) {
          pendingInitialization = undefined;
          options.onInitializationError?.(error, ctx);
        }
        return;
      }
      if (!isCurrent()) {
        await resolved?.releaseIfStale?.(initialization.reason ?? "replaced");
        return;
      }
      if (!resolved) {
        pendingInitialization = undefined;
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
        pendingInitialization = undefined;
        binding = nextBinding;
        options.onSessionReady?.(resolved);
      } catch (error) {
        if (isCurrent()) {
          pendingInitialization = undefined;
          options.onInitializationError?.(error, ctx);
        }
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const active = ownerRegistration === registration ? binding : undefined;
      if (!active || active.runtime.closed) return;
      nextAttemptReason = undefined;
      const git = await (options.resolveGitMetadata
        ? options.resolveGitMetadata(pi, ctx.cwd)
        : resolveGitMetadata((command, args, execOptions) => pi.exec(command, args, execOptions), ctx.cwd)
      ).catch(() => undefined);
      if (ownerRegistration !== registration || binding !== active || active.runtime.closed) return;
      lastSnapshot = contextSnapshot(ctx);
      active.recorder.beginAgent({
        prompt: event.prompt,
        images: event.images,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        git,
        snapshot: lastSnapshot,
        ...(requestId ? { requestId } : {}),
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
      ensureActiveRun(recorder, ctx, requestId);
      recorder.beginTurn(event.turnIndex);
    });

    pi.on("before_provider_request", (event, ctx) => {
      const recorder = activeRecorder();
      if (!recorder) return;
      lastSnapshot = contextSnapshot(ctx);
      ensureActiveRun(recorder, ctx, requestId);
      recorder.beginGeneration({
        payload: event.payload,
        payloadStage: "before_provider_request",
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        thinkingLevel: pi.getThinkingLevel(),
      });
    });

    pi.on("after_provider_response", (event) => {
      activeRecorder()?.recordProviderResponse(event.status, event.headers);
    });

    pi.on("message_update", (event) => {
      if (isRealOutputDelta(event.assistantMessageEvent)) activeRecorder()?.markGenerationFirstOutput();
    });

    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") activeRecorder()?.markGenerationEnd();
    });

    pi.on("turn_end", (event, ctx) => {
      const recorder = activeRecorder();
      if (!recorder) return;
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
      nextAttemptReason = undefined;
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (ownerRegistration !== registration) return;
      invalidatePendingInitialization(event.reason);
      ownerRegistration = undefined;
      const generation = ++sessionGeneration;
      options.onSessionShutdown?.();
      const active = binding?.registration === registration ? binding : undefined;
      const runtime = active?.runtime;
      lastSnapshot = active ? contextSnapshot(ctx) : lastSnapshot;
      closeBinding(
        active,
        event.reason === "quit"
          ? "Pi shut down before the active trace settled."
          : `Pi session ended before settlement (${event.reason}).`,
        lastSnapshot,
      );

      try {
        await options.beforeSessionDispose?.();
        if (disposed || generation !== sessionGeneration) return;
        if (runtime) {
          if (event.reason === "quit" && options.shutdownRuntimeOnQuit) await runtime.shutdown();
          else if (options.flushOnReplacement) await runtime.flush();
        }
      } catch (error) {
        if (!disposed && generation === sessionGeneration) options.onShutdownError?.(error, ctx);
      }
    });
  }

  function activeRecorderFor(registration: Registration): TraceRecorder | undefined {
    return ownerRegistration === registration && binding?.registration === registration && !binding.runtime.closed
      ? binding.recorder
      : undefined;
  }

  return controller;
}

function createRecorderOptions(ctx: ExtensionContext, options: PiLangfuseSessionOptions = {}): TraceRecorderOptions {
  return {
    sessionId: normalizeOptionalString(options.sessionId) ?? ctx.sessionManager.getSessionId(),
    ...(normalizeOptionalString(options.userId) ? { userId: normalizeOptionalString(options.userId) } : {}),
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
  return {
    ...options,
    ...(options.tags ? { tags: [...options.tags] } : {}),
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
  };
}

function ensureActiveRun(recorder: TraceRecorder, ctx: ExtensionContext, requestId: string | undefined): void {
  if (!recorder.hasActiveTrace()) {
    recorder.beginAgent({
      prompt: "[automatic continuation]",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
      snapshot: contextSnapshot(ctx),
      ...(requestId ? { requestId } : {}),
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

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
