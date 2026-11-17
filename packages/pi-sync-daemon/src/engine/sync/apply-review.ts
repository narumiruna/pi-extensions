import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { agentDir } from "../snapshot/session-paths.js";
import { addTopLevelCaseVariantDeletes } from "../snapshot/snapshot-apply.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { throwIfAborted } from "./signals.js";

export interface CaseCleanupReview {
  path: string;
  fingerprint: string;
}

/** Inspect the apply engine's additional alias removals, which logical snapshots omit. */
export async function inspectCaseCleanup(snapshot: Snapshot, signal?: AbortSignal): Promise<CaseCleanupReview[]> {
  throwIfAborted(signal);
  const root = agentDir();
  const plan = await addTopLevelCaseVariantDeletes(root, { writes: [], deletes: [] }, snapshot);
  throwIfAborted(signal);
  const review: CaseCleanupReview[] = [];
  for (const target of plan.deletes.sort()) {
    const stat = await fs.lstat(target);
    throwIfAborted(signal);
    const hash = createHash("sha256");
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(target));
    else {
      if (!stat.isFile()) throw new Error("Case-variant path is no longer a regular file or symlink.");
      const handle = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        throwIfAborted(signal);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
          throw new Error("Case-variant file changed while preparing review.");
        for await (const bytes of handle.createReadStream({ autoClose: false, signal })) {
          throwIfAborted(signal);
          hash.update(bytes);
        }
      } finally {
        await handle.close();
      }
    }
    throwIfAborted(signal);
    review.push({
      path: path.basename(target),
      fingerprint: `${stat.dev}:${stat.ino}:${stat.mode}:${hash.digest("hex")}`,
    });
  }
  return review;
}

export async function revalidateCaseCleanup(
  expected: readonly CaseCleanupReview[],
  snapshot: Snapshot,
  signal?: AbortSignal,
) {
  const current = await inspectCaseCleanup(snapshot, signal);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error("Case-variant paths changed during transfer review; reopen the preview.");
}
