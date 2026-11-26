import { createHash } from "node:crypto";
import type { RemoteHead } from "../backends/sync-backend.js";
import { toPosix } from "../paths.js";
import { canonicalSnapshotPathForConfig, filterSnapshotForConfigPolicy, isSessionPath } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotFileHash, SnapshotObservation } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { sameSyncExclude } from "./exclude-policy.js";
import { portableObservation, portableSnapshot, sameLocalFields } from "./local-fields.js";
import {
  configuredSnapshotPathMatcher,
  customIncludePathsByLower,
  includeFromSelectionConfig,
  normalizeSyncInclude,
  type SyncSelectionConfig,
  syncDirectoryPolicyKey,
  syncSessionsSelected,
} from "./sync-policy.js";

type SyncPolicyConfig = SyncSelectionConfig & {
  localFields?: string[];
  setupName?: string;
};

export function hasLocalChanges(local: Snapshot | SnapshotObservation, state: SyncState, config: SyncPolicyConfig) {
  if (
    state.lastAppliedSnapshot &&
    (state.scope !== config.scope ||
      !sameLocalFields(state.localFields, config.localFields) ||
      !sameSelectionRules(state, config))
  )
    return true;
  const portable =
    "version" in local ? portableSnapshot(local, config.localFields) : portableObservation(local, config.localFields);
  return !sameHashes(fileHashMap(portable), stateHashMapForConfig(state, config));
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
  if (syncPolicyChanged(state, config)) return true;
  return (
    syncSessionsSelected(config) &&
    (!state.include?.includes("sessions") || !syncSessionsSelected(state)) &&
    head.syncSessions
  );
}

export function hasRemoteChanges(
  remote: Snapshot,
  state: SyncState,
  config: SyncPolicyConfig,
  ignoredPaths = new Set<string>(),
) {
  if (remote.id === state.lastAppliedSnapshot && !syncPolicyChanged(state, config)) return false;
  return !snapshotHashesMatchState(
    portableSnapshot(filterSnapshotForConfigPolicy(remote, config), remote.localFields),
    state,
    config,
    ignoredPaths,
  );
}

export function sameHashes(left: Record<string, string>, right: Record<string, string>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

export function fileHashMap(snapshot: { files: readonly SnapshotFileHash[] }) {
  return Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
}

export function rawSnapshotHashIdentity(snapshot: { files: readonly SnapshotFileHash[] }) {
  return createHash("sha256")
    .update(JSON.stringify(fileHashMap(snapshot)))
    .digest("hex");
}

function stateHashMapForConfig(state: SyncState, config: SyncPolicyConfig) {
  const includePaths = customIncludePathsByLower(includeFromSelectionConfig(config));
  const configured = configuredSnapshotPathMatcher(config);
  return Object.fromEntries(
    Object.entries(state.lastFileHashes)
      .filter(([filePath]) => configured(filePath))
      .map(([filePath, hash]) => [
        config.scope === "agent-directory" ? filePath : canonicalSnapshotPathForConfig(filePath, includePaths),
        hash,
      ]),
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
  return (
    state.scope !== config.scope ||
    syncIncludeChanged(state, config) ||
    !sameSelectionRules(state, config) ||
    !sameLocalFields(state.localFields, config.localFields)
  );
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

export function acceptedSelection(config: {
  include: string[];
  exclude?: string[];
  scope?: "agent-directory";
  reinclude?: string[];
}) {
  return {
    include: [...config.include],
    ...(config.exclude === undefined ? {} : { exclude: [...config.exclude] }),
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    ...(config.reinclude === undefined ? {} : { reinclude: [...config.reinclude] }),
  };
}

function sameSelectionRules(state: SyncState, config: SyncPolicyConfig) {
  return config.scope === "agent-directory" && state.scope === config.scope
    ? syncDirectoryPolicyKey(state) === syncDirectoryPolicyKey(config)
    : sameSyncExclude(state.exclude, config.exclude);
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
