import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionMenuItem } from "@narumitw/pi-tui-kit";
import type { StartupObservation } from "../sync/sync-inspection.js";
import type { RunRoute } from "./cancellable-operation.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import type { ManagerDescription } from "./manager-state.js";
import type { SyncAttentionState } from "./sync-attention.js";

export interface SyncManagerAttentionOptions {
  getObservation?: () => StartupObservation | undefined;
  onObservationInvalidated?: () => void;
  getAttention?: () => SyncAttentionState | undefined;
  onSelectionResolved?: (expected: SyncAttentionState) => void;
}

export function attentionMainMenuItems(
  manager: ManagerDescription,
): ActionMenuItem<"main" | "more" | "recovery", "review-attention">[] {
  if (!manager.attention && manager.observation?.inspection.selectionState?.kind !== "different") return [];
  const disabled = manager.attentionReviewDisabled === true;
  return [
    {
      id: "review-attention",
      label: "Review synced content (recommended)",
      action: "review-attention",
      ...(disabled
        ? {
            disabled: true,
            disabledReason: "Finish or recover the active operation first.",
          }
        : {}),
    },
  ];
}

export function blockedSyncMenuItem(
  label: string,
  manager: ManagerDescription,
): ActionMenuItem<"main" | "more" | "recovery", "sync"> | undefined {
  if (label !== "Sync now (recommended)" || !manager.attentionBlocksSync) return undefined;
  return {
    id: "sync",
    label,
    description: "Review first.",
    action: "sync",
    disabled: true,
    disabledReason: "Review synced content first.",
  };
}

export async function showManagerAttention(
  ctx: ExtensionCommandContext,
  attention: SyncAttentionState,
  runRoute: RunRoute,
  signal: AbortSignal | undefined,
  onSelectionResolved: (() => void) | undefined,
): Promise<"close" | "stay"> {
  const { showRemoteSelectionReview } = await import("./remote-selection-ui.js");
  if (signal?.aborted) return "close";
  const review = await showRemoteSelectionReview(ctx, attention.decision.setupName, signal, undefined, {
    decision: attention.decision,
    origin: attention.origin,
    runRoute,
    onSelectionResolved,
  });
  if (review.kind === "route-result") {
    const disposition = await dispatchManagerResult(ctx, review.result, review.route, runRoute, signal, {
      onSelectionResolved,
    });
    return disposition.kind;
  }
  return review.kind === "closed" || review.kind === "stale" ? "close" : "stay";
}
