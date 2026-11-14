import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { PiPane, RexSnapshot, RexState } from "./rex-snapshot.js";

export interface RexDisplay extends RexSnapshot {
  loading?: boolean;
  error?: string;
}

export interface RexLocation {
  sessionId?: string;
  blockId?: string;
}

const STATUS: Record<RexState, { label: string; color: Parameters<Theme["fg"]>[0] }> = {
  blocked: { label: "! Blocked", color: "warning" },
  error: { label: "× Error", color: "error" },
  done: { label: "✓ Done", color: "success" },
  working: { label: "● Working", color: "accent" },
  idle: { label: "○ Idle", color: "muted" },
};

export function rexSummary(display: RexDisplay): string {
  if (display.loading) return display.error ? "Unavailable" : "Connecting";
  const count = `${display.entries.length} Pi ${display.entries.length === 1 ? "session" : "sessions"}`;
  if (display.error) return `Disconnected · ${count} (stale)`;
  return display.warnings.length ? `Partial · ${count}` : count;
}

function directory(entry: PiPane): string {
  const cwd = sanitizeTerminalText(entry.cwd ?? "CWD unavailable");
  const home = sanitizeTerminalText(entry.home ?? "").replace(/\/+$/u, "");
  return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

function pathTail(value: string, width: number): string {
  const cells = visibleWidth(value);
  return cells <= width ? value : `…${sliceByColumn(value, Math.max(0, cells - width + 1), width - 1, true)}`;
}

function paneLine(entry: PiPane, theme: Theme, width: number, here: RexLocation, stale: boolean): string {
  const status = STATUS[entry.state];
  const label = `${status.label}${entry.reported ? "" : "*"}`.padEnd(11);
  const cwd = directory(entry);
  const pathWidth = Math.max(1, Math.min(48, width - 13, Math.floor(width * 0.5)));
  const path = pathTail(cwd, pathWidth);
  const location = [entry.session, entry.tab, entry.pane].map(sanitizeTerminalText).join(" / ");
  const current = here.sessionId === entry.sessionId && here.blockId === entry.blockId ? " (this pane)" : "";
  const line = `${theme.fg(stale ? "muted" : status.color, label)}  ${theme.fg("muted", path)}  ${theme.fg("dim", `${location}${current}`)}`;
  return truncateToWidth(line, width);
}

export function renderRexWidget(
  display: RexDisplay,
  theme: Theme,
  width: number,
  rows: number,
  here: RexLocation = {},
): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  // Reserve most terminal rows for Pi's transcript, editor, and other widgets.
  const budget = Math.max(1, Math.min(8, Number.isFinite(rows) ? Math.floor(rows / 4) : 8));
  const body: string[] = [];
  if (display.error) body.push(theme.fg("warning", `Rex unavailable: ${sanitizeTerminalText(display.error)}`));
  else if (display.loading) body.push(theme.fg("muted", "Connecting to Rex…"));
  else if (display.warnings.length) {
    body.push(
      theme.fg(
        "warning",
        `Partial snapshot (${display.warnings.length} ${display.warnings.length === 1 ? "warning" : "warnings"}): ${sanitizeTerminalText(display.warnings[0] ?? "")}`,
      ),
    );
  }
  const available = Math.max(0, budget - 1 - body.length);
  const shown = Math.min(display.entries.length, Math.max(0, available - (display.entries.length > available ? 1 : 0)));
  for (const entry of display.entries.slice(0, shown)) {
    body.push(paneLine(entry, theme, columns, here, Boolean(display.error)));
  }
  const omitted = display.entries.length - shown;
  if (omitted && available > 0)
    body.push(theme.fg("muted", `+${omitted} more Pi ${omitted === 1 ? "session" : "sessions"}`));
  if (!display.loading && !display.error && !display.warnings.length && !display.entries.length) {
    body.push(theme.fg("muted", "No Pi sessions found in Rex"));
  }
  return new EditorStatusWidget({
    theme,
    renderBody: () => body.slice(0, Math.max(0, budget - 1)),
  }).render(columns);
}
