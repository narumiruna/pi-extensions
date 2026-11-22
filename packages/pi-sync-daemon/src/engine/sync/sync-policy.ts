import { createHash } from "node:crypto";
import path from "node:path";
import { DEBUG_LOG_FILENAME, isDebugLogPath, isDeniedPath, toPosix } from "../paths.js";
import {
  type DirectoryScope,
  IGNORE_SNAPSHOT_VERSION,
  type Snapshot,
  type SnapshotSelection,
} from "../snapshot/snapshot-types.js";
import { compilePathRules, compileSyncExclude, normalizeSyncExclude, sameSyncExclude } from "./exclude-policy.js";

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

export function normalizeDirectoryRules(value: unknown): string[] {
  return normalizeSyncExclude(
    Array.isArray(value)
      ? value.map((rule: unknown) => (typeof rule === "string" ? rule.replace(/(?<!\/)\/(?= *$)/u, "") : rule))
      : value,
  );
}

export function portableSnapshotSelection(value: unknown): SnapshotSelection {
  const selection = value as Partial<SnapshotSelection> | null;
  if (selection && typeof selection === "object" && !Array.isArray(selection) && selection.version === 4) {
    if (
      selection.scope !== "agent-directory" ||
      typeof selection.sessions !== "boolean" ||
      typeof selection.fingerprint !== "string" ||
      selection.fingerprint.length !== 64 ||
      !/^[0-9a-f]{64}$/u.test(selection.fingerprint) ||
      Object.keys(selection).length !== 4 ||
      !["version", "scope", "sessions", "fingerprint"].every((key) => Object.hasOwn(selection, key))
    )
      throw new Error("Invalid ignore-file snapshot policy.");
    return {
      version: 4,
      scope: "agent-directory",
      fingerprint: selection.fingerprint,
      sessions: selection.sessions,
    };
  }
  if (selection && typeof selection === "object" && !Array.isArray(selection) && selection.version === 3) {
    if (
      selection.scope !== "agent-directory" ||
      !Array.isArray(selection.exclude) ||
      !Array.isArray(selection.reinclude) ||
      Object.keys(selection).some((key) => !["version", "scope", "include", "exclude", "reinclude"].includes(key))
    )
      throw new Error("Invalid agent-directory snapshot policy.");
    return directorySelection(selection.include, selection.exclude, selection.reinclude);
  }
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
  if (snapshot.selection === undefined) return undefined;
  const selection = portableSnapshotSelection(snapshot.selection);
  return selection.version === 4 ? (selection.sessions ? ["sessions"] : []) : selection.include;
}

export function snapshotSelectionExclude(snapshot: Pick<Snapshot, "selection">) {
  return snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection).exclude;
}

function directorySelection(include: unknown, exclude: unknown, reinclude: unknown): SnapshotSelection {
  const normalized = normalizeSyncInclude(include);
  if (normalized.some((root) => root !== "sessions"))
    throw new Error("Agent-directory snapshots only use include metadata for explicit session selection.");
  return {
    version: 3,
    scope: "agent-directory",
    include: normalized,
    exclude: normalizeDirectoryRules(exclude),
    reinclude: normalizeDirectoryRules(reinclude),
  };
}

export function selectionForSnapshot(
  include: unknown,
  exclude?: unknown,
  directory?: DirectoryScope,
): SnapshotSelection {
  if (directory?.ignorePolicy) {
    if (directory.scope !== "agent-directory") throw new Error("Ignore rules require agent-directory scope.");
    return portableSnapshotSelection({
      version: 4,
      scope: directory.scope,
      fingerprint: directory.ignorePolicy.fingerprint,
      sessions: directory.ignorePolicy.sessions,
    });
  }
  if (directory?.scope === "agent-directory") return directorySelection(include, exclude, directory.reinclude);
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
  if ((snapshot.version === 5) !== (selection?.version === 3))
    throw new Error("Agent-directory policy requires snapshot version 5 and selection version 3.");
  if ((snapshot.version === IGNORE_SNAPSHOT_VERSION) !== (selection?.version === 4))
    throw new Error("Ignore-file policy requires snapshot version 6 and selection version 4.");
}

export function assertSnapshotPathExcludesDebugLog(filePath: unknown) {
  if (typeof filePath === "string" && isDebugLogPath(filePath))
    throw new Error(
      `Snapshot contains the local-only ${DEBUG_LOG_FILENAME}. Review the old snapshot before retrying sync.`,
    );
}

export function assertSnapshotExcludesDebugLog(snapshot: Pick<Snapshot, "files">) {
  for (const file of snapshot.files) assertSnapshotPathExcludesDebugLog(file?.path);
}

export function requireLegacyTransferPolicy(snapshot: Partial<Pick<Snapshot, "version" | "selection">>) {
  if (snapshot.version === IGNORE_SNAPSHOT_VERSION || snapshot.selection?.version === 4)
    throw new Error("This setup cannot transfer an ignore-file snapshot without a reviewed local ignore policy.");
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

export type IgnorePolicyComparison = "match" | "mismatch" | "local-ignore-remote-legacy" | "local-legacy-remote-ignore";

type PortableDirectoryScope = Pick<DirectoryScope, "scope" | "reinclude">;

export type RemoteSelectionState =
  | { kind: "legacy"; discovered: string[]; ignorePolicyComparison?: never }
  | ({ kind: "same"; include: string[]; exclude?: string[]; ignorePolicyComparison?: "match" } & PortableDirectoryScope)
  | ({
      kind: "different";
      include: string[];
      exclude?: string[];
      remoteOnly: string[];
      localOnly: string[];
      excludeChanged?: boolean;
      ignorePolicyComparison?: Exclude<IgnorePolicyComparison, "match">;
    } & PortableDirectoryScope);

export function compareIgnorePolicy(
  local: DirectoryScope["ignorePolicy"],
  remote: SnapshotSelection | undefined,
): IgnorePolicyComparison | undefined {
  if (remote?.version !== 4) return local ? "local-ignore-remote-legacy" : undefined;
  if (!local) return "local-legacy-remote-ignore";
  return local.fingerprint === remote.fingerprint && local.sessions === remote.sessions ? "match" : "mismatch";
}

export function formatIgnorePolicyComparison(comparison: IgnorePolicyComparison) {
  switch (comparison) {
    case "match":
      return "Remote ignore-file policy matches this device.";
    case "mismatch":
      return "Remote ignore-file policy differs. Edit local rules to match, or review publishing this device's policy.";
    case "local-ignore-remote-legacy":
      return "Remote uses a legacy content policy. Review publishing this device's ignore-file policy.";
    case "local-legacy-remote-ignore":
      return "Remote uses an ignore-file policy. Configure matching local rules before transferring.";
  }
}

export function syncDirectoryPolicyKey(config: SyncSelectionConfig) {
  if (config.scope !== "agent-directory") return undefined;
  const policy = config.ignorePolicy;
  if (policy) {
    return JSON.stringify([
      "ignore-file",
      policy.fingerprint,
      policy.sessions,
      policy.filename,
      policy.sourceDigest,
      policy.reservedNames,
    ]);
  }
  return JSON.stringify([
    config.scope,
    includeFromSelectionConfig(config).includes("sessions"),
    normalizeDirectoryRules(config.exclude).map((rule) => rule.toLowerCase()),
    normalizeDirectoryRules(config.reinclude).map((rule) => rule.toLowerCase()),
  ]);
}

export function localIgnorePolicyKey(
  config: SyncSelectionConfig & { setupName?: string; ignoreSourceIdentity?: string; recoverySetupKey?: string },
) {
  if (!config.ignorePolicy && config.reservedIgnoreNames === undefined) return undefined;
  const reserved = reservedIgnoreSnapshotNames(config);
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.setupName,
        config.recoverySetupKey,
        syncDirectoryPolicyKey(config) ?? [
          includeFromSelectionConfig(config),
          normalizeSyncExclude(config.exclude).map((rule) => rule.toLowerCase()),
        ],
        config.ignoreSourceIdentity,
        [...(reserved ?? [])].sort(),
      ]),
    )
    .digest("hex");
}

export function inspectRemoteSelection(
  localInclude: unknown,
  snapshot: Pick<Snapshot, "selection" | "files">,
  localExclude?: unknown,
  directory?: DirectoryScope,
): RemoteSelectionState {
  const selection = snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection);
  const ignorePolicyComparison = compareIgnorePolicy(directory?.ignorePolicy, selection);
  if (ignorePolicyComparison !== undefined) {
    const include = snapshotSelectionInclude(snapshot) ?? discoverLegacySnapshotInclude(snapshot);
    const scope = selection?.scope;
    if (ignorePolicyComparison === "match") return { kind: "same", include, scope, ignorePolicyComparison };
    const comparison = compareSyncInclude(
      directory?.ignorePolicy ? (directory.ignorePolicy.sessions ? ["sessions"] : []) : localInclude,
      include,
    );
    return { kind: "different", include, scope, ...comparison, ignorePolicyComparison };
  }
  if (!selection && !directory?.scope) return { kind: "legacy", discovered: discoverLegacySnapshotInclude(snapshot) };
  const remoteInclude = selection?.include ?? discoverLegacySnapshotInclude(snapshot);
  const exclude = selection?.exclude;
  const comparison = compareSyncInclude(localInclude, remoteInclude);
  const rules = {
    ...(exclude === undefined ? {} : { exclude }),
    ...(selection?.scope ? { scope: selection.scope, reinclude: selection.reinclude } : {}),
  };
  const directoryKey = syncDirectoryPolicyKey({ include: localInclude, exclude: localExclude, ...directory });
  const sameDirectoryPolicy = directoryKey === syncDirectoryPolicyKey({ include: remoteInclude, ...rules });
  const sameExclusions =
    directoryKey !== undefined
      ? sameSyncExclude(normalizeDirectoryRules(localExclude), exclude)
      : sameSyncExclude(localExclude, exclude);
  return comparison.same && sameExclusions && sameDirectoryPolicy
    ? { kind: "same", include: remoteInclude, ...rules }
    : {
        kind: "different",
        include: remoteInclude,
        ...comparison,
        ...rules,
        ...(!sameExclusions ? { excludeChanged: true } : {}),
      };
}

export interface RemoteSelectionDecision {
  setupName: string;
  configIdentity: string;
  localInclude: readonly string[];
  remoteInclude: readonly string[];
  localExclude?: readonly string[];
  remoteExclude?: readonly string[];
  localDirectory?: PortableDirectoryScope;
  remoteDirectory?: PortableDirectoryScope;
  ignorePolicyComparison?: IgnorePolicyComparison;
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
    localDirectory?: DirectoryScope,
    remoteDirectory?: PortableDirectoryScope,
    ignorePolicyComparison?: IgnorePolicyComparison,
  ) {
    const local = normalizeSyncInclude(localInclude);
    const remote = normalizeSyncInclude(remoteInclude);
    super(
      ignorePolicyComparison
        ? formatIgnorePolicyComparison(ignorePolicyComparison)
        : formatRemoteSelectionMismatch(
            setupName,
            local,
            remote,
            localExclude,
            remoteExclude,
            localDirectory,
            remoteDirectory,
          ),
    );
    this.name = "RemoteSelectionMismatchError";
    this.setupName = setupName;
    this.localInclude = local;
    this.remoteInclude = remote;
    this.decision = {
      setupName,
      configIdentity,
      localInclude: [...local],
      remoteInclude: [...remote],
      ...(ignorePolicyComparison
        ? { ignorePolicyComparison }
        : {
            ...(localExclude === undefined ? {} : { localExclude: normalizeSyncExclude(localExclude) }),
            ...(remoteExclude === undefined ? {} : { remoteExclude: normalizeSyncExclude(remoteExclude) }),
            ...(localDirectory?.scope ? { localDirectory: directoryRules(localDirectory) } : {}),
            ...(remoteDirectory?.scope ? { remoteDirectory: directoryRules(remoteDirectory) } : {}),
          }),
    };
  }
}

function directoryRules(directory: PortableDirectoryScope): PortableDirectoryScope {
  return { scope: directory.scope, reinclude: normalizeDirectoryRules(directory.reinclude) };
}

export function remoteSelectionMismatch(
  config: { setupName: string; include: unknown; exclude?: string[] } & DirectoryScope,
  remoteInclude: unknown,
  configIdentity?: string,
  remoteExclude?: string[],
  remoteDirectory?: PortableDirectoryScope & { ignorePolicyComparison?: IgnorePolicyComparison },
) {
  return new RemoteSelectionMismatchError(
    config.setupName,
    config.include,
    remoteInclude,
    configIdentity,
    config.exclude,
    remoteExclude,
    config,
    remoteDirectory,
    remoteDirectory?.ignorePolicyComparison,
  );
}

export function formatRemoteSelectionMismatch(
  setupName: string,
  localInclude: readonly string[],
  remoteInclude: readonly string[],
  localExclude?: readonly string[],
  remoteExclude?: readonly string[],
  localDirectory?: DirectoryScope,
  remoteDirectory?: DirectoryScope,
) {
  const comparison = compareSyncInclude(localInclude, remoteInclude);
  const lines = [
    `Synced content differs for sync setup “${stripTerminalControls(setupName)}”.`,
    `Remote-only: ${comparison.remoteOnly.join(", ") || "none"}`,
    `This-device-only: ${comparison.localOnly.join(", ") || "none"}`,
  ];
  if (localDirectory?.scope || remoteDirectory?.scope) {
    lines.push(
      `Remote scope: ${remoteDirectory?.scope ?? "selected paths or legacy"}`,
      `This device scope: ${localDirectory?.scope ?? "selected paths"}`,
      `Remote excluded paths: ${normalizeSyncExclude(remoteExclude).join(", ") || "none"}`,
      `This device excluded paths: ${normalizeSyncExclude(localExclude).join(", ") || "none"}`,
      `Remote re-included paths: ${normalizeDirectoryRules(remoteDirectory?.reinclude).join(", ") || "none"}`,
      `This device re-included paths: ${normalizeDirectoryRules(localDirectory?.reinclude).join(", ") || "none"}`,
    );
  } else if (!sameSyncExclude(localExclude, remoteExclude)) {
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

export interface SyncSelectionConfig extends DirectoryScope {
  version?: number;
  fingerprint?: string;
  sessions?: boolean;
  include?: unknown;
  exclude?: unknown;
  syncFiles?: unknown;
  syncSessions?: boolean;
  extraFiles?: unknown;
}

export function includeFromSelectionConfig(config: SyncSelectionConfig) {
  if (config.ignorePolicy) return config.ignorePolicy.sessions ? ["sessions"] : [];
  if (config.include !== undefined) return normalizeSyncInclude(config.include);
  if (config.scope === "agent-directory")
    return isIgnoreSnapshotSelection(config) && config.sessions ? ["sessions"] : [];
  return [
    ...normalizeSyncFiles(config.syncFiles),
    ...normalizeExtraFiles(config.extraFiles),
    ...(config.syncSessions ? ["sessions"] : []),
  ];
}

export function syncSelectionHasContent(config: SyncSelectionConfig) {
  return config.scope === "agent-directory" || includeFromSelectionConfig(config).length > 0;
}

const DIRECTORY_SCOPE_LOCAL_ROOTS = new Set([
  "auth.json",
  "auth.json.lock",
  "trust.json",
  "trust.json.lock",
  "settings.json.lock",
  "models-store.json",
  "models-store.json.lock",
  "crashes.json",
  "pi-debug.log",
]);

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isProtectedDirectoryPath(relativePath: string) {
  if (Buffer.byteLength(relativePath, "utf8") > 4_096) return true;
  const segments = relativePath.split("/");
  const root = segments[0]?.toLowerCase();
  if (
    segments.some(
      (segment) =>
        !segment || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment),
    ) ||
    /[\\<>:"|?*]/u.test(relativePath) ||
    hasControlCharacter(relativePath) ||
    (root === "sessions" && segments[0] !== "sessions") ||
    (root === "settings.json" && relativePath !== "settings.json") ||
    (root !== undefined && DIRECTORY_SCOPE_LOCAL_ROOTS.has(root))
  )
    return true;
  for (let ancestor = relativePath; ancestor; ) {
    if (isDeniedPath(ancestor)) return true;
    const slash = ancestor.lastIndexOf("/");
    if (slash < 0) break;
    ancestor = ancestor.slice(0, slash);
  }
  return false;
}

export function isIgnoreControlPath(relativePath: string, reservedNames?: ReadonlySet<string>) {
  const first = (relativePath.split("/", 1)[0] ?? "").toLowerCase();
  return first === ".syncignore" || reservedNames?.has(first) === true;
}

function isIgnoreSnapshotSelection(config: SyncSelectionConfig) {
  return config.version === 4 && config.fingerprint !== undefined;
}

function reservedIgnoreSnapshotNames(config: SyncSelectionConfig) {
  const local = config.ignorePolicy;
  if (!local && !config.reservedIgnoreNames && !isIgnoreSnapshotSelection(config)) return undefined;
  return new Set(
    [
      ".syncignore",
      ...(local ? [local.filename, ...local.reservedNames] : []),
      ...(config.reservedIgnoreNames ?? []),
    ].map((name) => name.toLowerCase()),
  );
}

function compileIgnoreControlPath(config: SyncSelectionConfig) {
  const names = reservedIgnoreSnapshotNames(config);
  return names ? (relativePath: string) => isIgnoreControlPath(relativePath, names) : undefined;
}

function compileDirectoryPolicy(config: SyncSelectionConfig) {
  const localIgnore = config.ignorePolicy;
  const ignoreSelection = localIgnore !== undefined || isIgnoreSnapshotSelection(config);
  const controlPath = compileIgnoreControlPath(config);
  const sessions = includeFromSelectionConfig(config).includes("sessions");
  const blocked = (relativePath: string) =>
    isProtectedDirectoryPath(relativePath) ||
    (ignoreSelection && !relativePath.isWellFormed()) ||
    controlPath?.(relativePath) === true ||
    (!sessions && /^sessions(?:\/|$)/iu.test(relativePath));
  if (localIgnore) {
    return {
      excludes: (relativePath: string, directory = false) =>
        blocked(relativePath) || localIgnore.matches(relativePath, directory),
      descends: (relativePath: string) => !blocked(relativePath) && !localIgnore.matches(relativePath, true),
    };
  }

  const excluded = compilePathRules(normalizeDirectoryRules(config.exclude));
  const restored = compilePathRules(normalizeDirectoryRules(config.reinclude));
  return {
    excludes: (relativePath: string) =>
      blocked(relativePath) || (excluded.matches(relativePath) && !restored.matches(relativePath)),
    descends: (relativePath: string) =>
      !blocked(relativePath) &&
      (!excluded.matches(relativePath) || restored.matches(relativePath) || restored.mayMatchBelow(relativePath)),
  };
}

export const MAX_AGENT_DIRECTORY_ENTRIES = 65_536;
export const MAX_AGENT_DIRECTORY_FILES = 16_384;

export function assertAgentDirectoryPathLayout(files: Iterable<string>) {
  const prefixes = new Map<string, { spelling: string; file: boolean }>();
  let count = 0;
  for (const file of files) {
    if (++count > MAX_AGENT_DIRECTORY_FILES) throw new Error("Agent-directory snapshot exceeds the file bound.");
    for (let end = file.indexOf("/"); ; end = file.indexOf("/", end + 1)) {
      const spelling = end === -1 ? file : file.slice(0, end);
      const portable = spelling.normalize("NFC").toLowerCase();
      const known = prefixes.get(portable);
      if (known && (known.spelling !== spelling || known.file || end === -1))
        throw new Error("Agent-directory snapshot has conflicting portable paths.");
      if (!known) {
        if (prefixes.size >= MAX_AGENT_DIRECTORY_ENTRIES)
          throw new Error("Agent-directory snapshot exceeds the path bound.");
        prefixes.set(portable, { spelling, file: end === -1 });
      }
      if (end === -1) break;
    }
  }
}

export function compileSyncPolicyExclude(
  config: SyncSelectionConfig,
): (relativePath: string, directory?: boolean) => boolean {
  if (config.scope === "agent-directory") return compileDirectoryPolicy(config).excludes;
  const excludes = compileSyncExclude(config.exclude);
  const controlPath = compileIgnoreControlPath(config);
  return controlPath ? (relativePath) => controlPath(toPosix(relativePath)) || excludes(relativePath) : excludes;
}

export function compileSyncPolicyTraversal(config: SyncSelectionConfig) {
  if (config.scope === "agent-directory") return compileDirectoryPolicy(config).descends;
  const excludes = compileSyncPolicyExclude(config);
  return (relativePath: string) => !excludes(relativePath);
}

export function syncSessionsSelected(config: SyncSelectionConfig) {
  return includeFromSelectionConfig(config).includes("sessions") && compileSyncPolicyTraversal(config)("sessions");
}

export function isConfiguredSnapshotPath(
  relativePath: string,
  config: SyncSelectionConfig,
  _legacyExtraFiles?: Set<string>,
) {
  return configuredSnapshotPathMatcher(config)(relativePath);
}

export function configuredSnapshotPathMatcher(config: SyncSelectionConfig) {
  if (config.scope === "agent-directory") {
    const excluded = compileSyncPolicyExclude(config);
    return (relativePath: string) =>
      !excluded(relativePath) &&
      relativePath !== "sessions" &&
      (!relativePath.startsWith("sessions/") || relativePath.endsWith(".jsonl"));
  }
  const selection = syncIncludeSelection(includeFromSelectionConfig(config));
  const excluded = compileSyncPolicyExclude(config);
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
