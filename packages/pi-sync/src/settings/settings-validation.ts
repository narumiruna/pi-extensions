export type * from "@narumitw/sync-daemon/engine/settings/settings-validation";
export {
  DEFAULT_ON_SWITCH,
  effectiveSyncSetupRemoteIdentity,
  isCloudflareR2Endpoint,
  normalizeOnSwitch,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  normalizeStoragePath,
  optionalString,
  ownObject,
  ownRecord,
  requiredString,
  validateConfigName,
  validateSettingsDocument,
  validateUniqueRemoteSyncSetups,
} from "@narumitw/sync-daemon/engine/settings/settings-validation";
