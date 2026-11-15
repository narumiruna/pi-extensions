import path from "node:path";
import { isDeniedPath, toPosix } from "../paths.js";
import type { Snapshot, SnapshotSelection } from "../snapshot/snapshot-types.js";
import { compileSyncExclude, normalizeSyncExclude, sameSyncExclude } from "./exclude-policy.js";

export const BUILT_IN_SYNC_ROOTS = [
  "settings.json",
  "keybindings.json",
  "models.json",
  "AGENTS.md",
  "APPEND_SYSTEM.md",
  "skills",
  "prompts",
  "themes",
  "extensions",
] as const;

export const DEFAULT_SYNC_INCLUDE = [...BUILT_IN_SYNC_ROOTS] as const;
export type BuiltInSyncFile = (typeof BUILT_IN_SYNC_ROOTS)[number];
const MAX_SYNC_INCLUDE_ITEMS = 1_024;
const MAX_SYNC_INCLUDE_PATH_BYTES = 4_096;
const MAX_SYNC_INCLUDE_TOTAL_BYTES = 256 * 1_024;

interface IncludePathNode {
  selected?: string;
  children: Map<string, IncludePathNode>;
}

const BUILT_IN_BY_LOWER = new Map<string, BuiltInSyncFile>(
  BUILT_IN_SYNC_ROOTS.map((fileName) => [fileName.toLowerCase(), fileName]),
);
const TOP_LEVEL_FILE_PATHS = new Map<string, string>(
  BUILT_IN_SYNC_ROOTS.filter((fileName) => fileName.includes(".")).map((fileName) => [
    fileName.toLowerCase(),
    fileName,
  ]),
);
const TOP_LEVEL_DIRS = new Set<string>(BUILT_IN_SYNC_ROOTS.filter((fileName) => !fileName.includes(".")));
const RESERVED_TOP_LEVEL_NAMES = new Set<string>([...BUILT_IN_BY_LOWER.keys(), "sessions"]);

export function normalizeSyncInclude(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid pi-sync settings: sync.include must be an array.");
  }
  if (value.length > MAX_SYNC_INCLUDE_ITEMS) {
    throw new Error(`Invalid pi-sync settings: sync.include has too many items; limit: ${MAX_SYNC_INCLUDE_ITEMS}.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  const pathRoot: IncludePathNode = { children: new Map() };
  let totalBytes = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("Invalid pi-sync settings: sync.include items must be strings.");
    }
    const itemBytes = Buffer.byteLength(item, "utf8");
    if (itemBytes > MAX_SYNC_INCLUDE_PATH_BYTES) {
      throw new Error(
        `Invalid pi-sync settings: sync.include item is too long; limit: ${MAX_SYNC_INCLUDE_PATH_BYTES} bytes.`,
      );
    }
    totalBytes += itemBytes;
    if (totalBytes > MAX_SYNC_INCLUDE_TOTAL_BYTES) {
      throw new Error(
        `Invalid pi-sync settings: sync.include is too large; limit: ${MAX_SYNC_INCLUDE_TOTAL_BYTES} bytes.`,
      );
    }
    const trimmed = item.trim();
    const builtIn = BUILT_IN_BY_LOWER.get(trimmed.toLowerCase());
    const normalized = builtIn ?? (trimmed.toLowerCase() === "sessions" ? "sessions" : trimmed);
    if (!builtIn && normalized !== "sessions") validateAgentRelativeInclude(normalized);
    const identity = normalized.toLowerCase();
    if (seen.has(identity)) {
      throw new Error(`Invalid pi-sync settings: duplicate sync.include item: ${item}`);
    }
    addIncludePath(pathRoot, identity, item);
    seen.add(identity);
    result.push(normalized);
  }
  return result;
}

function addIncludePath(root: IncludePathNode, identity: string, source: string) {
  let node = root;
  for (const segment of identity.split("/")) {
    if (node.selected !== undefined) throwOverlappingInclude(source);
    let child = node.children.get(segment);
    if (!child) {
      child = { children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.children.size > 0) throwOverlappingInclude(source);
  node.selected = identity;
}

function throwOverlappingInclude(item: string): never {
  throw new Error(`Invalid pi-sync settings: overlapping sync.include items are ambiguous: ${item}`);
}

function validateAgentRelativeInclude(value: string) {
  const normalized = toPosix(value);
  const topLevel = normalized.split("/")[0]?.toLowerCase();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("\\") ||
    path.posix.normalize(normalized) !== normalized ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Include paths cannot contain controls.
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new Error(`Invalid pi-sync settings: sync.include item must be a safe agent-relative path: ${value}`);
  }
  if (isDeniedPath(normalized)) {
    throw new Error(`Invalid pi-sync settings: ${value} cannot be synced.`);
  }
  if (topLevel && RESERVED_TOP_LEVEL_NAMES.has(topLevel)) {
    throw new Error(
      `Invalid pi-sync settings: use the canonical ${topLevel} root instead of a nested sync.include path.`,
    );
  }
}

export function portableSnapshotSelection(value: unknown): SnapshotSelection {
  const selection = value as Partial<SnapshotSelection> | null;
  if (
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection) ||
    (selection.version !== 1 && selection.version !== 2) ||
    !Object.hasOwn(selection, "include") ||
    (selection.version === 2 && !Object.hasOwn(selection, "exclude")) ||
    Object.keys(selection).some(
      (key) => key !== "version" && key !== "include" && !(selection.version === 2 && key === "exclude"),
    )
  )
    throw new Error("Invalid snapshot selection policy.");
  const include = normalizeSyncInclude(selection.include);
  if (selection.version === 1) return { version: 1, include };
  if (!Array.isArray(selection.exclude)) throw new Error("Invalid snapshot exclude policy.");
  return { version: 2, include, exclude: normalizeSyncExclude(selection.exclude) };
}

export function snapshotSelectionInclude(snapshot: Pick<Snapshot, "selection">) {
  return snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection).include;
}

export function snapshotSelectionExclude(snapshot: Pick<Snapshot, "selection">) {
  return snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection).exclude;
}

export function selectionForSnapshot(include: unknown, exclude?: unknown): SnapshotSelection {
  const normalized = normalizeSyncInclude(include);
  return exclude === undefined
    ? { version: 1, include: normalized }
    : { version: 2, include: normalized, exclude: normalizeSyncExclude(exclude) };
}

/** Metadata equality, not policy compatibility: bind the whole projection to its immutable image. */
export function sameSnapshotSelection(left: SnapshotSelection | undefined, right: SnapshotSelection | undefined) {
  return (
    JSON.stringify(left === undefined ? null : portableSnapshotSelection(left)) ===
    JSON.stringify(right === undefined ? null : portableSnapshotSelection(right))
  );
}

export function validateSnapshotSelection(snapshot: Pick<Snapshot, "version" | "selection">) {
  const selection = snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection);
  if ((snapshot.version === 4) !== (selection?.version === 2))
    throw new Error("Exclude policy requires snapshot version 4 and selection version 2.");
}

export function sameSyncInclude(left: unknown, right: unknown) {
  const normalizedLeft = normalizeSyncInclude(left);
  const normalizedRight = normalizeSyncInclude(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((item, index) => item === normalizedRight[index])
  );
}

export function compareSyncInclude(local: unknown, remote: unknown) {
  const localInclude = normalizeSyncInclude(local);
  const remoteInclude = normalizeSyncInclude(remote);
  const localSet = new Set(localInclude);
  const remoteSet = new Set(remoteInclude);
  return {
    same: sameSyncInclude(localInclude, remoteInclude),
    remoteOnly: remoteInclude.filter((item) => !localSet.has(item)),
    localOnly: localInclude.filter((item) => !remoteSet.has(item)),
  };
}

export type RemoteSelectionState =
  | { kind: "legacy"; discovered: string[] }
  | { kind: "same"; include: string[]; exclude?: string[] }
  | {
      kind: "different";
      include: string[];
      exclude?: string[];
      remoteOnly: string[];
      localOnly: string[];
      excludeChanged?: boolean;
    };

export function inspectRemoteSelection(
  localInclude: unknown,
  snapshot: Pick<Snapshot, "selection" | "files">,
  localExclude?: unknown,
): RemoteSelectionState {
  const remoteInclude = snapshotSelectionInclude(snapshot);
  if (!remoteInclude) return { kind: "legacy", discovered: discoverLegacySnapshotInclude(snapshot) };
  const exclude = snapshotSelectionExclude(snapshot);
  const comparison = compareSyncInclude(localInclude, remoteInclude);
  const rules = exclude === undefined ? {} : { exclude };
  return comparison.same && sameSyncExclude(localExclude, exclude)
    ? { kind: "same", include: remoteInclude, ...rules }
    : {
        kind: "different",
        include: remoteInclude,
        ...comparison,
        ...rules,
        ...(!sameSyncExclude(localExclude, exclude) ? { excludeChanged: true } : {}),
      };
}

export interface RemoteSelectionDecision {
  setupName: string;
  configIdentity: string;
  localInclude: readonly string[];
  remoteInclude: readonly string[];
  localExclude?: readonly string[];
  remoteExclude?: readonly string[];
}

export class RemoteSelectionMismatchError extends Error {
  readonly decision: RemoteSelectionDecision;
  readonly setupName: string;
  readonly localInclude: string[];
  readonly remoteInclude: string[];

  constructor(
    setupName: string,
    localInclude: unknown,
    remoteInclude: unknown,
    configIdentity = JSON.stringify([setupName, normalizeSyncInclude(localInclude)]),
    localExclude?: string[],
    remoteExclude?: string[],
  ) {
    const local = normalizeSyncInclude(localInclude);
    const remote = normalizeSyncInclude(remoteInclude);
    super(formatRemoteSelectionMismatch(setupName, local, remote, localExclude, remoteExclude));
    this.name = "RemoteSelectionMismatchError";
    this.setupName = setupName;
    this.localInclude = local;
    this.remoteInclude = remote;
    this.decision = {
      setupName,
      configIdentity,
      localInclude: [...local],
      remoteInclude: [...remote],
      ...(localExclude === undefined ? {} : { localExclude: normalizeSyncExclude(localExclude) }),
      ...(remoteExclude === undefined ? {} : { remoteExclude: normalizeSyncExclude(remoteExclude) }),
    };
  }
}

export function remoteSelectionMismatch(
  config: { setupName: string; include: unknown; exclude?: string[] },
  remoteInclude: unknown,
  configIdentity?: string,
  remoteExclude?: string[],
) {
  return new RemoteSelectionMismatchError(
    config.setupName,
    config.include,
    remoteInclude,
    configIdentity,
    config.exclude,
    remoteExclude,
  );
}

export function formatRemoteSelectionMismatch(
  setupName: string,
  localInclude: readonly string[],
  remoteInclude: readonly string[],
  localExclude?: readonly string[],
  remoteExclude?: readonly string[],
) {
  const comparison = compareSyncInclude(localInclude, remoteInclude);
  const lines = [
    `Synced content differs for sync setup “${stripTerminalControls(setupName)}”.`,
    `Remote-only: ${comparison.remoteOnly.join(", ") || "none"}`,
    `This-device-only: ${comparison.localOnly.join(", ") || "none"}`,
  ];
  if (!sameSyncExclude(localExclude, remoteExclude)) {
    lines.push(
      `Remote excluded paths: ${normalizeSyncExclude(remoteExclude).join(", ") || "none"}`,
      `This device excluded paths: ${normalizeSyncExclude(localExclude).join(", ") || "none"}`,
    );
  } else if (comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0) {
    lines.push(
      "Only ordering differs.",
      `Remote order: ${remoteInclude.join(", ") || "none"}`,
      `This device order: ${localInclude.join(", ") || "none"}`,
    );
  }
  lines.push("Run /sync in TUI to review both content lists and choose what happens next.");
  return lines.join("\n");
}

function stripTerminalControls(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

export function discoverLegacySnapshotInclude(snapshot: Pick<Snapshot, "files">) {
  const builtIns = new Set<BuiltInSyncFile>();
  const custom = new Set<string>();
  let sessions = false;
  for (const file of snapshot.files) {
    const normalized = toPosix(file.path);
    if (
      !normalized ||
      file.path.includes("\\") ||
      normalized.length > 4096 ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      path.posix.normalize(normalized) !== normalized ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Ignore unsafe legacy paths.
      /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ||
      isDeniedPath(normalized)
    ) {
      continue;
    }
    const [topLevel, ...rest] = normalized.split("/");
    if (!topLevel) continue;
    if (topLevel === "sessions" && rest.length > 0) {
      sessions = true;
      continue;
    }
    const builtIn = BUILT_IN_BY_LOWER.get(topLevel.toLowerCase());
    if (
      builtIn &&
      ((TOP_LEVEL_DIRS.has(builtIn) && rest.length > 0) || (!TOP_LEVEL_DIRS.has(builtIn) && rest.length === 0))
    ) {
      builtIns.add(builtIn);
      continue;
    }
    if (isSafeCustomIncludePath(topLevel)) custom.add(topLevel);
  }
  return [
    ...BUILT_IN_SYNC_ROOTS.filter((item) => builtIns.has(item)),
    ...[...custom].sort((left, right) => left.localeCompare(right)),
    ...(sessions ? ["sessions"] : []),
  ];
}

export function syncIncludeSelection(value: unknown) {
  const include = normalizeSyncInclude(value);
  const builtIns = include.filter((item): item is BuiltInSyncFile => BUILT_IN_BY_LOWER.has(item.toLowerCase()));
  const custom = include.filter((item) => item !== "sessions" && !BUILT_IN_BY_LOWER.has(item.toLowerCase()));
  return { include, builtIns, custom, sessions: include.includes("sessions") };
}

export function customIncludePathsByLower(value: unknown) {
  return new Map(syncIncludeSelection(value).custom.map((relativePath) => [relativePath.toLowerCase(), relativePath]));
}

export interface SyncSelectionConfig {
  include?: unknown;
  exclude?: unknown;
  syncFiles?: unknown;
  syncSessions?: boolean;
  extraFiles?: unknown;
}

export function includeFromSelectionConfig(config: SyncSelectionConfig) {
  if (config.include !== undefined) return normalizeSyncInclude(config.include);
  return [
    ...normalizeSyncFiles(config.syncFiles),
    ...normalizeExtraFiles(config.extraFiles),
    ...(config.syncSessions ? ["sessions"] : []),
  ];
}

export function syncSessionsSelected(config: SyncSelectionConfig) {
  return includeFromSelectionConfig(config).includes("sessions") && !compileSyncExclude(config.exclude)("sessions");
}

export function isConfiguredSnapshotPath(
  relativePath: string,
  config: SyncSelectionConfig,
  _legacyExtraFiles?: Set<string>,
) {
  return configuredSnapshotPathMatcher(config)(relativePath);
}

export function configuredSnapshotPathMatcher(config: SyncSelectionConfig) {
  const selection = syncIncludeSelection(includeFromSelectionConfig(config));
  const excluded = compileSyncExclude(config.exclude);
  return (relativePath: string) => {
    const normalized = toPosix(relativePath);
    if (excluded(normalized)) return false;
    if (normalized.startsWith("sessions/")) return selection.sessions;
    const lower = normalized.toLowerCase();
    if (!normalized.includes("/")) {
      const builtIn = BUILT_IN_BY_LOWER.get(lower);
      if (builtIn) return selection.builtIns.includes(builtIn) && !TOP_LEVEL_DIRS.has(builtIn);
    }
    const topLevel = normalized.slice(0, normalized.indexOf("/"));
    if (selection.builtIns.includes(topLevel as BuiltInSyncFile) && TOP_LEVEL_DIRS.has(topLevel)) return true;
    return selection.custom.some((candidate) => {
      const key = candidate.toLowerCase();
      return lower === key || lower.startsWith(`${key}/`);
    });
  };
}

export function canonicalSnapshotPathForConfig(relativePath: string, includePaths: Map<string, string>) {
  const normalized = toPosix(relativePath);
  const lower = normalized.toLowerCase();
  return TOP_LEVEL_FILE_PATHS.get(lower) ?? includePaths.get(lower) ?? normalized;
}

export function isPreservableUnmanagedSnapshotPath(relativePath: string) {
  const normalized = toPosix(relativePath);
  if (!normalized || isDeniedPath(normalized)) return false;
  if (normalized.startsWith("sessions/")) return normalized.endsWith(".jsonl");
  if (!normalized.includes("/")) {
    const lower = normalized.toLowerCase();
    return TOP_LEVEL_FILE_PATHS.has(lower) || !RESERVED_TOP_LEVEL_NAMES.has(lower);
  }
  return true;
}

export function isSafeCustomIncludePath(relativePath: string) {
  try {
    validateAgentRelativeInclude(relativePath);
    return true;
  } catch {
    return false;
  }
}

export function isBuiltInTopLevelFile(fileName: string) {
  return TOP_LEVEL_FILE_PATHS.has(path.posix.basename(fileName).toLowerCase());
}

/** Compatibility projection for backend-neutral output while callers move to sync.include. */
export function normalizeSyncFiles(value: unknown): BuiltInSyncFile[] {
  if (value === undefined) return [...DEFAULT_SYNC_INCLUDE];
  if (Array.isArray(value)) {
    return normalizeSyncInclude(value).filter((item): item is BuiltInSyncFile =>
      BUILT_IN_BY_LOWER.has(item.toLowerCase()),
    );
  }
  throw new Error("Invalid pi-sync settings: expected an include array.");
}

/** Compatibility projection for old rendering helpers; v3 persistence never writes this split field. */
export function normalizeExtraFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && isSafeCustomIncludePath(item));
}

export const extraFilePathsByLower = customIncludePathsByLower;
export const isSafeExtraFileName = isSafeCustomIncludePath;
export const selectedSyncFileSet = (value: unknown) => new Set(normalizeSyncFiles(value));
