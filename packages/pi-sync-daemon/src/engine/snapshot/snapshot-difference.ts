import type { DiffReviewStatus } from "../../diff-review-protocol.js";
import type { SnapshotFileHash } from "./snapshot-types.js";

export interface SnapshotDifference<T extends SnapshotFileHash> {
  path: string;
  status: DiffReviewStatus;
  local: T | undefined;
  remote: T | undefined;
}

export function snapshotDifferences<T extends SnapshotFileHash>(
  local: readonly T[],
  remote: readonly T[] = [],
): SnapshotDifference<T>[] {
  const left = new Map(local.map((file) => [file.path, file]));
  const right = new Map(remote.map((file) => [file.path, file]));
  const differences: SnapshotDifference<T>[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const local = left.get(path);
    const remote = right.get(path);
    if (local?.sha256 === remote?.sha256) continue;
    differences.push({ path, status: !local ? "remote-only" : !remote ? "local-only" : "different", local, remote });
  }
  return differences;
}
