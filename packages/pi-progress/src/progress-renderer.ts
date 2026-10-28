import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import type { ProgressStep } from "./progress-state.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettings } from "./settings.js";

export interface RenderProgressWidgetOptions {
  settings?: Readonly<ProgressSettings>;
  terminalRows?: number;
  /** Total rows, including the separator. Fewer than two rows hide the frame. */
  maxRows?: number;
  viewMode?: "default" | "expanded" | "compact" | "hidden";
  items?: readonly { value: ProgressStep; mode: "expanded" | "compact" }[];
}

interface RenderedProgressStep {
  step: ProgressStep;
  lines: string[];
}

export function renderProgressWidget(
  steps: readonly ProgressStep[],
  theme: Theme,
  width: number,
  options: RenderProgressWidgetOptions = {},
): string[] {
  const renderWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const settings = options.settings ?? DEFAULT_PROGRESS_SETTINGS;
  const maxRows =
    options.maxRows === undefined
      ? undefined
      : Number.isFinite(options.maxRows)
        ? Math.max(0, Math.floor(options.maxRows))
        : widgetRowBudget(options.terminalRows);
  if (options.viewMode === "hidden" || (maxRows !== undefined && maxRows < 2)) return [];
  const items = options.items ?? steps.map((value) => ({ value, mode: "expanded" as const }));
  if (options.items && items.length === 0) return [];
  const removed = steps.length - items.length;
  if (options.viewMode === "compact") return renderCompactProgress(steps, removed, theme, renderWidth);
  const presentationChanged = removed > 0 || items.some((item) => item.mode === "compact");
  const header = renderHeader(steps, theme, renderWidth, settings.showProgress);
  if (presentationChanged) header[1] = theme.fg("muted", progressSummary(steps, removed));
  const rendered = items.map(({ value: step, mode }) => ({
    step,
    lines: renderStep(step, theme, renderWidth, mode === "compact"),
  }));
  const displayMode = options.viewMode === "expanded" ? "expanded" : settings.displayMode;

  let lines: string[];
  switch (displayMode) {
    case "expanded":
      lines = renderExpanded(header, rendered, settings, theme, renderWidth);
      break;
    case "collapsed":
      lines = renderCollapsed(header, rendered, settings, theme, renderWidth, widgetRowBudget(options.terminalRows));
      break;
    case "adaptive": {
      const expanded = renderExpanded(header, rendered, settings, theme, renderWidth);
      const rowBudget = widgetRowBudget(options.terminalRows);
      const eligibleItems = settings.showCompleted
        ? rendered.length
        : rendered.filter(({ step }) => step.status !== "completed").length;
      const itemCapHidesWork = settings.maxVisibleItems !== null && eligibleItems > settings.maxVisibleItems;
      lines =
        expanded.length <= rowBudget && !itemCapHidesWork
          ? expanded
          : renderCollapsed(header, rendered, settings, theme, renderWidth, rowBudget);
      break;
    }
  }

  const omittedBlocked = rendered.some(
    ({ step, lines: detail }) => step.status === "blocked" && !lines.includes(detail[0] ?? ""),
  );
  if (omittedBlocked && lines.length > 1) lines[1] = theme.fg("warning", progressSummary(steps, removed));
  if (maxRows !== undefined && lines.length > maxRows) {
    // Under a cap, keep attention work ahead of pending/completed detail and
    // reserve a truthful aggregate instead of silently slicing off blocked work.
    if (maxRows === 2) return renderCompactProgress(steps, steps.length, theme, renderWidth);
    const priority = [...rendered].sort((a, b) => stepPriority(a.step) - stepPriority(b.step));
    const body: string[] = [];
    let shown = 0;
    for (const item of priority) {
      if (!settings.showCompleted && item.step.status === "completed") continue;
      if (settings.maxVisibleItems !== null && shown >= settings.maxVisibleItems) break;
      const available = maxRows - 2 - body.length - 1;
      if (available <= 0) break;
      body.push(...clipLines(item.lines, available, renderWidth));
      shown++;
    }
    lines = [header[0] ?? "", theme.fg("muted", progressSummary(steps, steps.length - shown)), ...body];
    if (body.length > 0 && steps.length > shown && lines.length < maxRows)
      lines.push(theme.fg("dim", `… ${steps.length - shown} hidden or omitted`));
  }
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

function stepPriority(step: ProgressStep): number {
  return { in_progress: 0, blocked: 1, pending: 2, completed: 3 }[step.status];
}

export function progressSummary(steps: readonly ProgressStep[], hidden = 0): string {
  const completed = steps.filter((step) => step.status === "completed").length;
  const blocked = steps.filter((step) => step.status === "blocked").length;
  const active = steps.filter((step) => step.status === "in_progress").length;
  return [
    blocked > 0 ? `⚠ ${blocked} blocked` : "Progress",
    `${completed}/${steps.length} complete`,
    ...(active ? [`${active} active`] : []),
    ...(hidden ? [`${hidden} hidden`] : []),
  ].join(" · ");
}

function renderCompactProgress(steps: readonly ProgressStep[], hidden: number, theme: Theme, width: number): string[] {
  return new EditorStatusWidget({
    theme,
    renderBody: () => [
      theme.fg(steps.some((step) => step.status === "blocked") ? "warning" : "muted", progressSummary(steps, hidden)),
    ],
  }).render(width);
}

export function renderCompletionSummary(total: number, theme: Theme, width: number, maxRows = 2): string[] {
  if (Number.isFinite(maxRows) && maxRows < 2) return [];
  return new EditorStatusWidget({
    theme,
    renderBody: () => [theme.fg("success", `✓ ${total}/${total} steps completed`)],
  }).render(width);
}

export function sanitizeProgressText(value: string): string {
  // Document sanitization preserves Progress's control-to-space policy; whitespace is local.
  return sanitizeTerminalDocument(value).replace(/\s+/gu, " ").trim();
}

export function widgetRowBudget(terminalRows?: number): number {
  const rows =
    typeof terminalRows === "number" && Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 36;
  return Math.max(4, Math.min(12, Math.floor(rows / 3)));
}

function renderHeader(steps: readonly ProgressStep[], theme: Theme, width: number, showProgress: boolean): string[] {
  const completed = steps.filter((step) => step.status === "completed").length;
  return new EditorStatusWidget({
    theme,
    renderBody: () => [
      theme.fg("muted", showProgress ? `Progress · ${completed}/${steps.length} complete` : "Progress"),
    ],
  }).render(width);
}

function renderStep(step: ProgressStep, theme: Theme, width: number, compact = false): string[] {
  const text = sanitizeProgressText(step.text) || "(text hidden after sanitization)";
  let prefix: string;
  let styledText: string;
  switch (step.status) {
    case "completed":
      prefix = theme.fg("success", "✓ ");
      styledText = theme.fg("muted", theme.strikethrough(text));
      break;
    case "in_progress":
      prefix = theme.fg("accent", "▶ ");
      styledText = theme.fg("accent", theme.bold(text));
      break;
    case "blocked": {
      prefix = theme.fg("warning", "⚠ ");
      styledText = theme.fg("warning", text);
      break;
    }
    case "pending":
      prefix = theme.fg("dim", "○ ");
      styledText = theme.fg("text", text);
      break;
  }

  if (compact) return [truncateToWidth(`${prefix}${styledText}`, width, "…")];
  if (width <= 2) return [prefix];
  const wrapped = wrapTextWithAnsi(styledText, width - 2);
  return wrapped.map((line, index) => `${index === 0 ? prefix : "  "}${line}`);
}

function renderExpanded(
  header: readonly string[],
  rendered: readonly RenderedProgressStep[],
  settings: Readonly<ProgressSettings>,
  theme: Theme,
  width: number,
): string[] {
  const candidates = settings.showCompleted ? rendered : rendered.filter(({ step }) => step.status !== "completed");
  const visible = candidates.slice(0, settings.maxVisibleItems ?? candidates.length);
  const hidden = candidates.length - visible.length;
  const lines = [...header, ...visible.flatMap((item) => item.lines)];
  if (hidden > 0) lines.push(theme.fg("dim", `… ${hidden} more`));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

function renderCollapsed(
  header: readonly string[],
  rendered: readonly RenderedProgressStep[],
  settings: Readonly<ProgressSettings>,
  theme: Theme,
  width: number,
  rowBudget: number,
): string[] {
  const prioritized = [
    ...rendered.filter(({ step }) => step.status === "in_progress"),
    ...rendered.filter(({ step }) => step.status === "blocked"),
    ...rendered.filter(({ step }) => step.status === "pending"),
  ];
  const itemLimit = Math.min(settings.maxVisibleItems ?? prioritized.length, prioritized.length);
  const completed = rendered.filter(({ step }) => step.status === "completed").length;
  const bodyBudget = Math.max(0, rowBudget - header.length);
  const selected: string[] = [];
  let selectedItems = 0;
  let clippedItem = false;

  for (const item of prioritized.slice(0, itemLimit)) {
    const remainingItems = prioritized.length - selectedItems - 1;
    const needsFooter =
      remainingItems > 0 || itemLimit < prioritized.length || (settings.showCompleted && completed > 0);
    const available = bodyBudget - selected.length - (needsFooter ? 1 : 0);
    if (available <= 0) break;
    if (item.lines.length <= available) {
      selected.push(...item.lines);
      selectedItems += 1;
      continue;
    }
    if (selectedItems === 0) {
      selected.push(...clipLines(item.lines, available, width));
      selectedItems += 1;
      clippedItem = true;
    }
    break;
  }

  const hidden = prioritized.length - selectedItems;
  const footerParts: string[] = [];
  if (settings.showCompleted && completed > 0) footerParts.push(`✓ ${completed} completed`);
  if (hidden > 0) footerParts.push(`… ${hidden} more`);
  if (clippedItem) footerParts.push("step truncated");
  if (footerParts.length > 0 && selected.length < bodyBudget) {
    selected.push(theme.fg("dim", footerParts.join(" · ")));
  }

  return [...header, ...selected].slice(0, rowBudget).map((line) => truncateToWidth(line, width, ""));
}

function clipLines(lines: readonly string[], count: number, width: number): string[] {
  const clipped = lines.slice(0, count);
  const last = clipped.at(-1);
  if (last !== undefined && lines.length > count) clipped[clipped.length - 1] = truncateToWidth(`${last}…`, width, "…");
  return clipped;
}
