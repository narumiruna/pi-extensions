import { readActiveLocalConfigDocumentForRepair } from "../settings/config-file.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { safeTerminalText } from "./terminal-text.js";

export async function loadSettingsCatalog() {
  const document = await readActiveLocalConfigDocumentForRepair();
  if (!document) return undefined;
  const settings = validateSettingsDocument(document.parsed);
  const ignoreSetups = Object.entries(settings.syncSetups)
    .filter(([, setup]) => setup.sync.pathPolicy === "ignore-file")
    .map(([name]) => name);
  return { settings, path: document.path, ignoreSetups };
}

export const IGNORE_SETUP_MANAGEMENT_LIMIT =
  "Adding, editing, and switching setups are unavailable while any setup uses an ignore file.";

export function ignoreSetupRecovery(settingsPath: string) {
  return [
    `For manual recovery, close Pi and back up: ${safeTerminalText(settingsPath)}`,
    "Remove the ignore-file entries from syncSetups.",
    "Set activeSyncSetup to a remaining setup, or remove it if none remain.",
    "Keep the settings version, ignore files, and remote data unchanged.",
    "Preserve any pending journal and backup. Review automatic sync before restarting Pi.",
  ];
}
