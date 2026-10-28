import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorStatusCollectionItem } from "@narumitw/pi-tui-kit/editor-status-collection";
import type { EditorStatusMode } from "@narumitw/pi-tui-kit/editor-status-view";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeSubagentDisplayText as sanitizeLabel } from "./display-text.js";
import type { ActiveJobDisplay } from "./runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./settings.js";

const TASK_PREVIEW_WIDTH = 40;
// Reserve editor/footer space locally; this does not estimate other widgets' space.
export const SUBAGENT_WIDGET_RESERVED_ROWS = 8;
export const SUBAGENT_WIDGET_MAX_ROWS = 10;

export interface SubagentWidgetSnapshot {
  jobs: readonly ActiveJobDisplay[];
  items: readonly EditorStatusCollectionItem<ActiveJobDisplay>[];
  settings: SubagentSettings;
  mode: EditorStatusMode;
}

export function subagentWidgetRowBudget(rows: number): number {
  return Number.isFinite(rows)
    ? Math.min(SUBAGENT_WIDGET_MAX_ROWS, Math.max(0, Math.floor(rows) - SUBAGENT_WIDGET_RESERVED_ROWS))
    : 0;
}

export function renderSubagentWidgetSnapshot(
  snapshot: SubagentWidgetSnapshot,
  theme: Theme,
  width: number,
  maxRows: number,
): string[] {
  const { jobs, items, settings, mode } = snapshot;
  const budget = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
  if (!settings.showWidget || mode === "hidden" || jobs.length === 0 || items.length === 0 || budget < 2) return [];
  const running = jobs.filter((job) => job.state === "running").length;
  const counts = `Subagents · ${jobs.length} active · ${running} running · ${jobs.length - running} queued`;
  const removed = jobs.length - items.length;
  const summary = (shown: number) =>
    `${counts}${jobs.length > shown ? ` · ${jobs.length - shown} not shown${removed ? ` (${removed} removed)` : ""}` : ""}`;
  const bodyRows = budget - 1; // The standard separator consumes one row.
  let body: string[];
  if (mode === "compact" || bodyRows === 1) {
    body = [theme.fg("muted", summary(0))];
  } else {
    const shown = items.slice(0, bodyRows - 1);
    body = [
      theme.fg("muted", shown.length === jobs.length ? `Subagents · ${jobs.length} active` : summary(shown.length)),
      ...shown.map(({ value, mode: itemMode }) => renderJob(value, theme, settings, itemMode === "compact")),
    ];
  }
  return new EditorStatusWidget({ theme, renderBody: () => body }).render(width);
}

export function renderSubagentWidget(
  jobs: readonly ActiveJobDisplay[],
  theme: Theme,
  width: number,
  settings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS,
  maxRows = SUBAGENT_WIDGET_MAX_ROWS,
  mode: EditorStatusMode = "default",
): string[] {
  return renderSubagentWidgetSnapshot(
    { jobs, items: jobs.map((value) => ({ id: value.jobId, value, mode: "expanded" })), settings, mode },
    theme,
    width,
    maxRows,
  );
}

function renderJob(job: ActiveJobDisplay, theme: Theme, settings: SubagentSettings, compact: boolean): string {
  const running = job.state === "running";
  const symbol = theme.fg(running ? "accent" : "dim", running ? "▶ " : "○ ");
  const state = theme.fg(running ? "accent" : "muted", job.state);
  const jobId = sanitizeLabel(job.jobId);
  const taskText = sanitizeLabel(job.task);
  // Pi's truncation adds ANSI resets; remove them before applying the callback theme.
  const task = stripTerminalSequences(truncateToWidth(taskText, TASK_PREVIEW_WIDTH, "…"));
  const labels = [
    ...(settings.showJobId && visibleWidth(jobId) > 0 ? [theme.fg("text", jobId)] : []),
    ...(visibleWidth(task) > 0 ? [theme.fg("text", task)] : []),
  ];
  const hasLabel = labels.length > 0;
  // Keep a readable label when the task has no visible text and IDs are hidden.
  if (!hasLabel) labels.push(state);
  if (compact) return `${symbol}${labels.join(" · ")}${!running && hasLabel ? ` · ${state}` : ""}`;
  const tools = job.tools.length > 0 ? job.tools.map(sanitizeLabel).join(", ") : "none";
  const timeout = job.timeout === undefined ? undefined : formatSeconds(job.timeout);
  const elapsed = formatSeconds(Math.floor(job.elapsedMs / 1_000));
  const timing = running
    ? `${elapsed}${timeout === undefined ? "" : ` / ${timeout}`}`
    : timeout === undefined
      ? undefined
      : `timeout: ${timeout}`;
  const details = [
    ...(job.provider !== undefined ? [`provider: ${sanitizeLabel(job.provider)}`] : []),
    ...(job.model !== undefined ? [`model: ${sanitizeLabel(job.model)}`] : []),
    ...(job.thinkingLevel !== job.defaultThinkingLevel ? [`thinking: ${sanitizeLabel(job.thinkingLevel)}`] : []),
    ...(!running && hasLabel ? ["queued"] : []),
    ...(settings.showTiming && timing !== undefined ? [timing] : []),
    ...(settings.showTools ? [`tools: ${tools}`] : []),
  ];
  return `${symbol}${labels.join(" · ")}${details.length > 0 ? theme.fg("muted", ` · ${details.join(" · ")}`) : ""}`;
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
