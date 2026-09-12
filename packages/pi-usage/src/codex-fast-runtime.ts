import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  codexFastAvailability,
  codexFastIsEffective,
  codexFastStatusLabel,
  correctCodexFastMessageCost,
  rewriteCodexFastPayload,
} from "./codex-fast.js";
import { errorMessage } from "./core.js";
import { isStaleExtensionContextError } from "./query.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "./settings.js";
import type { PiModel } from "./types.js";

const NO_FAST_REQUEST = Symbol("no-fast-request");
type PendingFastRequest = { fastRequested: boolean; model: PiModel };

export const FAST_USAGE_WARNING = "Fast is about 1.5× faster and uses more of your plan allowance.";

export function registerCodexFastMode(
  pi: ExtensionAPI,
  settingsRuntime: UsageSettingsRuntime,
  refreshStatus: (ctx: ExtensionContext) => void,
  options: { registerSessionStart?: boolean } = {},
) {
  let sessionController = new AbortController();
  let generation = 0;
  const pendingFastRequests = new Map<string, PendingFastRequest>();

  const toggle = async (
    ctx: ExtensionCommandContext,
    enabled: boolean,
    callerSignal?: AbortSignal,
  ): Promise<boolean> => {
    const ownerGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const signal = callerSignal ? AbortSignal.any([callerSignal, sessionController.signal]) : sessionController.signal;
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
      const availability = codexFastAvailability(ctx.model, settingsRuntime.get().settings.codexFastMode);
      if (availability.kind === "not-codex") {
        ctx.ui.notify("/fast is available only for the active OpenAI Codex model.", "warning");
        return;
      }
      if (availability.kind === "unavailable") {
        ctx.ui.notify(availability.reason, "warning");
        return;
      }
      if (settingsRuntime.get().kind === "invalid") {
        ctx.ui.notify("pi-usage.json is invalid; repair it and run /reload before changing Fast mode.", "error");
        return;
      }
      await toggle(ctx, !availability.enabled);
    },
  });

  const prepareSession = (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    generation += 1;
    sessionController.abort();
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
    })();
  };

  if (options.registerSessionStart !== false) {
    pi.on("session_start", async (_event, ctx) => prepareSession(ctx));
  }

  pi.on("before_provider_request", (event, ctx) => {
    const rewritten = rewriteCodexFastPayload(event.payload, ctx.model, settingsRuntime.get().settings.codexFastMode);
    const key = activeRequestKey(ctx);
    if (key && ctx.model) {
      pendingFastRequests.set(key, {
        fastRequested: isRecord(rewritten) && rewritten.service_tier === "priority",
        model: ctx.model,
      });
    }
    return rewritten;
  });
  pi.on("message_end", (event, ctx) => {
    const request = consumeFastRequest(ctx, event.message, pendingFastRequests);
    if (request === NO_FAST_REQUEST) return undefined;
    const message = correctCodexFastMessageCost(event.message, request.model, request.fastRequested);
    return message ? { message: message as never } : undefined;
  });
  pi.on("session_shutdown", async () => {
    generation += 1;
    sessionController.abort();
    pendingFastRequests.clear();
    await settingsRuntime.flush();
  });

  return {
    prepareSession,
    availability(model: PiModel | undefined) {
      return codexFastAvailability(model, settingsRuntime.get().settings.codexFastMode);
    },
    decorateStatus(model: PiModel | undefined, status: string) {
      return codexFastStatusLabel(status, codexFastIsEffective(model, settingsRuntime.get().settings.codexFastMode));
    },
    toggle,
  };
}

function activeRequestKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
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
