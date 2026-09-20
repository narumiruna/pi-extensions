import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import type { ProgressStep } from "./progress-state.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressWidgetSettings } from "./settings.js";

export interface RenderProgressWidgetOptions {
  settings?: Readonly<ProgressWidgetSettings>;
  terminalRows?: number;
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
  const renderWidth = Math.max(0, width);
  const settings = options.settings ?? DEFAULT_PROGRESS_SETTINGS.widget;
  const header = renderHeader(steps, theme, renderWidth, settings.showProgress);
  const rendered = steps.map((step) => ({ step, lines: renderStep(step, theme, renderWidth) }));

  let lines: string[];
  switch (settings.displayMode) {
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

  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

export function renderCompletionSummary(total: number, theme: Theme, width: number): string[] {
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

function renderStep(step: ProgressStep, theme: Theme, width: number): string[] {
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
      const reason = sanitizeProgressText(step.reason ?? "") || "(reason hidden after sanitization)";
      styledText = `${theme.fg("warning", text)}${reason ? theme.fg("muted", ` — ${reason}`) : ""}`;
      break;
    }
    case "pending":
      prefix = theme.fg("dim", "○ ");
      styledText = theme.fg("text", text);
      break;
  }

  if (width <= 2) return [prefix];
  const wrapped = wrapTextWithAnsi(styledText, width - 2);
  return wrapped.map((line, index) => `${index === 0 ? prefix : "  "}${line}`);
}

function renderExpanded(
  header: readonly string[],
  rendered: readonly RenderedProgressStep[],
  settings: Readonly<ProgressWidgetSettings>,
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
  settings: Readonly<ProgressWidgetSettings>,
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
  if (last !== undefined) clipped[clipped.length - 1] = truncateToWidth(`${last}…`, width, "…");
  return clipped;
}
