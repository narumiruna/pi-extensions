export type StorageConnectionType = "s3" | "git" | "webdav";
export type OnSwitchAction = "ask-before-pull" | "pull-after-switch" | "switch-only";

export interface S3CredentialsSettings {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	[key: string]: unknown;
}

export interface WebDavCredentialsSettings {
	username: string;
	password: string;
	[key: string]: unknown;
}

export interface S3StorageConnectionSettings {
	type: "s3";
	endpoint: string;
	region: string;
	credentials: S3CredentialsSettings;
	remote?: never;
	url?: never;
	[key: string]: unknown;
}

export interface GitStorageConnectionSettings {
	type: "git";
	remote: string;
	endpoint?: never;
	region?: never;
	credentials?: never;
	url?: never;
	[key: string]: unknown;
}

export interface WebDavStorageConnectionSettings {
	type: "webdav";
	url: string;
	credentials: WebDavCredentialsSettings;
	endpoint?: never;
	region?: never;
	remote?: never;
	[key: string]: unknown;
}

export type StorageConnectionSettings =
	| S3StorageConnectionSettings
	| GitStorageConnectionSettings
	| WebDavStorageConnectionSettings;

export interface CommonSyncSetupStorageSettings {
	connection: string;
	path: string;
	[key: string]: unknown;
}

export interface S3SyncSetupStorageSettings extends CommonSyncSetupStorageSettings {
	bucket: string;
	branch?: never;
}

export interface GitSyncSetupStorageSettings extends CommonSyncSetupStorageSettings {
	branch: string;
	bucket?: never;
}

export interface WebDavSyncSetupStorageSettings extends CommonSyncSetupStorageSettings {
	bucket?: never;
	branch?: never;
}

export type SyncSetupStorageSettings =
	| S3SyncSetupStorageSettings
	| GitSyncSetupStorageSettings
	| WebDavSyncSetupStorageSettings;

export interface SyncPolicySettings {
	include: string[];
	automatic: boolean;
	[key: string]: unknown;
}

export interface SyncSetupSettings {
	storage: SyncSetupStorageSettings;
	sync: SyncPolicySettings;
	[key: string]: unknown;
}

export interface PiSyncSettingsV3 {
	version: 3;
	activeSyncSetup?: string;
	onSwitch: OnSwitchAction;
	skipSecretScan?: boolean;
	storageConnections: Record<string, StorageConnectionSettings>;
	syncSetups: Record<string, SyncSetupSettings>;
	[key: string]: unknown;
}

/** Backend-only resolved S3 connection fields. */
export interface ResolvedS3StorageProfile {
	kind: "r2" | "s3-compatible";
	endpoint: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** Backend-only coordinates. `prefix` is the complete reviewed v3 storage path. */
export interface ResolvedS3Destination {
	bucket: string;
	prefix: string;
	/** Snapshot/wire identity; never derived from the local setup name. */
	namespace: string;
}

export interface ResolvedS3Backend {
	type: "s3";
	profile: ResolvedS3StorageProfile;
	destination: ResolvedS3Destination;
}

export interface ResolvedWebDavStorageProfile {
	kind: "webdav";
	url: string;
	username: string;
	password: string;
}

/** Backend-only coordinates. `path` is the complete reviewed v3 storage path. */
export interface ResolvedWebDavDestination {
	path: string;
	namespace: string;
}

export interface ResolvedWebDavBackend {
	type: "webdav";
	profile: ResolvedWebDavStorageProfile;
	destination: ResolvedWebDavDestination;
}

export interface ResolvedGitStorageProfile {
	kind: "git";
	remote: string;
}

/** Backend-only coordinates. `directory` is the complete reviewed v3 storage path. */
export interface ResolvedGitDestination {
	branch: string;
	directory: string;
	namespace: string;
}

export interface ResolvedGitBackend {
	type: "git";
	profile: ResolvedGitStorageProfile;
	destination: ResolvedGitDestination;
}

export type ResolvedSyncBackend = ResolvedS3Backend | ResolvedWebDavBackend | ResolvedGitBackend;

export interface SyncConfig<Backend extends ResolvedSyncBackend = ResolvedS3Backend> {
	setupName: string;
	connectionName: string;
	storagePath: string;
	/** Snapshot/wire identity retained behind the settings normalization boundary. */
	snapshotIdentity: string;
	include: string[];
	automatic: boolean;
	onSwitch: OnSwitchAction;
	skipSecretScan: boolean;
	backend: Backend;
}

export type AnySyncConfig = SyncConfig<ResolvedSyncBackend>;
export type CommonSyncConfig = Omit<AnySyncConfig, "backend">;

/** UI projection over a fully validated v3 setup; it is never persisted directly. */
export interface PartialConfig {
	setupName: string;
	connectionName: string;
	storageKind: StorageConnectionType;
	storagePath: string;
	include: string[];
	automatic: boolean;
	onSwitch: OnSwitchAction;
	bucket?: string;
	branch?: string;
}

export interface SnapshotFile {
	path: string;
	contentBase64: string;
	sha256: string;
}

export interface SnapshotSelection {
	version: 1;
	include: string[];
}

export interface Snapshot {
	version: number;
	id: string;
	createdAt: string;
	machine: string;
	/** Backend-scoped remote identity retained in the snapshot wire format. */
	profile: string;
	syncSessions?: boolean;
	/** Portable, credential-free included-content intent. Absent on legacy snapshots. */
	selection?: SnapshotSelection;
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
	/** Lightweight projection; the immutable snapshot remains authoritative. */
	selection?: SnapshotSelection;
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
	lastRemoteRevision?: string;
	lastRemoteEtag?: string;
	lastFileHashes: Record<string, string>;
	include?: string[];
	/** Legacy state fields are read only so v3 can detect and replace stale policy state. */
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
	setup?: string;
	signal?: AbortSignal;
	onCommit?: () => void;
	args: string[];
}

export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface SnapshotOptions {
	include?: string[];
	sessionDir?: string;
	/** Temporary internal projections while snapshot storage remains wire-compatible. */
	syncFiles?: string[];
	syncSessions?: boolean;
	extraFiles?: string[];
}

export interface SnapshotApplyPlan {
	writes: Array<{ target: string; content: Buffer }>;
	deletes: string[];
}
