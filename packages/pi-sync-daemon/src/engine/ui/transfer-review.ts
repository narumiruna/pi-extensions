import type { EngineContext } from "../host.js";
import { confirmMergeReview } from "./merge-review.js";
import type { TransferReview } from "./sync-format.js";

export async function confirmTransferReview(
  ctx: EngineContext,
  title: string,
  review: TransferReview,
  signal: AbortSignal | undefined,
  validate: () => void,
  reviewInRpc = false,
) {
  validate();
  const isCurrent = () => {
    try {
      validate();
      return true;
    } catch {
      return false;
    }
  };
  const confirmed =
    ctx.hasUI && (ctx.mode === "tui" || (reviewInRpc && ctx.mode === "rpc"))
      ? await confirmMergeReview(ctx, title, review.content, signal, isCurrent, "apply reviewed transfer", review.lines)
      : await ctx.ui.confirm(title, review.content, { signal });
  validate();
  return confirmed;
}
