import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit";

const RESERVED_HOST_ROWS = 3;

export interface PreviewMenuItem<Value extends string> {
  value: Value;
  label: string;
}

export type PreviewMenuResult<Value extends string> =
  | { kind: "selected"; value: Value }
  | { kind: "cancelled" }
  | { kind: "closed" };

export async function showPreviewActionMenu<Value extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  body: (width: number) => readonly string[],
  items: readonly PreviewMenuItem<Value>[],
  signal?: AbortSignal,
  isCurrent: () => boolean = () => !signal?.aborted,
): Promise<PreviewMenuResult<Value> | undefined> {
  if (signal?.aborted || !isCurrent()) return { kind: "closed" };
  const result = await runCustomInteraction<PreviewMenuResult<Value>>(ctx, {
    signal,
    isCurrent,
    create: ({ tui, theme, keybindings, complete }) => {
      let selectedIndex = 0;
      let scrollOffset = 0;
      let lastMaximumScroll = 0;
      let lastViewportSize = 1;
      let disposed = false;

      const requestRender = () => {
        if (!disposed) tui.requestRender();
      };
      const moveSelection = (delta: number) => {
        if (items.length === 0) return;
        selectedIndex = (selectedIndex + delta + items.length) % items.length;
        requestRender();
      };
      const movePreview = (offset: number) => {
        scrollOffset = Math.max(0, Math.min(offset, lastMaximumScroll));
        requestRender();
      };

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const availableRows = Math.max(1, terminalRows - RESERVED_HOST_ROWS);
          const bodyLines = body(safeWidth).flatMap((line) => (line ? wrapTextWithAnsi(line, safeWidth) : [""]));
          const layout = allocateLayout(availableRows, items.length, bodyLines.length);
          lastViewportSize = layout.previewRows;
          lastMaximumScroll = Math.max(0, bodyLines.length - layout.previewRows);
          scrollOffset = Math.max(0, Math.min(scrollOffset, lastMaximumScroll));
          const actionStart = actionWindowStart(selectedIndex, items.length, layout.actionRows);
          const actionLines = items.slice(actionStart, actionStart + layout.actionRows).map((item, index) => {
            const absoluteIndex = actionStart + index;
            const prefix = absoluteIndex === selectedIndex ? "→ " : "  ";
            return theme.fg(
              absoluteIndex === selectedIndex ? "accent" : "text",
              `${prefix}${safeDisplayText(item.label)}`,
            );
          });
          const position = layout.positionRows
            ? [theme.fg("dim", previewPosition(scrollOffset, layout.previewRows, bodyLines.length))]
            : [];
          const lines = [
            ...(layout.titleRows ? [theme.fg("accent", theme.bold(safeDisplayText(title)))] : []),
            ...bodyLines.slice(scrollOffset, scrollOffset + layout.previewRows),
            ...position,
            ...actionLines,
            ...(layout.hintRows ? [theme.fg("dim", previewHint(keybindings))] : []),
          ];
          return lines.map((line) => truncateToWidth(line, safeWidth, ""));
        },
        invalidate() {},
        handleInput(data: string) {
          if (disposed) return;
          if (matchesKey(data, Key.ctrl("c"))) {
            complete({ kind: "closed" });
          } else if (keybindings.matches(data, "tui.select.cancel")) {
            complete({ kind: "cancelled" });
          } else if (keybindings.matches(data, "tui.select.up")) {
            moveSelection(-1);
          } else if (keybindings.matches(data, "tui.select.down")) {
            moveSelection(1);
          } else if (keybindings.matches(data, "tui.select.pageUp")) {
            movePreview(scrollOffset - lastViewportSize);
          } else if (keybindings.matches(data, "tui.select.pageDown")) {
            movePreview(scrollOffset + lastViewportSize);
          } else if (matchesKey(data, Key.home)) {
            movePreview(0);
          } else if (matchesKey(data, Key.end)) {
            movePreview(lastMaximumScroll);
          } else if (keybindings.matches(data, "tui.select.confirm")) {
            const item = items[selectedIndex];
            if (item) complete({ kind: "selected", value: item.value });
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
        },
      };
    },
  });
  if (result.kind === "completed") return result.value;
  if (result.kind === "error") throw result.error;
  if (result.kind === "stale" && (signal?.aborted || !isCurrent())) return { kind: "closed" };
  return undefined;
}

interface PreviewLayout {
  titleRows: number;
  previewRows: number;
  positionRows: number;
  actionRows: number;
  hintRows: number;
}

function allocateLayout(availableRows: number, actionCount: number, bodyLineCount: number): PreviewLayout {
  if (availableRows === 1) {
    return { titleRows: 0, previewRows: 0, positionRows: 0, actionRows: 1, hintRows: 0 };
  }
  const titleRows = availableRows >= 3 ? 1 : 0;
  const hintRows = availableRows >= 3 ? 1 : 0;
  const minimumPreviewRows = bodyLineCount > 0 && availableRows >= 4 ? 1 : 0;
  const availableActionRows = Math.max(1, availableRows - titleRows - hintRows - minimumPreviewRows);
  const actionRows = Math.min(Math.max(1, actionCount), availableActionRows);
  let previewRows = Math.max(0, availableRows - titleRows - hintRows - actionRows);
  const positionRows = previewRows >= 2 && bodyLineCount > previewRows ? 1 : 0;
  previewRows -= positionRows;
  return { titleRows, previewRows, positionRows, actionRows, hintRows };
}

function actionWindowStart(selectedIndex: number, itemCount: number, viewportSize: number): number {
  if (itemCount <= viewportSize) return 0;
  return Math.max(0, Math.min(selectedIndex, itemCount - viewportSize));
}

function previewPosition(offset: number, viewportSize: number, lineCount: number): string {
  if (lineCount === 0) return "0/0";
  return `${offset + 1}-${Math.min(lineCount, offset + viewportSize)}/${lineCount}`;
}

function previewHint(keybindings: Pick<KeybindingsManager, "getKeys">): string {
  const up = bindingText(keybindings, "tui.select.up");
  const down = bindingText(keybindings, "tui.select.down");
  const confirm = bindingText(keybindings, "tui.select.confirm");
  const cancel = bindingText(keybindings, "tui.select.cancel", "ctrl+c");
  const pageUp = bindingText(keybindings, "tui.select.pageUp");
  const pageDown = bindingText(keybindings, "tui.select.pageDown");
  return [
    ...(up || down ? [`${[up, down].filter(Boolean).join("/")} navigate`] : []),
    ...(confirm ? [`${confirm} select`] : []),
    ...(cancel ? [`${cancel} discard`] : []),
    "ctrl+c close",
    ...(pageUp || pageDown ? [`${[pageUp, pageDown].filter(Boolean).join("/")} preview`] : []),
  ].join(" • ");
}

function bindingText(
  keybindings: Pick<KeybindingsManager, "getKeys">,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
  excluded?: string,
): string {
  return keybindings
    .getKeys(binding)
    .filter((key) => key !== excluded)
    .map((key) => {
      if (key === "up") return "↑";
      if (key === "down") return "↓";
      if (key === "escape") return "esc";
      if (key === "return") return "enter";
      return safeDisplayText(key);
    })
    .join("/");
}

function safeDisplayText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const control = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return control ? "" : character;
  }).join("");
}
