import os from "node:os";
import path from "node:path";
import { type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { readJsonIfExists } from "../state/json-file.js";
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
  const settings = await readJsonIfExists<{ sessionDir?: string }>(path.join(agentDir(), "settings.json"));
  return settings?.sessionDir ? expandHome(settings.sessionDir) : undefined;
}

export async function sessionDirForApply(ctx: ExtensionCommandContext | ExtensionContext, snapshot: Snapshot) {
  const contextSessionDir = sessionDirFromContext(ctx);
  const localSessionDir = await configuredSessionDir();
  if (contextSessionDir && path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")) {
    return contextSessionDir;
  }
  return sessionDirFromSnapshot(snapshot) ?? contextSessionDir;
}

function sessionDirFromSnapshot(snapshot: Snapshot) {
  const settingsFile = snapshot.files.find((file) => file.path === "settings.json");
  if (!settingsFile) return undefined;
  try {
    const settings = JSON.parse(decodeBase64Strict(settingsFile.contentBase64, settingsFile.path).toString("utf8")) as {
      sessionDir?: string;
    };
    return settings.sessionDir ? expandHome(settings.sessionDir) : undefined;
  } catch {
    return undefined;
  }
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

function expandHome(value: string) {
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
