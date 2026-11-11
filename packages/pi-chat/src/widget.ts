import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { EditorStatusWidget, type EditorStatusWidgetState } from "@narumitw/pi-tui-kit/editor-status-widget";
import type { ChatSnapshot, TranscriptEntry } from "./chat-session.js";
import type { WidgetMode } from "./settings.js";
import { sanitizeChatText, sanitizeSingleLine } from "./text.js";

interface ChatWidgetOptions {
  theme: Theme;
  state?: EditorStatusWidgetState;
  getSnapshot(): ChatSnapshot | undefined;
  getMode(): WidgetMode;
  getTerminalRows(): number;
}

export function createChatWidget(options: ChatWidgetOptions) {
  let snapshot: ChatSnapshot | undefined;
  let mode: WidgetMode = "off";
  const frame = new EditorStatusWidget({
    theme: options.theme,
    name: "Chat",
    get summary() {
      return snapshot ? chatSummary(snapshot) : undefined;
    },
    state: options.state,
    renderBody: (width) =>
      snapshot ? renderChatWidgetBody(snapshot, mode, width, options.theme, options.getTerminalRows()) : [],
  });
  return {
    render(width: number): string[] {
      // Summary and body must use one snapshot, including renders while collapsed.
      snapshot = options.getSnapshot();
      mode = options.getMode();
      if (!snapshot || snapshot.state === "disconnected" || mode === "off") {
        frame.invalidate();
        return [];
      }
      return frame.render(width);
    },
    invalidate: () => frame.invalidate(),
    handleMouse: (event: TuiMouseEvent) => frame.handleMouse(event),
    dispose: () => {
      snapshot = undefined;
      frame.dispose();
    },
  };
}

function renderChatWidgetBody(
  snapshot: ChatSnapshot,
  mode: WidgetMode,
  width: number,
  theme: Theme,
  terminalRows = 24,
): string[] {
  if (mode === "dock") return renderRoomDock(snapshot, width, terminalRows, theme);

  const header = truncateToWidth(theme.fg("accent", participantSummary(snapshot)), width);
  const roomHint = truncateToWidth(theme.fg("dim", "/chat to open"), width);
  if (mode !== "latest") return [header, roomHint];
  const latest = snapshot.transcript.at(-1);
  if (!latest) return [header, roomHint];
  return [header, roomHint, renderMessagePreview(latest, width, theme, false)];
}

function chatSummary(snapshot: ChatSnapshot): string {
  const state =
    snapshot.state === "connecting" ? "joining… · " : snapshot.state === "degraded" ? "reconnecting · " : "";
  const unread = snapshot.unread > 0 ? ` · ${snapshot.unread} unread` : "";
  return `${state}${sanitizeSingleLine(snapshot.room.label)}${unread}`;
}

function participantSummary(snapshot: ChatSnapshot): string {
  return `${snapshot.participants.length} active · ${snapshot.directNeighbors} direct neighbor${snapshot.directNeighbors === 1 ? "" : "s"}`;
}

function renderRoomDock(snapshot: ChatSnapshot, width: number, terminalRows: number, theme: Theme): string[] {
  const waiting = snapshot.state === "connected" && snapshot.directNeighbors === 0 ? " · waiting for neighbors" : "";
  const header = truncateToWidth(theme.fg("accent", `${participantSummary(snapshot)}${waiting}`), width);
  const previewCount = terminalRows < 10 ? 0 : terminalRows < 18 ? 1 : terminalRows < 26 ? 2 : 3;
  const previews = (previewCount === 0 ? [] : snapshot.transcript.slice(-previewCount)).map((entry) =>
    renderMessagePreview(entry, width, theme, true),
  );
  const target = snapshot.composerOpen
    ? `Input → CHAT ${sanitizeSingleLine(snapshot.room.label)} · Esc returns to Pi/LLM`
    : "Input → Pi/LLM · /chat then Enter to reply";
  return [header, ...previews, truncateToWidth(theme.fg("dim", target), width)];
}

function renderMessagePreview(entry: TranscriptEntry, width: number, theme: Theme, includeIdentity = false): string {
  const preview = sanitizeChatText(entry.text).replace(/\n+/gu, " ");
  const label = sanitizeSingleLine(entry.label);
  const author = includeIdentity ? label || "peer" : label.split("~", 1)[0] || "peer";
  return truncateToWidth(theme.fg("muted", `${author}: ${preview}`), width);
}
