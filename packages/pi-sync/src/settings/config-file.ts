export type * from "sync-daemon/engine/settings/config-file";
export {
  activeLocalConfigPath,
  consumeLocalConfigMigrationNotice,
  createLocalConfigDocument,
  legacyLocalConfigPath,
  localConfigPath,
  quarantineAndRemoveConfigIfMatches,
  readActiveLocalConfigDocumentForRepair,
  readMigratingLocalConfigDocument,
  replaceLocalConfigDocument,
  updateLocalConfigDocument,
  withConfigFilePublicationForTest,
  withConfigPublicationReadyHookForTest,
  withConfigQuarantinedHookForTest,
  withConfigReplacementInstalledHookForTest,
  withLocalConfigFileLock,
  withMissingConfigReadProbeHookForTest,
} from "sync-daemon/engine/settings/config-file";
