import { stripVTControlCharacters } from "node:util";
import { type Input, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderBoundedFrame } from "../bounded-frame.js";
import { HorizontalRule } from "../horizontal-rule.js";
import { formatInteractionHints } from "../interaction-hints.js";
import { replaceTerminalControls, safeMenuText } from "../text.js";
import type { ActionMenuItem } from "../types.js";
import type { MenuKeybindings, MenuScreenComponentOptions } from "./contracts.js";

export { safeMenuText } from "../text.js";

export function actionMenuItemPresentation(item: ActionMenuItem<string, string>): {
  label: string;
  description?: string;
} {
  const label = safeMenuText(item.label);
  const description = item.description ? safeMenuText(item.description) : undefined;
  return { label: item.disabled ? `[-] ${label}` : label, description };
}

export function actionMenuUnavailableDescription(item: ActionMenuItem<string, string>): string | undefined {
  if (!item.disabled) return undefined;
  const reason = safeMenuText(item.disabledReason ?? "");
  return reason ? `Unavailable: ${reason}` : undefined;
}

export function actionMenuDialogLabel(item: ActionMenuItem<string, string>): string {
  const label = safeMenuText(item.label);
  const reason = safeMenuText(item.disabledReason ?? "");
  if (!item.disabled || !reason) return label;
  return `[-] ${label} (unavailable: ${reason})`;
}

interface FrameLayoutOptions {
  compactOverflowText?: string;
  confirmAction?: string;
  hint?: string;
  navigation?: boolean;
  pinnedContentRows?: number;
  priorityTailRows?: number;
}

export function renderFrame<ScreenId extends string, ActionId extends string>(
  title: string,
  lines: readonly string[],
  content: readonly string[],
  destination: "back" | "close",
  width: number,
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
  layout: FrameLayoutOptions = {},
): string[] {
  const safeWidth = Math.max(1, width);
  const rule = renderHorizontalRule(safeWidth, options.theme);
  const confirmAction = layout.confirmAction ?? "select";
  const navigation = layout.navigation ?? true;
  const titleRows = wrapTextWithAnsi(options.theme.fg("accent", options.theme.bold(safeMenuText(title))), safeWidth);
  const contextRows = lines.flatMap((line) =>
    wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), safeWidth),
  );
  const hintText =
    layout.hint ?? options.interactionHint ?? menuHint(options.keybindings, destination, confirmAction, navigation);
  const hintRows = wrapTextWithAnsi(options.theme.fg("dim", hintText), safeWidth);
  const compactFullHintRows = wrapTextWithAnsi(
    options.theme.fg(
      "dim",
      layout.compactOverflowText ? `${hintText} • ${safeMenuText(layout.compactOverflowText).trim()}` : hintText,
    ),
    safeWidth,
  );
  const compactHintRow = options.theme.fg(
    "dim",
    compactMenuHint(
      hintText,
      options.keybindings,
      destination,
      confirmAction,
      navigation,
      layout.compactOverflowText,
      safeWidth,
    ),
  );
  // Selection affordances belong to the menu adapter, not the public frame primitive.
  const compactContent = content
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => stripVTControlCharacters(line).trim().length > 0);
  const compactRows = compactContent.map(({ line }) => line);
  const priorities = priorityRowIndexes(compactRows, layout.pinnedContentRows ?? 0, layout.priorityTailRows ?? 0);
  return renderBoundedFrame({
    width: safeWidth,
    maxRows: componentRows(options.tui.terminal.rows),
    rule,
    title: titleRows,
    context: contextRows,
    content,
    hints: hintRows,
    compactHints: compactFullHintRows,
    compactHint: compactHintRow,
    priorityRows: [...priorities].map((index) => compactContent[index]?.index ?? -1),
    focusedRow: compactContent[selectedRowIndex(compactRows)]?.index,
  });
}

function priorityRowIndexes(
  rows: readonly string[],
  pinnedRows: number,
  priorityTailRows: number,
  budget = Number.POSITIVE_INFINITY,
) {
  const indexes = new Set<number>();
  const pinned = Math.max(0, Math.min(rows.length, Math.floor(pinnedRows)));
  if (pinned > 0 && indexes.size < budget) indexes.add(0);
  const selectedIndex = selectedRowIndex(rows);
  if (selectedIndex >= 0 && indexes.size < budget) indexes.add(selectedIndex);
  for (let index = 1; index < pinned && indexes.size < budget; index += 1) indexes.add(index);
  const tailStart = Math.max(pinned, rows.length - Math.max(0, Math.floor(priorityTailRows)));
  for (let index = tailStart; index < rows.length && indexes.size < budget; index += 1) {
    indexes.add(index);
  }
  return indexes;
}

function selectedRowIndex(rows: readonly string[]) {
  return rows.findIndex((line) => /^[→›]\s/u.test(stripVTControlCharacters(line)));
}

export function componentRows(rows: number) {
  const terminalRows = Number.isFinite(rows) ? Math.floor(rows) : 24;
  return Math.max(1, terminalRows - 3);
}

export function renderHorizontalRule(
  width: number,
  theme: MenuScreenComponentOptions<string, string>["theme"],
): string {
  return (
    new HorizontalRule({
      ruleStyle: (text) => theme.fg("border", text),
    }).render(Math.max(1, width))[0] ?? ""
  );
}

export function menuHint(
  keybindings: MenuKeybindings,
  destination: "back" | "close",
  confirmAction: string,
  navigation = true,
) {
  return formatInteractionHints(keybindings, [
    ...(navigation ? [{ bindings: ["tui.select.up", "tui.select.down"] as const, label: "navigate" }] : []),
    ...(confirmAction ? [{ bindings: ["tui.select.confirm"] as const, label: confirmAction }] : []),
    {
      bindings: ["tui.select.cancel"],
      excludeKeys: ["ctrl+c"],
      label: destination,
    },
    ...(destination === "back" ? [{ keys: ["ctrl+c"], label: "close" }] : []),
  ]);
}

function compactMenuHint(
  hintText: string,
  keybindings: MenuKeybindings,
  destination: "back" | "close",
  confirmAction: string,
  navigation: boolean,
  compactOverflowText: string | undefined,
  width: number,
) {
  const cancel = formatInteractionHints(keybindings, [
    {
      bindings: ["tui.select.cancel"],
      excludeKeys: ["ctrl+c"],
      label: destination,
    },
  ]);
  const hardCancel =
    destination === "back" || !cancel
      ? formatInteractionHints(keybindings, [{ keys: ["ctrl+c"], label: "close" }])
      : "";
  const confirm = confirmAction
    ? formatInteractionHints(keybindings, [{ bindings: ["tui.select.confirm"], label: confirmAction }])
    : "";
  const navigate = navigation
    ? formatInteractionHints(keybindings, [{ bindings: ["tui.select.up", "tui.select.down"], label: "navigate" }])
    : "";
  const supplied = hintSegments(hintText);
  const groups = {
    cancel: hintSegmentKeys(cancel),
    confirm: hintSegmentKeys(confirm),
    hardCancel: hintSegmentKeys(hardCancel),
    navigate: hintSegmentKeys(navigate),
  };
  const classified = supplied.map((segment) => ({ segment, keys: hintSegmentKeys(segment) }));
  const matching = (keys: ReadonlySet<string>) =>
    classified.filter((candidate) => intersects(candidate.keys, keys)).map(({ segment }) => segment);
  const cancelSegments = matching(groups.cancel);
  const confirmSegments = matching(groups.confirm);
  const hardCancelSegments = matching(groups.hardCancel);
  const navigationSegments = matching(groups.navigate);
  const claimed = new Set([...cancelSegments, ...confirmSegments, ...hardCancelSegments, ...navigationSegments]);
  const remaining = classified.filter(({ segment }) => !claimed.has(segment));
  const keyedCustom = remaining.filter(({ keys }) => keys.size > 0).map(({ segment }) => segment);
  const reminders = remaining.filter(({ keys }) => keys.size === 0).map(({ segment }) => segment);
  return fitCompactHintSegments(
    [
      ...(cancelSegments.length > 0 ? cancelSegments : [cancel]),
      ...(compactOverflowText ? [safeMenuText(compactOverflowText).trim()] : []),
      ...confirmSegments,
      ...hardCancelSegments,
      ...navigationSegments,
      ...keyedCustom,
      ...reminders,
    ],
    width,
  );
}

function hintSegments(hintText: string) {
  return safeMenuText(hintText)
    .split(/\s+[•·]\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function hintSegmentKeys(segment: string) {
  const token = safeMenuText(segment).trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? "";
  const parts = token.split("/");
  return parts.length > 0 && parts.every(isHintKey) ? new Set(parts) : new Set<string>();
}

function isHintKey(value: string) {
  return (
    value.length === 1 ||
    value.includes("+") ||
    ["esc", "escape", "enter", "return", "space", "↑", "↓", "up", "down", "pageup", "pagedown", "home", "end"].includes(
      value,
    )
  );
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

export function fitCompactHintSegments(segments: readonly string[], width: number) {
  const safeWidth = Math.max(1, width);
  let result = "";
  for (const segment of segments.map(safeMenuText).filter(Boolean)) {
    const candidate = result ? `${result} • ${segment}` : segment;
    if (visibleWidth(candidate) > safeWidth) continue;
    result = candidate;
  }
  return result;
}

export function handleSearchInput(input: Input, data: string) {
  input.handleInput(data);
  const value = replaceTerminalControls(input.getValue());
  if (value !== input.getValue()) input.setValue(value);
}
