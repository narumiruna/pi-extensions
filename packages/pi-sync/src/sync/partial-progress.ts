import type { RemoteHead } from "../backends/sync-backend.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import type { FileMergeDecision } from "./file-merge-planner.js";
import { fileHashMap } from "./sync-state.js";
/** Withholding preserves the complete local version, including explicit absence. */
export function acceptedMergeFiles(
  decisions: readonly FileMergeDecision[],
  localFiles: readonly SnapshotFile[],
  withheld: ReadonlySet<string>,
) {
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  return decisions.flatMap((decision) => {
    const file = withheld.has(decision.path)
      ? localByPath.get(decision.path)
      : decision.kind === "accepted"
        ? decision.file
        : undefined;
    return file ? [file] : [];
  });
}

export interface PartialProgress {
  previous: SyncState;
  groups: { paths: string[]; artifact: string }[];
}
export function progressState(
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  progress: PartialProgress,
): SyncState {
  const withheld = new Set(progress.groups.flatMap((group) => group.paths));
  const current = fileHashMap(snapshot);
  const hashes = Object.assign(Object.create(null) as Record<string, string>, progress.previous.lastFileHashes);
  for (const key of new Set([...Object.keys(hashes), ...Object.keys(current)])) {
    if (withheld.has(key)) continue;
    const value = current[key];
    if (value === undefined) delete hashes[key];
    else hashes[key] = value;
  }
  return {
    ...progress.previous,
    version: 3,
    profile: config.snapshotIdentity,
    lastFileHashes: hashes,
    include: [...config.include],
    syncIgnore: config.syncIgnore,
    localFields: config.localFields,
    lastObservedSnapshot: head.snapshotId,
    lastObservedRevision: head.revision,
    unresolved: progress.groups,
  };
}
