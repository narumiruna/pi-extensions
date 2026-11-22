import { performance } from "node:perf_hooks";
import type { EngineContext as ExtensionContext } from "../host.js";

const startupStages = [
  "daemon initialization",
  "transaction recovery",
  "settings read",
  "config resolution",
  "inspection import",
  "inspection and guards",
  "backend initialization",
  "local snapshot",
  "sync state read",
  "remote head",
  "operations import",
  "automatic transfer",
  "transfer authorization",
  "transfer backend initialization",
  "transfer journal read",
  "transfer journal recovery",
  "transfer state read",
  "transfer local snapshot",
  "transfer remote head",
  "transfer snapshot download",
  "transfer unchanged verification",
  "transfer merge planning",
  "transfer settings merge",
  "transfer content merge",
  "transfer preflight",
  "transfer backup",
  "transfer journal write",
  "transfer remote publication",
  "transfer local apply",
  "transfer baseline write",
  "transfer cleanup",
] as const;
const startupScopes = [
  "local initialization",
  "background startup",
  "continuous startup",
  "daemon inspection",
  "daemon transfer",
] as const;
const outcomes = ["completed", "stopped"] as const;
const unchangedLine = "transfer result: unchanged (fast path)";
const end = "(?![\\s\\S])";
const duration = "(?:0|[1-9][0-9]{0,15})\\.[0-9] ms";
const headingPattern = new RegExp(
  `^pi-sync debug: (?:${startupScopes.join("|")}) \\((?:${outcomes.join("|")})\\)${end}`,
  "u",
);
const stagePattern = new RegExp(
  `^(${startupStages.join("|")}): ${duration}(?: \\((?:[2-9]|[1-9][0-9]{1,15}) calls\\))?(?: \\(interrupted\\))?${end}`,
  "u",
);
const totalPattern = new RegExp(`^total: ${duration}${end}`, "u");

type StartupStage = (typeof startupStages)[number];
type StartupScope = (typeof startupScopes)[number];
type StartupOutcome = (typeof outcomes)[number];

export function isStartupTimingReport(value: string): boolean {
  if (value.length > 4096) return false;
  const lines = value.split("\n");
  if (!headingPattern.test(lines.shift() ?? "") || !totalPattern.test(lines.pop() ?? "")) return false;
  if (lines.at(-1) === unchangedLine) lines.pop();
  const seen = new Set<string>();
  for (const line of lines) {
    const stage = stagePattern.exec(line)?.[1];
    if (!stage || seen.has(stage)) return false;
    seen.add(stage);
  }
  return true;
}

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
    wasUnchanged: () => unchanged,
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
      scope: StartupScope,
      outcome: StartupOutcome = "completed",
      observe?: (report: string) => void,
    ) {
      const display = enabled && ctx.hasUI && !sessionSignal.aborted;
      if (!display && !observe) return;
      const report = [
        `pi-sync debug: ${scope} (${outcome})`,
        ...Array.from(
          stages,
          ([stage, value]) =>
            `${stage}: ${value.ms.toFixed(1)} ms${value.calls > 1 ? ` (${value.calls} calls)` : ""}${value.interrupted ? " (interrupted)" : ""}`,
        ),
        ...(unchanged ? [unchangedLine] : []),
        `total: ${(performance.now() - started).toFixed(1)} ms`,
      ].join("\n");
      try {
        observe?.(report);
      } catch {}
      try {
        if (display) publishReport(ctx, report);
      } catch {
        // Diagnostics must not change sync behavior if the UI is unavailable during teardown.
      }
    },
  };
}

export type StartupTimings = ReturnType<typeof createStartupTimings>;
