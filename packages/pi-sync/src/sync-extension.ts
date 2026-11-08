import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSyncArguments, splitArgs } from "./commands/command.js";
import type { AnySyncConfig } from "./settings/settings-types.js";
import { withStateDirectoryAccess } from "./state/state-directory.js";
import { startupTransferEnabled } from "./sync/agent-policy.js";
import { autoPushSessions, startSession } from "./sync/automatic-sync.js";
import { combineSignals } from "./sync/signals.js";
import { createStartupCheck } from "./sync/startup-check.js";
import { errorMessage } from "./sync/sync-errors.js";
import { createSyncLoaders, type SyncDependencies } from "./sync/sync-loaders.js";
import { registerStartupTimings } from "./ui/startup-timings-entry.js";
import { createSyncAttentionController } from "./ui/sync-attention.js";
import { createSyncStatusPublisher, setSyncStatus } from "./ui/sync-status.js";
import { safeTerminalText } from "./ui/terminal-text.js";

export default function sync(pi: ExtensionAPI, dependencies: Partial<SyncDependencies> = {}) {
  const loaders = createSyncLoaders(dependencies);
  const attention = createSyncAttentionController();
  const status = createSyncStatusPublisher(pi.events);
  const publishTimings = registerStartupTimings(pi);
  const check = createStartupCheck(loaders, attention, 30_000, publishTimings);
  let sessionAbort = new AbortController();
  let shutdownAbort: AbortController | undefined;
  let initialization = Promise.resolve<AnySyncConfig | false | undefined>(undefined);
  let continuous: ReturnType<typeof import("./sync/continuous-sync.js")["createContinuousSync"]> | undefined;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let continuousPossible = false;
  let startupDebug = false;
  const foreground = new Map<ExtensionContext["sessionManager"], number>();
  async function resumeContinuous(ctx: ExtensionContext, signal: AbortSignal, retry?: { setup?: string }) {
    const isCurrent = () => !signal.aborted && !foreground.has(ctx.sessionManager) && owner === ctx.sessionManager;
    if (!isCurrent() || !ctx.hasUI) return;
    try {
      const { loadConfigForCheck } = await import("./settings/config.js");
      if (!isCurrent()) return;
      const config = await loadConfigForCheck();
      if (!isCurrent()) return;
      continuousPossible = Boolean(config.continuous && config.agentMode);
      if (!continuousPossible) {
        await continuous?.stop(ctx.sessionManager);
        return;
      }
      const { createContinuousSync } = await import("./sync/continuous-sync.js");
      if (!isCurrent()) return;
      continuous ??= createContinuousSync(loaders, undefined, publishTimings);
      continuous.start(
        ctx,
        signal,
        Boolean(retry && (retry.setup === undefined || retry.setup === config.setupName)),
        startupDebug,
      );
    } catch {
      /* Existing initialization/command paths report settings errors. */
    }
  }

  pi.registerCommand("sync", {
    description: "Sync Pi settings through Git, WebDAV, R2, or S3-compatible storage",
    getArgumentCompletions: completeSyncArguments,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("/sync requires TUI or RPC mode so results and safety prompts are observable.");
      }
      status.bind(ctx);
      const signal = sessionAbort.signal;
      const manager = ctx.sessionManager;
      const command = splitArgs(args)[0];
      let retry: { setup?: string } | undefined;
      let mayResume = false;
      foreground.set(manager, (foreground.get(manager) ?? 0) + 1);
      try {
        const ready = await initialization;
        mayResume = ready !== false;
        if (signal.aborted) return;
        await continuous?.stop(manager);
        if (signal.aborted) return;
        await check.stop();
        if (signal.aborted) return;
        if (ready === false && command !== "help" && command !== "unlock" && command !== "migrate-state") {
          ctx.ui.notify(
            "pi-sync recovery required. Repair the startup error, then /reload before syncing. Use /sync help for recovery guidance.",
            "error",
          );
          return;
        }
        const commands = await loaders.commands().catch((error) => {
          if (!signal.aborted) {
            ctx.ui.notify(`pi-sync command unavailable: ${safeTerminalText(errorMessage(error))}`, "error");
          }
        });
        if (signal.aborted || !commands) return;
        const run = () =>
          commands.handleCommand(args, ctx, signal, loaders, attention, (setup) => {
            retry = { setup };
          });
        // Drain background children before foreground guards. Help remains reachable during repair.
        if (command === "migrate-state" || command === "help") await run();
        else await withStateDirectoryAccess(run);
      } finally {
        const count = (foreground.get(manager) ?? 1) - 1;
        if (count) foreground.set(manager, count);
        else foreground.delete(manager);
        if (mayResume) await resumeContinuous(ctx, signal, retry);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const releaseStatus = status.start(ctx);
    try {
      shutdownAbort?.abort(new DOMException("Session replaced", "AbortError"));
      shutdownAbort = undefined;
      sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
      sessionAbort = new AbortController();
      const signal = sessionAbort.signal;
      owner = ctx.sessionManager;
      continuousPossible = false;
      startupDebug = false;
      attention.reset(ctx);
      const previous = initialization;
      initialization = (async () => {
        await previous;
        if (signal.aborted) return false;
        await continuous?.stop();
        if (signal.aborted) return false;
        await check.stop();
        if (signal.aborted) return false;
        try {
          const startup = await withStateDirectoryAccess(() => startSession(ctx, signal, publishTimings));
          if (signal.aborted) return false;
          startupDebug = startup?.debug ?? false;
          return startup?.config;
        } catch (error) {
          if (!signal.aborted && ctx.hasUI) {
            ctx.ui.notify(`pi-sync recovery required: ${safeTerminalText(errorMessage(error))}`, "error");
          }
          return false;
        }
      })();
      const ready = await initialization;
      if (ready === false) releaseStatus();
      if (ready && !signal.aborted) {
        if (ready.continuous && ready.agentMode) await resumeContinuous(ctx, signal);
        else if (ready.automatic || startupTransferEnabled(ready)) check.start(ctx, signal, ready);
      }
    } catch (error) {
      releaseStatus();
      throw error;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    await continuous?.stop(ctx.sessionManager);
    await check.interrupt(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const signal = sessionAbort.signal;
    if (!signal.aborted) {
      check.settled(ctx);
      if (continuousPossible) await resumeContinuous(ctx, signal);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const releaseStatus = status.cleanupFor(ctx);
    try {
      if (continuous && owner && owner !== ctx.sessionManager) return;
      sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
      attention.reset(ctx);
      shutdownAbort?.abort(new DOMException("Session shut down again", "AbortError"));
      const controller = new AbortController();
      shutdownAbort = controller;
      const signal = combineSignals(controller.signal, AbortSignal.timeout(30_000));
      const reason = typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
      try {
        const ready = await initialization;
        if (signal.aborted) return;
        await continuous?.stop(ctx.sessionManager);
        if (signal.aborted) return;
        await check.stop();
        if (signal.aborted) return;
        if (ready !== false && reason !== "reload") {
          await withStateDirectoryAccess(async () => {
            if (signal.aborted) return;
            await autoPushSessions(ctx, signal, loaders);
          });
        }
      } catch (error) {
        if (!signal.aborted) {
          ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
        }
      } finally {
        if (shutdownAbort === controller) shutdownAbort = undefined;
      }
      if (signal.aborted) return;
      setSyncStatus(ctx, undefined);
    } finally {
      releaseStatus();
    }
  });
}

export type { SyncDependencies } from "./sync/sync-loaders.js";
