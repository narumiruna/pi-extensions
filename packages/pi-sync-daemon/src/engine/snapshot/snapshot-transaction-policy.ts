import path from "node:path";
import { assertWithinRoot, isDeniedPath, isPathInside } from "../paths.js";
import { normalizeSyncExclude, sameSyncExclude } from "../sync/exclude-policy.js";
import { portableSnapshotSelection, type SyncSelectionConfig, syncDirectoryPolicyKey } from "../sync/sync-policy.js";
import { agentDir } from "./session-paths.js";
import { isCaseReplacement } from "./snapshot-case-replacement.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import { type SessionRootTransition, validateSessionRootTransition } from "./snapshot-root-transition.js";
import type { SnapshotSelection } from "./snapshot-types.js";

export const AGENT_DIRECTORY_JOURNAL_VERSION = 8;

export interface TransactionJournalPolicy {
  version: number;
  exclude?: string[];
  /** Version 8 binds recovery to the complete directory policy, including session opt-in. */
  selection?: SnapshotSelection;
}

export function validateJournalPolicy(journal: TransactionJournalPolicy) {
  if (!journal || ![1, 2, 3, 4, 5, 6, 7, AGENT_DIRECTORY_JOURNAL_VERSION].includes(journal.version))
    throw new Error("Unsupported pi-sync transaction journal; preserve evidence for review.");
  if (journal.version === AGENT_DIRECTORY_JOURNAL_VERSION) {
    if (journal.exclude !== undefined || portableSnapshotSelection(journal.selection).version !== 3)
      throw new Error("Invalid agent-directory transaction policy; preserve evidence.");
  } else if (journal.selection !== undefined) {
    throw new Error("Unsupported pi-sync transaction journal policy; preserve evidence for review.");
  }
  if (journal.exclude !== undefined && !Array.isArray(journal.exclude))
    throw new Error("Invalid transaction exclude policy; preserve evidence.");
  normalizeSyncExclude(journal.exclude);
}

export function assertRecoveryPolicy(journal: TransactionJournalPolicy, options: SyncSelectionConfig) {
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
  /** Version 5: one physical file, original target spelling and intended installed spelling. */
  afterTarget?: string;
  backupName: string;
  kind: "missing" | "file" | "directory" | "symlink";
  linkTarget?: string;
  beforeImage?: string;
  afterImage?: string;
  postFiles?: { relative: string; image: string }[];
  /** Durable intent permits only a missing intermediate image, never unknown bytes. */
  removalPending?: boolean;
  /** Published before materialization: absence/partial trees can no longer prove an unstarted replacement. */
  replacementStarted?: boolean;
  /** Published before copying to a transaction-derived sibling staging path. */
  recoveryStaged?: boolean;
}
export interface TransactionJournal extends TransactionJournalPolicy {
  /** Version 6: durable files are accepted; surviving evidence permits cleanup only. */
  completed?: boolean;
  root: string;
  sessionRoot?: string;
  /** Version 7: reviewed settings images authorize recovery from either transition root. */
  sessionRootTransition?: SessionRootTransition;
  entries: TransactionEntry[];
}

export function validateJournal(directory: string, journal: TransactionJournal, sessionDir?: string) {
  validateJournalPolicy(journal);
  const wholeDirectory = journal.version === AGENT_DIRECTORY_JOURNAL_VERSION;
  if (!Array.isArray(journal.entries) || journal.entries.length > 16_384)
    throw new Error("Unsupported pi-sync transaction journal; preserve evidence for review.");
  if (
    journal.completed !== undefined &&
    (![6, 7, AGENT_DIRECTORY_JOURNAL_VERSION].includes(journal.version) || journal.completed !== true)
  )
    throw new Error("Invalid transaction completion evidence.");
  const root = path.resolve(agentDir());
  if (typeof journal.root !== "string" || path.resolve(journal.root) !== root)
    throw new Error("Transaction root no longer matches the Pi agent directory.");
  if (journal.sessionRootTransition !== undefined) {
    if (journal.version !== 7 || typeof journal.sessionRoot !== "string")
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
      (![5, 6, 7, AGENT_DIRECTORY_JOURNAL_VERSION].includes(journal.version) ||
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
    if (entry.recoveryStaged !== undefined && typeof entry.recoveryStaged !== "boolean")
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
