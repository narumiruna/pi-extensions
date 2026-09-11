import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { throwIfAborted } from "./signals.js";
import { inspectRemoteSelection } from "./sync-policy.js";
import { hasLocalChanges, remoteChangedSinceState } from "./sync-state.js";

/** Advisory baseline-relative observation, never an authorization to transfer files. */
export async function inspectSync(
  config: AnySyncConfig,
  options: SnapshotOptions,
  signal?: AbortSignal,
  factory: SyncBackendFactory = createSyncBackend,
) {
  throwIfAborted(signal);
  const backend = await factory(config);
  throwIfAborted(signal);
  const local = await createSnapshot(config.snapshotIdentity, { ...options, signal });
  throwIfAborted(signal);
  const state = await readStateForConfig(config);
  throwIfAborted(signal);
  const head = await backend.readHead(signal);
  throwIfAborted(signal);
  return {
    head,
    selectionState: head ? inspectRemoteSelection(config.include, { selection: head.selection, files: [] }) : undefined,
    localFiles: local.files.length,
    localChanged: hasLocalChanges(local, state, config),
    remoteChanged: remoteChangedSinceState(head, state, config, (left, right) => backend.sameRevision(left, right)),
    firstSync: !state.lastAppliedSnapshot,
    emptyInclude: config.include.length === 0,
    stateIdentity: syncStateFingerprint(state),
    destination: backend.destination,
    capability: backend.capability,
  };
}

export type SyncInspection = Awaited<ReturnType<typeof inspectSync>>;

export interface StartupObservation {
  setupName: string;
  configIdentity: string;
  checkedAt: string;
  inspection: SyncInspection;
}
