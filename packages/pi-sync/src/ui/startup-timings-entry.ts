import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { StartupTimingPublisher } from "../sync/startup-timings.js";
import { safeTerminalText } from "./terminal-text.js";

export const STARTUP_TIMING_ENTRY = "pi-sync-startup-timings";

export interface StartupTimingEntry {
  version: 1;
  report: string;
}

export function registerStartupTimings(pi: ExtensionAPI): StartupTimingPublisher {
  pi.registerEntryRenderer<StartupTimingEntry>(STARTUP_TIMING_ENTRY, (entry, _options, theme) => {
    const data = entry.data;
    if (data?.version !== 1 || typeof data.report !== "string") return undefined;
    const text = new Text(
      data.report
        .split("\n")
        .map((line, index) => theme.fg(index === 0 ? "accent" : "muted", safeTerminalText(line)))
        .join("\n"),
      0,
      0,
    );
    return {
      render: (width) => (width > 0 ? text.render(width).map((line) => truncateToWidth(line, width)) : []),
      invalidate: () => text.invalidate(),
    };
  });
  return (ctx, report) => {
    // Pi coalesces consecutive info notifications, including the final /reload notice.
    // Custom entries remain visible without adding messages to model context.
    if (ctx.mode === "tui") pi.appendEntry<StartupTimingEntry>(STARTUP_TIMING_ENTRY, { version: 1, report });
    else ctx.ui.notify(report, "info");
  };
}
