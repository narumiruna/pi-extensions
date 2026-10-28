import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { readStateForConfig } from "../state/sync-state-store.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { withAgentSyncLock } from "./agent-sync.js";
import { ContinuousError, continuousFailure } from "./continuous-errors.js";
import { acquireContinuousLease, type ContinuousLease } from "./continuous-lease.js";
import {
  normalizeContinuousClock,
  readContinuousRecord,
  reserveContinuousRequest,
  updateContinuousRecord,
} from "./continuous-record.js";
import { continuousBinding, hashContinuous } from "./continuous-storage.js";
import { watchContinuous } from "./continuous-watch.js";
import { readMergeJournal } from "./merge-journal.js";
import type { SyncLoaders } from "./sync-loaders.js";
import { captureMutationOwner } from "./sync-local.js";
import { fileHashMap } from "./sync-state.js";

export function continuousEnabled(config: Pick<AnySyncConfig, "continuous" | "agentMode">) {
  return Boolean(config.continuous && config.agentMode);
}
export interface ContinuousClock {
  now(): number;
  random(): number;
  schedule(ms: number, run: () => void, kind?: "wait" | "authorization"): () => void;
}
const systemClock: ContinuousClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
const LOCAL_CHECK_MS = 5_000;
const POLL_MS = 60_000;
const DEBOUNCE_MS = 1_000;

/** Created on first enabled session. No module/factory-owned timers or watchers. */
export function createContinuousSync(loaders: SyncLoaders, clock: ContinuousClock = systemClock) {
  const repairNotices = new WeakSet<ExtensionContext["sessionManager"]>();
  let task:
    | { owner: ExtensionContext["sessionManager"]; controller: AbortController; promise: Promise<void>; clear(): void }
    | undefined;
  return {
    start(ctx: ExtensionContext, sessionSignal: AbortSignal, explicitRetry = false) {
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc") || sessionSignal.aborted || task) return;
      const controller = new AbortController();
      const signal = AbortSignal.any([sessionSignal, controller.signal]);
      const validateContext = captureMutationOwner(ctx);
      const current = {
        owner: ctx.sessionManager,
        controller,
        promise: Promise.resolve(),
        clear: () => {
          try {
            validateContext();
            setSyncStatus(ctx, undefined);
          } catch {
            /* replaced session */
          }
        },
      };
      task = current;
      current.promise = (async () => {
        let explicit = explicitRetry;
        while (!signal.aborted) {
          try {
            await run(ctx, signal, explicit);
            return;
          } catch {
            if (signal.aborted) return;
            try {
              validateContext();
              setSyncStatus(ctx, "sync blocked: private state or settings need repair");
              if (!repairNotices.has(ctx.sessionManager)) {
                repairNotices.add(ctx.sessionManager);
                ctx.ui.notify(
                  "Continuous sync blocked: private state or settings need repair. Use /sync. Evidence was retained.",
                  "warning",
                );
              }
            } catch {
              return;
            }
          }
          explicit = false;
          // Only local prerequisites are retried here. No remote/model request can
          // pass a malformed settings/state read. A repair can resume monitoring.
          await wait(clock, LOCAL_CHECK_MS, signal);
        }
      })()
        .catch(() => {
          /* Cancellation/UI disposal must not leak a detached rejection. */
        })
        .finally(() => {
          if (task === current) task = undefined;
        });
    },
    async stop(owner?: ExtensionContext["sessionManager"]) {
      const current = task;
      if (!current || (owner && current.owner !== owner)) return;
      current.controller.abort(new DOMException("Continuous sync interrupted", "AbortError"));
      current.clear();
      await current.promise;
    },
  };

  async function run(ctx: ExtensionContext, signal: AbortSignal, explicitRetry: boolean) {
    const validateOwner = captureMutationOwner(ctx, signal);
    try {
      while (!signal.aborted) {
        validateOwner();
        const config = await loadConfigForCheck();
        validateOwner();
        if (!continuousEnabled(config)) return;
        try {
          if (ctx.isIdle()) {
            let lease: ContinuousLease | undefined;
            let binding = "";
            try {
              await withStateDirectoryAccess(async () => {
                validateOwner();
                binding = await continuousBinding(config);
                validateOwner();
                lease = await acquireContinuousLease(binding);
                validateOwner();
              });
              if (lease) {
                await monitor(ctx, config, binding, lease, signal, explicitRetry);
                explicitRetry = false;
              } else setSyncStatus(ctx, "sync waiting: another local owner");
            } finally {
              await lease?.release();
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          const failure = continuousFailure(error);
          if (!failure.retry && !(error instanceof Error && error.name === "AbortError")) throw error;
          setSyncStatus(ctx, `sync retry scheduled: ${failure.kind}`);
        }
        validateOwner();
        if (!continuousEnabled(await loadConfigForCheck())) return;
        validateOwner();
        await wait(clock, LOCAL_CHECK_MS, signal);
      }
    } finally {
      // Shutdown/replacement owns clearing the old UI; do not call it from a stale continuation.
      if (!signal.aborted) {
        try {
          validateOwner();
          setSyncStatus(ctx, undefined);
        } catch {
          /* stale context */
        }
      }
    }
  }

  async function monitor(
    ctx: ExtensionContext,
    initial: AnySyncConfig,
    binding: string,
    lease: ContinuousLease,
    parent: AbortSignal,
    explicitRetry: boolean,
  ) {
    const signal = AbortSignal.any([parent, lease.signal]);
    const validateOwner = captureMutationOwner(ctx, signal);
    let config = initial;
    let closeWatch = () => {};
    let wake = () => {};
    let dirtyAt: number | undefined;
    let cycle: AbortController | undefined;
    const changed = (settings: boolean) => {
      dirtyAt = clock.now();
      if (settings) cycle?.abort(new DOMException("Continuous settings changed", "AbortError"));
      wake();
    };
    const validate = () => {
      validateOwner();
      lease.assert();
      if (!ctx.isIdle()) throw new DOMException("Owning session became busy", "AbortError");
    };
    const stopWatch = () => {
      closeWatch();
      wake();
    };
    signal.addEventListener("abort", stopWatch, { once: true });
    let pollDue = 0;
    try {
      closeWatch = await watchContinuous(config, changed);
      validate();
      while (!signal.aborted && ctx.isIdle()) {
        validate();
        const latest = await loadConfigForCheck();
        validate();
        if (!continuousEnabled(latest) || (await continuousBinding(latest)) !== binding) return;
        validate();
        if (syncCheckConfigFingerprint(latest) !== syncCheckConfigFingerprint(config)) {
          closeWatch();
          config = latest;
          closeWatch = await watchContinuous(config, changed);
          validate();
          pollDue = 0;
        }
        const record = await readContinuousRecord(binding);
        validate();
        const now = clock.now();
        const oldClock = JSON.stringify([record.next, record.calls]);
        normalizeContinuousClock(record, now);
        if (oldClock !== JSON.stringify([record.next, record.calls])) {
          await updateContinuousRecord(binding, lease, (current) => normalizeContinuousClock(current, now));
          validate();
        }
        const configuration = hashContinuous([{ ...config, showStatus: undefined, debug: undefined }, ctx.model]);
        const controlChanged = record.configuration !== configuration;
        if (controlChanged || explicitRetry) {
          record.next = 0;
          pollDue = 0;
        }
        const hintDue = dirtyAt === undefined ? Number.POSITIVE_INFINITY : dirtyAt + DEBOUNCE_MS;
        const due = Math.max(record.error === "budget" ? 0 : record.next, Math.min(pollDue, hintDue));
        if (now >= due) {
          const force = explicitRetry || controlChanged;
          explicitRetry = false;
          const expectedModel = hashContinuous(ctx.model);
          const expectedConfig = syncCheckConfigFingerprint(config);
          dirtyAt = undefined;
          cycle = new AbortController();
          const cancelDeadline = clock.schedule(30_000, () =>
            cycle?.abort(new DOMException("Continuous cycle timed out", "TimeoutError")),
          );
          const guard = new AbortController();
          const guardSignal = AbortSignal.any([signal, cycle.signal, guard.signal]);
          const activeCycle = cycle;
          // Transfer entrypoints supply each fresh settings read. Never let a new
          // transfer adopt authorization that changed after this cycle's inspection.
          const validateCycle = (latest?: AnySyncConfig) => {
            validate();
            if (
              (latest && syncCheckConfigFingerprint(latest) !== expectedConfig) ||
              hashContinuous(ctx.model) !== expectedModel
            )
              activeCycle.abort(new DOMException("Continuous authorization changed", "AbortError"));
            activeCycle.signal.throwIfAborted();
          };
          const guardTask = (async () => {
            while (!guardSignal.aborted) {
              await wait(clock, LOCAL_CHECK_MS, guardSignal, undefined, "authorization");
              if (guardSignal.aborted) return;
              try {
                validate();
                const latest = await loadConfigForCheck();
                if (guardSignal.aborted) return;
                validateCycle(latest);
              } catch {
                activeCycle.abort(new DOMException("Continuous authorization unavailable", "AbortError"));
              }
            }
          })().catch(() => {});
          try {
            await performCycle(
              ctx,
              config,
              binding,
              lease,
              AbortSignal.any([signal, cycle.signal]),
              validateCycle,
              configuration,
              force,
            );
          } catch (error) {
            if (signal.aborted || !ctx.isIdle()) return;
            // A settings hint interrupts the old authorization; load it afresh, not as a failed transfer.
            if (cycle.signal.aborted && cycle.signal.reason?.name !== "TimeoutError") {
              pollDue = 0;
              continue;
            }
            const failure = continuousFailure(error);
            let announce = false;
            await updateContinuousRecord(binding, lease, (current) => {
              const now = clock.now();
              normalizeContinuousClock(current, now);
              const notice = hashContinuous([failure.kind, current.evidence, configuration]);
              announce = current.notice !== notice;
              if (!failure.retry) current.notice = notice;
              current.configuration = configuration;
              current.pending = true;
              current.error = failure.kind;
              current.phase = failure.retry ? "retry" : "blocked";
              current.failures = Math.min(30, current.failures + 1);
              const base = Math.min(300_000, 5_000 * 2 ** Math.min(6, current.failures - 1));
              const delay = Math.min(300_000, base + Math.floor(clock.random() * base * 0.2));
              current.next = now + Math.max(delay, failure.delay ?? 0);
            });
            validate();
            if (announce && !failure.retry)
              ctx.ui.notify(
                `Continuous sync blocked (${failure.kind}). Review /sync or repair the setup. Evidence was retained.`,
                "warning",
              );
          } finally {
            cancelDeadline();
            guard.abort();
            await guardTask;
            cycle = undefined;
          }
          pollDue = clock.now() + POLL_MS + Math.floor(clock.random() * 6_000);
          closeWatch();
          closeWatch = () => {};
          closeWatch = await watchContinuous(config, changed);
          validate();
        }
        validate();
        const state = await readContinuousRecord(binding);
        validate();
        setSyncStatus(
          ctx,
          state.phase === "blocked"
            ? `sync blocked: ${state.error}`
            : state.phase === "retry"
              ? `sync retry scheduled: ${state.error}`
              : "sync waiting for changes",
        );
        if (state.phase === "retry") pollDue = Math.min(pollDue, state.next);
        const next = Math.max(
          state.error === "budget" ? 0 : state.next,
          Math.min(pollDue, dirtyAt === undefined ? Number.POSITIVE_INFINITY : dirtyAt + DEBOUNCE_MS),
        );
        await wait(clock, Math.max(1, Math.min(LOCAL_CHECK_MS, next - clock.now())), signal, (callback) => {
          wake = callback;
        });
      }
    } finally {
      signal.removeEventListener("abort", stopWatch);
      closeWatch();
      cycle?.abort();
    }
  }

  async function performCycle(
    ctx: ExtensionContext,
    config: AnySyncConfig,
    binding: string,
    lease: ContinuousLease,
    signal: AbortSignal,
    validateOwner: (config?: AnySyncConfig) => void,
    configuration: string,
    force: boolean,
  ) {
    const validate = (latest?: AnySyncConfig) => {
      signal.throwIfAborted();
      validateOwner(latest);
    };
    validate();
    const current = await readContinuousRecord(binding);
    validate();
    // A newly pending journal may prove an uncertain commit. It is never authority to republish.
    const pending = await guardedLock("continuous-journal", () => readMergeJournal(config));
    validate();
    if (
      !force &&
      !pending &&
      current.phase === "blocked" &&
      ["authentication", "storage", "unknown"].includes(current.error ?? "")
    )
      return;
    setSyncStatus(ctx, "sync checking");
    const inspectionModule = await loaders.inspection();
    validate();
    const observed = await guardedLock("continuous-check", async () => {
      validate();
      const inspection = await inspectionModule.inspectSync(config, snapshotOptionsForContext(ctx, config), signal);
      validate();
      let localIdentity = inspection.localIdentity;
      if (!localIdentity) {
        const snapshotModule = await loaders.snapshot();
        validate();
        const local = await snapshotModule.createSnapshot(config.snapshotIdentity, {
          ...snapshotOptionsForContext(ctx, config),
          signal,
        });
        validate();
        localIdentity = hashContinuous(fileHashMap(local));
      }
      const journal = await readMergeJournal(config);
      validate();
      return { inspection, journal, localIdentity };
    });
    validate();
    const evidence = hashContinuous([
      configuration,
      observed.localIdentity,
      observed.inspection.head?.revision,
      observed.inspection.stateIdentity,
    ]);
    const recovery = observed.journal ? hashContinuous([evidence, observed.journal]) : undefined;
    const blocked =
      !force &&
      current.evidence === evidence &&
      ((current.phase === "blocked" && (!recovery || recovery === current.recovery)) ||
        (current.error === "budget" && current.next > clock.now() && !observed.journal));
    await updateContinuousRecord(binding, lease, (record) => {
      if (record.configuration !== configuration) {
        record.failures = 0;
        record.next = 0;
      }
      record.configuration = configuration;
      record.checked = clock.now();
      record.evidence = evidence;
      if (!blocked) {
        if (record.phase !== "blocked") record.phase = "syncing";
        record.pending = true;
        if (recovery) record.recovery = recovery;
      }
    });
    validate();
    if (blocked) return;
    if (
      !observed.journal &&
      (observed.inspection.firstSync ||
        !observed.inspection.head ||
        observed.inspection.selectionState?.kind !== "same")
    )
      throw new ContinuousError("unsafe", "Continuous sync needs an accepted baseline and matching remote selection.");
    let transferred = false;
    if (observed.journal || observed.inspection.localChanged || observed.inspection.remoteChanged) {
      const operations = await loaders.operations();
      validate();
      setSyncStatus(ctx, "sync syncing");
      const result = await withStateDirectoryAccess(() =>
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
            background: {
              validate,
              reserve: (key, requestSignal) =>
                reserveContinuousRequest(binding, lease, key, () => clock.now(), requestSignal),
            },
          },
          (options) => operations.syncBoth(ctx, options),
        ),
      );
      validate();
      transferred = result === "applied";
    }
    const state = await guardedLock("continuous-result", () => readStateForConfig(config));
    validate();
    const unresolved = state.unresolved;
    let announcePartial = false;
    await updateContinuousRecord(binding, lease, (record) => {
      record.phase = unresolved?.length ? "blocked" : "waiting";
      record.pending = Boolean(unresolved?.length);
      record.failures = 0;
      record.next = 0;
      if (unresolved?.length) {
        record.error = "unsafe";
        const notice = hashContinuous(["partial", unresolved, configuration]);
        announcePartial = record.notice !== notice;
        record.notice = notice;
      } else {
        delete record.error;
        delete record.notice;
      }
      if (transferred) record.transferred = clock.now();
    });
    validate();
    if (announcePartial)
      ctx.ui.notify(
        "Continuous sync retained unresolved groups. Review /sync conflicts; independent partial progress was preserved.",
        "warning",
      );
  }
}

function guardedLock<T>(command: string, run: () => Promise<T>) {
  return withStateDirectoryAccess(() => withLock(command, run));
}

function wait(
  clock: ContinuousClock,
  ms: number,
  signal: AbortSignal,
  expose?: (wake: () => void) => void,
  kind: "wait" | "authorization" = "wait",
) {
  signal.throwIfAborted();
  return new Promise<void>((resolve) => {
    const done = () => {
      cancel();
      signal.removeEventListener("abort", done);
      expose?.(() => {});
      resolve();
    };
    const cancel = clock.schedule(ms, done, kind);
    signal.addEventListener("abort", done, { once: true });
    expose?.(done);
    if (signal.aborted) done();
  });
}
