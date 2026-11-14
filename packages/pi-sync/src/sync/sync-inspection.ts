import { createHash } from "node:crypto";
import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { throwIfAborted } from "./signals.js";
import { createStartupTimings, type StartupTimings } from "./startup-timings.js";
import { inspectRemoteSelection } from "./sync-policy.js";
import { fileHashMap, hasLocalChanges, remoteChangedSinceState } from "./sync-state.js";

/** Advisory baseline-relative observation, never an authorization to transfer files. */
export async function inspectSync(
  config: AnySyncConfig,
  options: SnapshotOptions,
  signal?: AbortSignal,
  factory: SyncBackendFactory = createSyncBackend,
  timings: StartupTimings = createStartupTimings(),
) {
  throwIfAborted(signal);
  const backend = await timings.measure("backend initialization", () => factory(config));
  throwIfAborted(signal);
  const local = await timings.measure("local snapshot", () =>
    createSnapshot(config.snapshotIdentity, { ...options, signal }),
  );
  throwIfAborted(signal);
  const state = await timings.measure("sync state read", () => readStateForConfig(config));
  throwIfAborted(signal);
  const head = await timings.measure("remote head", () => backend.readHead(signal));
  throwIfAborted(signal);
  const freshness: { localIdentity?: string } = {
    localIdentity: createHash("sha256")
      .update(JSON.stringify(fileHashMap(local)))
      .digest("hex"),
  };
  return {
    ...freshness,
    head,
    selectionState: head ? inspectRemoteSelection(config, { selection: head.selection, files: [] }) : undefined,
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
  automaticTransfer?: boolean;
  inspection: SyncInspection;
}
