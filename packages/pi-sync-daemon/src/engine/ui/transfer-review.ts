import type { EngineContext } from "../host.js";
import { confirmMergeReview } from "./merge-review.js";

/** Presentation is supplied by the host; RPC keeps its existing directional confirmation. */
export async function confirmTransferReview(
  ctx: EngineContext,
  title: string,
  content: string,
  signal: AbortSignal | undefined,
  validate: () => void,
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
    ctx.mode === "tui" && ctx.hasUI
      ? await confirmMergeReview(ctx, title, content, signal, isCurrent, "apply reviewed transfer", content.split("\n"))
      : await ctx.ui.confirm(title, content, { signal });
  validate();
  return confirmed;
}
