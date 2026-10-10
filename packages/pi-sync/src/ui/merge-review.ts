import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { defineMenu, runDocumentReview, runMenu } from "@narumitw/pi-tui-kit";
import { safeTerminalText } from "./terminal-text.js";

type ReviewContext = ExtensionCommandContext | ExtensionContext;

/** One approval screen; full details are optional and never authorize a transfer. */
export async function confirmMergeReview(
  ctx: ReviewContext,
  title: string,
  content: string,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
  confirmationLabel = "apply changes",
  summaryLines?: readonly string[],
) {
  const lines = summaryLines ?? [
    ...content
      .split("\n")
      .slice(0, 6)
      .map((line) => truncateToWidth(safeTerminalText(line), 100)),
    "View details for the complete review.",
  ];
  while (isCurrent() && !signal?.aborted) {
    const choice: { value: "cancel" | "approve" | "details" } = { value: "cancel" };
    const menu = defineMenu<undefined, "confirm", "choose", ReviewContext>({
      start: "confirm",
      screens: {
        confirm: () => ({
          kind: "choice",
          title,
          lines,
          initialItemId: "cancel",
          items: [
            { id: "cancel", label: "No, cancel" },
            { id: "approve", label: `Yes, ${confirmationLabel}` },
            { id: "details", label: "View details" },
          ],
          action: "choose",
          hint: "close",
        }),
      },
      actions: {
        choose: ({ itemId }) => {
          if (itemId === "approve" || itemId === "details") choice.value = itemId;
          return { kind: "close" };
        },
      },
    });
    const result = await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent, onError: () => {} });
    if (!isCurrent() || signal?.aborted) return false;
    if (result.kind === "error") throw new Error("Merge review failed; no transfer was performed.");
    if (result.kind === "unsupported")
      throw new Error("Merge review requires observable TUI or RPC; review the plan before using --yes.");
    if (result.kind !== "closed") return false;
    // The action callback runs inside Kit. Keep authorization separate from UI termination.
    if (choice.value === "approve") return true;
    if (choice.value !== "details") return false;
    const detail = await runDocumentReview(ctx, {
      title: "Sync change details",
      content,
      format: { kind: "text" },
      viewportSize: "adaptive",
      hint: "back",
      signal,
      isCurrent,
      onError: () => {},
    });
    if (!isCurrent() || signal?.aborted) return false;
    if (detail.kind === "error") throw new Error("Merge review failed; no transfer was performed.");
    if (detail.kind !== "cancelled" || detail.reason !== "back") return false;
    // A fresh menu discards remembered selection: returning from details always selects No.
    // Unlike Pi's native Yes-first dialog, approval requires moving off the safe default.
  }
  return false;
}
