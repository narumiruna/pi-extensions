import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CodexFastCapability,
  codexFastAvailability,
  codexFastIsEffective,
  codexFastStatusLabel,
  correctCodexFastMessageCost,
  isOfficialCodexModel,
  rewriteCodexFastPayload,
  UNKNOWN_CODEX_FAST_CAPABILITY,
} from "./codex-fast.js";
import { createCodexFastCatalog } from "./codex-fast-catalog.js";
import { errorMessage } from "./core.js";
import {
  createOAuthCredentialCandidateReader,
  type OAuthCredentialCandidateReader,
  type StoredCredentialReader,
} from "./oauth-credential-source.js";
import { isStaleExtensionContextError } from "./query.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "./settings.js";
import type { PiModel } from "./types.js";

const NO_FAST_REQUEST = Symbol("no-fast-request");
type PendingFastRequest = { fastRequested: boolean; model: PiModel; capability: CodexFastCapability };

export const FAST_USAGE_WARNING = "Fast is about 1.5× faster and uses more of your plan allowance.";

export function registerCodexFastMode(
  pi: ExtensionAPI,
  settingsRuntime: UsageSettingsRuntime,
  refreshStatus: (ctx: ExtensionContext) => void,
  options: {
    registerSessionStart?: boolean;
    credentialReader?: StoredCredentialReader;
    candidateReader?: OAuthCredentialCandidateReader;
    timeoutMs?: number;
  } = {},
) {
  let sessionController = new AbortController();
  let generation = 0;
  const pendingFastRequests = new Map<string, PendingFastRequest>();
  const catalog = createCodexFastCatalog({
    credentialReader: options.credentialReader,
    candidateReader: options.candidateReader ?? createOAuthCredentialCandidateReader(pi, options.credentialReader),
    timeoutMs: options.timeoutMs,
    onChanged(ctx) {
      if (sessionController.signal.aborted || !settingsRuntime.get().settings.codexFastMode) return;
      try {
        refreshStatus(ctx);
      } catch (error) {
        if (!isStaleExtensionContextError(error)) throw error;
      }
    },
  });

  const toggle = async (
    ctx: ExtensionCommandContext,
    enabled: boolean,
    callerSignal?: AbortSignal,
  ): Promise<boolean> => {
    const ownerGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const signal = callerSignal ? AbortSignal.any([callerSignal, sessionController.signal]) : sessionController.signal;
    if (ctx.model?.provider !== "openai-codex") {
      ctx.ui.notify("/fast is available only for the active OpenAI Codex model.", "warning");
      return false;
    }
    if (!isOfficialCodexModel(ctx.model)) {
      ctx.ui.notify("Fast mode requires the official OpenAI Codex Responses endpoint.", "warning");
      return false;
    }
    if (settingsRuntime.get().kind === "invalid") {
      ctx.ui.notify("pi-usage.json is invalid; repair it and run /reload before changing Fast mode.", "error");
      return false;
    }
    if (enabled) {
      const capability = await catalog.read(ctx, signal, true, catalog.get(ctx.model).kind !== "supported");
      if (signal.aborted || ownerGeneration !== generation) return false;
      if (!capability) {
        const latest = catalog.get(ctx.model);
        ctx.ui.notify(
          latest.kind === "unknown"
            ? latest.reason
            : "The active Codex account changed while checking Fast capability.",
          "warning",
        );
        return false;
      }
      const availability = codexFastAvailability(ctx.model, false, capability);
      if (availability.kind !== "available") {
        if (availability.kind === "unknown" || availability.kind === "unavailable") {
          ctx.ui.notify(availability.reason, "warning");
        }
        return false;
      }
    }
    try {
      await settingsRuntime.update({ codexFastMode: enabled }, signal);
    } catch (error) {
      if (isAbortError(error) || isStaleExtensionContextError(error)) return false;
      ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
      return false;
    }
    if (signal.aborted || ownerGeneration !== generation || ctx.sessionManager.getSessionId() !== sessionId) {
      return false;
    }
    refreshStatus(ctx);
    ctx.ui.notify(
      enabled
        ? `Codex Fast mode enabled. ${FAST_USAGE_WARNING}`
        : "Codex Fast mode disabled; standard routing will be used.",
      "info",
    );
    return true;
  };

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode",
    handler: async (args, ctx) => {
      if (args.trim()) {
        if (!ctx.hasUI) throw new Error("/fast does not accept arguments.");
        ctx.ui.notify("/fast does not accept arguments.", "warning");
        return;
      }
      if (!ctx.hasUI) throw new Error("/fast requires TUI or RPC mode.");
      await toggle(ctx, !settingsRuntime.get().settings.codexFastMode);
    },
  });

  const refreshCapabilities = (ctx: ExtensionContext, callerSignal?: AbortSignal, force = false) => {
    const signal = callerSignal ? AbortSignal.any([callerSignal, sessionController.signal]) : sessionController.signal;
    return catalog.read(ctx, signal, true, force);
  };

  const prepareSession = (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    generation += 1;
    sessionController.abort();
    catalog.reset();
    pendingFastRequests.clear();
    sessionController = new AbortController();
    const ownerGeneration = generation;
    return (async () => {
      let state: Readonly<UsageSettingsState>;
      try {
        state = await settingsRuntime.reload(sessionController.signal);
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(`Could not load pi-usage.json; using defaults. ${errorMessage(error)}`, "warning");
        }
        return;
      }
      if (
        sessionController.signal.aborted ||
        ownerGeneration !== generation ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(`Invalid pi-usage.json; using defaults without overwriting it. ${state.issue}`, "warning");
      }
      refreshStatus(ctx);
      if (state.kind !== "invalid" && isOfficialCodexModel(ctx.model)) void refreshCapabilities(ctx);
    })();
  };

  if (options.registerSessionStart !== false) {
    pi.on("session_start", async (_event, ctx) => prepareSession(ctx));
  }
  pi.on("model_select", (_event, ctx) => {
    void refreshCapabilities(ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const ownerGeneration = generation;
    const model = ctx.model;
    const enabled = settingsRuntime.get().settings.codexFastMode;
    const capability =
      enabled && isOfficialCodexModel(model)
        ? ((await catalog.read(ctx, sessionController.signal)) ?? UNKNOWN_CODEX_FAST_CAPABILITY)
        : UNKNOWN_CODEX_FAST_CAPABILITY;
    if (sessionController.signal.aborted || ownerGeneration !== generation) return undefined;
    const rewritten = rewriteCodexFastPayload(event.payload, model, enabled, capability);
    const key = activeRequestKey(ctx, model);
    if (key && model) {
      pendingFastRequests.set(key, {
        fastRequested: isRecord(rewritten) && rewritten.service_tier === "priority",
        model,
        capability,
      });
    }
    return rewritten;
  });
  pi.on("message_end", (event, ctx) => {
    const request = consumeFastRequest(ctx, event.message, pendingFastRequests);
    if (request === NO_FAST_REQUEST) return undefined;
    const message = correctCodexFastMessageCost(
      event.message,
      request.model,
      request.fastRequested,
      request.capability,
    );
    return message ? { message: message as never } : undefined;
  });
  pi.on("session_shutdown", async () => {
    generation += 1;
    sessionController.abort();
    catalog.reset(true);
    pendingFastRequests.clear();
    await settingsRuntime.flush();
  });

  return {
    prepareSession,
    refreshCapabilities,
    availability(model: PiModel | undefined) {
      return codexFastAvailability(model, settingsRuntime.get().settings.codexFastMode, catalog.get(model));
    },
    decorateStatus(model: PiModel | undefined, status: string) {
      const enabled = settingsRuntime.get().settings.codexFastMode;
      const capability = catalog.get(model);
      if (
        enabled &&
        codexFastAvailability(model, enabled, capability).kind === "unknown" &&
        /^codex(?:\s|$)/u.test(status)
      ) {
        return `codex (Fast unknown)${status.slice("codex".length)}`;
      }
      return codexFastStatusLabel(status, codexFastIsEffective(model, enabled, capability));
    },
    toggle,
  };
}

function activeRequestKey(ctx: ExtensionContext, model = ctx.model): string | undefined {
  return model ? `${ctx.sessionManager.getSessionId()}:${model.provider}/${model.id}` : undefined;
}

function consumeFastRequest(
  ctx: ExtensionContext,
  message: unknown,
  pending: Map<string, PendingFastRequest>,
): PendingFastRequest | typeof NO_FAST_REQUEST {
  if (!isRecord(message) || message.role !== "assistant") return NO_FAST_REQUEST;
  const key = messageRequestKey(ctx, message);
  if (!key) return NO_FAST_REQUEST;
  const request = pending.get(key);
  pending.delete(key);
  return request ?? NO_FAST_REQUEST;
}

function messageRequestKey(ctx: ExtensionContext, message: Record<string, unknown>): string | undefined {
  if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
  return `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
