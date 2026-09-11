import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { localConfigPath, readMigratingLocalConfigDocument, updateLocalConfigDocument } from "./config-file.js";
import type { OnSwitchAction, PiSyncSettingsV3 } from "./settings-types.js";
import { DEFAULT_ON_SWITCH, validateSettingsDocument } from "./settings-validation.js";

let configUpdateQueue: Promise<void> = Promise.resolve();

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
  const operation = configUpdateQueue.then(() => {
    signal?.throwIfAborted();
    return performLocalConfigUpdate(update, signal);
  });
  configUpdateQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function performLocalConfigUpdate(update: (current: PiSyncSettingsV3) => PiSyncSettingsV3, signal?: AbortSignal) {
  return updateLocalConfigDocument(localConfigTemplate(), update, validateSettingsDocument, signal);
}

export async function writeLocalConfigObject(value: PiSyncSettingsV3 | Record<string, unknown>) {
  validateSettingsDocument(value as Record<string, unknown>);
  const configPath = localConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    const stat = await fs.lstat(configPath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlinked pi-sync settings: ${configPath}`);
    if (!stat.isFile()) throw new Error(`pi-sync settings are not a regular file: ${configPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
