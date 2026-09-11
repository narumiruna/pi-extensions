import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeniedPath, posixJoin, safeJoin, toPosix } from "../paths.js";
import { agentDir, configuredSessionDir } from "./session-paths.js";
import { sessionStorageRoot } from "./snapshot-paths.js";

export { isDeniedPath } from "../paths.js";
export { sessionStorageRoot } from "./snapshot-paths.js";

import {
  canonicalSnapshotPathForConfig,
  customIncludePathsByLower,
  DEFAULT_SYNC_INCLUDE,
  includeFromSelectionConfig,
  isConfiguredSnapshotPath,
  isPreservableUnmanagedSnapshotPath,
  normalizeExtraFiles,
  normalizeSyncFiles,
  type SyncSelectionConfig,
  selectionForSnapshot,
  snapshotSelectionInclude,
  syncIncludeSelection,
} from "../sync/sync-policy.js";
import type { Snapshot, SnapshotFile, SnapshotOptions } from "./snapshot-types.js";

export { canonicalSnapshotPathForConfig, isConfiguredSnapshotPath } from "../sync/sync-policy.js";

const VERSION = 1;
const TOP_LEVEL_FILES: readonly string[] = DEFAULT_SYNC_INCLUDE.filter((name) => name.includes("."));
const TOP_LEVEL_DIRS = new Set<string>(DEFAULT_SYNC_INCLUDE.filter((name) => !name.includes(".")));
const SECRET_PATTERNS = [
  /AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+]{35,}/i,
  /(ANTHROPIC|OPENAI|GEMINI|GOOGLE|FIRECRAWL|GITHUB|CLOUDFLARE|R2|S3)_[A-Z0-9_]*(KEY|TOKEN|SECRET)\s*[=:]\s*['"]?[^\s'"]{12,}/i,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
];

function selectTopLevelFileEntry(entries: Dirent[], fileName: string) {
  const exact = entries.find((entry) => entry.isFile() && entry.name === fileName);
  if (exact) return exact;
  const lower = fileName.toLowerCase();
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase() === lower)
    .sort((left, right) => left.name.localeCompare(right.name))[0];
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeSnapshotPath(relativePath: string) {
  if (relativePath.includes("\\")) return false;
  const normalized = toPosix(relativePath);
  return (
    Boolean(normalized) &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.posix.isAbsolute(normalized) &&
    path.posix.normalize(normalized) === normalized &&
    !isDeniedPath(normalized)
  );
}

function snapshotsMatch(left: Snapshot, right: Snapshot) {
  const leftHashes = new Map(left.files.map((file) => [file.path, file.sha256]));
  const rightHashes = new Map(right.files.map((file) => [file.path, file.sha256]));
  return (
    left.syncSessions === right.syncSessions &&
    sameOptionalInclude(snapshotSelectionInclude(left), snapshotSelectionInclude(right)) &&
    leftHashes.size === rightHashes.size &&
    [...leftHashes].every(([filePath, hash]) => rightHashes.get(filePath) === hash)
  );
}

function snapshotId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function regenerateSnapshotIdentity(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
  };
}

export async function createSnapshot(profile: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  options.signal?.throwIfAborted();
  const include = effectiveInclude(options);
  const syncSessions = include.includes("sessions");
  const sessionDir = options.sessionDir ?? (await configuredSessionDir());
  options.signal?.throwIfAborted();
  const files = await collectFiles(agentDir(), { include, sessionDir, signal: options.signal });
  options.signal?.throwIfAborted();
  return {
    version: VERSION,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    profile,
    syncSessions,
    selection: selectionForSnapshot(include),
    files,
  };
}

function effectiveInclude(options: SnapshotOptions) {
  if (options.include) return options.include;
  return [
    ...normalizeSyncFiles(options.syncFiles),
    ...normalizeExtraFiles(options.extraFiles),
    ...(options.syncSessions ? ["sessions"] : []),
  ];
}

export async function collectFiles(root: string, options: SnapshotOptions = {}): Promise<SnapshotFile[]> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const results: SnapshotFile[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  signal?.throwIfAborted();
  const selection = syncIncludeSelection(effectiveInclude(options));
  const selectedFiles = new Set<string>(selection.builtIns);
  for (const entry of entries) {
    if (entry.isDirectory() && TOP_LEVEL_DIRS.has(entry.name) && selectedFiles.has(entry.name)) {
      await collectDirectory(results, root, entry.name, { signal });
    }
  }
  for (const fileName of TOP_LEVEL_FILES) {
    if (!selectedFiles.has(fileName)) continue;
    const entry = selectTopLevelFileEntry(entries, fileName);
    if (entry) await addFile(results, root, entry.name, fileName, signal);
  }
  for (const relativePath of selection.custom) {
    await collectIncludedPath(results, root, relativePath, signal);
  }
  if (selection.sessions) {
    try {
      await collectDirectory(results, sessionStorageRoot(root, options.sessionDir), "", {
        sessionsOnly: true,
        virtualPrefix: "sessions",
        signal,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  signal?.throwIfAborted();
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectIncludedPath(results: SnapshotFile[], root: string, relativePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const absolutePath = safeJoin(root, relativePath);
  try {
    const stat = await fs.lstat(absolutePath);
    signal?.throwIfAborted();
    if (stat.isFile()) await addFile(results, root, relativePath, relativePath, signal);
    else if (stat.isDirectory()) await collectDirectory(results, root, relativePath, { signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!relativePath.includes("/")) {
      const entries = await fs.readdir(root, { withFileTypes: true });
      signal?.throwIfAborted();
      const entry = selectTopLevelFileEntry(entries, relativePath);
      if (entry) await addFile(results, root, entry.name, relativePath, signal);
    }
  }
}

async function collectDirectory(
  results: SnapshotFile[],
  root: string,
  relativeDirectory: string,
  options: { sessionsOnly?: boolean; virtualPrefix?: string; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const absoluteDirectory = path.join(root, relativeDirectory);
  for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
    options.signal?.throwIfAborted();
    const relativePath = relativeDirectory ? posixJoin(relativeDirectory, entry.name) : entry.name;
    const snapshotPath = options.virtualPrefix ? posixJoin(options.virtualPrefix, relativePath) : relativePath;
    if (isDeniedPath(snapshotPath)) continue;
    if (entry.isDirectory()) {
      await collectDirectory(results, root, relativePath, options);
    } else if (entry.isFile() && (!options.sessionsOnly || isSessionFilePath(snapshotPath))) {
      await addFile(results, root, relativePath, snapshotPath, options.signal);
    }
  }
}

async function addFile(
  results: SnapshotFile[],
  root: string,
  relativePath: string,
  snapshotPath = relativePath,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!isSafeSnapshotPath(snapshotPath)) return;
  const absolutePath = safeJoin(root, relativePath);
  const content = await fs.readFile(absolutePath, { signal });
  signal?.throwIfAborted();
  results.push({
    path: snapshotPath,
    contentBase64: content.toString("base64"),
    sha256: sha256(content),
  });
}

export function isSessionPath(relativePath: string) {
  return toPosix(relativePath).startsWith("sessions/");
}

export function isSessionFilePath(relativePath: string) {
  const normalized = toPosix(relativePath);
  return isSessionPath(normalized) && normalized.endsWith(".jsonl");
}

export function sessionSnapshotPathFromAbsolute(sessionFile: string, configuredSessionDir?: string) {
  const relativePath = toPosix(path.relative(sessionStorageRoot(agentDir(), configuredSessionDir), sessionFile));
  if (!relativePath || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    return undefined;
  }
  const snapshotPath = posixJoin("sessions", relativePath);
  return isSessionFilePath(snapshotPath) ? snapshotPath : undefined;
}

export function snapshotTarget(root: string, relativePath: string, configuredSessionDir?: string) {
  if (isSessionPath(relativePath)) {
    return safeJoin(sessionStorageRoot(root, configuredSessionDir), relativePath.slice("sessions/".length));
  }
  return safeJoin(root, relativePath);
}

export function snapshotIncludesSessions(snapshot: Snapshot) {
  return (
    snapshot.syncSessions === true ||
    snapshotSelectionInclude(snapshot)?.includes("sessions") === true ||
    snapshot.files.some((file) => isSessionPath(file.path))
  );
}

export function filterSnapshotForConfigPolicy(
  snapshot: Snapshot,
  config: SyncSelectionConfig,
  options: { regenerateId?: boolean } = {},
) {
  const include = includeFromSelectionConfig(config);
  const includePaths = customIncludePathsByLower(include);
  const filtered = {
    ...snapshot,
    syncSessions: include.includes("sessions") ? snapshot.syncSessions : false,
    selection: selectionForSnapshot(include),
    files: canonicalizeSnapshotFilesForConfig(snapshot.files, config, includePaths),
  };
  if (!options.regenerateId || snapshotsMatch(snapshot, filtered)) return filtered;
  return {
    ...filtered,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
  };
}

function canonicalizeSnapshotFilesForConfig(
  files: SnapshotFile[],
  config: SyncSelectionConfig,
  includePaths: Map<string, string>,
) {
  const configuredFiles: SnapshotFile[] = [];
  const extraCandidates = new Map<string, { exact: boolean; file: SnapshotFile; originalPath: string }>();
  for (const file of files) {
    const normalized = toPosix(file.path);
    if (!isSafeSnapshotPath(file.path) || !isConfiguredSnapshotPath(normalized, config)) {
      continue;
    }
    if (normalized.includes("/")) {
      configuredFiles.push(normalized === file.path ? file : { ...file, path: normalized });
      continue;
    }
    const topLevelPath = canonicalSnapshotPathForConfig(normalized, includePaths);
    const candidate = {
      exact: normalized === topLevelPath,
      file: { ...file, path: topLevelPath },
      originalPath: normalized,
    };
    const current = extraCandidates.get(topLevelPath.toLowerCase());
    if (!current || isPreferredExtraCandidate(candidate, current)) {
      extraCandidates.set(topLevelPath.toLowerCase(), candidate);
    }
  }
  return [...configuredFiles, ...[...extraCandidates.values()].map((candidate) => candidate.file)].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function isPreferredExtraCandidate(
  left: { exact: boolean; originalPath: string },
  right: { exact: boolean; originalPath: string },
) {
  if (left.exact !== right.exact) return left.exact;
  return left.originalPath.localeCompare(right.originalPath) < 0;
}

export function snapshotWithoutSessions(snapshot: Snapshot) {
  const files = snapshot.files.filter((file) => !isSessionPath(file.path));
  const include = snapshotSelectionInclude(snapshot)?.filter((item) => item !== "sessions");
  if (
    files.length === snapshot.files.length &&
    snapshot.syncSessions !== true &&
    include?.length === snapshot.selection?.include.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    syncSessions: false,
    ...(include ? { selection: selectionForSnapshot(include) } : {}),
    files,
  };
}

export function scanSnapshot(snapshot: Snapshot) {
  const findings: string[] = [];
  for (const file of snapshot.files) {
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        findings.push(file.path);
        break;
      }
    }
  }
  return findings;
}

export function mergeRemotePreservedFiles(local: Snapshot, remote: Snapshot, config: SyncSelectionConfig) {
  const localPathNames = new Set(local.files.map((file) => file.path.toLowerCase()));
  const preservedPathNames = new Set<string>();
  const preserved = remote.files.filter((file) => {
    const normalized = toPosix(file.path);
    const lower = normalized.toLowerCase();
    if (
      localPathNames.has(lower) ||
      preservedPathNames.has(lower) ||
      !isSafeSnapshotPath(file.path) ||
      isConfiguredSnapshotPath(normalized, config) ||
      !isPreservableUnmanagedSnapshotPath(normalized)
    ) {
      return false;
    }
    preservedPathNames.add(lower);
    return true;
  });
  if (preserved.length === 0) return local;
  return {
    ...local,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    syncSessions: snapshotIncludesSessions(local) || snapshotIncludesSessions(remote),
    files: [...local.files, ...preserved].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function mergeRemoteSessionFiles(local: Snapshot, remote: Snapshot) {
  const remoteSessions = remote.files.filter((file) => {
    const normalized = toPosix(file.path);
    return isSessionFilePath(normalized) && isSafeSnapshotPath(file.path);
  });
  if (remoteSessions.length === 0 && !snapshotIncludesSessions(remote)) return local;
  const localInclude = snapshotSelectionInclude(local);
  return {
    ...local,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    syncSessions: true,
    ...(localInclude
      ? {
          selection: selectionForSnapshot(
            localInclude.includes("sessions") ? localInclude : [...localInclude, "sessions"],
          ),
        }
      : {}),
    files: [...local.files.filter((file) => !isSessionPath(file.path)), ...remoteSessions].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

function sameOptionalInclude(left: string[] | undefined, right: string[] | undefined) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
