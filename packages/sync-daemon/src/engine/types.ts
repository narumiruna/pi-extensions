// Compatibility type surface; implementation modules import from the owning domain.

export type {
  LatestPointer,
  RemoteObject,
  ResolvedGitBackend,
  ResolvedGitDestination,
  ResolvedGitStorageProfile,
  ResolvedS3Backend,
  ResolvedS3Destination,
  ResolvedS3StorageProfile,
  ResolvedSyncBackend,
  ResolvedWebDavBackend,
  ResolvedWebDavDestination,
  ResolvedWebDavStorageProfile,
} from "./backends/backend-types.js";
export type { CommandArgumentCompletion, CommandOptions } from "./commands/command-types.js";
export type {
  AnySyncConfig,
  CommonSyncConfig,
  CommonSyncSetupStorageSettings,
  GitStorageConnectionSettings,
  GitSyncSetupStorageSettings,
  OnSwitchAction,
  PartialConfig,
  PiSyncSettingsV3,
  S3CredentialsSettings,
  S3StorageConnectionSettings,
  S3SyncSetupStorageSettings,
  StorageConnectionSettings,
  StorageConnectionType,
  SyncConfig,
  SyncPolicySettings,
  SyncSetupSettings,
  SyncSetupStorageSettings,
  WebDavCredentialsSettings,
  WebDavStorageConnectionSettings,
  WebDavSyncSetupStorageSettings,
} from "./settings/settings-types.js";
export type {
  Snapshot,
  SnapshotApplyPlan,
  SnapshotFile,
  SnapshotOptions,
  SnapshotSelection,
} from "./snapshot/snapshot-types.js";
export type { LockFile, SyncState } from "./state/state-types.js";
