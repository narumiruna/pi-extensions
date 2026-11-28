import type { ForegroundTransferIntent } from "../../foreground-transfer.js";
import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { sameRemoteHead } from "./remote-snapshot.js";
import { fileHashMap, sameHashes, stateHashMapForConfig } from "./sync-state.js";

export class DirectionalDestinationConflict extends Error {}

export class DirectionalReviewChangedError extends Error {
  constructor() {
    super("The transfer contents changed again. Start from a fresh review.");
  }
}

export function needsDirectionalForce(
  intent: ForegroundTransferIntent,
  config: AnySyncConfig,
  state: SyncState,
  destination: Snapshot | undefined,
  candidate: Snapshot,
  protectedPaths: ReadonlySet<string>,
) {
  const current = new Map(destination?.files.map(({ path, sha256 }) => [path, sha256]));
  const proposed = new Map(candidate.files.map(({ path, sha256 }) => [path, sha256]));
  const accepted = state.lastAppliedSnapshot
    ? new Map(Object.entries(stateHashMapForConfig(state, config)))
    : new Map();
  const conflicts = [...new Set([...accepted.keys(), ...current.keys()])].some(
    (path) =>
      !protectedPaths.has(path) && current.get(path) !== accepted.get(path) && current.get(path) !== proposed.get(path),
  );
  if (conflicts && !state.lastAppliedSnapshot)
    throw new Error(
      "This destination has no accepted sync baseline. Review first sync with Sync… before replacing content.",
    );
  if (!conflicts && intent === "review-force")
    throw new Error("The destination no longer has a content conflict. Start a normal transfer again.");
  return conflicts;
}

export async function recheckDirectionalReview(
  backend: SyncBackend,
  head: RemoteHead | undefined,
  local: Snapshot,
  options: SnapshotOptions,
  validate: () => void,
) {
  const currentHead = await backend.readHead(options.signal);
  validate();
  const currentLocal = await createSnapshot(local.profile, options);
  validate();
  if (!sameRemoteHead(backend, head, currentHead) || !sameHashes(fileHashMap(local), fileHashMap(currentLocal)))
    throw new DirectionalReviewChangedError();
}
