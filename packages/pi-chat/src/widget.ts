import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChatSnapshot, TranscriptEntry } from "./chat-session.js";
import type { WidgetMode } from "./settings.js";
import { sanitizeChatText, sanitizeSingleLine } from "./text.js";

export function renderChatWidget(
  snapshot: ChatSnapshot,
  mode: WidgetMode,
  width: number,
  theme: Theme,
  terminalRows = 24,
): string[] {
  if (mode === "off" || snapshot.state === "disconnected") return [];
  const safeWidth = Math.max(1, width);
  if (mode === "dock") return renderRoomDock(snapshot, safeWidth, terminalRows, theme);

  const participants = snapshot.participants.length;
  const presence = `${participants} active · ${snapshot.directNeighbors} direct neighbor${snapshot.directNeighbors === 1 ? "" : "s"}`;
  const unread = snapshot.unread > 0 ? `${snapshot.unread} unread · ` : "";
  const attention = snapshot.state === "degraded" ? " · reconnecting" : "";
  const header = truncateToWidth(
    theme.fg(snapshot.state === "degraded" ? "warning" : "accent", `chat · ${unread}${presence}${attention}`),
    safeWidth,
  );
  const roomHint = truncateToWidth(
    theme.fg("dim", `${sanitizeSingleLine(snapshot.room.label)} · /chat to open`),
    safeWidth,
  );
  if (mode !== "latest") return [header, roomHint];
  const latest = snapshot.transcript.at(-1);
  if (!latest) return [header, roomHint];
  return [header, roomHint, renderMessagePreview(latest, safeWidth, theme, false)];
}

function renderRoomDock(snapshot: ChatSnapshot, width: number, terminalRows: number, theme: Theme): string[] {
  const participantText = `${snapshot.participants.length} active · ${snapshot.directNeighbors} direct neighbor${snapshot.directNeighbors === 1 ? "" : "s"}`;
  const stateText =
    snapshot.state === "connecting"
      ? "joining…"
      : snapshot.state === "degraded"
        ? `reconnecting · ${participantText}`
        : snapshot.directNeighbors === 0
          ? "waiting for neighbors"
          : participantText;
  const unread = snapshot.unread > 0 ? ` · ${snapshot.unread} unread` : "";
  const roomTitle = `ROOM ${sanitizeSingleLine(snapshot.room.label)}`;
  const status = `${stateText}${unread}`;
  const color = snapshot.state === "degraded" ? "warning" : "accent";
  const combinedHeader = `${roomTitle} · ${status}`;
  const header =
    visibleWidth(combinedHeader) <= width
      ? [theme.fg(color, combinedHeader)]
      : [truncateToWidth(theme.fg(color, roomTitle), width), truncateToWidth(theme.fg(color, status), width)];
  const previewCount = terminalRows < 10 ? 0 : terminalRows < 18 ? 1 : terminalRows < 26 ? 2 : 3;
  const previews = (previewCount === 0 ? [] : snapshot.transcript.slice(-previewCount)).map((entry) =>
    renderMessagePreview(entry, width, theme, true),
  );
  const target = snapshot.composerOpen
    ? `Input → CHAT ${sanitizeSingleLine(snapshot.room.label)} · Esc returns to Pi/LLM`
    : "Input → Pi/LLM · /chat then Enter to reply";
  return [...header, ...previews, truncateToWidth(theme.fg("dim", target), width)];
}

function renderMessagePreview(entry: TranscriptEntry, width: number, theme: Theme, includeIdentity = false): string {
  const preview = sanitizeChatText(entry.text).replace(/\n+/gu, " ");
  const label = sanitizeSingleLine(entry.label);
  const author = includeIdentity ? label || "peer" : label.split("~", 1)[0] || "peer";
  return truncateToWidth(theme.fg("muted", `${author}: ${preview}`), width);
}
