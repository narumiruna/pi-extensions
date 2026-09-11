import type { RemoteHead } from "../backends/sync-backend.js";
import { toPosix } from "../paths.js";
import {
  canonicalSnapshotPathForConfig,
  filterSnapshotForConfigPolicy,
  isConfiguredSnapshotPath,
  isSessionPath,
} from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import {
  customIncludePathsByLower,
  includeFromSelectionConfig,
  normalizeSyncInclude,
  type SyncSelectionConfig,
} from "./sync-policy.js";

type SyncPolicyConfig = SyncSelectionConfig;

export function hasLocalChanges(local: Snapshot, state: SyncState, config: SyncPolicyConfig) {
  return !sameHashes(fileHashMap(local), stateHashMapForConfig(state, config));
}

export function remoteChangedSinceState(
  head: RemoteHead | undefined,
  state: SyncState,
  config: SyncPolicyConfig,
  sameRevision: (left: string, right: string) => boolean,
) {
  if (!head) return Boolean(state.lastAppliedSnapshot);
  if (head.snapshotId !== state.lastAppliedSnapshot) return true;
  if (state.lastRemoteRevision && !sameRevision(head.revision, state.lastRemoteRevision)) return true;
  if (syncIncludeChanged(state, config)) return true;
  return (
    includeFromSelectionConfig(config).includes("sessions") && !state.include?.includes("sessions") && head.syncSessions
  );
}

export function hasRemoteChanges(
  remote: Snapshot,
  state: SyncState,
  config: SyncPolicyConfig,
  ignoredPaths = new Set<string>(),
) {
  if (remote.id === state.lastAppliedSnapshot && !syncPolicyChanged(state, config)) return false;
  return !snapshotHashesMatchState(filterSnapshotForConfigPolicy(remote, config), state, config, ignoredPaths);
}

export function sameHashes(left: Record<string, string>, right: Record<string, string>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

export function fileHashMap(snapshot: Snapshot) {
  return Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
}

function stateHashMapForConfig(state: SyncState, config: SyncPolicyConfig) {
  const includePaths = customIncludePathsByLower(includeFromSelectionConfig(config));
  return Object.fromEntries(
    Object.entries(state.lastFileHashes)
      .filter(([filePath]) => isConfiguredSnapshotPath(filePath, config))
      .map(([filePath, hash]) => [canonicalSnapshotPathForConfig(filePath, includePaths), hash]),
  );
}

export function snapshotHashesMatchState(
  snapshot: Snapshot,
  state: SyncState,
  config: SyncPolicyConfig,
  ignoredPaths = new Set<string>(),
) {
  return sameHashes(
    withoutHashPaths(fileHashMap(snapshot), ignoredPaths),
    withoutHashPaths(stateHashMapForConfig(state, config), ignoredPaths),
  );
}

export function snapshotsMatch(left: Snapshot, right: Snapshot) {
  return left.syncSessions === right.syncSessions && sameHashes(fileHashMap(left), fileHashMap(right));
}

function withoutHashPaths(hashes: Record<string, string>, ignoredPaths: Set<string>) {
  if (ignoredPaths.size === 0) return hashes;
  return Object.fromEntries(Object.entries(hashes).filter(([filePath]) => !ignoredPaths.has(toPosix(filePath))));
}

export function syncPolicyChanged(state: SyncState, config: SyncPolicyConfig) {
  return syncIncludeChanged(state, config);
}

export function shouldRefreshSyncedState(
  remote: Snapshot,
  head: RemoteHead | undefined,
  state: SyncState,
  config: SyncPolicyConfig,
  sameRevision: (left: string, right: string) => boolean,
) {
  return (
    remote.id !== state.lastAppliedSnapshot ||
    Boolean(head && (!state.lastRemoteRevision || !sameRevision(head.revision, state.lastRemoteRevision))) ||
    syncPolicyChanged(state, config)
  );
}

function syncIncludeChanged(state: SyncState, config: SyncPolicyConfig) {
  const stored = state.include ? normalizeSyncInclude(state.include) : includeFromSelectionConfig(state);
  const current = includeFromSelectionConfig(config);
  return stored.length !== current.length || stored.some((item, index) => item !== current[index]);
}

export function settingsHashMap(snapshot: Snapshot) {
  return Object.fromEntries(
    snapshot.files.filter((file) => !isSessionPath(file.path)).map((file) => [file.path, file.sha256]),
  );
}

export function sessionHashMap(snapshot: Snapshot) {
  return Object.fromEntries(
    snapshot.files.filter((file) => isSessionPath(file.path)).map((file) => [file.path, file.sha256]),
  );
}

export function settingsHashMapFromState(state: SyncState) {
  return Object.fromEntries(Object.entries(state.lastFileHashes).filter(([filePath]) => !isSessionPath(filePath)));
}

export function settingsHashesMatchState(remote: Snapshot, state: SyncState) {
  return sameHashes(settingsHashMap(remote), settingsHashMapFromState(state));
}

export function canPullRemoteSettingsOnFirstSync(local: Snapshot, remote: Snapshot) {
  const remoteSettings = settingsHashMap(remote);
  return Object.entries(settingsHashMap(local)).every(([filePath, hash]) => remoteSettings[filePath] === hash);
}

export function canPullRemoteSessionsOnFirstSync(local: Snapshot, remote: Snapshot) {
  const localSessions = sessionHashMap(local);
  const remoteSessions = sessionHashMap(remote);
  return Object.entries(localSessions).every(([filePath, hash]) => remoteSessions[filePath] === hash);
}
