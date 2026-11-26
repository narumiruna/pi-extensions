import fs from "node:fs/promises";
import path from "node:path";
import { assertWithinRoot, isDeniedPath, isPathInside } from "../paths.js";
import { retiredIgnorePolicy } from "../settings/retired-ignore-policy.js";
import { normalizeSyncExclude, sameSyncExclude } from "../sync/exclude-policy.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { portableSnapshotSelection, type SyncSelectionConfig, syncDirectoryPolicyKey } from "../sync/sync-policy.js";
import { agentDir } from "./session-paths.js";
import { isCaseReplacement } from "./snapshot-case-replacement.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import { type SessionRootTransition, validateSessionRootTransition } from "./snapshot-root-transition.js";
import type { SnapshotOptions, SnapshotSelection } from "./snapshot-types.js";

export const LEGACY_AGENT_DIRECTORY_JOURNAL_VERSION = 8;
export const FIXED_WORKSPACE_JOURNAL_VERSION = 9;
export const AGENT_DIRECTORY_JOURNAL_VERSION = 10;
export function isScopedJournal(journal: TransactionJournalPolicy) {
  return [
    LEGACY_AGENT_DIRECTORY_JOURNAL_VERSION,
    FIXED_WORKSPACE_JOURNAL_VERSION,
    AGENT_DIRECTORY_JOURNAL_VERSION,
  ].includes(journal.version);
}

function usesSlottedWorkspace(journal: TransactionJournalPolicy) {
  return journal.version >= AGENT_DIRECTORY_JOURNAL_VERSION && isScopedJournal(journal);
}

export function isRecoveryStageId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

export function isScopedIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}:[1-9]\d{0,19}:\d{1,20}$/u.test(value);
}

export interface TransactionJournalPolicy {
  version: number;
  exclude?: string[];
  selection?: SnapshotSelection;
}

export type TransactionOptions = SyncSelectionConfig &
  Pick<SnapshotOptions, "signal" | "validateMutation" | "validateApplyReview"> & {
    sessionDir?: string;
    protectedTargets?: readonly string[];
    expectedPreimages?: ReadonlyMap<string, string>;
    resolveConfiguredSessionDir?: boolean;
  };

export function validateJournalPolicy(journal: TransactionJournalPolicy) {
  if (journal && ([11, 12, 13].includes(journal.version) || Object.hasOwn(journal, "ignoreSource")))
    throw retiredIgnorePolicy("recovery");
  if (!journal || (![1, 2, 3, 4, 5, 6, 7].includes(journal.version) && !isScopedJournal(journal)))
    throw new Error("Unsupported pi-sync transaction journal; preserve evidence for review.");
  if (isScopedJournal(journal)) {
    if (journal.exclude !== undefined || portableSnapshotSelection(journal.selection).version !== 3)
      throw new Error("Invalid agent-directory transaction policy; preserve evidence.");
  } else if (journal.selection !== undefined) {
    throw new Error("Unsupported pi-sync transaction journal policy; preserve evidence for review.");
  }
  if (journal.exclude !== undefined && !Array.isArray(journal.exclude))
    throw new Error("Invalid transaction exclude policy; preserve evidence.");
  normalizeSyncExclude(journal.exclude);
}

export function assertRecoveryPolicy(journal: TransactionJournalPolicy, options: TransactionOptions) {
  const directoryKey = syncDirectoryPolicyKey(journal.selection ?? {});
  const effectiveDirectoryKey = syncDirectoryPolicyKey(options);
  if (
    directoryKey !== undefined
      ? directoryKey === effectiveDirectoryKey
      : effectiveDirectoryKey === undefined && sameSyncExclude(journal.exclude, options.exclude)
  )
    return;
  throw new Error(
    "Pending transaction has a different exclude policy or directory scope; preserve its backup for reviewed recovery.",
  );
}

export interface TransactionEntry {
  target: string;
  afterTarget?: string;
  backupName: string;
  kind: "missing" | "file" | "directory" | "symlink";
  linkTarget?: string;
  beforeImage?: string;
  afterImage?: string;
  postFiles?: { relative: string; image: string }[];
  removalPending?: boolean;
  replacementStarted?: boolean;
  recoveryStaged?: boolean;
  recoveryWorkspace?: string;
  recoveryWorkspaceId?: string;
  scopedRemoval?: { image: "before" | "after"; identity: string };
  vacantInstall?: string;
}
export interface TransactionJournal extends TransactionJournalPolicy {
  completed?: boolean;
  root: string;
  sessionRoot?: string;
  sessionRootTransition?: SessionRootTransition;
  entries: TransactionEntry[];
}

export function validateJournal(directory: string, journal: TransactionJournal, sessionDir?: string) {
  validateJournalPolicy(journal);
  const wholeDirectory = isScopedJournal(journal);
  const scopedWorkspace = wholeDirectory && journal.version >= FIXED_WORKSPACE_JOURNAL_VERSION;
  if (!Array.isArray(journal.entries) || journal.entries.length > 16_384)
    throw new Error("Unsupported pi-sync transaction journal; preserve evidence for review.");
  if (
    journal.completed !== undefined &&
    ((!wholeDirectory && ![6, 7].includes(journal.version)) || journal.completed !== true)
  )
    throw new Error("Invalid transaction completion evidence.");
  const root = path.resolve(agentDir());
  if (typeof journal.root !== "string" || path.resolve(journal.root) !== root)
    throw new Error("Transaction root no longer matches the Pi agent directory.");
  if (journal.sessionRootTransition !== undefined) {
    if (![7].includes(journal.version) || typeof journal.sessionRoot !== "string")
      throw new Error("Invalid session root-transition version.");
    validateSessionRootTransition(journal.sessionRootTransition);
  } else if (journal.version === 7) throw new Error("Missing session root-transition evidence.");
  const trustedSessionRoot = sessionDir
    ? path.resolve(sessionStorageRoot(root, sessionDir))
    : path.join(root, "sessions");
  if (wholeDirectory && journal.sessionRoot === undefined)
    throw new Error("Missing agent-directory transaction session root evidence.");
  if (
    journal.sessionRoot !== undefined &&
    (typeof journal.sessionRoot !== "string" ||
      !path.isAbsolute(journal.sessionRoot) ||
      path.resolve(journal.sessionRoot) !== journal.sessionRoot ||
      (!journal.completed &&
        (wholeDirectory || transactionHasSessionTargets(journal)) &&
        journal.sessionRoot !== trustedSessionRoot))
  )
    throw new Error("Transaction session root is not owned by this context; preserve evidence for review.");
  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry.target !== "string" ||
      !path.isAbsolute(entry.target) ||
      path.resolve(entry.target) !== entry.target ||
      typeof entry.backupName !== "string" ||
      !/^\d+$/u.test(entry.backupName) ||
      !["missing", "file", "directory", "symlink"].includes(entry.kind)
    )
      throw new Error("Invalid pi-sync transaction entry.");
    assertWithinRoot(directory, path.join(directory, "before", entry.backupName));
    assertAllowedTarget(root, journal.sessionRoot, entry.target);
    if (
      entry.afterTarget !== undefined &&
      ((!wholeDirectory && ![5, 6, 7].includes(journal.version)) ||
        typeof entry.afterTarget !== "string" ||
        !isCaseReplacement(root, entry.target, entry.afterTarget) ||
        path.resolve(entry.afterTarget) !== entry.afterTarget ||
        entry.kind !== "file")
    )
      throw new Error("Invalid transaction case replacement evidence.");
    if (entry.afterTarget) assertAllowedTarget(root, journal.sessionRoot, entry.afterTarget);
    if (
      journal.version >= 2 &&
      ((entry.beforeImage === undefined ? !journal.completed : typeof entry.beforeImage !== "string") ||
        (entry.afterImage === undefined ? !journal.completed : typeof entry.afterImage !== "string") ||
        (entry.postFiles === undefined ? !journal.completed : !Array.isArray(entry.postFiles)))
    )
      throw new Error("Invalid transaction postimage evidence.");
    if (entry.recoveryStaged !== undefined && (typeof entry.recoveryStaged !== "boolean" || scopedWorkspace))
      throw new Error("Invalid recovery staging evidence.");
    if (entry.removalPending !== undefined && (journal.version < 3 || typeof entry.removalPending !== "boolean"))
      throw new Error("Invalid transaction removal evidence.");
    if (
      entry.replacementStarted !== undefined &&
      (journal.version < 4 || typeof entry.replacementStarted !== "boolean")
    )
      throw new Error("Invalid transaction replacement evidence.");
    if (entry.removalPending && entry.replacementStarted)
      throw new Error("Conflicting transaction replacement evidence.");
    if (
      (entry.recoveryWorkspace !== undefined &&
        (!scopedWorkspace ||
          !isScopedIdentity(entry.recoveryWorkspace) ||
          entry.recoveryStaged ||
          !["file", "directory"].includes(entry.kind))) ||
      (entry.recoveryWorkspaceId !== undefined &&
        (!usesSlottedWorkspace(journal) ||
          !entry.recoveryWorkspace ||
          !isRecoveryStageId(entry.recoveryWorkspaceId))) ||
      (entry.scopedRemoval !== undefined &&
        (!scopedWorkspace ||
          !entry.removalPending ||
          !["before", "after"].includes(entry.scopedRemoval?.image) ||
          !isScopedIdentity(entry.scopedRemoval?.identity) ||
          (entry.scopedRemoval.image === "before"
            ? !["file", "directory"].includes(entry.kind)
            : entry.afterImage === "missing" && !entry.postFiles?.length))) ||
      (entry.vacantInstall !== undefined &&
        (!scopedWorkspace ||
          !entry.recoveryWorkspace ||
          !isScopedIdentity(entry.vacantInstall) ||
          entry.removalPending ||
          entry.replacementStarted))
    )
      throw new Error("Invalid scoped transaction progress evidence.");
    for (const file of entry.postFiles ?? []) {
      if (
        typeof file.relative !== "string" ||
        typeof file.image !== "string" ||
        !isStrictlyInside(entry.target, path.resolve(entry.target, file.relative))
      )
        throw new Error("Invalid transaction subtree evidence.");
    }
  }
}
export function transactionHasSessionTargets(journal: TransactionJournal) {
  const root = path.resolve(agentDir());
  return (
    Array.isArray(journal.entries) &&
    journal.entries.some(
      (entry) =>
        typeof entry?.target === "string" &&
        (!isPathInside(root, entry.target) ||
          isPathInside(path.join(root, "sessions"), entry.target) ||
          (typeof journal.sessionRoot === "string" && isPathInside(journal.sessionRoot, entry.target))),
    )
  );
}
export function isStrictlyInside(root: string, target: string) {
  return path.relative(path.resolve(root), path.resolve(target)) !== "" && isPathInside(root, target);
}

export function touchesProtectedTarget(target: string, protectedTargets?: readonly string[]) {
  return protectedTargets?.some(
    (protectedTarget) =>
      mergePathIdentity(target) === mergePathIdentity(protectedTarget) ||
      isPathInside(mergePathIdentity(target), mergePathIdentity(protectedTarget)),
  );
}

export async function assertSafeParents(root: string, sessionRoot: string | undefined, target: string) {
  assertAllowedTarget(root, sessionRoot, target);
  const boundary = isPathInside(root, target) ? root : sessionRoot;
  for (
    let parent = path.dirname(target);
    boundary && mergePathIdentity(parent) !== mergePathIdentity(boundary);
    parent = path.dirname(parent)
  ) {
    if (path.dirname(parent) === parent) throw new Error("Transaction parent did not reach its owned boundary.");
    try {
      const stat = await fs.lstat(parent);
      if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink())
        throw new Error("Unsafe transaction parent.");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
}

export function assertAllowedTarget(root: string, sessionRoot: string | undefined, target: string) {
  const resolved = path.resolve(target);
  if (isStrictlyInside(root, resolved)) {
    if (isDeniedPath(path.relative(root, resolved))) throw new Error("Transaction targets denied private storage.");
    assertWithinRoot(root, resolved);
    return;
  }
  if (sessionRoot && isStrictlyInside(sessionRoot, resolved)) {
    if (isDeniedPath(`sessions/${path.relative(sessionRoot, resolved)}`))
      throw new Error("Transaction targets denied session storage.");
    assertWithinRoot(sessionRoot, resolved);
    return;
  }
  throw new Error("Transaction target is outside configured roots.");
}
