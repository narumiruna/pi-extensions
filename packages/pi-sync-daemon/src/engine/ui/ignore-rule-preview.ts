import type { TransferReview } from "./sync-format.js";
import { snapshotPathLabel } from "./terminal-text.js";

export function formatRuleChanges(before: string | undefined, after: string | undefined): TransferReview {
  if (before === after) {
    const message = before === undefined ? "Rule text is unavailable on both sides." : "Rule text is unchanged.";
    return { lines: [message], content: message };
  }
  const lines = (text: string | undefined, prefix: string) =>
    text === undefined
      ? [`${prefix} (rule text not in snapshot)`]
      : text.split(/(?<=\n)/u).map((line) => `${prefix} ${snapshotPathLabel(JSON.stringify(line))}`);
  return {
    lines: ["Rule text changes. View details for the exact lines."],
    content: [
      "Rule text (− before, + after; JSON quotes show whitespace):",
      ...lines(before, "-"),
      ...lines(after, "+"),
    ].join("\n"),
  };
}
