import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSyncArguments, splitArgs } from "./commands/command.js";
import { handleCommand } from "./commands/command-handler.js";
import type { AnySyncConfig } from "./settings/settings-types.js";
import { withStateDirectoryAccess } from "./state/state-directory.js";
import { autoPushSessions, startSession } from "./sync/automatic-sync.js";
import { combineSignals } from "./sync/signals.js";
import { createStartupCheck } from "./sync/startup-check.js";
import { errorMessage } from "./sync/sync-errors.js";
import { createSyncLoaders, type SyncDependencies } from "./sync/sync-loaders.js";
import { createSyncAttentionController } from "./ui/sync-attention.js";
import { safeTerminalText } from "./ui/terminal-text.js";

const STATUS_KEY = "sync";

export default function sync(pi: ExtensionAPI, dependencies: Partial<SyncDependencies> = {}) {
  const loaders = createSyncLoaders(dependencies);
  const attention = createSyncAttentionController();
  const check = createStartupCheck(loaders, attention);
  let sessionAbort = new AbortController();
  let shutdownAbort: AbortController | undefined;
  let initialization = Promise.resolve<AnySyncConfig | false | undefined>(undefined);

  pi.registerCommand("sync", {
    description: "Sync Pi settings through Git, WebDAV, R2, or S3-compatible storage",
    getArgumentCompletions: completeSyncArguments,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("/sync requires TUI or RPC mode so results and safety prompts are observable.");
      }
      const signal = sessionAbort.signal;
      const ready = await initialization;
      if (signal.aborted) return;
      await check.stop();
      if (signal.aborted) return;
      const command = splitArgs(args)[0];
      if (ready === false && command !== "help" && command !== "unlock" && command !== "migrate-state") {
        ctx.ui.notify(
          "pi-sync recovery required. Repair the startup error, then /reload before syncing. Use /sync help for recovery guidance.",
          "error",
        );
        return;
      }
      const run = () => handleCommand(args, ctx, signal, loaders, attention);
      // Drain background cache/child cleanup before entering any foreground guard.
      // Help must remain reachable when the state roots themselves need repair.
      if (command === "migrate-state" || command === "help") await run();
      else await withStateDirectoryAccess(run);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    shutdownAbort?.abort(new DOMException("Session replaced", "AbortError"));
    shutdownAbort = undefined;
    sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
    sessionAbort = new AbortController();
    const signal = sessionAbort.signal;
    attention.reset(ctx);
    const previous = initialization;
    initialization = (async () => {
      await previous;
      if (signal.aborted) return false;
      await check.stop();
      if (signal.aborted) return false;
      try {
        const config = await withStateDirectoryAccess(() => startSession(ctx, signal));
        return signal.aborted ? false : config;
      } catch (error) {
        if (!signal.aborted && ctx.hasUI) {
          ctx.ui.notify(`pi-sync recovery required: ${safeTerminalText(errorMessage(error))}`, "error");
        }
        return false;
      }
    })();
    const ready = await initialization;
    if (ready && !signal.aborted) check.start(ctx, signal, ready);
  });

  pi.on("session_shutdown", async (event, ctx) => {
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
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export type { SyncDependencies } from "./sync/sync-loaders.js";
