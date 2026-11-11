import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TYPESAFE_COMPACT_SETTINGS_FILE = "pi-typesafe-compact.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_API_KEY_LENGTH = 16 * 1024;

export interface TypeSafeCompactSettings {
  apiKey?: string;
}

export interface TypeSafeCompactSettingsState {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: TypeSafeCompactSettings;
  document?: Record<string, unknown>;
  issue?: string;
  fingerprint?: string;
}

export interface TypeSafeCompactSettingsRuntime {
  get(): Readonly<TypeSafeCompactSettingsState>;
  reload(signal?: AbortSignal): Promise<Readonly<TypeSafeCompactSettingsState>>;
  setApiKey(apiKey: string, signal?: AbortSignal): Promise<Readonly<TypeSafeCompactSettingsState>>;
  removeApiKey(signal?: AbortSignal): Promise<Readonly<TypeSafeCompactSettingsState>>;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

export function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_API_KEY_LENGTH || hasControlCharacter(normalized)) return undefined;
  return normalized;
}

export function normalizeTypeSafeCompactSettings(value: unknown): TypeSafeCompactSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (!Object.hasOwn(value, "apiKey")) return {};
  const apiKey = normalizeApiKey(value.apiKey);
  return apiKey ? { apiKey } : undefined;
}

export function typeSafeCompactSettingsPath(): string {
  return join(getAgentDir(), TYPESAFE_COMPACT_SETTINGS_FILE);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

function cloneState(state: TypeSafeCompactSettingsState): TypeSafeCompactSettingsState {
  return structuredClone(state);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readBoundedSettingsText(handle: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch {
    throw new Error("settings file is not valid UTF-8");
  }
}

/** @internal Exported for deterministic filesystem race coverage. */
export async function readSettingsTextFromValidatedPath(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    throwIfAborted(signal);
    if (!stats.isFile()) throw new Error("settings path is not a regular file");
    if (stats.size > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
    return await readBoundedSettingsText(handle);
  } finally {
    await handle.close();
  }
}

export async function loadTypeSafeCompactSettings(
  path = typeSafeCompactSettingsPath(),
  signal?: AbortSignal,
): Promise<TypeSafeCompactSettingsState> {
  throwIfAborted(signal);
  try {
    const pathStats = await lstat(path);
    throwIfAborted(signal);
    if (pathStats.isSymbolicLink()) throw new Error("symbolic links are not accepted");
    if (!pathStats.isFile()) throw new Error("settings path is not a regular file");
    const text = await readSettingsTextFromValidatedPath(path, signal);
    throwIfAborted(signal);
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      throw new Error("settings file contains malformed JSON");
    }
    const settings = normalizeTypeSafeCompactSettings(document);
    if (!settings || !isRecord(document)) throw new Error("invalid settings shape or API key");
    return { kind: "loaded", path, settings, document, fingerprint: text };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: {}, document: {} };
    }
    return {
      kind: "invalid",
      path,
      settings: {},
      issue:
        isNodeError(error) && error.code === "ELOOP"
          ? "symbolic links are not accepted"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function saveApiKeyMutation(
  path: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<TypeSafeCompactSettingsState> {
  const latest = await loadTypeSafeCompactSettings(path, signal);
  if (latest.kind === "invalid") {
    throw new Error("Cannot overwrite an invalid pi-typesafe-compact.json; repair it and reload first");
  }
  const document = { ...(latest.document ?? {}) };
  if (apiKey === undefined) delete document.apiKey;
  else document.apiKey = apiKey;
  const settings = normalizeTypeSafeCompactSettings(document);
  if (!settings) throw new Error("Refusing to save invalid TypeSafe compaction settings");

  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error("Refusing to save settings that exceed 64 KiB");
  }

  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  throwIfAborted(signal);
  try {
    await writeFile(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    throwIfAborted(signal);
    const current = await loadTypeSafeCompactSettings(path, signal);
    const unchanged =
      current.kind === latest.kind && (latest.kind === "missing" || current.fingerprint === latest.fingerprint);
    if (!unchanged) throw new Error("pi-typesafe-compact.json changed while saving; reopen settings and retry");
    await rename(temporaryPath, path);
    return { kind: "loaded", path, settings, document, fingerprint: text };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createTypeSafeCompactSettingsRuntime(
  path = typeSafeCompactSettingsPath(),
): TypeSafeCompactSettingsRuntime {
  let state: TypeSafeCompactSettingsState = { kind: "missing", path, settings: {}, document: {} };
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    get: () => cloneState(state),
    reload: (signal) =>
      enqueue(async () => {
        state = await loadTypeSafeCompactSettings(path, signal);
        return cloneState(state);
      }),
    setApiKey: (value, signal) =>
      enqueue(async () => {
        const apiKey = normalizeApiKey(value);
        if (!apiKey) throw new Error("TypeSafe API key must be non-empty and contain no control characters");
        state = await saveApiKeyMutation(path, apiKey, signal);
        return cloneState(state);
      }),
    removeApiKey: (signal) =>
      enqueue(async () => {
        state = await saveApiKeyMutation(path, undefined, signal);
        return cloneState(state);
      }),
    flush: () => queue,
  };
}
