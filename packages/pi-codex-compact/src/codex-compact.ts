import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  parseCheckpointDetails,
  REPLACEMENT_BYTE_BUDGET,
} from "./checkpoint.js";
import {
  checkpointIssuerRequest,
  PLAINTEXT_CHECKPOINT_TYPE,
  plaintextCheckpointMessages,
  savedPlaintextCheckpoint,
} from "./checkpoint-portability.js";
import { projectedKeptMessages, projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { recoverCheckpoint, summarizeCheckpoint, summaryPrefix } from "./checkpoint-recovery.js";
import {
  compactionFailureDetail,
  compactionFailureMessage,
  inspectFailureResponse,
  isOAuthOperationRejection,
  observeSseRejections,
  streamOperationRejection,
} from "./compaction-failure.js";
import { captureCompactionBranch } from "./compaction-ownership.js";
import { validateContextManagementHistory } from "./context-management.js";
import { type CompactionRoute, resolveCompactionRoute } from "./model-api.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import { requestRemoteCompaction } from "./remote.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

const STATUS_KEY = "codex-compact";
const CONTINUATION_TYPE = "codex-compact:continue-v1";
const CONTINUATION_MESSAGE =
  "Conversation compaction is complete. Continue unfinished work under the original conversation instructions, " +
  "using tools when needed. If the work is already complete, provide the final result without repeating completed actions.";

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
  settings: CodexCompactSettings,
): boolean {
  const route = resolveCompactionRoute(model, settings);
  return (
    route.kind === "remote" &&
    model !== undefined &&
    model.provider === details.provider &&
    route.api === details.api &&
    route.profile === details.profile
  );
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  return projectedKeptMessages(event.branchEntries, leafId, event.preparation.firstKeptEntryId);
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = available.get(name);
    return tool
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ]
      : [];
  });
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  route: Extract<CompactionRoute, { kind: "remote" }>,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries);
  if (!prior) return { messages: session.messages };
  if (prior.details.api !== route.api || prior.details.profile !== route.profile) {
    throw new Error("The active opaque checkpoint belongs to an incompatible Responses API/profile");
  }
  const projected = projectSessionCheckpointContext(session.messages, event.branchEntries, prior);
  if (!projected) {
    throw new Error(
      "The saved transcript cannot verify the previous opaque checkpoint projection. History preserved; " +
        "use /tree to branch before that checkpoint and compact the saved transcript there. Opaque state cannot be decoded locally.",
    );
  }
  return { messages: projected, prior: prior.details };
}

function notifyFailure(
  ctx: ExtensionContext,
  error: unknown,
  settings: CodexCompactSettings,
  requestValues: readonly string[],
  checkpointPresent = false,
  routePaused = true,
): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  const diagnosis = compactionFailureMessage(error, requestValues);
  const message = routePaused
    ? diagnosis
    : diagnosis.replace(
        "This route is paused for this session; /reload retries it. ",
        "This failure did not pause the route. ",
      );
  ctx.ui.notify(
    checkpointPresent
      ? message.replace(
          "Responses compaction failed; using Pi compaction. ",
          "Responses compaction failed; applying checkpoint recovery (summary or safe cancellation). ",
        )
      : message,
    "warning",
  );
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  ownerSignal: AbortSignal,
  rejected: RejectedRoutes,
  isCurrent: () => boolean,
  ownsStatus: () => boolean,
  fetch?: typeof globalThis.fetch,
) {
  const model = ctx.model;
  const route = resolveCompactionRoute(model, settings);
  const signal = AbortSignal.any([event.signal, ownerSignal]);
  if (signal.aborted) return { cancel: true };
  if (route.kind === "native" || !model)
    return settings.enabled && hasActiveCheckpointClaim(ctx.sessionManager.getBranch()) ? { cancel: true } : undefined;
  const publicRouteKey = rejectionRouteKey(model, route);
  let routeKey = publicRouteKey;
  let endpointObserved = false;
  let paused = false;
  const sessionId = ctx.sessionManager.getSessionId();
  const checkpoint = latestCheckpoint(event.branchEntries);
  const checkpointPresent = hasActiveCheckpointClaim(event.branchEntries);
  const branchIsCurrent = captureCompactionBranch(event.branchEntries);
  const systemPrompt = ctx.getSystemPrompt?.();
  const tools = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
  const stillCurrent = () =>
    sessionStillOwned(ctx, sessionId, signal) &&
    isCurrent() &&
    ctx.getSystemPrompt?.() === systemPrompt &&
    JSON.stringify([pi.getActiveTools(), activeTools(pi)]) === tools &&
    branchIsCurrent(ctx.sessionManager.getBranch());
  let requestValues: string[] = [];
  let remoteAttempted = false;
  let rejectionError: Error | undefined;
  const remoteController = new AbortController();
  const remoteSignal = AbortSignal.any([signal, remoteController.signal]);
  const recordRejection = (error: Error) => {
    if (!remoteAttempted || !stillCurrent() || rejectionError) return;
    rejectionError = error;
    rejected.add(routeKey);
    rejected.observe(publicRouteKey, routeKey);
    // Stream callbacks can run inside a TransformStream; abort after that callback
    // unwinds to avoid reentrant stream teardown. This controller owns only this task.
    queueMicrotask(() => remoteController.abort());
  };
  ctx.ui.setStatus(
    STATUS_KEY,
    route.protocol === "context-management"
      ? "Responses Context Management…"
      : route.protocol === "remote-v2"
        ? "Responses Remote V2…"
        : "Responses Compact API…",
  );
  try {
    if (checkpointPresent && !checkpoint)
      throw new Error("The active opaque checkpoint is invalid or unsupported; history preserved");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!stillCurrent()) return { cancel: true };
    if (!auth.ok) throw new Error(auth.error);
    // Keep resolved request values local and redact them if the provider echoes them in an error.
    requestValues = [auth.apiKey, ...Object.values(auth.headers ?? {}), ...Object.values(auth.env ?? {})].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("The active Responses provider is unavailable");
    const current = projectedCurrentMessages(event, route);
    if (checkpoint && current.prior && checkpoint.details.provider !== model.provider) {
      if (settings.checkpointRecovery === "cancel") return { cancel: true };
      ctx.ui.setStatus(STATUS_KEY, "Transferring checkpoint through its issuing provider…");
      const messages = summaryPrefix(current.messages, keptMessages(event), fingerprintMessage);
      const request = await checkpointIssuerRequest(ctx, checkpoint, messages, settings, signal, stillCurrent, fetch);
      if (!stillCurrent()) return { cancel: true };
      const compaction = await recoverCheckpoint(request, event).catch(() => {
        throw new Error("Checkpoint transfer through its issuing provider failed; history preserved");
      });
      if (!stillCurrent()) return { cancel: true };
      return { compaction };
    }
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: activeTools(pi),
    };
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      protocol: route.protocol,
      profile: route.profile,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: remoteSignal,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxRetries,
      onProviderStreamEvent: (raw) => {
        const error = streamOperationRejection(raw);
        if (error) recordRejection(error);
      },
      fetch: async (input, init) => {
        if (!stillCurrent()) throw new Error("Compaction ownership changed before dispatch");
        const endpoint = input instanceof Request ? input.url : String(input);
        routeKey = rejectionRouteKey(model, route, endpoint);
        endpointObserved = true;
        rejected.observe(publicRouteKey, routeKey);
        paused = rejected.has(routeKey);
        if (paused) {
          // Cancel only the remote subrequest, including adapter-owned retries.
          // Keep the parent compaction signal available for checkpoint recovery.
          remoteController.abort();
          return Response.json(
            { error: { message: "Remote compaction route is paused after an OAuth operation rejection" } },
            { status: 409, headers: { "x-should-retry": "false" } },
          );
        }
        remoteAttempted = true;
        const response = await (fetch ?? globalThis.fetch)(input, init);
        if (!stillCurrent()) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error("Compaction ownership changed after response");
        }
        const signals = [
          remoteSignal,
          ...(init?.signal ? [init.signal] : []),
          ...(input instanceof Request ? [input.signal] : []),
        ];
        const requestSignal = AbortSignal.any(signals);
        const failure = await inspectFailureResponse(response, requestSignal);
        if (!stillCurrent()) {
          void failure.response.body?.cancel().catch(() => undefined);
          throw new Error("Compaction ownership changed during error inspection");
        }
        if (failure.rejection) recordRejection(failure.rejection);
        return route.protocol === "responses-compact"
          ? failure.response
          : observeSseRejections(failure.response, requestSignal, recordRejection);
      },
    });
    if (!stillCurrent()) return { cancel: true };
    const replacementHistory =
      route.protocol === "context-management"
        ? validateContextManagementHistory(response.replacementHistory ?? [], {
            byteBudget: REPLACEMENT_BYTE_BUDGET,
            tokenBudget: settings.replacementTokenBudget,
          })
        : buildReplacementHistory(response.compactedOutput?.slice(0, -1) ?? response.promptInput, response.item, {
            tokenBudget: settings.replacementTokenBudget,
          });
    const details = createCheckpointDetails({
      provider: model.provider,
      api: route.api,
      profile: route.profile,
      modelId: model.id,
      protocol: route.protocol,
      replacementHistory,
      keptMessages: keptMessages(event),
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    if (!stillCurrent()) return { cancel: true };
    if (remoteAttempted && isOAuthOperationRejection(error))
      recordRejection(error instanceof Error ? error : new Error(String(error)));
    if (!paused || remoteAttempted)
      notifyFailure(ctx, rejectionError ?? error, settings, requestValues, checkpointPresent, rejected.has(routeKey));
    if (!checkpointPresent) return undefined;
    if (!checkpoint) return { cancel: true };
    if (checkpoint.details.provider !== model.provider) return { cancel: true };
    if (settings.checkpointRecovery === "cancel") return { cancel: true };
    let nativeFallbackAllowed = false;
    try {
      const current = projectedCurrentMessages(event, route);
      if (!current.prior) throw new Error("Checkpoint recovery lost its checkpoint");
      const messages = summaryPrefix(current.messages, keptMessages(event), fingerprintMessage);
      // Native fallback is intentionally lossy, but never bypass projection or ownership checks.
      nativeFallbackAllowed = true;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!stillCurrent()) return { cancel: true };
      if (!auth.ok) throw new Error(auth.error);
      requestValues = [
        ...requestValues,
        auth.apiKey,
        ...Object.values(auth.headers ?? {}),
        ...Object.values(auth.env ?? {}),
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error("The active Responses provider is unavailable");
      ctx.ui.setStatus(STATUS_KEY, "Checkpoint recovery summary…");
      const compaction = await recoverCheckpoint(
        {
          provider,
          model,
          context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: [] },
          profile: route.profile,
          protocol: route.protocol,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal,
          priorCheckpoint: {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          },
          requestTimeoutMs: settings.requestTimeoutMs,
          maxRetries: settings.maxRetries,
          fetch: async (input, init) => {
            if (!stillCurrent()) throw new Error("Checkpoint recovery ownership changed before dispatch");
            const endpoint = new URL(input instanceof Request ? input.url : String(input));
            // Unary compaction derives /responses/compact from the provider's
            // inference endpoint. Compare that exact public dispatch identity.
            if (route.protocol === "responses-compact") endpoint.pathname += "/compact";
            if (endpointObserved && rejectionRouteKey(model, route, endpoint.toString()) !== routeKey) {
              nativeFallbackAllowed = false;
              return Response.json(
                { error: { message: "Checkpoint recovery backend changed before dispatch" } },
                { status: 400, headers: { "x-should-retry": "false" } },
              );
            }
            return (fetch ?? globalThis.fetch)(input, init);
          },
        },
        event,
      );
      if (!stillCurrent()) return { cancel: true };
      return { compaction };
    } catch (recoveryError) {
      if (!stillCurrent()) return { cancel: true };
      if (ctx.hasUI && settings.notifyOnFallback) {
        const outcome = nativeFallbackAllowed
          ? "using Pi native compaction. Older context stored only in the opaque checkpoint may be lost."
          : "compaction cancelled and history preserved.";
        ctx.ui.notify(
          `Checkpoint recovery could not complete; ${outcome} ${compactionFailureDetail(recoveryError, requestValues)}`,
          "warning",
        );
      }
      return nativeFallbackAllowed ? undefined : { cancel: true };
    }
  } finally {
    remoteController.abort();
    if (!ownerSignal.aborted && ctx.sessionManager.getSessionId() === sessionId && ownsStatus()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    type ContinuationRun = {
      used: boolean;
      pending?: {
        checkpointId: string;
        routeKey: string;
        settingsKey: string;
        entryId?: string;
      };
    };
    type Owner = {
      controller: AbortController;
      rejected: RejectedRoutes;
      sessionId: string;
      operation?: AbortController;
      run?: ContinuationRun;
    };
    const owners = new WeakMap<object, Owner>();
    const ownerFor = (ctx: ExtensionContext): Owner => {
      let owner = owners.get(ctx.sessionManager);
      const sessionId = ctx.sessionManager.getSessionId();
      if (owner?.controller.signal.aborted) return owner;
      if (!owner || owner.sessionId !== sessionId) {
        owner?.controller.abort();
        if (owner) ctx.ui.setStatus(STATUS_KEY, undefined);
        owner = { controller: new AbortController(), rejected: new RejectedRoutes(), sessionId };
        owners.set(ctx.sessionManager, owner);
      }
      return owner;
    };

    const cancelOperation = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      const operation = owner?.operation;
      if (!owner || !operation) return;
      operation.abort();
      if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
        owner.operation = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure Responses compaction",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /codex-compact");
        const owner = ownerFor(ctx);
        const controller = owner.controller;
        const { showCodexCompactMenu } = await import("./settings-menu.js");
        if (owners.get(ctx.sessionManager) !== owner || controller.signal.aborted) return;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: controller.signal,
          isCurrent: () =>
            owners.get(ctx.sessionManager) === owner &&
            !controller.signal.aborted &&
            ctx.sessionManager.getSessionId() === owner.sessionId,
          isPaused: () => {
            const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
            return (
              !!ctx.model && route.kind === "remote" && owner.rejected.hasObserved(rejectionRouteKey(ctx.model, route))
            );
          },
          hasCheckpoint: () => hasActiveCheckpointClaim(ctx.sessionManager.getBranch()),
          canReplayCheckpoint: () => {
            const checkpoint = activeCheckpoint(ctx);
            return (
              !!checkpoint && isCheckpointCompatible(checkpoint.details, ctx.model, settingsRuntime.get().settings)
            );
          },
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      owners.get(ctx.sessionManager)?.controller.abort();
      const owner: Owner = {
        controller: new AbortController(),
        rejected: new RejectedRoutes(),
        sessionId: ctx.sessionManager.getSessionId(),
      };
      owners.set(ctx.sessionManager, owner);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      let state: Readonly<CodexCompactSettingsState>;
      try {
        state = await settingsRuntime.reload(owner.controller.signal);
      } catch (error) {
        if (
          owner.controller.signal.aborted ||
          owners.get(ctx.sessionManager) !== owner ||
          ctx.sessionManager.getSessionId() !== sessionId
        )
          return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-codex-compact.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
        return;
      }
      if (
        owner.controller.signal.aborted ||
        owners.get(ctx.sessionManager) !== owner ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-codex-compact.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
    });

    // before_agent_start follows pre-prompt compaction and runs once per user run,
    // unlike agent_start, which also fires for Pi retries and our continuation.
    pi.on("before_agent_start", (_event, ctx) => {
      const owner = ownerFor(ctx);
      if (!owner.controller.signal.aborted) owner.run = { used: false };
    });

    pi.on("session_before_compact", (event, ctx) => {
      const owner = ownerFor(ctx);
      const run = owner.run;
      if (run) run.pending = undefined;
      cancelOperation(ctx);
      const operation = new AbortController();
      owner.operation = operation;
      const settings = settingsRuntime.get().settings;
      const model = ctx.model;
      const route = resolveCompactionRoute(model, settings);
      const key = model && route.kind === "remote" ? rejectionRouteKey(model, route) : undefined;
      const isCurrent = () => {
        if (owners.get(ctx.sessionManager) !== owner || owner.operation !== operation || operation.signal.aborted)
          return false;
        const currentSettings = settingsRuntime.get().settings;
        const currentRoute = resolveCompactionRoute(ctx.model, currentSettings);
        return (
          JSON.stringify(currentSettings) === JSON.stringify(settings) &&
          (key === undefined ||
            (!!ctx.model && currentRoute.kind === "remote" && rejectionRouteKey(ctx.model, currentRoute) === key))
        );
      };
      return compactRemotely(
        pi,
        event,
        ctx,
        settings,
        AbortSignal.any([owner.controller.signal, operation.signal]),
        owner.rejected,
        isCurrent,
        () => owners.get(ctx.sessionManager) === owner && owner.operation === operation,
        options.fetch,
      )
        .then((result) => {
          const details =
            result && "compaction" in result ? parseCheckpointDetails(result.compaction?.details) : undefined;
          if (
            run &&
            owner.run === run &&
            !run.used &&
            isCurrent() &&
            !owner.controller.signal.aborted &&
            event.reason !== "manual" &&
            !event.willRetry &&
            route.kind === "remote" &&
            route.protocol === "context-management" &&
            key &&
            details?.protocol === "context-management"
          ) {
            // A returned result is not yet a committed checkpoint. Only the matching
            // session_compact event can arm it for the settlement boundary.
            run.pending = { checkpointId: details.checkpointId, routeKey: key, settingsKey: JSON.stringify(settings) };
          }
          return result;
        })
        .finally(() => {
          if (owner.operation === operation) owner.operation = undefined;
          operation.abort();
        });
    });

    pi.on("session_compact", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      const run = owner?.run;
      const pending = run?.pending;
      if (!owner || !run || !pending || pending.entryId) return;
      const checkpoint = activeCheckpoint(ctx);
      if (
        !owner.controller.signal.aborted &&
        owner.sessionId === ctx.sessionManager.getSessionId() &&
        event.fromExtension &&
        event.reason !== "manual" &&
        !event.willRetry &&
        checkpoint?.entry.id === event.compactionEntry.id &&
        checkpoint.details.checkpointId === pending.checkpointId
      ) {
        pending.entryId = checkpoint.entry.id;
      } else {
        run.pending = undefined;
      }
    });

    pi.on("agent_before_settle", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      const run = owner?.run;
      const pending = run?.pending;
      if (!owner || !run || !pending?.entryId) return;
      // Consume the candidate even when another participant already continues.
      // Repeated events cannot replay it at a later or unrelated boundary.
      run.pending = undefined;
      const settings = settingsRuntime.get().settings;
      const route = resolveCompactionRoute(ctx.model, settings);
      const checkpoint = activeCheckpoint(ctx);
      if (
        run.used ||
        owner.controller.signal.aborted ||
        ctx.signal?.aborted ||
        owner.sessionId !== ctx.sessionManager.getSessionId() ||
        event.outcome !== "completed" ||
        route.kind !== "remote" ||
        route.protocol !== "context-management" ||
        !ctx.model ||
        rejectionRouteKey(ctx.model, route) !== pending.routeKey ||
        JSON.stringify(settings) !== pending.settingsKey ||
        checkpoint?.entry.id !== pending.entryId ||
        checkpoint.details.checkpointId !== pending.checkpointId ||
        !isCheckpointCompatible(checkpoint.details, ctx.model, settings) ||
        (event.continue && event.context.canContinue) ||
        // Boundary pendingMessages also includes context-only custom messages.
        // They can make canContinue true without scheduling any provider request.
        (ctx.hasPendingMessages() && event.context.canContinue) ||
        !projectSessionCheckpointContext(event.context.contextMessages, ctx.sessionManager.getBranch(), checkpoint)
      ) {
        return;
      }
      run.used = true;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message" as const,
            customType: CONTINUATION_TYPE,
            content: CONTINUATION_MESSAGE,
            display: false,
            details: { checkpointId: pending.checkpointId },
          },
        ],
        continue: true,
      };
    });

    pi.on("session_compact_failed", (_event, ctx) => {
      const run = owners.get(ctx.sessionManager)?.run;
      if (run) run.pending = undefined;
    });

    pi.on("agent_settled", (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("context", async (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint) return undefined;
      const route = resolveCompactionRoute(ctx.model, settings);
      if (
        route.kind !== "remote" ||
        route.api !== checkpoint.details.api ||
        route.profile !== checkpoint.details.profile
      )
        return undefined;
      const messages = projectSessionCheckpointContext(event.messages, ctx.sessionManager.getBranch(), checkpoint);
      if (!messages) return undefined;
      if (isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return { messages };
      let summary = savedPlaintextCheckpoint(ctx.sessionManager.getBranch(), checkpoint);
      if (summary) return { messages: plaintextCheckpointMessages(messages, checkpoint, summary) };
      const owner = ownerFor(ctx);
      if (owner.controller.signal.aborted || ctx.signal?.aborted) return undefined;
      cancelOperation(ctx);
      const operation = new AbortController();
      owner.operation = operation;
      const signal = AbortSignal.any([owner.controller.signal, operation.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const model = ctx.model;
      const branchIsCurrent = captureCompactionBranch(ctx.sessionManager.getBranch());
      const systemPrompt = ctx.getSystemPrompt();
      const stillCurrent = () =>
        !signal.aborted &&
        owners.get(ctx.sessionManager) === owner &&
        owner.operation === operation &&
        owner.sessionId === ctx.sessionManager.getSessionId() &&
        ctx.model === model &&
        JSON.stringify(settingsRuntime.get().settings) === JSON.stringify(settings) &&
        ctx.getSystemPrompt() === systemPrompt &&
        branchIsCurrent(ctx.sessionManager.getBranch());
      let transferred = false;
      ctx.ui.setStatus(STATUS_KEY, "Transferring checkpoint through its issuing provider…");
      try {
        if (settings.checkpointRecovery === "cancel") throw new Error("Checkpoint recovery is disabled");
        const marker = messages.find(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === "text" && part.text === checkpointMarker(checkpoint.details.checkpointId),
            ),
        );
        if (!marker) throw new Error("The checkpoint marker is unavailable");
        const request = await checkpointIssuerRequest(
          ctx,
          checkpoint,
          [marker],
          settings,
          signal,
          stillCurrent,
          options.fetch,
        );
        if (!stillCurrent()) return undefined;
        const result = await summarizeCheckpoint(request, {
          maxTokens: Math.min(request.model.maxTokens, settings.replacementTokenBudget),
        });
        if (!stillCurrent()) return undefined;
        summary = result.summary;
        pi.appendEntry(PLAINTEXT_CHECKPOINT_TYPE, {
          entryId: checkpoint.entry.id,
          checkpointId: checkpoint.details.checkpointId,
          summary,
        });
        transferred = true;
        if (ctx.hasUI)
          ctx.ui.notify(
            "Checkpoint transferred as a plaintext summary through its issuing provider. Encrypted state was not sent to the selected provider.",
            "info",
          );
        return { messages: plaintextCheckpointMessages(messages, checkpoint, summary) };
      } catch {
        if (stillCurrent()) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Checkpoint transfer could not complete; request stopped and history preserved. Switch back to the checkpoint's issuing provider and verify its authentication, or enable checkpoint summary recovery.",
              "warning",
            );
        }
        return undefined;
      } finally {
        if (
          !transferred &&
          owners.get(ctx.sessionManager) === owner &&
          owner.sessionId === ctx.sessionManager.getSessionId() &&
          (owner.operation === operation || owner.operation === undefined)
        )
          ctx.abort();
        if (owner.operation === operation) {
          owner.operation = undefined;
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        operation.abort();
      }
    });

    pi.on("before_provider_request", (event, ctx) => {
      // This hook is for normal session requests, not the separate maintenance
      // call. Mid-turn compaction and queued work already satisfy continuation.
      const run = owners.get(ctx.sessionManager)?.run;
      if (run?.pending?.entryId) run.pending = undefined;
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!isCheckpointCompatible(checkpoint.details, ctx.model, settings)) {
        if (hasCheckpointMarker(event.payload, marker)) ctx.abort();
        return undefined;
      }
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      return rewriteCheckpointMarker(event.payload, marker, checkpoint.details.replacementHistory);
    });

    pi.on("session_tree", (_event, ctx) => {
      cancelOperation(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("model_select", (event, ctx) => {
      cancelOperation(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
      if (!settingsRuntime.get().settings.enabled) return;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model, settings)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Responses checkpoint cannot replay directly on this provider/API. For a compatible API/profile, the next request transfers it through its issuing provider as a plaintext summary; otherwise only the fallback marker and recent messages remain available.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager) ?? ownerFor(ctx);
      owner.controller.abort();
      owner.rejected = new RejectedRoutes();
      owner.operation = undefined;
      owner.run = undefined;
      // Keep an aborted tombstone until session_start so queued old-context
      // events cannot recreate an active controller after shutdown.
      providerWarnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
