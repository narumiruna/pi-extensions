import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeniedPath, posixJoin, safeJoin, toPosix } from "../paths.js";
import { agentDir, configuredSessionDir, expandSessionDir } from "./session-paths.js";
import { assertAgentDirectorySettingsSize, MAX_AGENT_DIRECTORY_BYTES } from "./snapshot-bounds.js";
import {
  agentDirectoryAnchor,
  agentDirectoryPhysicalSessionPath,
  agentDirectorySessionRoot,
} from "./snapshot-exclude-safety.js";
import { sessionStorageRoot } from "./snapshot-paths.js";

export { isDeniedPath } from "../paths.js";
export { sessionStorageRoot } from "./snapshot-paths.js";

import { compileSyncExclude } from "../sync/exclude-policy.js";
import {
  assertAgentDirectoryPathLayout,
  canonicalSnapshotPathForConfig,
  compileSyncPolicyExclude,
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  customIncludePathsByLower,
  DEFAULT_SYNC_INCLUDE,
  includeFromSelectionConfig,
  isPreservableUnmanagedSnapshotPath,
  MAX_AGENT_DIRECTORY_ENTRIES,
  MAX_AGENT_DIRECTORY_FILES,
  normalizeExtraFiles,
  normalizeSyncFiles,
  type SyncSelectionConfig,
  sameSnapshotSelection,
  selectionForSnapshot,
  snapshotSelectionExclude,
  snapshotSelectionInclude,
  syncIncludeSelection,
  syncSessionsSelected,
} from "../sync/sync-policy.js";
import type { AgentDirectoryInventory, Snapshot, SnapshotFile, SnapshotOptions } from "./snapshot-types.js";

export { canonicalSnapshotPathForConfig, isConfiguredSnapshotPath } from "../sync/sync-policy.js";

const VERSION = 1;
const scanInventories = new WeakMap<Pick<Snapshot, "files">, AgentDirectoryInventory>();

export function agentDirectoryInventory(snapshot: Pick<Snapshot, "files">) {
  return scanInventories.get(snapshot);
}
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
    sameSnapshotSelection(left.selection, right.selection) &&
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
  const policy = { ...options, include };
  const excluded = compileSyncPolicyExclude(policy);
  const syncSessions = syncSessionsSelected(policy);
  const needsSessionConfig = syncSessions || !excluded("settings.json");
  const sessionDir =
    options.scope === "agent-directory"
      ? options.sessionDir
      : (options.sessionDir ?? (needsSessionConfig ? await configuredSessionDir() : undefined));
  options.signal?.throwIfAborted();
  const collectionOptions = { ...policy, sessionDir };
  const collected =
    options.scope === "agent-directory" ? await collectAgentDirectory(agentDir(), collectionOptions) : undefined;
  const files = collected?.files ?? (await collectFiles(agentDir(), collectionOptions, excluded));
  options.signal?.throwIfAborted();
  const snapshot: Snapshot = {
    version: options.scope === "agent-directory" ? 5 : options.exclude === undefined ? VERSION : 4,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    profile,
    syncSessions,
    selection: selectionForSnapshot(include, options.exclude, options),
    files,
  };
  if (collected) scanInventories.set(snapshot, collected.inventory);
  return snapshot;
}

function effectiveInclude(options: SnapshotOptions) {
  if (options.include) return options.include;
  if (options.scope === "agent-directory") return [];
  return [
    ...normalizeSyncFiles(options.syncFiles),
    ...normalizeExtraFiles(options.extraFiles),
    ...(options.syncSessions ? ["sessions"] : []),
  ];
}

export async function collectFiles(
  root: string,
  options: SnapshotOptions = {},
  excluded = compileSyncExclude(options.exclude),
): Promise<SnapshotFile[]> {
  if (options.scope === "agent-directory") return (await collectAgentDirectory(root, options)).files;
  const signal = options.signal;
  signal?.throwIfAborted();
  const results: SnapshotFile[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  signal?.throwIfAborted();
  const selection = syncIncludeSelection(effectiveInclude(options));
  const selectedFiles = new Set<string>(selection.builtIns);
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      TOP_LEVEL_DIRS.has(entry.name) &&
      selectedFiles.has(entry.name) &&
      !excluded(entry.name)
    ) {
      await collectDirectory(results, root, entry.name, { signal, excluded });
    }
  }
  for (const fileName of TOP_LEVEL_FILES) {
    if (!selectedFiles.has(fileName) || excluded(fileName)) continue;
    const entry = selectTopLevelFileEntry(entries, fileName);
    if (entry) await addFile(results, root, entry.name, fileName, signal);
  }
  for (const relativePath of selection.custom) {
    if (!excluded(relativePath)) await collectIncludedPath(results, root, relativePath, signal, excluded);
  }
  if (selection.sessions && !excluded("sessions")) {
    try {
      await collectDirectory(results, sessionStorageRoot(root, options.sessionDir), "", {
        sessionsOnly: true,
        excluded,
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

interface ScannedPath {
  absolute: string;
  canonical: string;
  stat: Stats;
}

function sameScannedPath(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function changedScan(): never {
  throw new Error("Agent directory changed or has an unsafe filesystem layout; no snapshot was collected.");
}

async function identify(absolute: string, canonical: string, signal?: AbortSignal): Promise<ScannedPath> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || (await fs.realpath(absolute)) !== canonical) changedScan();
  signal?.throwIfAborted();
  return { absolute, canonical, stat };
}

async function recheck({ absolute, canonical, stat }: ScannedPath, signal?: AbortSignal) {
  if (!sameScannedPath((await identify(absolute, canonical, signal)).stat, stat)) changedScan();
}

async function readScannedFile(candidate: ScannedPath, signal?: AbortSignal) {
  await recheck(candidate, signal);
  const handle = await fs.open(candidate.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Read only through the verified descriptor, and never read more than the approved size.
    if (!sameScannedPath(await handle.stat(), candidate.stat)) changedScan();
    await recheck(candidate, signal);
    const content = Buffer.alloc(candidate.stat.size);
    for (let offset = 0; offset < content.length; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) changedScan();
      offset += bytesRead;
    }
    if (!sameScannedPath(await handle.stat(), candidate.stat)) changedScan();
    return content;
  } finally {
    await handle.close();
  }
}

/** Read Pi's bounded session routing metadata independently of snapshot payload selection. */
export async function agentDirectoryConfiguredSessionDir(signal?: AbortSignal, root = agentDir()) {
  const content = await readAgentDirectorySettings(signal, root);
  return content === undefined ? undefined : agentDirectorySessionDirFromSettings(content);
}

export async function readAgentDirectorySettings(signal?: AbortSignal, root = agentDir()) {
  const absolute = path.resolve(root);
  const canonical = path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
  await identify(absolute, canonical, signal);
  let settings: ScannedPath;
  try {
    settings = await identify(path.join(absolute, "settings.json"), path.join(canonical, "settings.json"), signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!settings.stat.isFile() || settings.stat.nlink !== 1) changedScan();
  assertAgentDirectorySettingsSize(settings.stat.size);
  const content = await readScannedFile(settings, signal);
  await recheck(settings, signal);
  return content;
}

export function agentDirectorySessionDirFromSettings(content: Buffer) {
  assertAgentDirectorySettingsSize(content.length);
  let value: unknown;
  try {
    value = (JSON.parse(content.toString("utf8").replace(/^\uFEFF/u, "")) as { sessionDir?: unknown } | null)
      ?.sessionDir;
  } catch {
    throw new Error("Pi settings.json cannot be parsed; repair the file before syncing.");
  }
  if (value !== undefined && typeof value !== "string") throw new Error("Pi sessionDir must be a string.");
  return value ? expandSessionDir(value) : undefined;
}

async function collectAgentDirectory(root: string, options: SnapshotOptions) {
  const signal = options.signal;
  const excluded = compileSyncPolicyExclude(options);
  const canTraverse = compileSyncPolicyTraversal(options);
  const sessionDir = options.sessionDir ?? (await agentDirectoryConfiguredSessionDir(signal, root));
  const isPhysicalSessionPath = agentDirectoryPhysicalSessionPath(root, sessionDir);
  const sessionRoot = agentDirectorySessionRoot(root, sessionDir);
  const directories: ScannedPath[] = [];
  const candidates: Array<ScannedPath & { snapshotPath: string }> = [];
  const entries = new Map<string, "file" | "directory" | "unreviewed">();
  const routingDirectories = new Set<string>();
  let bytes = 0;

  async function walk(directory: ScannedPath, prefix: string, sessions: boolean) {
    if (!directory.stat.isDirectory()) changedScan();
    directories.push(directory);
    const children: Dirent[] = [];
    for await (const entry of await fs.opendir(directory.absolute)) {
      signal?.throwIfAborted();
      const absolute = path.join(directory.absolute, entry.name);
      if (entries.size >= MAX_AGENT_DIRECTORY_ENTRIES) throw new Error("Agent directory exceeds the scan entry bound.");
      entries.set(absolute, "unreviewed");
      children.push(entry);
    }
    await recheck(directory, signal);
    for (const entry of children) {
      signal?.throwIfAborted();
      const snapshotPath = posixJoin(prefix, entry.name);
      if (!sessions && (/^sessions(?:\/|$)/iu.test(snapshotPath) || isPhysicalSessionPath(snapshotPath))) continue;
      if (entry.isDirectory() ? !canTraverse(snapshotPath) : !entry.isFile() || excluded(snapshotPath)) continue;
      if (!entry.isDirectory() && sessions && !isSessionFilePath(snapshotPath)) continue;
      const candidate = await identify(
        path.join(directory.absolute, entry.name),
        path.join(directory.canonical, entry.name),
        signal,
      );
      if (entry.isDirectory()) {
        if (!excluded(snapshotPath)) entries.set(candidate.absolute, "directory");
        await walk(candidate, snapshotPath, sessions);
      } else {
        if (!candidate.stat.isFile() || candidate.stat.nlink !== 1) changedScan();
        if (snapshotPath.toLowerCase() === "settings.json") assertAgentDirectorySettingsSize(candidate.stat.size);
        bytes += candidate.stat.size;
        if (bytes > MAX_AGENT_DIRECTORY_BYTES) throw new Error("Agent directory exceeds the 64 MiB scan byte bound.");
        if (candidates.length >= MAX_AGENT_DIRECTORY_FILES)
          throw new Error("Agent directory exceeds the scan file bound.");
        entries.set(candidate.absolute, "file");
        candidates.push({ ...candidate, snapshotPath });
      }
    }
    await recheck(directory, signal);
  }

  const absoluteRoot = path.resolve(root);
  const canonicalRoot = path.join(await fs.realpath(path.dirname(absoluteRoot)), path.basename(absoluteRoot));
  const selectedSessions = syncSessionsSelected(options);
  async function identifySessionRoot(routing?: Set<string>) {
    // Validate the custom root even when opted out: an external alias could otherwise hide an in-tree store.
    if (!sessionDir && !selectedSessions) return undefined;
    let absolute = agentDirectoryAnchor(absoluteRoot, sessionRoot);
    const parts = path.relative(absolute, sessionRoot).split(path.sep);
    let canonical = await fs.realpath(absolute);
    let directory: ScannedPath | undefined;
    try {
      for (const part of parts) {
        absolute = path.join(absolute, part);
        canonical = path.join(canonical, part);
        directory = await identify(absolute, canonical, signal);
        if (!directory.stat.isDirectory()) changedScan();
        routing?.add(absolute);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return directory;
  }
  const sessionDirectory = await identifySessionRoot(routingDirectories);
  await walk(await identify(absoluteRoot, canonicalRoot, signal), "", false);
  if (selectedSessions && sessionDirectory) await walk(sessionDirectory, "sessions", true);

  assertAgentDirectoryPathLayout(candidates.map((candidate) => candidate.snapshotPath));
  const results: SnapshotFile[] = [];
  for (const candidate of candidates) {
    const content = await readScannedFile(candidate, signal);
    results.push({ path: candidate.snapshotPath, contentBase64: content.toString("base64"), sha256: sha256(content) });
  }
  // No caller can mistake a changed/disappeared directory or routing policy for an empty snapshot subtree.
  for (const directory of directories) await recheck(directory, signal);
  if (options.sessionDir === undefined && (await agentDirectoryConfiguredSessionDir(signal, root)) !== sessionDir)
    changedScan();
  const currentSessionDirectory = await identifySessionRoot();
  if (
    Boolean(sessionDirectory) !== Boolean(currentSessionDirectory) ||
    (sessionDirectory &&
      currentSessionDirectory &&
      (sessionDirectory.stat.dev !== currentSessionDirectory.stat.dev ||
        sessionDirectory.stat.ino !== currentSessionDirectory.stat.ino))
  )
    changedScan();
  for (const candidate of candidates) await recheck(candidate, signal);
  signal?.throwIfAborted();
  return {
    files: results.sort((left, right) => left.path.localeCompare(right.path)),
    inventory: {
      root: absoluteRoot,
      sessionRoot,
      scanSessions: selectedSessions,
      entries,
      walkedDirectories: new Set(directories.map(({ absolute }) => absolute)),
      routingDirectories,
    },
  };
}

async function collectIncludedPath(
  results: SnapshotFile[],
  root: string,
  relativePath: string,
  signal?: AbortSignal,
  excluded?: (relativePath: string) => boolean,
) {
  signal?.throwIfAborted();
  const absolutePath = safeJoin(root, relativePath);
  try {
    const stat = await fs.lstat(absolutePath);
    signal?.throwIfAborted();
    if (stat.isFile()) await addFile(results, root, relativePath, relativePath, signal);
    else if (stat.isDirectory()) await collectDirectory(results, root, relativePath, { signal, excluded });
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
  options: {
    sessionsOnly?: boolean;
    virtualPrefix?: string;
    signal?: AbortSignal;
    excluded?: (relativePath: string) => boolean;
  } = {},
) {
  options.signal?.throwIfAborted();
  const absoluteDirectory = path.join(root, relativeDirectory);
  for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
    options.signal?.throwIfAborted();
    const relativePath = relativeDirectory ? posixJoin(relativeDirectory, entry.name) : entry.name;
    const snapshotPath = options.virtualPrefix ? posixJoin(options.virtualPrefix, relativePath) : relativePath;
    if (isDeniedPath(snapshotPath) || options.excluded?.(snapshotPath)) continue;
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
  if (snapshot.selection?.version === 3) return syncSessionsSelected(snapshot.selection);
  return (
    snapshot.syncSessions === true ||
    (snapshotSelectionInclude(snapshot)?.includes("sessions") === true &&
      !compileSyncExclude(snapshotSelectionExclude(snapshot))("sessions")) ||
    snapshot.files.some((file) => isSessionPath(file.path))
  );
}

export function filterSnapshotForConfigPolicy(
  snapshot: Snapshot,
  config: SyncSelectionConfig,
  options: { regenerateId?: boolean; sessionDir?: string } = {},
) {
  const include = includeFromSelectionConfig(config);
  const wholeDirectory = config.scope === "agent-directory";
  const exclude = config.exclude ?? (snapshot.version >= 4 ? [] : undefined);
  const files = wholeDirectory
    ? filterAgentDirectoryFiles(snapshot.files, config, options.sessionDir)
    : canonicalizeSnapshotFilesForConfig(snapshot.files, config, customIncludePathsByLower(include));
  const filtered = {
    ...snapshot,
    version: wholeDirectory ? 5 : exclude === undefined ? snapshot.version : 4,
    syncSessions: syncSessionsSelected(config) ? snapshot.syncSessions : false,
    selection: selectionForSnapshot(include, exclude, config),
    files,
  };
  if (!options.regenerateId || snapshotsMatch(snapshot, filtered)) return filtered;
  return {
    ...filtered,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
  };
}

function filterAgentDirectoryFiles(files: SnapshotFile[], config: SyncSelectionConfig, sessionDir?: string) {
  const configured = configuredSnapshotPathMatcher(config);
  const isPhysicalSessionPath = sessionDir ? agentDirectoryPhysicalSessionPath(agentDir(), sessionDir) : undefined;
  const projected = files.filter((file) => {
    if (!isSafeSnapshotPath(file.path) || !configured(file.path)) return false;
    if (/^sessions(?:\/|$)/iu.test(file.path)) return isSessionFilePath(file.path);
    return !isPhysicalSessionPath?.(file.path);
  });
  assertAgentDirectoryPathLayout(projected.map((file) => file.path));
  return projected.sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalizeSnapshotFilesForConfig(
  files: SnapshotFile[],
  config: SyncSelectionConfig,
  includePaths: Map<string, string>,
) {
  const configuredFiles: SnapshotFile[] = [];
  const extraCandidates = new Map<string, { exact: boolean; file: SnapshotFile; originalPath: string }>();
  const configured = configuredSnapshotPathMatcher(config);
  for (const file of files) {
    const normalized = toPosix(file.path);
    if (!isSafeSnapshotPath(file.path) || !configured(normalized)) {
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
    ...(include
      ? {
          selection: selectionForSnapshot(
            include,
            snapshotSelectionExclude(snapshot),
            snapshot.selection?.version === 3 ? snapshot.selection : undefined,
          ),
        }
      : {}),
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

export function mergeRemotePreservedFiles(
  local: Snapshot,
  remote: Snapshot,
  config: SyncSelectionConfig,
  options: { sessionDir?: string } = {},
) {
  // Directory scope has no unmanaged ordinary files to carry forward.
  if (config.scope === "agent-directory")
    return filterSnapshotForConfigPolicy(local, config, { ...options, regenerateId: true });
  const localPathNames = new Set(local.files.map((file) => file.path.toLowerCase()));
  const preservedPathNames = new Set<string>();
  const configured = configuredSnapshotPathMatcher(config);
  const excluded = compileSyncPolicyExclude(config);
  const preserved = remote.files.filter((file) => {
    const normalized = toPosix(file.path);
    const lower = normalized.toLowerCase();
    if (
      localPathNames.has(lower) ||
      preservedPathNames.has(lower) ||
      !isSafeSnapshotPath(file.path) ||
      configured(normalized) ||
      excluded(normalized) ||
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
    syncSessions: !excluded("sessions") && (snapshotIncludesSessions(local) || snapshotIncludesSessions(remote)),
    files: [...local.files, ...preserved].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function mergeRemoteSessionFiles(local: Snapshot, remote: Snapshot) {
  const directory = local.selection?.version === 3 ? local.selection : undefined;
  const excluded = directory
    ? compileSyncPolicyExclude(directory)
    : compileSyncExclude(snapshotSelectionExclude(local));
  if (directory ? !syncSessionsSelected(directory) : excluded("sessions")) return local;
  const remoteSessions = remote.files.filter((file) => {
    const normalized = toPosix(file.path);
    return isSessionFilePath(normalized) && isSafeSnapshotPath(file.path) && !excluded(normalized);
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
            snapshotSelectionExclude(local),
            directory,
          ),
        }
      : {}),
    files: [...local.files.filter((file) => !isSessionPath(file.path)), ...remoteSessions].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}
