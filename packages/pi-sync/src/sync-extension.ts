import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSyncArguments, splitArgs } from "./commands/command.js";
import {
  bindPiDaemonClient,
  installPiDaemonHost,
  type PiDaemonClient,
  withPiDaemonClient,
} from "./daemon/pi-client.js";
import type { AnySyncConfig } from "./settings/settings-types.js";
import { startupTransferEnabled } from "./sync/agent-policy.js";
import { autoPushSessions, startSession } from "./sync/automatic-sync.js";
import { combineSignals } from "./sync/signals.js";
import { createStartupCheck } from "./sync/startup-check.js";
import { errorMessage } from "./sync/sync-errors.js";
import { createSyncLoaders, type SyncDependencies } from "./sync/sync-loaders.js";
import { registerStartupTimings } from "./ui/startup-timings-entry.js";
import { createSyncAttentionController } from "./ui/sync-attention.js";
import { createSyncStatusPublisher } from "./ui/sync-status.js";
import { safeTerminalText } from "./ui/terminal-text.js";

export default function sync(pi: ExtensionAPI, dependencies: Partial<SyncDependencies> = {}) {
  installPiDaemonHost();
  const loaders = createSyncLoaders(dependencies);
  const attention = createSyncAttentionController();
  const status = createSyncStatusPublisher(pi.events);
  const publishTimings = registerStartupTimings(pi);
  const check = createStartupCheck(loaders, attention, 30_000, publishTimings);
  let sessionAbort = new AbortController();
  let shutdownAbort: AbortController | undefined;
  let initialization = Promise.resolve<AnySyncConfig | false | undefined>(undefined);
  let owner: PiDaemonClient | undefined;
  let ownerManager: ExtensionContext["sessionManager"] | undefined;

  pi.registerCommand("sync", {
    description: "Sync Pi settings through Git, WebDAV, R2, or S3-compatible storage",
    getArgumentCompletions: completeSyncArguments,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/sync requires TUI or RPC mode so results and safety prompts are observable.");
      status.bind(ctx);
      const signal = sessionAbort.signal;
      const client = owner;
      if (!client || ownerManager !== ctx.sessionManager) {
        if (splitArgs(args)[0] !== "help") throw new Error("pi-sync session is not ready.");
        const commands = await loaders.commands();
        if (signal.aborted || owner) return;
        ctx.isIdle();
        await commands.handleCommand(args, ctx, signal, loaders, attention);
        return;
      }
      const reload = new AbortController();
      const commandSignal = combineSignals(signal, reload.signal);
      try {
        await withPiDaemonClient(
          ctx,
          async (ctx) => {
            const command = splitArgs(args)[0];
            const ready = await initialization;
            if (signal.aborted || owner !== client) return;
            const requiresContact = !["help", "unlock", "migrate-state"].includes(command ?? "");
            let busyPublished = false;
            try {
              await client.setBusy("command", true, requiresContact);
              busyPublished = requiresContact;
              if (signal.aborted || owner !== client) return;
              await check.stop();
              if (signal.aborted || owner !== client) return;
              if (
                ready === false &&
                command !== "help" &&
                command !== "unlock" &&
                command !== "migrate-state" &&
                command !== "daemon"
              ) {
                ctx.ui.notify(
                  "pi-sync recovery required. Repair the startup error, then /reload before syncing. Use /sync help for recovery guidance.",
                  "error",
                );
                return;
              }
              if (command === "unlock" || command === "migrate-state") {
                const { stateDirectoryMigrationNotice } = await import("./state/state-directory.js");
                if (signal.aborted || owner !== client) return;
                // Recovery cannot guess an authoritative root when roots coexist or are unsafe.
                stateDirectoryMigrationNotice();
              }
              const commands = await loaders.commands();
              if (signal.aborted || owner !== client) return;
              await commands.handleCommand(args, ctx, commandSignal, loaders, attention);
            } catch (error) {
              if (!commandSignal.aborted && owner === client) {
                ctx.ui.notify(`pi-sync command unavailable: ${safeTerminalText(errorMessage(error))}`, "error");
                if (command === "unlock" || command === "migrate-state") throw error;
              }
            } finally {
              if (!signal.aborted && owner === client) {
                // Recovery can publish busy facts after bypassing the initial contact check.
                const publish = busyPublished || command === "unlock" || command === "migrate-state";
                // Release local busy state even if contact failed; do not mask the command result.
                await client.setBusy("command", false, publish).catch(() => {});
              }
            }
          },
          reload,
        );
        // Pi reload awaits our shutdown hook. Neither daemon work nor old UI may await reload.
        if (!signal.aborted && owner === client && client.canReload(reload)) await ctx.reload();
      } finally {
        client.releaseReload(reload);
        reload.abort();
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const releaseStatus = status.start(ctx);
    const previousClient = owner;
    shutdownAbort?.abort(new DOMException("Session replaced", "AbortError"));
    shutdownAbort = undefined;
    sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
    sessionAbort = new AbortController();
    const signal = sessionAbort.signal;
    const client = bindPiDaemonClient(ctx, signal, publishTimings);
    owner = client;
    ownerManager = ctx.sessionManager;
    const replacementFile = ctx.sessionManager.getSessionFile?.();
    attention.reset(ctx);
    const previous = initialization;
    initialization = withPiDaemonClient(ctx, async () => {
      await previous.catch(() => {});
      if (signal.aborted || owner !== client) return false;
      try {
        await check.stop();
        if (previousClient) {
          // Protect the replacement session before removing old session protection.
          try {
            await client.attachExisting({ allowUpgrade: true });
          } catch {
            /* Initialization below reports an unavailable owner. */
          }
          try {
            await previousClient.disposeForShutdown("resume", replacementFile);
          } catch {
            /* Plain, detached recovery owns uncertain grants; no closed ctx is retained. */
          }
          await client.finishReattachment();
        }
        if (signal.aborted || owner !== client) return false;
        return (await startSession(ctx, signal, publishTimings))?.config;
      } catch (error) {
        if (!signal.aborted && owner === client) {
          try {
            client.validate();
            if (ctx.hasUI)
              ctx.ui.notify(`pi-sync recovery required: ${safeTerminalText(errorMessage(error))}`, "error");
          } catch {
            /* SDK context was replaced. */
          }
        }
        return false;
      }
    });
    try {
      const ready = await initialization;
      if (ready === false) releaseStatus();
      if (
        ready &&
        !signal.aborted &&
        owner === client &&
        !(ready.continuous && ready.agentMode) &&
        (ready.automatic || startupTransferEnabled(ready))
      )
        await withPiDaemonClient(ctx, async () => {
          check.start(ctx, signal, ready);
        });
    } catch (error) {
      releaseStatus();
      throw error;
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    const client = owner;
    if (!client || ownerManager !== ctx.sessionManager || sessionAbort.signal.aborted) return;
    if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) await client.attachExisting();
    await client.setBusy("agent", true);
    if (owner === client && !sessionAbort.signal.aborted) await check.interrupt(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const client = owner;
    if (!client || ownerManager !== ctx.sessionManager || sessionAbort.signal.aborted) return;
    await client.setBusy("agent", false);
    if (owner === client && !sessionAbort.signal.aborted)
      await withPiDaemonClient(ctx, async () => {
        check.settled(ctx);
      });
  });
  pi.on("model_select", async (_event, ctx) => {
    if (owner && ownerManager === ctx.sessionManager && !sessionAbort.signal.aborted) await owner.update();
  });
  const pauseForReplacement = async (_event: unknown, ctx: ExtensionContext) => {
    const client = owner;
    if (!client || ownerManager !== ctx.sessionManager || sessionAbort.signal.aborted) return;
    const results = await Promise.allSettled([client.pauseForSessionChange(), check.stop()]);
    if (results.some((result) => result.status === "rejected")) {
      if (owner === client && !sessionAbort.signal.aborted)
        ctx.ui.notify(
          "pi-sync could not drain its writer. Repair or stop the existing daemon before changing sessions.",
          "error",
        );
      return { cancel: true };
    }
    // Another handler can still cancel the SDK transition. Stay paused until
    // /reload instead of guessing that it is safe to resume while handlers run.
  };
  pi.on("session_before_switch", pauseForReplacement);
  pi.on("session_before_fork", pauseForReplacement);
  pi.on("session_shutdown", async (event, ctx) => {
    const releaseStatus = status.cleanupFor(ctx);
    const client = owner;
    if (!client || ownerManager !== ctx.sessionManager) {
      releaseStatus();
      return;
    }
    const controller = new AbortController();
    shutdownAbort?.abort(new DOMException("Session shut down again", "AbortError"));
    shutdownAbort = controller;
    const signal = combineSignals(controller.signal, AbortSignal.timeout(30_000));
    const reason = typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
    const target =
      typeof event === "object" && event ? (event as { targetSessionFile?: string }).targetSessionFile : undefined;
    // Cancel old dialogs/settings work now, while the SDK context is still active.
    sessionAbort.abort(new DOMException("Session shutting down", "AbortError"));
    let shutdownClient: PiDaemonClient | undefined;
    try {
      await initialization.catch(() => {});
      await check.stop();
      if (signal.aborted || owner !== client) return;
      if (reason !== "reload") {
        shutdownClient = bindPiDaemonClient(ctx, signal, publishTimings);
        await shutdownClient.setBusy("shutdown", true);
        const attached = await shutdownClient.attachExisting();
        if (!signal.aborted && owner === client && attached)
          await withPiDaemonClient(ctx, () => autoPushSessions(ctx, signal, loaders));
      }
    } catch (error) {
      if (!signal.aborted && owner === client) {
        try {
          ctx.ui.notify(`pi-sync shutdown skipped: ${safeTerminalText(errorMessage(error))}`, "warning");
        } catch {
          /* SDK context was replaced. */
        }
      }
    } finally {
      if (owner === client) {
        owner = undefined;
        ownerManager = undefined;
        try {
          attention.reset(ctx);
        } catch {
          /* Cleanup never depends on an active SDK context. */
        }
      }
      try {
        await client.disposeForShutdown(reason, target);
      } finally {
        try {
          await shutdownClient?.disposeForShutdown(reason, target);
        } finally {
          controller.abort();
          releaseStatus();
        }
      }
      if (shutdownAbort === controller) shutdownAbort = undefined;
    }
  });
}
export type { SyncDependencies } from "./sync/sync-loaders.js";
