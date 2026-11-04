import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  HorizontalRule,
  hardWrapTerminalDocument,
  renderBoundedFrameLayout,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";

// Escape controls rather than deleting bytes from a path's display identity.
// JSON quotes also expose leading/trailing spaces and distinguish literal backslashes.
export function displayPath(path: string): string {
  return JSON.stringify(path).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu,
    escapeCharacter,
  );
}

function escapeCharacter(character: string): string {
  return Array.from(character, (part) => {
    const point = part.codePointAt(0) ?? 0;
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, "0")}`;
  }).join("");
}

export function displayError(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}

export function scopeFrame(
  tui: TUI,
  theme: Theme,
  width: number,
  title: string,
  context: readonly string[],
  content: readonly string[],
  priorityRows: readonly number[],
  focusedRow?: number,
) {
  // The owned overlay uses terminal bounds; three spare rows are presentation
  // space, not a prediction of the native editor dock or another widget's height.
  const rows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
  const rule = new HorizontalRule({ ruleStyle: (line) => theme.fg("border", line) });
  return renderBoundedFrameLayout({
    width,
    maxRows: Math.max(1, rows - 3),
    rule: rule.render(width)[0] ?? "",
    title: [theme.fg("accent", theme.bold(title))],
    context: context.flatMap((line) => hardWrapTerminalDocument(line, width).map((part) => theme.fg("muted", part))),
    content,
    priorityRows,
    focusedRow,
  });
}

export function exactRows(value: string, width: number): string[] {
  return hardWrapTerminalDocument(value, width);
}
