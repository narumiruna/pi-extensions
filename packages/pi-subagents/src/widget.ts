import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./message-broker.js";
import type { ActiveJobDisplay, SubagentRuntime } from "./runtime.js";

export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_WIDGET_REFRESH_INTERVAL_MS = 1_000;

const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;

export interface SubagentWidgetController {
  start(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): void;
}

export function createSubagentWidgetController(runtime: SubagentRuntime): SubagentWidgetController {
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeJobs: (() => void) | undefined;
  let publishedValue: string | undefined;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const stop = (): void => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unsubscribeJobs?.();
    unsubscribeJobs = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ownsSession(ctx)) return;
    const jobs = runtime.activeJobsForDisplay();
    const value = widgetValue(jobs);
    if (value === publishedValue) return;
    if (jobs.length === 0) {
      ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
    } else {
      const snapshot = jobs.map(cloneDisplayJob);
      ctx.ui.setWidget(
        SUBAGENT_WIDGET_KEY,
        (_tui, theme) => ({
          render: (width) => renderSubagentWidget(snapshot, theme, width),
          invalidate: () => {},
        }),
        WIDGET_OPTIONS,
      );
    }
    publishedValue = value;
  };

  return {
    start(ctx) {
      stop();
      activeSession = ctx.sessionManager;
      publishedValue = undefined;
      if (ctx.mode !== "tui") return;
      ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
      unsubscribeJobs = runtime.subscribeJobs(() => publish(ctx));
      refreshTimer = setInterval(() => publish(ctx), SUBAGENT_WIDGET_REFRESH_INTERVAL_MS);
      refreshTimer.unref();
      publish(ctx);
    },
    shutdown(ctx) {
      if (!ownsSession(ctx)) return;
      stop();
      if (ctx.mode === "tui") ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
      publishedValue = undefined;
      activeSession = undefined;
    },
  };
}

export function renderSubagentWidget(jobs: readonly ActiveJobDisplay[], theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  const lines = [
    theme.fg("borderMuted", "─".repeat(renderWidth)),
    theme.fg("muted", `Subagents · ${jobs.length} active`),
    ...jobs.map((job) => renderJob(job, theme)),
  ];
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

function renderJob(job: ActiveJobDisplay, theme: Theme): string {
  const running = job.state === "running";
  const symbol = theme.fg(running ? "accent" : "dim", running ? "▶ " : "○ ");
  const state = theme.fg(running ? "accent" : "muted", job.state);
  const jobId = sanitizeLabel(job.jobId);
  const tools = job.tools.length > 0 ? job.tools.map(sanitizeLabel).join(", ") : "none";
  const timeout = job.timeout === undefined ? "no timeout" : formatSeconds(job.timeout);
  const detail = ` · ${formatSeconds(Math.floor(job.elapsedMs / 1_000))} / ${timeout} · tools: ${tools}`;
  return `${symbol}${theme.fg("text", jobId)} · ${state}${theme.fg("muted", detail)}`;
}

function widgetValue(jobs: readonly ActiveJobDisplay[]): string {
  return jobs
    .map(
      (job) =>
        `${job.jobId}\0${job.state}\0${Math.floor(job.elapsedMs / 1_000)}\0${job.timeout ?? ""}\0${job.tools.join(",")}`,
    )
    .join("\n");
}

function cloneDisplayJob(job: ActiveJobDisplay): ActiveJobDisplay {
  return { ...job, tools: [...job.tools] };
}

function sanitizeLabel(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function formatSeconds(value: number): string {
  if (value < 60) return `${formatNumber(value)}s`;
  const wholeSeconds = Math.floor(value);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
