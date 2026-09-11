import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { FleetMessage } from "./protocol.js";
import { safeTerminalLine, safeTerminalText } from "./text.js";

export const FLEET_MESSAGE_TYPE = "pi-fleet-message";

export interface FleetMessageDetails {
  message: FleetMessage;
}

export const renderFleetMessage: MessageRenderer<FleetMessageDetails> = (message, options, theme) => {
  const details = message.details;
  if (!details?.message) return undefined;
  const value = details.message;
  const sender = safeTerminalLine(value.fromName ?? value.fromSessionId) || "unknown session";
  const mode = value.mode === "request" || value.mode === "kickoff" ? "request" : value.mode;
  const lines = [theme.fg("accent", theme.bold(`Pi Fleet ${mode} · ${sender}`)), safeTerminalText(value.text)];
  if (options.expanded) {
    lines.push(
      theme.fg("dim", `Session: ${safeTerminalLine(value.fromSessionId)}`),
      theme.fg("dim", `Cwd: ${safeTerminalLine(value.fromCwd ?? "unknown")}`),
      theme.fg("dim", `Message: ${safeTerminalLine(value.id)}`),
    );
    if (value.replyTo) {
      lines.push(theme.fg("dim", `Reply to: ${safeTerminalLine(value.replyTo)}`));
    }
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
};
