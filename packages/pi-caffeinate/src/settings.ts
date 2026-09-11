import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const NEW_SETTINGS_FILE = "pi-caffeinate.json";
const LEGACY_SETTINGS_FILE = "pi-caffeinate-settings.json";

export type CaffeinateMode = "sleep" | "display";

export interface CaffeinateSettings {
  mode: CaffeinateMode;
  quiet: boolean;
  updatedAt: number;
}

export interface SettingsFileOperations {
  write(path: string, data: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
  write: (path, data) => writeFile(path, data, "utf8").then(() => undefined),
  rename,
};

export type SettingsLoadResult =
  | { kind: "missing"; notice?: string }
  | { kind: "invalid"; reason: string; notice?: string }
  | { kind: "loaded"; settings: CaffeinateSettings; notice?: string };

export async function loadSettings(): Promise<SettingsLoadResult> {
  await settingsSaveQueue;
  const newPath = settingsFilePath();
  const newSettings = await readSettingsFile(newPath);
  if (newSettings.kind !== "missing") return withLegacyIgnoredNotice(newSettings);

  const legacyPath = legacySettingsFilePath();
  const legacySettings = await readSettingsFile(legacyPath);
  const concurrentlyCreatedSettings = await readSettingsFile(newPath);
  if (concurrentlyCreatedSettings.kind !== "missing") {
    return withLegacyIgnoredNotice(concurrentlyCreatedSettings);
  }
  if (legacySettings.kind === "missing") return { kind: "missing" };
  if (legacySettings.kind === "invalid") return legacySettings;

  return {
    ...legacySettings,
    notice: `Using legacy ${LEGACY_SETTINGS_FILE}; rename it to ${NEW_SETTINGS_FILE}. Future saves write ${NEW_SETTINGS_FILE} without modifying the legacy file.`,
  };
}

interface SettingsDocumentResult {
  result: SettingsLoadResult;
  document?: Record<string, unknown>;
}

async function readSettingsDocument(filePath: string): Promise<SettingsDocumentResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
    return { result: { kind: "invalid", reason: `${filePath}: ${formatError(error)}` } };
  }
  try {
    const document = JSON.parse(text) as unknown;
    const settings = normalizeCaffeinateSettings(document);
    if (settings) {
      return {
        result: { kind: "loaded", settings },
        document: { ...(document as Record<string, unknown>) },
      };
    }
    return {
      result: {
        kind: "invalid",
        reason: `${filePath}: expected { "mode": "sleep" | "display", optional "quiet": boolean }`,
      },
    };
  } catch (error) {
    return { result: { kind: "invalid", reason: `${filePath}: ${formatError(error)}` } };
  }
}

async function readSettingsFile(filePath: string): Promise<SettingsLoadResult> {
  return (await readSettingsDocument(filePath)).result;
}

async function withLegacyIgnoredNotice(settings: SettingsLoadResult): Promise<SettingsLoadResult> {
  if (!(await fileExists(legacySettingsFilePath()))) return settings;
  return {
    ...settings,
    notice: `pi-caffeinate legacy settings ignored: ${legacySettingsFilePath()} exists, but ${settingsFilePath()} takes precedence. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
  };
}

async function fileExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function normalizeCaffeinateSettings(value: unknown): CaffeinateSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = value as { mode?: unknown; quiet?: unknown; updatedAt?: unknown };
  if (!isCaffeinateMode(settings.mode)) return undefined;
  if (settings.quiet !== undefined && typeof settings.quiet !== "boolean") return undefined;
  if (settings.updatedAt !== undefined && typeof settings.updatedAt !== "number") return undefined;
  return {
    mode: settings.mode,
    quiet: settings.quiet ?? false,
    updatedAt: settings.updatedAt ?? 0,
  };
}

function isCaffeinateMode(value: unknown): value is CaffeinateMode {
  return value === "sleep" || value === "display";
}

let settingsSaveQueue: Promise<unknown> = Promise.resolve();

export function saveSettings(
  settings: Omit<CaffeinateSettings, "quiet"> & { quiet?: boolean },
  operations: Partial<SettingsFileOperations> = {},
): Promise<CaffeinateSettings> {
  const operation = settingsSaveQueue.then(() => saveSettingsNow(settings, operations));
  settingsSaveQueue = operation.catch(() => undefined);
  return operation;
}

async function saveSettingsNow(
  settings: Omit<CaffeinateSettings, "quiet"> & { quiet?: boolean },
  operations: Partial<SettingsFileOperations>,
): Promise<CaffeinateSettings> {
  const filePath = settingsFilePath();
  let current = await readSettingsDocument(filePath);
  const replaceCanonical = current.result.kind !== "missing";
  if (!replaceCanonical) current = await readSettingsDocument(legacySettingsFilePath());
  if (current.result.kind === "invalid") {
    throw new Error(`Cannot save pi-caffeinate settings until you repair ${current.result.reason}`);
  }
  const document = current.document ?? {};
  const quiet = settings.quiet ?? (current.result.kind === "loaded" ? current.result.settings.quiet : false);
  const nextSettings = { mode: settings.mode, quiet, updatedAt: settings.updatedAt };
  const nextDocument = {
    ...document,
    ...nextSettings,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(tempFile, `${JSON.stringify(nextDocument, null, 2)}\n`);
    if (!replaceCanonical && (await pathEntryExists(filePath))) {
      throw new Error(`${NEW_SETTINGS_FILE} was created concurrently; reopen settings and retry.`);
    }
    await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(tempFile, filePath);
    return nextSettings;
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function settingsFilePath() {
  return join(agentDir(), NEW_SETTINGS_FILE);
}

function legacySettingsFilePath() {
  return join(agentDir(), LEGACY_SETTINGS_FILE);
}

function agentDir() {
  return getAgentDir();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
