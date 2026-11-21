import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type EngineContext as ExtensionCommandContext,
  type EngineContext as ExtensionContext,
  getEngineRoot as getAgentDir,
} from "../host.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { configuredSnapshotPathMatcher, type SyncSelectionConfig } from "../sync/sync-policy.js";
import { agentDirectorySessionRoot } from "./snapshot-exclude-safety.js";
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

export async function effectiveSessionRoot(
  ctx: ExtensionCommandContext | ExtensionContext,
  policy?: SyncSelectionConfig,
  signal?: AbortSignal,
) {
  const sessionDir = sessionDirFromContext(ctx);
  if (policy?.scope === "agent-directory") {
    const root = agentDir();
    if (sessionDir !== undefined || ctx.sessionManager.usesDefaultSessionDir?.())
      return agentDirectorySessionRoot(root, sessionDir);
    if (!configuredSnapshotPathMatcher(policy)("settings.json"))
      throw new Error("Pi session storage is unknown and settings.json is excluded. Use an active Pi context to sync.");
    const { agentDirectoryConfiguredSessionDir } = await import("./snapshot.js");
    signal?.throwIfAborted();
    return agentDirectorySessionRoot(root, await agentDirectoryConfiguredSessionDir(signal));
  }
  return path.resolve(sessionStorageRoot(agentDir(), sessionDir ?? (await configuredSessionDir())));
}

export async function sessionDirForApply(
  ctx: ExtensionCommandContext | ExtensionContext,
  snapshot: Snapshot,
  options: SnapshotOptions = {},
) {
  const contextSessionDir = sessionDirFromContext(ctx);
  if (options.scope === "agent-directory") {
    // A scoped operation uses the physical root reported by Pi, even when sessions are off.
    // Reading excluded settings to infer the root would violate the collection policy.
    const root = await effectiveSessionRoot(ctx, options, options.signal);
    if (root !== agentDirectorySessionRoot(agentDir(), options.sessionDir))
      throw new Error("Pi session storage changed during transfer; retry from a fresh review.");
    return root;
  }
  const localSessionDir = await configuredSessionDir();
  if (contextSessionDir && path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")) {
    return contextSessionDir;
  }
  return sessionDirFromSnapshot(snapshot) ?? contextSessionDir;
}

/** Hash-only merge plans cannot describe installation into a different session root. */
export function requireStableMergeSessionRoot(before: Snapshot, after: Snapshot, scope?: SnapshotOptions["scope"]) {
  const scoped = scope === "agent-directory";
  const settings = (snapshot: Snapshot) => {
    const files = snapshot.files.filter((file) => (scoped ? file.path.toLowerCase() : file.path) === "settings.json");
    if (files.length > 1) throw new Error("Multiple Pi settings paths cannot establish a stable session root.");
    return files[0];
  };
  const previous = settings(before);
  const next = settings(after);
  if (scoped && previous?.sha256 === next?.sha256) return;
  const root = agentDir();
  if (
    path.resolve(sessionStorageRoot(root, sessionDirFromSettingsFile(previous))) !==
    path.resolve(sessionStorageRoot(root, sessionDirFromSettingsFile(next)))
  ) {
    throw new Error(
      scoped
        ? "Agent-directory transfer would change Pi session storage. Configure session storage on this machine before syncing."
        : "Merged transfer changes the session root; no local apply or baseline acceptance is allowed. Review /sync diff and choose an explicit push or pull direction.",
    );
  }
}

function sessionDirFromSnapshot(snapshot: Snapshot) {
  return sessionDirFromSettingsFile(snapshot.files.find((file) => file.path === "settings.json"));
}

function sessionDirFromSettingsFile(settingsFile: Snapshot["files"][number] | undefined) {
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
  const defaultScopedSessionDir =
    config.scope === "agent-directory" && ctx.sessionManager.usesDefaultSessionDir?.()
      ? sessionStorageRoot(agentDir())
      : undefined;
  return {
    include: config.include,
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config.reinclude === undefined ? {} : { reinclude: config.reinclude }),
    sessionDir: sessionDirFromContext(ctx) ?? defaultScopedSessionDir,
  };
}

export async function resolvedSnapshotOptionsForContext(
  ctx: ExtensionCommandContext | ExtensionContext,
  config: AnySyncConfig,
  signal?: AbortSignal,
): Promise<SnapshotOptions> {
  return {
    ...snapshotOptionsForContext(ctx, config),
    ...(config.scope === "agent-directory" ? { sessionDir: await effectiveSessionRoot(ctx, config, signal) } : {}),
    signal,
  };
}
