import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import type { SyncAttentionController } from "../ui/sync-attention.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { combineSignals, throwIfAborted } from "./signals.js";
import { errorMessage } from "./sync-errors.js";
import type { SyncLoaders } from "./sync-loaders.js";

const STATUS_KEY = "sync";

/** One owned task per extension session, never keyed by the shared headless UI. */
export function createStartupCheck(loaders: SyncLoaders, attention: SyncAttentionController, timeoutMs = 30_000) {
  let active:
    | {
        controller: AbortController;
        promise: Promise<void>;
        owner: ExtensionContext["sessionManager"];
      }
    | undefined;

  return {
    start(ctx: ExtensionContext, sessionSignal: AbortSignal, initialConfig?: AnySyncConfig) {
      if (!ctx.hasUI || sessionSignal.aborted) return;
      if (active) throw new Error("Previous startup check has not been drained.");
      const controller = new AbortController();
      const signal = combineSignals(sessionSignal, controller.signal);
      const task = { controller, owner: ctx.sessionManager, promise: Promise.resolve() };
      active = task;
      const isCurrent = () => !sessionSignal.aborted && active === task && task.owner === ctx.sessionManager;
      const timer = setTimeout(
        () => controller.abort(new DOMException("Startup check timed out", "TimeoutError")),
        timeoutMs,
      );
      let config: AnySyncConfig | undefined;
      let checking = false;
      // Handle every detached rejection here; Pi's awaited event runner cannot catch it.
      task.promise = Promise.resolve()
        .then(async () => {
          try {
            throwIfAborted(signal);
            config = initialConfig ?? (await loadConfigForCheck());
            throwIfAborted(signal);
            if (!config.automatic) return;
            const captured = config;
            const identity = syncCheckConfigFingerprint(captured);
            checking = true;
            ctx.ui.setStatus(STATUS_KEY, "checking in background");
            const { inspectSync } = await loaders.inspection();
            throwIfAborted(signal);
            const currentConfig = await loadConfigForCheck();
            throwIfAborted(signal);
            if (syncCheckConfigFingerprint(currentConfig) !== identity) return;
            // Lock order: state migration guard → sync operation → backend cache.
            // Read heads may write only private cache data. Never call doctor/syncBoth.
            const inspection = await withStateDirectoryAccess(() => {
              throwIfAborted(signal);
              return withLock("startup-check", () => {
                throwIfAborted(signal);
                return inspectSync(captured, snapshotOptionsForContext(ctx, captured), signal);
              });
            });
            throwIfAborted(signal);
            const latest = await loadConfigForCheck();
            throwIfAborted(signal);
            if (syncCheckConfigFingerprint(latest) !== identity) return;
            const state = await withStateDirectoryAccess(() => readStateForConfig(latest));
            throwIfAborted(signal);
            if (syncStateFingerprint(state) !== inspection.stateIdentity || !isCurrent()) return;
            attention.observe({
              setupName: captured.setupName,
              configIdentity: identity,
              checkedAt: new Date().toISOString(),
              inspection,
            });
            if (ctx.mode === "rpc") attention.notifyObservation(ctx);
          } catch (error) {
            if (!isCurrent() || sessionSignal.aborted || isMissingConfigError(error)) return;
            if (signal.aborted && controller.signal.reason?.name !== "TimeoutError") return;
            // A settings edit invalidates failures as well as successful observations.
            if (config) {
              const latest = await loadConfigForCheck().catch(() => undefined);
              if (!isCurrent() || (signal.aborted && controller.signal.reason?.name !== "TimeoutError")) return;
              if (!latest || syncCheckConfigFingerprint(latest) !== syncCheckConfigFingerprint(config)) return;
            }
            ctx.ui.notify(
              `pi-sync startup check skipped: ${safeTerminalText(errorMessage(error))}. Run /sync status to retry. No startup transfer was performed.`,
              "warning",
            );
          } finally {
            clearTimeout(timer);
            if (isCurrent() && checking) await attention.publish(ctx, sessionSignal);
            if (active === task) active = undefined;
          }
        })
        .catch(() => {
          // UI teardown can itself throw. No unhandled rejection or retained timer.
          clearTimeout(timer);
          if (active === task) active = undefined;
        });
    },
    async stop() {
      const task = active;
      if (!task) return;
      task.controller.abort(new DOMException("Startup check cancelled", "AbortError"));
      // Drain the actual work, including child/ref cleanup, before foreground guards.
      await task.promise;
    },
  };
}
