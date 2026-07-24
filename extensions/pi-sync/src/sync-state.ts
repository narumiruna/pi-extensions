import { toPosix } from "./paths.js";
import {
	canonicalSnapshotPathForConfig,
	filterSnapshotForConfigPolicy,
	isConfiguredSnapshotPath,
	isSessionPath,
} from "./snapshot.js";
import { extraFilePathsByLower, normalizeExtraFiles, normalizeSyncFiles } from "./sync-policy.js";
import type { LatestPointer, RemoteObject, Snapshot, SyncConfig, SyncState } from "./types.js";

export function hasLocalChanges(local: Snapshot, state: SyncState, config: SyncConfig) {
	return !sameHashes(fileHashMap(local), stateHashMapForConfig(state, config));
}

export function remoteChangedSinceState(
	latest: RemoteObject<LatestPointer>,
	state: SyncState,
	config: SyncConfig,
) {
	if (latest.missing) return Boolean(state.lastAppliedSnapshot);
	if (latest.value?.snapshot !== state.lastAppliedSnapshot) return true;
	if (syncFilesChanged(state, config) || extraFilesChanged(state, config)) return true;
	return config.syncSessions && state.syncSessions !== true && latest.value?.syncSessions === true;
}

export function hasRemoteChanges(
	remote: Snapshot,
	state: SyncState,
	config: SyncConfig,
	ignoredPaths = new Set<string>(),
) {
	if (remote.id === state.lastAppliedSnapshot && !syncPolicyChanged(state, config)) return false;
	return !snapshotHashesMatchState(
		filterSnapshotForConfigPolicy(remote, config),
		state,
		config,
		ignoredPaths,
	);
}

export function sameHashes(left: Record<string, string>, right: Record<string, string>) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

export function fileHashMap(snapshot: Snapshot) {
	return Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
}

function stateHashMapForConfig(
	state: SyncState,
	config: Pick<SyncConfig, "syncFiles" | "syncSessions" | "extraFiles">,
) {
	const extraFilePaths = extraFilePathsByLower(config.extraFiles);
	const extraFiles = new Set(extraFilePaths.keys());
	return Object.fromEntries(
		Object.entries(state.lastFileHashes)
			.filter(([filePath]) => isConfiguredSnapshotPath(filePath, config, extraFiles))
			.map(([filePath, hash]) => [canonicalSnapshotPathForConfig(filePath, extraFilePaths), hash]),
	);
}

export function snapshotHashesMatchState(
	snapshot: Snapshot,
	state: SyncState,
	config: Pick<SyncConfig, "syncFiles" | "syncSessions" | "extraFiles">,
	ignoredPaths = new Set<string>(),
) {
	return sameHashes(
		withoutHashPaths(fileHashMap(snapshot), ignoredPaths),
		withoutHashPaths(stateHashMapForConfig(state, config), ignoredPaths),
	);
}

export function snapshotsMatch(left: Snapshot, right: Snapshot) {
	return (
		left.syncSessions === right.syncSessions && sameHashes(fileHashMap(left), fileHashMap(right))
	);
}

function withoutHashPaths(hashes: Record<string, string>, ignoredPaths: Set<string>) {
	if (ignoredPaths.size === 0) return hashes;
	return Object.fromEntries(
		Object.entries(hashes).filter(([filePath]) => !ignoredPaths.has(toPosix(filePath))),
	);
}

export function syncPolicyChanged(
	state: SyncState,
	config: Pick<SyncConfig, "syncFiles" | "syncSessions" | "extraFiles">,
) {
	return (
		syncFilesChanged(state, config) ||
		(state.syncSessions ?? false) !== config.syncSessions ||
		extraFilesChanged(state, config)
	);
}

export function shouldRefreshSyncedState(
	remote: Snapshot,
	state: SyncState,
	config: Pick<SyncConfig, "syncFiles" | "syncSessions" | "extraFiles">,
) {
	return remote.id !== state.lastAppliedSnapshot || syncPolicyChanged(state, config);
}

function syncFilesChanged(state: SyncState, config: Pick<SyncConfig, "syncFiles">) {
	return !sameStringSet(normalizeSyncFiles(state.syncFiles), normalizeSyncFiles(config.syncFiles));
}

function extraFilesChanged(state: SyncState, config: Pick<SyncConfig, "extraFiles">) {
	return !sameStringSet(
		normalizeExtraFiles(state.extraFiles),
		normalizeExtraFiles(config.extraFiles),
	);
}

function sameStringSet(left: string[], right: string[]) {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((item) => rightSet.has(item));
}

export function settingsHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files
			.filter((file) => !isSessionPath(file.path))
			.map((file) => [file.path, file.sha256]),
	);
}

export function sessionHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files
			.filter((file) => isSessionPath(file.path))
			.map((file) => [file.path, file.sha256]),
	);
}

export function settingsHashMapFromState(state: SyncState) {
	return Object.fromEntries(
		Object.entries(state.lastFileHashes).filter(([filePath]) => !isSessionPath(filePath)),
	);
}

export function settingsHashesMatchState(remote: Snapshot, state: SyncState) {
	return sameHashes(settingsHashMap(remote), settingsHashMapFromState(state));
}

export function canPullRemoteSettingsOnFirstSync(local: Snapshot, remote: Snapshot) {
	const remoteSettings = settingsHashMap(remote);
	return Object.entries(settingsHashMap(local)).every(
		([filePath, hash]) => remoteSettings[filePath] === hash,
	);
}

export function canPullRemoteSessionsOnFirstSync(local: Snapshot, remote: Snapshot) {
	const localSessions = sessionHashMap(local);
	const remoteSessions = sessionHashMap(remote);
	return Object.entries(localSessions).every(
		([filePath, hash]) => remoteSessions[filePath] === hash,
	);
}
