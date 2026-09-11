import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tool-names.js";

const NEW_SETTINGS_FILE = "pi-firecrawl.json";
const LEGACY_SETTINGS_FILE = "pi-firecrawl-settings.json";

export interface FirecrawlSettings {
  tools: FirecrawlToolName[];
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
  | { kind: "loaded"; settings: FirecrawlSettings; notice?: string };

export async function loadSettings(): Promise<SettingsLoadResult> {
  await settingsSaveQueue;
  const newPath = settingsFilePath();
  const newSettings = await readSettingsFile(newPath);
  if (newSettings.kind !== "missing") {
    return withLegacyIgnoredNotice(newSettings);
  }

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
    const parsed = JSON.parse(text) as unknown;
    const settings = normalizeFirecrawlSettings(parsed);
    if (settings) {
      return {
        result: { kind: "loaded", settings },
        document: { ...(parsed as Record<string, unknown>) },
      };
    }
    return {
      result: {
        kind: "invalid",
        reason: `${filePath}: expected tools to be an array of Firecrawl tool names`,
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
    notice: `Firecrawl legacy settings ignored: ${legacySettingsFilePath()} exists, but ${settingsFilePath()} takes precedence. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
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

export function normalizeFirecrawlSettings(value: unknown): FirecrawlSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = value as { tools?: unknown; updatedAt?: unknown };
  if (typeof settings.updatedAt !== "number" || !Number.isFinite(settings.updatedAt)) {
    return undefined;
  }
  if (!Array.isArray(settings.tools)) return undefined;
  if (!settings.tools.every(isFirecrawlToolName)) return undefined;
  return { tools: orderedUniqueFirecrawlTools(settings.tools), updatedAt: settings.updatedAt };
}

function isFirecrawlToolName(value: unknown): value is FirecrawlToolName {
  return typeof value === "string" && FIRECRAWL_TOOL_NAMES.includes(value as never);
}

function orderedUniqueFirecrawlTools(tools: readonly FirecrawlToolName[]) {
  const selectedTools = new Set(tools);
  return FIRECRAWL_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

let settingsSaveQueue = Promise.resolve();

export function saveSettings(
  settings: FirecrawlSettings,
  operations: Partial<SettingsFileOperations> = {},
): Promise<void> {
  const normalizedSettings = normalizeFirecrawlSettings(settings);
  if (!normalizedSettings) {
    return Promise.reject(new Error("Cannot save invalid Firecrawl settings"));
  }
  const operation = settingsSaveQueue.then(() => saveSettingsNow(normalizedSettings, operations));
  settingsSaveQueue = operation.catch(() => undefined);
  return operation;
}

async function saveSettingsNow(
  settings: FirecrawlSettings,
  operations: Partial<SettingsFileOperations>,
): Promise<void> {
  const filePath = settingsFilePath();
  let current = await readSettingsDocument(filePath);
  const replaceCanonical = current.result.kind !== "missing";
  if (!replaceCanonical) current = await readSettingsDocument(legacySettingsFilePath());
  if (current.result.kind === "invalid") {
    throw new Error(`Cannot save Firecrawl settings until you repair ${current.result.reason}`);
  }
  const nextDocument = {
    ...(current.document ?? {}),
    tools: [...settings.tools],
    updatedAt: settings.updatedAt,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(tempFile, `${JSON.stringify(nextDocument, null, 2)}\n`);
    if (!replaceCanonical && (await pathEntryExists(filePath))) {
      throw new Error(`${NEW_SETTINGS_FILE} was created concurrently; reopen settings and retry.`);
    }
    await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(tempFile, filePath);
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
