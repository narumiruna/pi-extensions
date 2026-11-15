import { type EngineContext, engineHost } from "../host.js";
export async function confirmMergeReview(
  ctx: EngineContext,
  title: string,
  content: string,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
  confirmationLabel = "apply changes",
  summaryLines?: readonly string[],
) {
  if (signal?.aborted || !isCurrent()) return false;
  const result = await engineHost().review(ctx, { title, content, confirmationLabel, summaryLines }, signal, isCurrent);
  return !signal?.aborted && isCurrent() && result;
}
