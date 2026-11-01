import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type StartupStage =
  | "transaction recovery"
  | "settings read"
  | "config resolution"
  | "inspection import"
  | "inspection and guards"
  | "backend initialization"
  | "local snapshot"
  | "sync state read"
  | "remote head"
  | "operations import"
  | "automatic transfer"
  | "transfer authorization"
  | "transfer backend initialization"
  | "transfer journal read"
  | "transfer journal recovery"
  | "transfer state read"
  | "transfer local snapshot"
  | "transfer remote head"
  | "transfer snapshot download"
  | "transfer unchanged verification"
  | "transfer merge planning"
  | "transfer settings merge"
  | "transfer content merge"
  | "transfer preflight"
  | "transfer backup"
  | "transfer journal write"
  | "transfer remote publication"
  | "transfer local apply"
  | "transfer baseline write"
  | "transfer cleanup";

export type StartupTimingPublisher = (ctx: ExtensionContext, report: string) => void;

/** Fixed labels and durations only: never retain errors, paths, settings, or payloads. */
export function createStartupTimings(
  publishReport: StartupTimingPublisher = (ctx, report) => ctx.ui.notify(report, "info"),
) {
  const started = performance.now();
  const stages = new Map<StartupStage, { ms: number; calls: number; interrupted: boolean }>();
  let unchanged = false;
  return {
    markUnchanged() {
      unchanged = true;
    },
    async measure<T>(stage: StartupStage, run: () => T | Promise<T>): Promise<T> {
      const start = performance.now();
      let completed = false;
      try {
        const result = await run();
        completed = true;
        return result;
      } finally {
        const previous = stages.get(stage);
        stages.set(stage, {
          ms: (previous?.ms ?? 0) + performance.now() - start,
          calls: (previous?.calls ?? 0) + 1,
          interrupted: Boolean(previous?.interrupted || !completed),
        });
      }
    },
    publish(
      ctx: ExtensionContext,
      enabled: boolean,
      sessionSignal: AbortSignal,
      scope: "local initialization" | "background startup" | "continuous startup",
      outcome: "completed" | "stopped" = "completed",
    ) {
      if (!enabled || !ctx.hasUI || sessionSignal.aborted) return;
      try {
        publishReport(
          ctx,
          [
            `pi-sync debug: ${scope} (${outcome})`,
            ...Array.from(
              stages,
              ([stage, value]) =>
                `${stage}: ${value.ms.toFixed(1)} ms${value.calls > 1 ? ` (${value.calls} calls)` : ""}${value.interrupted ? " (interrupted)" : ""}`,
            ),
            ...(unchanged ? ["transfer result: unchanged (fast path)"] : []),
            `total: ${(performance.now() - started).toFixed(1)} ms`,
          ].join("\n"),
        );
      } catch {
        // Diagnostics must not change sync behavior if the UI is unavailable during teardown.
      }
    },
  };
}

export type StartupTimings = ReturnType<typeof createStartupTimings>;
