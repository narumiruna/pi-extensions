export interface SyncConfig {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	profile: string;
	prefix: string;
	syncFiles?: string[];
	syncSessions: boolean;
	extraFiles: string[];
}

export interface PartialConfig {
	endpoint?: string;
	bucket?: string;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
	profile?: string;
	prefix?: string;
	autoSync?: boolean | string;
	syncFiles?: unknown;
	syncSessions?: boolean | string;
	extraFiles?: unknown;
}

export interface SnapshotFile {
	path: string;
	contentBase64: string;
	sha256: string;
}

export interface Snapshot {
	version: number;
	id: string;
	createdAt: string;
	machine: string;
	profile: string;
	syncSessions?: boolean;
	files: SnapshotFile[];
}

export interface LatestPointer {
	version: number;
	profile: string;
	snapshot: string;
	sha256: string;
	createdAt: string;
	machine: string;
	syncSessions?: boolean;
}

export interface RemoteObject<T> {
	value?: T;
	etag?: string;
	missing: boolean;
}

export interface SyncState {
	version: number;
	profile: string;
	lastAppliedSnapshot?: string;
	lastRemoteEtag?: string;
	lastFileHashes: Record<string, string>;
	syncFiles?: string[];
	syncSessions?: boolean;
	extraFiles?: string[];
}

export interface LockFile {
	id: string;
	pid: number;
	command: string;
	startedAt: string;
}

export interface CommandOptions {
	yes: boolean;
	force: boolean;
	stale: boolean;
	silent: boolean;
	reload: boolean;
	auto: boolean;
	args: string[];
}

export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface SnapshotOptions {
	syncFiles?: string[];
	syncSessions?: boolean;
	sessionDir?: string;
	extraFiles?: string[];
}

export interface SnapshotApplyPlan {
	writes: Array<{ target: string; content: Buffer }>;
	deletes: string[];
}
