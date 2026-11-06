import { localConfigPath, readMigratingLocalConfigDocument, updateLocalConfigDocument } from "./config-file.js";
import type { OnSwitchAction, PiSyncSettingsV3 } from "./settings-types.js";
import { DEFAULT_ON_SWITCH, validateSettingsDocument } from "./settings-validation.js";

export async function requireSettings() {
  const settings = await readLocalConfigObject();
  if (!settings) {
    throw new Error(`Missing pi-sync settings. Open /sync and choose Set up sync, or create ${localConfigPath()}.`);
  }
  return settings;
}

export async function configuredSyncSetupNames() {
  const settings = await readLocalConfigObject();
  return settings ? Object.keys(settings.syncSetups).sort((left, right) => left.localeCompare(right)) : [];
}

export async function loadOnSwitch(): Promise<OnSwitchAction> {
  return (await requireSettings()).onSwitch;
}

export function localConfigTemplate(): PiSyncSettingsV3 {
  return {
    version: 3,
    onSwitch: DEFAULT_ON_SWITCH,
    skipSecretScan: false,
    showStatus: true,
    debug: false,
    storageConnections: {},
    syncSetups: {},
  };
}

export async function readLocalConfigDocument() {
  const document = await readMigratingLocalConfigDocument((settings) => {
    validateSettingsDocument(settings);
  });
  if (document) validateSettingsDocument(document.parsed);
  return document;
}

export async function readLocalConfigObject(): Promise<PiSyncSettingsV3 | undefined> {
  return (await readLocalConfigDocument())?.parsed as PiSyncSettingsV3 | undefined;
}

export function updateLocalConfig(update: (current: PiSyncSettingsV3) => PiSyncSettingsV3, signal?: AbortSignal) {
  return updateLocalConfigDocument(localConfigTemplate(), update, validateSettingsDocument, signal);
}
