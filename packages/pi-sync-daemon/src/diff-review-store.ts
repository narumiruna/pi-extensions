import type { DiffReviewInventory, DiffReviewPreview } from "./diff-review-protocol.js";
import { buildDiffReviewPreview, type DiffReviewInput } from "./engine/sync/diff-review-preview.js";

const REVIEW_LIFETIME_MS = 120_000;
export const DIFF_REVIEW_RETAINED_BYTES = 8 * 1024 * 1024;
const TOTAL_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_READS = 4;

export type DiffReviewOffer = Extract<DiffReviewInventory, { kind: "review" }>;
export interface PreparedDiffReview {
  inventory: DiffReviewOffer;
  rows: Map<string, DiffReviewInput>;
  bytes: number;
  staleSetup(signal: AbortSignal): Promise<boolean>;
}

interface Capture {
  id: string;
  rows: Map<string, DiffReviewInput>;
  bytes: number;
  staleSetup: PreparedDiffReview["staleSetup"];
  controller: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  unbind(): void;
}

export function createDiffReviewStore(options: { lifetime?: number; totalBytes?: number } = {}) {
  const lifetime = options.lifetime ?? REVIEW_LIFETIME_MS;
  const totalBytes = options.totalBytes ?? TOTAL_RETAINED_BYTES;
  const captures = new Map<object, Capture>();
  const reads = new Set<object>();
  let bytes = 0;

  function release(owner: object, id?: string) {
    const capture = captures.get(owner);
    if (!capture || (id !== undefined && id !== capture.id)) return;
    captures.delete(owner);
    bytes -= capture.bytes;
    capture.rows.clear();
    capture.controller.abort();
    capture.unbind();
    clearTimeout(capture.timer);
  }

  function current(owner: object, id: string) {
    const capture = captures.get(owner);
    if (capture?.id !== id) return;
    if (performance.now() >= capture.deadline) {
      release(owner, id);
      return;
    }
    return capture;
  }

  return {
    retain(owner: object, prepared: PreparedDiffReview, signal: AbortSignal) {
      signal.throwIfAborted();
      release(owner);
      if (prepared.bytes > DIFF_REVIEW_RETAINED_BYTES || bytes + prepared.bytes > totalBytes) return false;
      const {
        inventory: { id },
        rows,
        staleSetup,
      } = prepared;
      const abort = () => release(owner, id);
      const timer = setTimeout(abort, lifetime);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      captures.set(owner, {
        id,
        bytes: prepared.bytes,
        rows,
        staleSetup,
        timer,
        deadline: performance.now() + lifetime,
        controller: new AbortController(),
        unbind: () => signal.removeEventListener("abort", abort),
      });
      bytes += prepared.bytes;
      return true;
    },
    async read(owner: object, id: string, fileId: string, signal: AbortSignal): Promise<DiffReviewPreview> {
      signal.throwIfAborted();
      const capture = current(owner, id);
      if (!capture?.rows.has(fileId)) return { kind: "stale" };
      if (reads.has(owner) || reads.size >= MAX_READS)
        return { kind: "notice", message: "File previews are busy. Try this file again." };
      const owned = AbortSignal.any([signal, capture.controller.signal]);
      reads.add(owner);
      try {
        const stale = await capture.staleSetup(owned);
        signal.throwIfAborted();
        if (current(owner, id) !== capture) return { kind: "stale" };
        if (stale) {
          release(owner, id);
          return { kind: "stale" };
        }
        const row = capture.rows.get(fileId);
        return row ? buildDiffReviewPreview(row, owned) : { kind: "stale" };
      } finally {
        reads.delete(owner);
      }
    },
    isCurrent: (owner: object, id: string) => current(owner, id) !== undefined,
    release,
    close() {
      for (const owner of captures.keys()) release(owner);
    },
  };
}
