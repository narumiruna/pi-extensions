import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_SETTINGS_BYTES, SETTINGS_FILE_NAME } from "./constants.js";

export interface JevSearchSettings {
  apiKey: string;
}

export type SettingsLoadResult =
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; reason: string }
  | { kind: "loaded"; path: string; settings: JevSearchSettings };

export function settingsFilePath(): string {
  return join(getAgentDir(), SETTINGS_FILE_NAME);
}

export async function loadSettings(path = settingsFilePath()): Promise<SettingsLoadResult> {
  try {
    const pathStats = await lstat(path);
    if (pathStats.isSymbolicLink()) {
      return { kind: "invalid", path, reason: "settings path must not be a symbolic link" };
    }
    if (!pathStats.isFile()) return { kind: "invalid", path, reason: "settings path is not a regular file" };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", path };
    return { kind: "invalid", path, reason: `cannot inspect settings: ${formatError(error)}` };
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", path };
    if (isNodeError(error) && error.code === "ELOOP") {
      return { kind: "invalid", path, reason: "settings path must not be a symbolic link" };
    }
    return { kind: "invalid", path, reason: `cannot open settings: ${formatError(error)}` };
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "invalid", path, reason: "settings path is not a regular file" };
    if (stats.size > MAX_SETTINGS_BYTES) {
      return { kind: "invalid", path, reason: `settings file exceeds ${MAX_SETTINGS_BYTES} bytes` };
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      return { kind: "invalid", path, reason: "settings file must use private permissions (chmod 600)" };
    }

    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SETTINGS_BYTES) {
      return { kind: "invalid", path, reason: `settings file exceeds ${MAX_SETTINGS_BYTES} bytes` };
    }

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      return { kind: "invalid", path, reason: "settings file is not valid UTF-8" };
    }

    let document: unknown;
    try {
      document = JSON.parse(source) as unknown;
    } catch {
      return { kind: "invalid", path, reason: "settings file contains invalid JSON" };
    }
    if (!isRecord(document)) return { kind: "invalid", path, reason: "settings must contain a JSON object" };
    const apiKey = document.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return { kind: "invalid", path, reason: 'setting "apiKey" must be a non-empty string' };
    }
    const normalizedKey = apiKey.trim();
    if (normalizedKey.length > 4_096) {
      return { kind: "invalid", path, reason: 'setting "apiKey" exceeds 4096 characters' };
    }
    return { kind: "loaded", path, settings: { apiKey: normalizedKey } };
  } catch (error: unknown) {
    return { kind: "invalid", path, reason: `cannot read settings: ${formatError(error)}` };
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
