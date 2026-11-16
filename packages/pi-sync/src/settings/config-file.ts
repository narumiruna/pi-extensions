export type * from "@narumitw/sync-daemon/engine/settings/config-file";
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
} from "@narumitw/sync-daemon/engine/settings/config-file";
