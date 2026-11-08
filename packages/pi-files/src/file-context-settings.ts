import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export const FILE_CONTEXT_SETTINGS_FILE = "pi-file-context.json";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface FileContextSettings {
  openShortcut: KeyId | null;
}

export interface LoadedFileContextSettings {
  settings: FileContextSettings;
  warning?: string;
  invalidReason?: string;
}

export interface UpdateFileContextSettingsOptions {
  settingsPath?: string;
  signal?: AbortSignal;
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}

export const DEFAULT_FILE_CONTEXT_SETTINGS: FileContextSettings = {
  openShortcut: "ctrl+shift+x",
};

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string; warning: string }
  | { kind: "loaded"; document: SettingsDocument; settings: FileContextSettings };

const mutationQueues = new Map<string, Promise<void>>();

export function fileContextSettingsPath(): string {
  return join(getAgentDir(), FILE_CONTEXT_SETTINGS_FILE);
}

export async function loadFileContextSettings(
  settingsPath = fileContextSettingsPath(),
): Promise<LoadedFileContextSettings> {
  await awaitFileContextSettingsWrites(settingsPath);
  const snapshot = await readSettingsSnapshot(settingsPath);
  if (snapshot.kind === "loaded") return { settings: snapshot.settings };
  if (snapshot.kind === "missing") {
    return { settings: { ...DEFAULT_FILE_CONTEXT_SETTINGS } };
  }
  return {
    settings: { ...DEFAULT_FILE_CONTEXT_SETTINGS },
    warning: snapshot.warning,
    invalidReason: snapshot.reason,
  };
}

export function updateFileContextSettings(
  openShortcut: KeyId | null,
  options: UpdateFileContextSettingsOptions = {},
): Promise<FileContextSettings> {
  const settingsPath = options.settingsPath ?? fileContextSettingsPath();
  return enqueueMutation(settingsPath, async () => {
    options.signal?.throwIfAborted();
    const snapshot = await readSettingsSnapshot(settingsPath);
    if (snapshot.kind === "invalid") {
      throw new Error(`File Context settings are invalid: ${snapshot.reason}`);
    }
    const updated: SettingsDocument = {
      ...(snapshot.kind === "loaded" ? snapshot.document : {}),
      openShortcut,
    };
    const settings = normalizeFileContextSettings(updated);
    if (!settings) throw new Error("File Context settings update is invalid");
    await publishSettings(settingsPath, updated, options);
    return settings;
  });
}

export async function awaitFileContextSettingsWrites(settingsPath = fileContextSettingsPath()): Promise<void> {
  await mutationQueues.get(settingsPath);
}

export function normalizeKeyId(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const base = [...BASE_KEYS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalized === candidate || normalized.endsWith(`+${candidate}`));
  if (!base) return undefined;
  const prefix = normalized.slice(0, normalized.length - base.length);
  if (!prefix) return base as KeyId;
  if (/^f(?:[1-9]|1[0-2])$/.test(base) || !prefix.endsWith("+")) return undefined;
  const modifiers = prefix.slice(0, -1).split("+");
  if (
    modifiers.length === 0 ||
    modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return undefined;
  }
  return normalized as KeyId;
}

function normalizeFileContextSettings(value: unknown): FileContextSettings | undefined {
  if (!isSettingsDocument(value)) return undefined;
  if (!Object.hasOwn(value, "openShortcut")) {
    return { ...DEFAULT_FILE_CONTEXT_SETTINGS };
  }
  const openShortcut = Reflect.get(value, "openShortcut");
  if (openShortcut === null) return { openShortcut: null };
  const normalized = normalizeKeyId(openShortcut);
  return normalized ? { openShortcut: normalized } : undefined;
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(settingsPath, settled);
  void settled.finally(() => {
    if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
  });
  return result;
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
  let source: string;
  try {
    source = await readSettingsContents(settingsPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
    const reason = safeReadError(error);
    return {
      kind: "invalid",
      reason,
      warning: `Cannot read File Context settings: ${reason}`,
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    return {
      kind: "invalid",
      reason: "invalid JSON",
      warning: `Cannot parse File Context settings: ${formatError(error)}`,
    };
  }
  if (!isSettingsDocument(document)) {
    return {
      kind: "invalid",
      reason: "settings must contain a JSON object",
      warning: "File Context settings must contain a JSON object.",
    };
  }
  const settings = normalizeFileContextSettings(document);
  if (!settings) {
    return {
      kind: "invalid",
      reason: 'setting "openShortcut" must be a valid Pi key string or null',
      warning: 'File Context setting "openShortcut" must be a valid Pi key string or null.',
    };
  }
  return { kind: "loaded", document, settings };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(settingsPath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("settings path is not a regular file");
    if (stats.size > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error("settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

async function publishSettings(
  settingsPath: string,
  document: SettingsDocument,
  options: UpdateFileContextSettingsOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  const directory = dirname(settingsPath);
  await mkdir(directory, { recursive: true });
  options.signal?.throwIfAborted();
  const temporaryPath = join(directory, `.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal: options.signal,
    });
    await options.beforeRename?.(temporaryPath, settingsPath);
    options.signal?.throwIfAborted();
    await rename(temporaryPath, settingsPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown): string {
  if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
  return formatError(error);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
