import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import type { Snapshot, SnapshotOptions } from "./snapshot-types.js";

export function sessionDirFromContext(ctx: ExtensionCommandContext | ExtensionContext) {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    usesDefaultSessionDir?: () => boolean;
  };
  const usesDefaultSessionDir = manager.usesDefaultSessionDir;
  if (typeof usesDefaultSessionDir === "function" && usesDefaultSessionDir.call(manager)) {
    return undefined;
  }
  const getSessionDir = manager.getSessionDir;
  return typeof getSessionDir === "function" ? (getSessionDir.call(manager) as string | undefined) : undefined;
}

export async function configuredSessionDir() {
  let content: string;
  try {
    content = await fs.readFile(path.join(agentDir(), "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let settings: { sessionDir?: string } | null;
  try {
    // Pi accepts a leading UTF-8 BOM in its settings file; snapshot bytes stay unchanged.
    settings = JSON.parse(content.replace(/^\uFEFF/u, "")) as typeof settings;
  } catch {
    throw new SyntaxError("Pi settings.json cannot be parsed; repair the file before syncing.");
  }
  return settings?.sessionDir ? expandSessionDir(settings.sessionDir) : undefined;
}

export async function effectiveSessionRoot(ctx: ExtensionCommandContext | ExtensionContext) {
  return path.resolve(sessionStorageRoot(agentDir(), sessionDirFromContext(ctx) ?? (await configuredSessionDir())));
}

export async function sessionDirForApply(ctx: ExtensionCommandContext | ExtensionContext, snapshot: Snapshot) {
  const contextSessionDir = sessionDirFromContext(ctx);
  const localSessionDir = await configuredSessionDir();
  if (contextSessionDir && path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")) {
    return contextSessionDir;
  }
  return sessionDirFromSnapshot(snapshot) ?? contextSessionDir;
}

/** Hash-only merge plans cannot describe installation into a different session root. */
export function requireStableMergeSessionRoot(before: Snapshot, after: Snapshot) {
  const root = agentDir();
  if (
    path.resolve(sessionStorageRoot(root, sessionDirFromSnapshot(before))) !==
    path.resolve(sessionStorageRoot(root, sessionDirFromSnapshot(after)))
  ) {
    throw new Error(
      "Merged transfer changes the session root; no local apply or baseline acceptance is allowed. Review /sync diff and choose an explicit push or pull direction.",
    );
  }
}

function sessionDirFromSnapshot(snapshot: Snapshot) {
  const settingsFile = snapshot.files.find((file) => file.path === "settings.json");
  if (!settingsFile) return undefined;
  let settings: unknown;
  try {
    settings = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Strict(settingsFile.contentBase64, settingsFile.path),
      ),
    );
  } catch {
    // JSON parser errors can quote private settings values; never surface their payload.
    throw new Error("Merged settings cannot be parsed; review a directional recovery.");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Merged settings must be a JSON object; review a directional recovery.");
  const sessionDir = (settings as { sessionDir?: unknown }).sessionDir;
  if (sessionDir !== undefined && typeof sessionDir !== "string")
    throw new Error("Merged sessionDir must be a string; review a directional recovery.");
  return sessionDir ? expandSessionDir(sessionDir) : undefined;
}

function decodeBase64Strict(value: string, filePath: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
  }
  return Buffer.from(value, "base64");
}

export function agentDir() {
  return getAgentDir();
}

export function expandSessionDir(value: string) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function snapshotOptionsForContext(
  ctx: ExtensionCommandContext | ExtensionContext,
  config: AnySyncConfig,
): SnapshotOptions {
  return {
    include: config.include,
    sessionDir: sessionDirFromContext(ctx),
  };
}
