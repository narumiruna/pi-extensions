import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWithinRoot, isDeniedPath, isPathInside, parentPaths, safeJoin, toPosix } from "../paths.js";
import { syncDirectory } from "../state/json-file.js";
import { stateDir } from "../state/state-directory.js";
import { collidingPaths } from "../sync/file-merge-planner.js";
import {
  assertSnapshotExcludesDebugLog,
  compileSyncPolicyExclude,
  requireLegacyTransferPolicy,
  sameSnapshotSelection,
  selectionForSnapshot,
} from "../sync/sync-policy.js";
import { agentDir } from "./session-paths.js";
import {
  agentDirectoryConfiguredSessionDir,
  agentDirectoryInventory,
  createSnapshot,
  isSessionFilePath,
  isSessionPath,
  sessionStorageRoot,
  snapshotIncludesSessions,
  snapshotTarget,
} from "./snapshot.js";
import { assertAgentDirectorySnapshotBound } from "./snapshot-bounds.js";
import { assertProjectedAgentDirectoryBudget } from "./snapshot-entry-projection.js";
import { agentDirectoryPhysicalSessionPath, assertUnexcludedTargets } from "./snapshot-exclude-safety.js";
import { decodeBase64Strict } from "./snapshot-payload.js";
import { reviewedSnapshotPreimages } from "./snapshot-reviewed-preimages.js";
import {
  applySnapshotTransaction,
  recoverPendingSnapshotTransactions,
  type SkippedSnapshotWrite,
} from "./snapshot-transaction.js";
import { ignorePolicyValidator } from "./snapshot-transaction-policy.js";
import {
  isIgnoreSnapshotVersion,
  type Snapshot,
  type SnapshotApplyPlan,
  type SnapshotOptions,
} from "./snapshot-types.js";

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function fileHashMap(snapshot: Snapshot) {
  return Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
}

function assertSnapshotApplyPolicy(snapshot: Snapshot, options: SnapshotOptions) {
  assertSnapshotExcludesDebugLog(snapshot);
  if (!isIgnoreSnapshotVersion(snapshot.version)) {
    requireLegacyTransferPolicy(snapshot);
    if (options.ignorePolicy)
      throw new Error("Project the snapshot into the reviewed local ignore-file policy before applying it.");
    return;
  }
  if (options.scope !== "agent-directory" || !options.ignorePolicy) requireLegacyTransferPolicy(snapshot);
  if (!sameSnapshotSelection(snapshot.selection, selectionForSnapshot(undefined, undefined, options)))
    throw new Error("Snapshot does not match the local ignore-file policy; review and project it before applying it.");
}

export async function applySnapshot(
  snapshot: Snapshot,
  protectedRelativePaths = new Set<string>(),
  options: Pick<
    SnapshotOptions,
    | "include"
    | "exclude"
    | "scope"
    | "reinclude"
    | "ignorePolicy"
    | "reservedIgnoreNames"
    | "setupName"
    | "recoverySetupKey"
    | "ignoreSourceIdentity"
    | "sessionDir"
    | "syncFiles"
    | "syncSessions"
    | "extraFiles"
    | "signal"
    | "validateMutation"
    | "validateIgnorePolicy"
    | "validateApplyReview"
    | "expectedFileHashes"
  > & { reviewedLocal?: Pick<Snapshot, "files"> } = {},
) {
  assertSnapshotApplyPolicy(snapshot, options);
  const validateIgnorePolicy = ignorePolicyValidator(options);
  const root = agentDir();
  if (snapshot.version === 5 && options.scope !== "agent-directory")
    throw new Error("Agent-directory snapshot apply requires the local agent-directory policy.");
  const sessionDir =
    options.scope === "agent-directory"
      ? sessionStorageRoot(
          root,
          options.sessionDir ?? (await agentDirectoryConfiguredSessionDir(options.signal, root, options)),
        )
      : options.sessionDir;
  options.validateMutation?.();
  options = { ...options, sessionDir };
  const excluded = excludedApplyPath(root, options);
  snapshot = { ...snapshot, files: snapshot.files.filter((file) => !excluded(file.path)) };
  const transactionOptions = {
    ...options,
    protectedTargets: [...protectedRelativePaths].map((relative) => snapshotTarget(root, relative, sessionDir)),
    expectedPreimages: new Map(
      Object.entries(options.expectedFileHashes ?? {})
        .filter(([relative]) => !excluded(relative))
        .map(([relative, hash]) => [
          snapshotTarget(root, relative, sessionDir),
          hash === null ? "missing" : `file:${hash}`,
        ]),
    ),
  };
  options.validateMutation?.();
  if (validateIgnorePolicy) await validateIgnorePolicy();
  await recoverPendingSnapshotTransactions(transactionOptions);
  const current = await createSnapshot(snapshot.profile, {
    ...options,
    ...(options.scope === undefined && options.include === undefined
      ? { syncSessions: snapshotIncludesSessions(snapshot) }
      : {}),
    sessionDir,
  });
  const inventory = agentDirectoryInventory(current);
  if (options.reviewedLocal && !sameReviewedFiles(current, options.reviewedLocal))
    throw new Error("Reviewed local files changed before apply; reopen the transfer preview.");
  if (options.scope === "agent-directory") {
    assertAgentDirectorySnapshotBound([
      ...snapshot.files.filter(({ path }) => !protectedRelativePaths.has(path)),
      ...current.files.filter(({ path }) => protectedRelativePaths.has(path)),
    ]);
  }
  const plan = await addTopLevelCaseVariantDeletes(
    root,
    protectSnapshotApplyPlan(
      root,
      preflightSnapshotApply(root, snapshot, current, options),
      protectedRelativePaths,
      sessionDir,
    ),
    snapshot,
    options,
  );
  const currentHashes = new Map(current.files.map(({ path, sha256 }) => [path, sha256]));
  const dependencies = collidingPaths([...plan.deletes, ...plan.writes.map(({ target }) => target)].map(toPosix));
  const unchangedHashes = new Map<string, string>();
  for (const file of snapshot.files) {
    if (currentHashes.get(file.path) !== file.sha256) continue;
    const target = snapshotTarget(root, file.path, sessionDir);
    if (!dependencies.has(toPosix(target))) unchangedHashes.set(target, file.sha256);
  }
  if (inventory) {
    assertProjectedAgentDirectoryBudget(
      inventory,
      {
        deletes: plan.deletes,
        writes: [
          ...plan.writes.map(({ target, content }) => ({ target, size: content.length })),
          { target: stateDir(root) },
        ],
      },
      options,
    );
  }
  const skipped = inventory
    ? await preflightSnapshotMutations(root, plan, sessionDir, options, unchangedHashes)
    : undefined;
  if (options.reviewedLocal || inventory) {
    const images = reviewedSnapshotPreimages(root, sessionDir, current.files, plan, inventory);
    const reviewed = options.reviewedLocal;
    if (reviewed && inventory) {
      const approved = reviewedSnapshotPreimages(
        root,
        sessionDir,
        reviewed.files,
        plan,
        agentDirectoryInventory(reviewed),
      );
      if ([...images].some(([target, image]) => image !== approved.get(target)))
        throw new Error("Reviewed directory preimage changed before apply; reopen the transfer preview.");
    }
    for (const [target, image] of images) {
      const existing = transactionOptions.expectedPreimages.get(target);
      if (existing !== undefined && existing !== image) throw new Error("Reviewed preimage evidence is inconsistent.");
      transactionOptions.expectedPreimages.set(target, image);
    }
  }
  await applySnapshotTransaction(
    plan,
    transactionOptions,
    skipped ?? (await preflightSnapshotMutations(root, plan, sessionDir, options, unchangedHashes)),
  );
  return appliedFileHashMap(snapshot, current, protectedRelativePaths);
}

function sameReviewedFiles(scanned: Pick<Snapshot, "files">, reviewed: Pick<Snapshot, "files">) {
  const hashes = new Map(scanned.files.map((file) => [file.path, file.sha256]));
  return (
    scanned.files.length === reviewed.files.length &&
    reviewed.files.every((file) => hashes.get(file.path) === file.sha256)
  );
}

export function preflightSnapshotApply(
  root: string,
  snapshot: Snapshot,
  current: Snapshot,
  options: SnapshotOptions = {},
): SnapshotApplyPlan {
  assertSnapshotApplyPolicy(snapshot, options);
  const seenPaths = new Set<string>();
  const remotePaths = new Set<string>();
  const writes: Array<{ target: string; content: Buffer }> = [];
  const deletes: string[] = [];
  const excluded = excludedApplyPath(root, options);

  for (const file of snapshot.files) {
    const normalized = toPosix(file.path);
    if (options.scope === "agent-directory" && excluded(normalized)) continue;
    if (!isSafeSnapshotPath(file.path)) {
      throw new Error(`Unsafe path in snapshot: ${file.path}`);
    }
    if (isSessionPath(normalized) && !isSessionFilePath(normalized)) {
      throw new Error(`Unsafe session path in snapshot: ${file.path}`);
    }
    if (excluded(normalized)) continue;
    if (seenPaths.has(normalized)) throw new Error(`Duplicate path in snapshot: ${normalized}`);
    seenPaths.add(normalized);
    remotePaths.add(normalized);

    const target = snapshotTarget(root, normalized, options.sessionDir);
    const content = decodeBase64Strict(file.contentBase64, normalized);
    if (sha256(content) !== file.sha256) throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
    writes.push({ target, content });
  }

  const deletePaths = new Set<string>();
  const inventory = options.scope === "agent-directory" ? agentDirectoryInventory(current) : undefined;
  for (const { target } of writes) {
    if (inventory?.entries.get(target) === "directory") deletePaths.add(target);
  }
  for (const file of current.files) {
    const normalized = toPosix(file.path);
    if (excluded(normalized)) continue;
    if (!remotePaths.has(normalized)) {
      deletePaths.add(snapshotTarget(root, normalized, options.sessionDir));
    }
    for (const remotePath of parentPaths(normalized)) {
      if (remotePaths.has(remotePath)) {
        deletePaths.add(snapshotTarget(root, remotePath, options.sessionDir));
      }
    }
  }
  deletes.push(...deletePaths);

  return { writes, deletes };
}

export function protectSnapshotApplyPlan(
  root: string,
  plan: SnapshotApplyPlan,
  protectedRelativePaths: Set<string>,
  sessionDir?: string,
): SnapshotApplyPlan {
  if (protectedRelativePaths.size === 0) return plan;
  const protectedTargets = new Set(
    [...protectedRelativePaths].map((relativePath) => snapshotTarget(root, relativePath, sessionDir)),
  );
  return {
    writes: plan.writes.filter((item) => !protectedTargets.has(item.target)),
    deletes: plan.deletes.filter((target) => !protectedTargets.has(target)),
  };
}

export async function addTopLevelCaseVariantDeletes(
  root: string,
  plan: SnapshotApplyPlan,
  snapshot: Pick<Snapshot, "files" | "selection">,
  options: SnapshotOptions = {},
): Promise<SnapshotApplyPlan> {
  if (options.scope === "agent-directory" || snapshot.selection?.scope === "agent-directory") return plan;
  const excluded = compileSyncPolicyExclude(options);
  const topLevelPaths = new Map<string, string>();
  for (const file of snapshot.files) {
    const normalized = toPosix(file.path);
    if (!normalized.includes("/") && isSafeSnapshotPath(file.path) && !excluded(normalized)) {
      topLevelPaths.set(normalized.toLowerCase(), normalized);
    }
  }
  if (topLevelPaths.size === 0) return plan;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return plan;
    throw error;
  }

  const deletes = new Set(plan.deletes);
  for (const entry of entries) {
    const canonicalPath = topLevelPaths.get(entry.name.toLowerCase());
    if (
      canonicalPath &&
      entry.name !== canonicalPath &&
      !excluded(entry.name) &&
      (entry.isFile() || entry.isSymbolicLink())
    ) {
      deletes.add(safeJoin(root, entry.name));
    }
  }
  return { ...plan, deletes: [...deletes] };
}

export function appliedFileHashMap(snapshot: Snapshot, current: Snapshot, protectedRelativePaths: Set<string>) {
  const hashes = fileHashMap(snapshot);
  if (protectedRelativePaths.size === 0) return hashes;
  const currentHashes = fileHashMap(current);
  for (const relativePath of protectedRelativePaths) {
    const normalized = toPosix(relativePath);
    if (currentHashes[normalized]) {
      hashes[normalized] = currentHashes[normalized];
    } else {
      delete hashes[normalized];
    }
  }
  return hashes;
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

function excludedApplyPath(root: string, options: SnapshotOptions) {
  const excluded = compileSyncPolicyExclude(options);
  if (options.scope !== "agent-directory") return excluded;
  const physicalSessionPath = agentDirectoryPhysicalSessionPath(
    root,
    options.sessionDir,
    options.ignorePolicy,
    options.reservedIgnoreNames,
  );
  return (relative: string) =>
    excluded(relative) ||
    (/^sessions(?:\/|$)/iu.test(relative) ? !isSessionFilePath(relative) : physicalSessionPath(relative));
}

type MutationGuards = Pick<
  SnapshotOptions,
  "signal" | "validateMutation" | "exclude" | "scope" | "include" | "reinclude" | "ignorePolicy" | "reservedIgnoreNames"
>;

export async function preflightSnapshotMutations(
  root: string,
  plan: { deletes: string[]; writes: Array<{ target: string; content: Buffer }> },
  sessionDir?: string,
  options: MutationGuards = {},
  unchangedHashes?: ReadonlyMap<string, string>,
): Promise<SkippedSnapshotWrite[]> {
  const skipped: SkippedSnapshotWrite[] = [];
  assertMutationCurrent(options);
  await assertUnexcludedTargets(root, [...plan.deletes, ...plan.writes.map((item) => item.target)], {
    ...options,
    sessionDir,
  });
  assertMutationCurrent(options);
  const deletePaths = new Set(plan.deletes);
  for (const target of plan.deletes) {
    await assertNoSymlinkParents(rootForTarget(root, target, sessionDir), target, options);
    assertMutationCurrent(options);
  }
  for (const item of plan.writes) {
    const stat = await prepareSnapshotWrite(
      rootForTarget(root, item.target, sessionDir),
      item.target,
      deletePaths,
      options,
    );
    assertMutationCurrent(options);
    const hash = unchangedHashes?.get(item.target);
    if (hash !== undefined && stat?.isFile() && stat.nlink === 1) {
      const canonical = await fs.realpath(item.target);
      assertMutationCurrent(options);
      if (canonical === item.target) skipped.push({ ...item, preimage: `file:${hash}` });
    }
  }
  return skipped;
}

function assertMutationCurrent(options: MutationGuards) {
  options.validateMutation?.();
  options.signal?.throwIfAborted();
}

async function guardedStat(target: string, options: MutationGuards) {
  assertMutationCurrent(options);
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    assertMutationCurrent(options);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertMutationCurrent(options);
  return stat;
}

function rootForTarget(root: string, target: string, sessionDir?: string) {
  const sessionRoot = sessionDir ? sessionStorageRoot(root, sessionDir) : undefined;
  if (sessionRoot && isPathInside(sessionRoot, target)) return sessionRoot;
  return root;
}

async function prepareSnapshotWrite(root: string, target: string, deletePaths: Set<string>, options: MutationGuards) {
  const parentWillBeReplaced = await ensureSafeDirectory(root, path.dirname(target), deletePaths, options);
  assertMutationCurrent(options);
  if (parentWillBeReplaced) return;
  const stat = await guardedStat(target, options);
  assertMutationCurrent(options);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink during snapshot apply: ${target}`);
  if (stat?.isDirectory() && !deletePaths.has(target)) {
    throw new Error(`Refusing to overwrite directory during snapshot apply: ${target}`);
  }
  return stat;
}

async function ensureSafeDirectory(root: string, directory: string, deletePaths: Set<string>, options: MutationGuards) {
  assertMutationCurrent(options);
  assertWithinRoot(root, directory);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(directory));
  let current = rootPath;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await guardedStat(current, options);
    assertMutationCurrent(options);
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
      if (!stat.isDirectory()) {
        if (deletePaths.has(current)) return true;
        throw new Error(`Snapshot path parent is not a directory: ${current}`);
      }
    } else {
      if (options.scope === "agent-directory") return true;
      await fs.mkdir(current);
      assertMutationCurrent(options);
      await syncDirectory(path.dirname(current));
      assertMutationCurrent(options);
    }
  }
  return false;
}

async function assertNoSymlinkParents(root: string, target: string, options: MutationGuards) {
  assertMutationCurrent(options);
  assertWithinRoot(root, target);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(target));
  let current = rootPath;
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await guardedStat(current, options);
    assertMutationCurrent(options);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Snapshot path parent is not a directory: ${current}`);
  }
}
