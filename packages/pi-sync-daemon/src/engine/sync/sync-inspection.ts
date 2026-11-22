import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { observeSnapshot } from "../snapshot/snapshot.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { inspectHeadSelection } from "./remote-snapshot.js";
import { throwIfAborted } from "./signals.js";
import { createStartupTimings, type StartupTimings } from "./startup-timings.js";
import { syncSelectionHasContent } from "./sync-policy.js";
import { hasLocalChanges, rawSnapshotHashIdentity, remoteChangedSinceState } from "./sync-state.js";

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
    observeSnapshot({ ...options, signal }, Boolean(config.localFields?.length)),
  );
  throwIfAborted(signal);
  const state = await timings.measure("sync state read", () => readStateForConfig(config));
  throwIfAborted(signal);
  const head = await timings.measure("remote head", () => backend.readHead(signal));
  throwIfAborted(signal);
  const selectionState = head ? await inspectHeadSelection(backend, config, head, signal) : undefined;
  throwIfAborted(signal);
  const freshness: { localIdentity?: string } = {
    localIdentity: rawSnapshotHashIdentity(local),
  };
  return {
    ...freshness,
    head,
    selectionState,
    localFiles: local.files.length,
    localChanged: hasLocalChanges(local, state, config),
    remoteChanged:
      (selectionState?.kind === "different" && !!selectionState.ignorePolicyComparison) ||
      remoteChangedSinceState(head, state, config, (left, right) => backend.sameRevision(left, right)),
    firstSync: !state.lastAppliedSnapshot,
    emptyInclude: !syncSelectionHasContent(config),
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
