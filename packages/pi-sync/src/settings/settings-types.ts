import type { ResolvedS3Backend, ResolvedSyncBackend } from "../backends/backend-types.js";
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
