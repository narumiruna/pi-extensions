import type { RemoteHead } from "../backends/sync-backend.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { stageMergeBaseline } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import { syncStateFingerprint, writeStateForConfig } from "../state/sync-state-store.js";
import { portableSnapshot } from "./local-fields.js";
import { type PartialProgress, progressState } from "./partial-progress.js";
import { acceptedSelection, fileHashMap } from "./sync-state.js";

export function matchesAcceptedState(
  state: SyncState,
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  progress?: PartialProgress,
) {
  return [true, false].some(
    (canonical) =>
      syncStateFingerprint(state) === syncStateFingerprint(acceptedState(config, head, snapshot, progress, canonical)),
  );
}

export function acceptedState(
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  progress?: PartialProgress,
  canonical = true,
) {
  if (progress) return progressState(config, head, snapshot, progress);
  return {
    version: 1,
    profile: config.snapshotIdentity,
    lastAppliedSnapshot: head.snapshotId,
    lastRemoteRevision: head.revision,
    lastFileHashes: fileHashMap(canonical ? portableSnapshot(snapshot, config.localFields) : snapshot),
    ...acceptedSelection(config),
    ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
  };
}

export async function writeAcceptedState(
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  validate: () => Promise<void>,
  progress?: PartialProgress,
) {
  const accepted = portableSnapshot(snapshot, config.localFields);
  const state = acceptedState(config, head, accepted, progress);
  await stageMergeBaseline(config, accepted, state, progress?.previous);
  await validate();
  await writeStateForConfig(config, state);
  await validate();
}
