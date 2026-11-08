import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import type { SyncAttentionController } from "../ui/sync-attention.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { startupTransferEnabled } from "./agent-policy.js";
import { combineSignals, throwIfAborted } from "./signals.js";
import { createStartupTimings, type StartupTimingPublisher } from "./startup-timings.js";
import { errorMessage } from "./sync-errors.js";
import type { SyncLoaders } from "./sync-loaders.js";

/** One owned task per extension session, never keyed by the shared headless UI. */
export function createStartupCheck(
  loaders: SyncLoaders,
  attention: SyncAttentionController,
  timeoutMs = 30_000,
  publish?: StartupTimingPublisher,
) {
  let active:
    | {
        controller: AbortController;
        promise: Promise<void>;
        owner: ExtensionContext["sessionManager"];
        transfer: boolean;
      }
    | undefined;

  let pending: { ctx: ExtensionContext; signal: AbortSignal; config: AnySyncConfig } | undefined;

  const controllerApi = {
    async interrupt(ctx: ExtensionContext) {
      const task = active;
      if (!task?.transfer || task.owner !== ctx.sessionManager) return;
      task.controller.abort(new DOMException("Agent became busy", "AbortError"));
      await task.promise;
    },
    settled(ctx: ExtensionContext) {
      const queued = pending;
      if (!queued || queued.ctx.sessionManager !== ctx.sessionManager || queued.signal.aborted || !ctx.isIdle()) return;
      pending = undefined;
      controllerApi.start(ctx, queued.signal, queued.config);
    },
    start(ctx: ExtensionContext, sessionSignal: AbortSignal, initialConfig?: AnySyncConfig) {
      if (!ctx.hasUI || sessionSignal.aborted) return;
      if (initialConfig && startupTransferEnabled(initialConfig) && !ctx.isIdle()) {
        pending = { ctx, signal: sessionSignal, config: initialConfig };
        return;
      }
      if (active) throw new Error("Previous startup check has not been drained.");
      const timings = createStartupTimings(publish);
      const controller = new AbortController();
      const signal = combineSignals(sessionSignal, controller.signal);
      const task = {
        controller,
        owner: ctx.sessionManager,
        promise: Promise.resolve(),
        transfer: Boolean(initialConfig && startupTransferEnabled(initialConfig)),
      };
      active = task;
      const isCurrent = () => !sessionSignal.aborted && active === task && task.owner === ctx.sessionManager;
      const timer = setTimeout(
        () => controller.abort(new DOMException("Startup check timed out", "TimeoutError")),
        timeoutMs,
      );
      timer.unref();
      let config: AnySyncConfig | undefined;
      let checking = false;
      let stopped = false;
      // Handle every detached rejection here; Pi's awaited event runner cannot catch it.
      task.promise = Promise.resolve()
        .then(async () => {
          try {
            throwIfAborted(signal);
            config = initialConfig ?? (await loadConfigForCheck());
            task.transfer = startupTransferEnabled(config);
            throwIfAborted(signal);
            if (!config.automatic && !startupTransferEnabled(config)) return;
            const captured = config;
            const identity = syncCheckConfigFingerprint(captured);
            checking = true;
            setSyncStatus(ctx, "sync ...", { activity: "checking" });
            const { inspectSync } = await timings.measure("inspection import", () => loaders.inspection());
            throwIfAborted(signal);
            const currentConfig = await loadConfigForCheck();
            throwIfAborted(signal);
            if (syncCheckConfigFingerprint(currentConfig) !== identity) return;
            // Lock order: state migration guard → sync operation → backend cache.
            // Read heads may write only private cache data. Never call doctor/syncBoth.
            const inspection = await timings.measure("inspection and guards", () =>
              withStateDirectoryAccess(() => {
                throwIfAborted(signal);
                return withLock("startup-check", () => {
                  throwIfAborted(signal);
                  return inspectSync(captured, snapshotOptionsForContext(ctx, captured), signal, undefined, timings);
                });
              }),
            );
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
              automaticTransfer: startupTransferEnabled(captured),
            });
            if (
              startupTransferEnabled(captured) &&
              !inspection.firstSync &&
              inspection.head &&
              inspection.selectionState?.kind === "same"
            ) {
              const [operations, { withAgentSyncLock }] = await timings.measure("operations import", () =>
                Promise.all([loaders.operations(), import("./agent-sync.js")]),
              );
              throwIfAborted(signal);
              if (!isCurrent()) return;
              if (!ctx.isIdle()) {
                pending = { ctx, signal: sessionSignal, config: captured };
                return;
              }
              await timings.measure("automatic transfer", () =>
                withStateDirectoryAccess(() =>
                  withAgentSyncLock(
                    ctx,
                    {
                      args: [],
                      yes: true,
                      force: false,
                      stale: false,
                      silent: true,
                      reload: false,
                      auto: true,
                      signal,
                      startupTimings: timings,
                      onCommit: () => attention.clearObservation(),
                    },
                    (options) => operations.syncBoth(ctx, options),
                  ),
                ),
              );
              throwIfAborted(signal);
              if (!isCurrent()) return;
              attention.clearObservation();
              return;
            }
            attention.observe({
              setupName: captured.setupName,
              configIdentity: identity,
              checkedAt: new Date().toISOString(),
              inspection,
              automaticTransfer: startupTransferEnabled(captured),
            });
            if (ctx.mode === "rpc") attention.notifyObservation(ctx);
          } catch (error) {
            stopped = true;
            if (!isCurrent() || sessionSignal.aborted || isMissingConfigError(error)) return;
            if (signal.aborted && controller.signal.reason?.name !== "TimeoutError") return;
            // A settings edit invalidates failures as well as successful observations.
            if (config) {
              const latest = await loadConfigForCheck().catch(() => undefined);
              if (!isCurrent() || (signal.aborted && controller.signal.reason?.name !== "TimeoutError")) return;
              if (!latest || syncCheckConfigFingerprint(latest) !== syncCheckConfigFingerprint(config)) return;
            }
            ctx.ui.notify(
              config && startupTransferEnabled(config)
                ? `pi-sync automatic transfer stopped: ${safeTerminalText(errorMessage(error))}. Run /sync to review or reconcile retained recovery evidence. No resources were reloaded.`
                : `pi-sync startup check skipped: ${safeTerminalText(errorMessage(error))}. Run /sync status to retry. No startup transfer was performed.`,
              "warning",
            );
          } finally {
            clearTimeout(timer);
            if (isCurrent() && checking) {
              if (!signal.aborted || controller.signal.reason?.name === "TimeoutError") {
                const latest = await loadConfigForCheck().catch(() => undefined);
                if (isCurrent()) {
                  if (signal.aborted && controller.signal.reason?.name !== "TimeoutError")
                    setSyncStatus(ctx, undefined);
                  else if (
                    config &&
                    latest &&
                    syncCheckConfigFingerprint(latest) === syncCheckConfigFingerprint(config)
                  )
                    await attention.publish(ctx, sessionSignal);
                  else attention.reset(ctx);
                }
              } else setSyncStatus(ctx, undefined);
            }
            if (isCurrent()) {
              timings.publish(
                ctx,
                config?.debug ?? false,
                sessionSignal,
                "background startup",
                signal.aborted || stopped ? "stopped" : "completed",
              );
            }
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
      pending = undefined;
      const task = active;
      if (!task) return;
      task.controller.abort(new DOMException("Startup check cancelled", "AbortError"));
      // Drain the actual work, including child/ref cleanup, before foreground guards.
      await task.promise;
    },
  };
  return controllerApi;
}
