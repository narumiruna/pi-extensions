import { DIFF_REVIEW_REQUEST_MS, type DiffReviewPreview, isDiffReviewId } from "./diff-review-protocol.js";
import type { createDiffReviewStore } from "./diff-review-store.js";
import { validId } from "./protocol.js";

export async function handleDiffReviewRequest(
  method: "diff-review-read" | "diff-review-close",
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  store: ReturnType<typeof createDiffReviewStore>,
  currentOwner: (client: string, generation: string) => object | undefined,
  assertOwner: () => void,
  publish: (value: DiffReviewPreview | true) => void,
): Promise<void> {
  const reading = method === "diff-review-read";
  const { client, generation, id, fileId } = params;
  if (
    Object.keys(params).length !== (reading ? 4 : 3) ||
    !validId(client) ||
    !validId(generation) ||
    !isDiffReviewId(id) ||
    (reading ? !isDiffReviewId(fileId) : Object.hasOwn(params, "fileId"))
  )
    throw new Error("Invalid diff review request.");
  const owner = currentOwner(client, generation);
  if (!reading) {
    if (owner) store.release(owner, id);
    publish(true);
    return;
  }
  const stale = { kind: "stale" } satisfies DiffReviewPreview;
  if (!owner || !isDiffReviewId(fileId)) {
    publish(stale);
    return;
  }
  if (!signal) throw new Error("File preview transport is unavailable.");
  const owned = AbortSignal.any([signal, AbortSignal.timeout(DIFF_REVIEW_REQUEST_MS)]);
  let result: DiffReviewPreview;
  try {
    result = await store.read(owner, id, fileId, owned);
    owned.throwIfAborted();
    assertOwner();
  } catch {
    throw new Error("File preview could not be loaded. Try again or reopen the review.");
  }
  publish(currentOwner(client, generation) === owner && store.isCurrent(owner, id) ? result : stale);
}
