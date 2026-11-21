import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../paths.js";
import { syncDirectory, writeJson } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { syncMutationParents } from "../state/mutation-directory-sync.js";
import { stateDir } from "../state/state-directory.js";
import { normalizeSyncExclude } from "../sync/exclude-policy.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { includeFromSelectionConfig, type SyncSelectionConfig, selectionForSnapshot } from "../sync/sync-policy.js";
import { agentDir, configuredSessionDir } from "./session-paths.js";
import {
  agentDirectoryConfiguredSessionDir,
  agentDirectorySessionDirFromSettings,
  readAgentDirectorySettings,
} from "./snapshot.js";
import { caseReplacementSpelling, coalesceCaseReplacements } from "./snapshot-case-replacement.js";
import { assertUnexcludedTargets } from "./snapshot-exclude-safety.js";
import { withMissingTargetQueues, withTargetQueues } from "./snapshot-mutation-queues.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import { prepareSessionRootTransition, resolveTransitionSessionRoot } from "./snapshot-root-transition.js";
import { pendingTransactionEntries, transactionRoot } from "./snapshot-transaction-directory.js";
import { fileImage, indexTransactionPlan } from "./snapshot-transaction-plan.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  assertAllowedTarget,
  assertRecoveryPolicy,
  isStrictlyInside,
  type TransactionEntry,
  type TransactionJournal,
  transactionHasSessionTargets,
  validateJournal,
  validateJournalPolicy,
} from "./snapshot-transaction-policy.js";
import type { SnapshotApplyPlan } from "./snapshot-types.js";

const JOURNAL_VERSION = 4;
interface TransactionOptions extends SyncSelectionConfig {
  sessionDir?: string;
  exclude?: readonly string[];
  signal?: AbortSignal;
  validateMutation?: () => void;
  protectedTargets?: readonly string[];
  /** Fresh apply authorization only; recovery remains bound to durable journal images. */
  expectedPreimages?: ReadonlyMap<string, string>;
  resolveConfiguredSessionDir?: boolean;
}

export async function applySnapshotTransaction(plan: SnapshotApplyPlan, options: TransactionOptions = {}) {
  options.validateMutation?.();
  const root = path.resolve(agentDir());
  if (options.scope === "agent-directory") {
    const sessionDir = options.sessionDir ?? (await agentDirectoryConfiguredSessionDir(options.signal, root));
    options = { ...options, sessionDir: sessionStorageRoot(root, sessionDir) };
  }
  await recoverPendingSnapshotTransactions(options);
  const coalesced = await coalesceCaseReplacements(root, plan);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  const targets = [...new Set([...coalesced.plan.deletes, ...coalesced.plan.writes.map((item) => item.target)])].sort();
  if (targets.length > 16_384)
    throw new Error("Snapshot transaction exceeds its target bound; review a smaller transfer.");
  return withTargetQueues(targets, options, async (heldKeys) => {
    await assertUnexcludedTargets(root, [...targets, ...coalesced.replacements.values()], options);
    options.signal?.throwIfAborted();
    if (
      targets.some((target) =>
        options.protectedTargets?.some(
          (protectedTarget) =>
            mergePathIdentity(target) === mergePathIdentity(protectedTarget) ||
            isPathInside(mergePathIdentity(target), mergePathIdentity(protectedTarget)),
        ),
      )
    )
      throw new Error("Snapshot transaction targets the current session; review is required.");
    for (const [before, after] of coalesced.replacements) {
      if ((await caseReplacementSpelling(before, after)) !== before)
        throw new Error("Case replacement changed before preparation; review is required.");
      options.validateMutation?.();
      options.signal?.throwIfAborted();
    }
    const originalTargets = new Map([...coalesced.replacements].map(([before, after]) => [after, before]));
    const expectedPreimages = new Map(
      [...(options.expectedPreimages ?? [])].map(([target, expected]) => [
        originalTargets.get(target) ?? target,
        expected,
      ]),
    );
    // A case-sensitive spelling replacement has two targets, unlike a coalesced physical alias.
    // Bind both the source bytes and destination absence/bytes before capturing their backups.
    for (const [target, expected] of options.expectedPreimages ?? []) {
      if (originalTargets.has(target)) continue;
      const variants = coalesced.plan.deletes.filter(
        (candidate) =>
          candidate !== target &&
          path.dirname(candidate) === path.dirname(target) &&
          mergePathIdentity(candidate) === mergePathIdentity(target),
      );
      if (variants.length > 1) throw new Error("Ambiguous reviewed file preimage spellings; review required.");
      const original = variants[0];
      if (!original) continue;
      const destination = await image(target);
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      if (destination !== "missing" && destination !== expected)
        throw new Error("Reviewed destination preimage changed before apply.");
      expectedPreimages.set(original, expected);
      expectedPreimages.set(target, destination);
    }
    if (options.scope === "agent-directory") {
      const evidence = await stableAgentDirectorySettingsImage(root, plan, options);
      if (evidence) {
        const target = originalTargets.get(evidence.target) ?? evidence.target;
        const reviewed = expectedPreimages.get(target);
        if (reviewed !== undefined && reviewed !== evidence.image)
          throw new Error("Reviewed Pi settings changed before apply; snapshot installation refused.");
        expectedPreimages.set(target, evidence.image);
      }
    }
    for (const [target, expected] of expectedPreimages) {
      if (options.scope === "agent-directory") await assertUnexcludedTargets(agentDir(), [target], options);
      const current = await image(target);
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      if (current !== expected)
        throw new Error("Reviewed file preimage changed before apply; snapshot installation refused.");
    }
    const transaction = await prepareTransaction(
      coalesced.plan,
      targets,
      { ...options, expectedPreimages },
      coalesced.replacements,
    );
    const entriesByTarget = new Map(
      transaction.journal.entries.flatMap((entry) => [
        [entry.target, entry] as const,
        ...(entry.afterTarget ? [[entry.afterTarget, entry] as const] : []),
      ]),
    );
    // A released additional key cannot authorize rollback, even for recognized raced bytes.
    const changesQueueKey = transaction.journal.entries.some(
      (entry) => !heldKeys.has(entry.target) || (entry.afterTarget && !heldKeys.has(entry.afterTarget)),
    );
    try {
      for (const target of transaction.deletes.sort((a, b) => a.length - b.length)) {
        options.signal?.throwIfAborted();
        const entry = entriesByTarget.get(target);
        if (!entry) throw new Error("Unowned transaction target.");
        await removeOwnedTarget(transaction.directory, entry, transaction.journal, options);
        await syncDirectory(path.dirname(target));
      }
      await withMissingTargetQueues(
        transaction.journal.entries
          .filter((entry) => entry.removalPending)
          .flatMap((entry) => [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])]),
        heldKeys,
        options,
        async () => {
          await retireRemovalIntent(
            transaction.directory,
            transaction.journal,
            transaction.journal.entries.filter(
              (entry) => entry.removalPending && (entry.afterImage !== "missing" || (entry.postFiles?.length ?? 0) > 0),
            ),
            options,
          );
          // Only this uninterrupted call knows which deleted writes have not attempted installation yet.
          const uninstalledWrites = new Set(transaction.deletedWrites);
          for (const item of plan.writes) {
            options.signal?.throwIfAborted();
            const entry = entriesByTarget.get(item.target);
            if (!entry) throw new Error("Unowned transaction target.");
            const deletedByThisCall = uninstalledWrites.delete(entry.target);
            if (options.scope === "agent-directory")
              await assertUnexcludedTargets(transaction.journal.root, [item.target], options);
            await verifyTarget(transaction.directory, entry, transaction.journal, deletedByThisCall);
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            await fs.mkdir(path.dirname(item.target), { recursive: true });
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            const temp = path.join(path.dirname(item.target), `.pi-sync.json.${randomUUID()}.apply`);
            try {
              let mode = 0o600;
              try {
                const stat = await fs.lstat(item.target);
                if (stat.isFile()) mode = stat.mode & 0o777;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
              const handle = await fs.open(temp, "wx", mode);
              try {
                await handle.writeFile(item.content);
                await handle.sync();
              } finally {
                await handle.close();
              }
              await verifyTarget(transaction.directory, entry, transaction.journal, deletedByThisCall);
              options.signal?.throwIfAborted();
              options.validateMutation?.();
              await fs.rename(temp, item.target);
              await syncDirectory(path.dirname(item.target));
            } finally {
              await fs.rm(temp, { force: true });
            }
          }
          options.validateMutation?.();
          options.signal?.throwIfAborted();
          await syncMutationParents(
            targets,
            [transaction.journal.root, ...(transaction.journal.sessionRoot ? [transaction.journal.sessionRoot] : [])],
            options,
          );
          options.validateMutation?.();
          options.signal?.throwIfAborted();
        },
      );
    } catch (error) {
      // Aborted owners cannot roll back files after another session has replaced them.
      if (options.signal?.aborted)
        throw new Error("Snapshot apply cancelled; guarded transaction evidence retained for review.");
      // Additional queues have been released. Recovery must reserve missing keys afresh.
      if (changesQueueKey)
        throw new Error("Snapshot apply failed; guarded transaction evidence retained for review.", {
          cause: error,
        });
      try {
        await restoreTransaction(transaction.directory, transaction.journal, options, heldKeys);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Snapshot apply failed and guarded recovery requires review. Transaction and backup retained; newer bytes were not restored over.",
        );
      }
      throw error;
    }
    // Files are durably installed. Cleanup cannot roll back once it starts deleting evidence.
    await completeTransaction(transaction.directory, transaction.journal);
  });
}

export async function recoverSnapshotTransactionsOnStartup(options: TransactionOptions = {}) {
  if (!(await pendingTransactionEntries()).some((entry) => entry.isDirectory())) return;
  // A pending settings.json may itself be the interrupted postimage. Read each journal
  // before consulting that file, and only consult it when a session target needs it.
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  await withLock(
    "recovery",
    () => recoverPendingSnapshotTransactions({ ...options, resolveConfiguredSessionDir: true }),
    {
      reclaimStale: true,
    },
  );
}

export async function recoverPendingSnapshotTransactions(options: TransactionOptions = {}) {
  for (const entry of (await pendingTransactionEntries()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(transactionRoot(), entry.name);
    let journal: TransactionJournal;
    try {
      const file = path.join(directory, "journal.json");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid journal file.");
      journal = JSON.parse(await fs.readFile(file, "utf8")) as TransactionJournal;
    } catch (error) {
      // Unknown evidence is not disposable, including interrupted preparation directories.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cannot recover malformed pi-sync transaction; preserve private evidence for review.");
    }
    validateJournalPolicy(journal);
    if (!journal.completed) assertRecoveryPolicy(journal, options);
    let sessionDir = options.sessionDir;
    if (sessionDir === undefined && !journal.completed) {
      if (options.scope === "agent-directory") sessionDir = await agentDirectoryConfiguredSessionDir(options.signal);
      else if (options.resolveConfiguredSessionDir && transactionHasSessionTargets(journal))
        sessionDir = await configuredSessionDir();
    }
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    if (journal.sessionRootTransition && !journal.completed) {
      // Validate every path before consulting backup evidence under the recorded root.
      validateJournal(directory, journal, journal.sessionRoot);
      sessionDir = await resolveTransitionSessionRoot(
        directory,
        journal.root,
        journal.sessionRoot as string,
        journal.sessionRootTransition,
        journal.entries,
        path.resolve(sessionStorageRoot(journal.root, sessionDir)),
        options,
      );
      options.validateMutation?.();
      options.signal?.throwIfAborted();
    }
    validateJournal(directory, journal, sessionDir);
    if (journal.completed) {
      await removeTransaction(directory);
      continue;
    }
    await withTargetQueues(journal.entries.map((entry) => entry.target).sort(), options, (heldKeys) =>
      restoreTransaction(directory, journal, { ...options, sessionDir }, heldKeys),
    );
  }
}

async function stableAgentDirectorySettingsImage(root: string, plan: SnapshotApplyPlan, options: TransactionOptions) {
  const settingsTarget = mergePathIdentity(path.join(root, "settings.json"));
  const write = plan.writes.find(({ target }) => mergePathIdentity(target) === settingsTarget);
  const target = write?.target ?? plan.deletes.find((target) => mergePathIdentity(target) === settingsTarget);
  if (!target) return;
  const beforeBytes = await readAgentDirectorySettings(options.signal, root);
  const before = beforeBytes === undefined ? undefined : agentDirectorySessionDirFromSettings(beforeBytes);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  const after = write ? agentDirectorySessionDirFromSettings(write.content) : undefined;
  if (sessionStorageRoot(root, before) !== sessionStorageRoot(root, after))
    throw new Error("Agent-directory transfers cannot change Pi session storage; keep the local sessionDir setting.");
  return { target, image: beforeBytes === undefined ? "missing" : fileImage(beforeBytes) };
}

async function prepareTransaction(
  plan: SnapshotApplyPlan,
  targets: string[],
  options: TransactionOptions,
  replacements = new Map<string, string>(),
) {
  const { sessionDir } = options;
  const root = path.resolve(agentDir());
  const wholeDirectory = options.scope === "agent-directory";
  const sessionRoot = sessionDir || wholeDirectory ? path.resolve(sessionStorageRoot(root, sessionDir)) : undefined;
  const indexed = indexTransactionPlan(plan, targets);
  const directory = path.join(transactionRoot(), randomUUID());
  const backupDirectory = path.join(directory, "before");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const entries: TransactionEntry[] = [];
  for (const [index, target] of targets.entries()) {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    assertAllowedTarget(root, sessionRoot, target);
    await assertSafeParents(root, sessionRoot, target);
    if (wholeDirectory) await assertUnexcludedTargets(root, [target], options);
    const entry: TransactionEntry = { target, backupName: `${index}`, kind: "missing" };
    if (replacements.has(target)) entry.afterTarget = replacements.get(target);
    const backup = path.join(backupDirectory, entry.backupName);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        entry.kind = "symlink";
        entry.linkTarget = await fs.readlink(target);
      } else if (stat.isDirectory()) {
        entry.kind = "directory";
        await fs.cp(target, backup, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          preserveTimestamps: true,
          filter: async (source) => {
            options.signal?.throwIfAborted();
            options.validateMutation?.();
            if (wholeDirectory) await assertUnexcludedTargets(root, [source], options, { recursive: false });
            return true;
          },
        });
      } else if (stat.isFile()) {
        entry.kind = "file";
        await fs.copyFile(target, backup);
        await fs.chmod(backup, stat.mode);
      } else throw new Error("Unsupported existing snapshot target.");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    entry.beforeImage =
      entry.kind === "symlink"
        ? `symlink:${entry.linkTarget}`
        : entry.kind === "missing"
          ? "missing"
          : await image(backup, true);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    const expected = options.expectedPreimages?.get(target);
    if (expected !== undefined && entry.beforeImage !== expected)
      throw new Error("Reviewed file preimage changed during backup; private preparation evidence retained.");
    if (entry.afterTarget) {
      if (entry.kind !== "file" || (await caseReplacementSpelling(target, entry.afterTarget)) !== target)
        throw new Error("Case replacement preimage changed during backup; evidence retained for review.");
      options.validateMutation?.();
      options.signal?.throwIfAborted();
    }
    entry.afterImage = indexed.writeImages.get(target) ?? "missing";
    entry.postFiles = indexed.postFiles.get(target) ?? [];
    entries.push(entry);
  }
  // File fsync does not persist the name linking each backup into this directory.
  await syncDirectory(backupDirectory);
  const effectiveRoot = sessionRoot ?? path.join(root, "sessions");
  const sessionRootTransition = wholeDirectory
    ? undefined
    : await prepareSessionRootTransition(directory, root, effectiveRoot, entries, plan, options);
  const journal: TransactionJournal = {
    version: wholeDirectory
      ? AGENT_DIRECTORY_JOURNAL_VERSION
      : sessionRootTransition
        ? 7
        : replacements.size
          ? 5
          : JOURNAL_VERSION,
    root,
    ...(wholeDirectory
      ? { selection: selectionForSnapshot(includeFromSelectionConfig(options), options.exclude, options) }
      : options.exclude === undefined
        ? {}
        : { exclude: normalizeSyncExclude(options.exclude) }),
    sessionRoot: sessionRootTransition ? effectiveRoot : sessionRoot,
    sessionRootTransition,
    entries,
  };
  options.signal?.throwIfAborted();
  options.validateMutation?.();
  await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: 32 * 1024 * 1024 });
  await syncDirectory(transactionRoot());
  await syncDirectory(stateDir());
  await syncDirectory(path.dirname(stateDir()));
  return { directory, journal, deletes: indexed.deletes, deletedWrites: indexed.deletedWrites };
}

async function restoreTransaction(
  directory: string,
  journal: TransactionJournal,
  options: TransactionOptions,
  heldKeys: ReadonlySet<string>,
) {
  validateJournal(directory, journal, options.sessionDir);
  const missingSpellings: string[] = [];
  for (const entry of journal.entries) {
    if (!entry.afterTarget) continue;
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    const spelling = await caseReplacementSpelling(entry.target, entry.afterTarget);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    if (spelling === undefined) missingSpellings.push(entry.target, entry.afterTarget);
  }
  // Reserve an interrupted removal's other spelling before staging or image checks:
  // recognizable bytes installed by a writer in that gap are not our postimage.
  return withMissingTargetQueues(missingSpellings, heldKeys, options, (reservedKeys) =>
    restoreQueuedTransaction(directory, journal, options, reservedKeys),
  );
}

async function restoreQueuedTransaction(
  directory: string,
  journal: TransactionJournal,
  options: TransactionOptions,
  heldKeys: ReadonlySet<string>,
) {
  validateJournal(directory, journal, options.sessionDir);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  await assertUnexcludedTargets(
    journal.root,
    journal.entries.flatMap((entry) => [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])]),
    options,
  );
  for (const entry of journal.entries) {
    if (
      options.protectedTargets?.some(
        (target) =>
          mergePathIdentity(target) === mergePathIdentity(entry.target) ||
          isPathInside(mergePathIdentity(entry.target), mergePathIdentity(target)),
      )
    )
      throw new Error(
        "Pending transaction touches the current session; resume a different session before guarded recovery.",
      );
    await verifyTarget(directory, entry, journal);
  }
  // Recover copies left by a process crash even when the target is already restored.
  for (const entry of journal.entries) {
    if (!entry.recoveryStaged) continue;
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    await fs.rm(recoveryStagePath(directory, entry), { recursive: true, force: true });
    options.validateMutation?.();
    options.signal?.throwIfAborted();
  }
  // Verify the complete group before removing any path. Recheck each destructive boundary.
  for (const entry of [...journal.entries].sort((a, b) => a.target.length - b.target.length)) {
    const current = await verifyTarget(directory, entry, journal);
    const before = await beforeImage(directory, entry);
    const spellingMatches = async () =>
      !entry.afterTarget || (await caseReplacementSpelling(entry.target, entry.afterTarget)) === entry.target;
    if (current === before && (await spellingMatches())) continue;
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    if (entry.kind === "file") {
      const temporary = await prepareRecoveryStage(directory, journal, entry, options);
      try {
        await fs.mkdir(path.dirname(entry.target), { recursive: true });
        await fs.copyFile(path.join(directory, "before", entry.backupName), temporary);
        // Windows requires write access to flush an existing regular file.
        const handle = await fs.open(temporary, process.platform === "win32" ? "r+" : "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const verified = await verifyTarget(directory, entry, journal);
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (verified === before && (await spellingMatches())) continue;
        const needsCaseQueue =
          entry.afterTarget !== undefined &&
          (await caseReplacementSpelling(entry.target, entry.afterTarget)) === entry.afterTarget;
        if (needsCaseQueue) {
          // Keep the installed-spelling queue while reserving the now-missing original spelling.
          await removeOwnedTarget(directory, entry, journal, options);
        } else if (
          verified.startsWith("directory:") &&
          !(await removeOwnedTarget(directory, entry, journal, options, before))
        )
          continue;
        await withMissingTargetQueues(
          entry.afterTarget && (needsCaseQueue || verified === "missing")
            ? [entry.target, entry.afterTarget]
            : verified.startsWith("directory:")
              ? [entry.target]
              : [],
          heldKeys,
          options,
          async () => {
            const atRename = await verifyTarget(directory, entry, journal);
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            if (atRename === before && (await spellingMatches())) return;
            await retireRestorationIntent(directory, journal, entry, options);
            const atInstall = await verifyTarget(directory, entry, journal, atRename === "missing");
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            if (atInstall === before && (await spellingMatches())) return;
            await fs.rename(temporary, entry.target);
            await syncDirectory(path.dirname(entry.target));
          },
        );
      } finally {
        await fs.rm(temporary, { force: true });
      }
      continue;
    }
    if (entry.kind === "missing") {
      await removeOwnedTarget(directory, entry, journal, options, before);
      continue;
    }
    const temporary = await prepareRecoveryStage(directory, journal, entry, options);
    try {
      await fs.mkdir(path.dirname(entry.target), { recursive: true });
      await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
      if (entry.kind === "directory") {
        await fs.cp(path.join(directory, "before", entry.backupName), temporary, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          preserveTimestamps: true,
          filter: () => {
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            return true;
          },
        });
      } else if (entry.linkTarget !== undefined) await fs.symlink(entry.linkTarget, temporary);
      if ((await image(temporary, true)) !== before)
        throw new Error("Staged recovery image differs from the backup; evidence retained.");
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      if (!(await removeOwnedTarget(directory, entry, journal, options, before))) continue;
      await withMissingTargetQueues([entry.target], heldKeys, options, async () => {
        const atRename = await verifyTarget(directory, entry, journal);
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (atRename === before) return;
        await retireRestorationIntent(directory, journal, entry, options);
        const atInstall = await verifyTarget(directory, entry, journal, atRename === "missing");
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (atInstall === before) return;
        await fs.rename(temporary, entry.target);
        await syncDirectory(path.dirname(entry.target));
      });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  await syncMutationParents(
    journal.entries.map((entry) => entry.target),
    [journal.root, ...(journal.sessionRoot ? [journal.sessionRoot] : [])],
    options,
  );
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  await completeTransaction(directory, journal);
}

async function verifyTarget(
  directory: string,
  entry: TransactionEntry,
  journal: TransactionJournal,
  deletedByThisCall = false,
) {
  await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
  // Hash the potentially large backup before observing the live target, not after it.
  const before = await beforeImage(directory, entry);
  if (journal.version >= 2 && before !== entry.beforeImage)
    throw new Error("Transaction backup changed; preserve evidence for review.");
  if (entry.afterTarget) await caseReplacementSpelling(entry.target, entry.afterTarget);
  const current = await image(entry.target);
  if (current === before) return current;
  if (current === "missing") {
    if (deletedByThisCall || (journal.version >= 4 && entry.removalPending && !entry.replacementStarted))
      return current;
  } else if (
    journal.version >= 2 &&
    (current === entry.afterImage ||
      (await ownedPostTree(
        entry.target,
        entry.postFiles ?? [],
        journal.version < 4 || entry.replacementStarted === true || !entry.removalPending,
      )))
  )
    return current;
  throw new Error(
    "Transaction target has unrecognized or newer bytes; automatic rollback refused. Preserve the transaction and review its backup with Pi closed.",
  );
}

async function removeOwnedTarget(
  directory: string,
  entry: TransactionEntry,
  journal: TransactionJournal,
  options: TransactionOptions,
  restoringBefore?: string,
) {
  await assertUnexcludedTargets(
    journal.root,
    [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])],
    options,
  );
  const current = await verifyTarget(directory, entry, journal);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (restoringBefore !== undefined && current === restoringBefore) return false;
  // Persist intent before removal, including descendants affected by a recursive delete.
  // Until replacement is armed, interrupted removal can recognize absence without accepting unknown bytes.
  upgradeRemovalEvidence(journal);
  for (const affected of journal.entries) {
    if (affected.target === entry.target || isStrictlyInside(entry.target, affected.target)) {
      affected.removalPending = true;
      affected.replacementStarted = false;
    }
  }
  await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: 32 * 1024 * 1024 });
  const verified = await verifyTarget(directory, entry, journal);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (restoringBefore !== undefined && verified === restoringBefore) return false;
  if (options.scope === "agent-directory") await assertUnexcludedTargets(journal.root, [entry.target], options);
  await fs.rm(entry.target, { recursive: true, force: true });
  await syncDirectory(path.dirname(entry.target));
  return true;
}

function upgradeRemovalEvidence(journal: TransactionJournal) {
  if (journal.version < JOURNAL_VERSION) {
    // Old pending markers may already have survived a committed replacement.
    for (const entry of journal.entries) entry.removalPending = false;
    journal.version = JOURNAL_VERSION;
  }
}

async function retireRemovalIntent(
  directory: string,
  journal: TransactionJournal,
  entries: TransactionEntry[],
  options: TransactionOptions,
) {
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (!entries.length) return;
  upgradeRemovalEvidence(journal);
  for (const entry of entries) {
    entry.removalPending = false;
    entry.replacementStarted = true;
  }
  await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: 32 * 1024 * 1024 });
  options.validateMutation?.();
  options.signal?.throwIfAborted();
}

async function retireRestorationIntent(
  directory: string,
  journal: TransactionJournal,
  entry: TransactionEntry,
  options: TransactionOptions,
) {
  // Installing a complete parent preimage supersedes descendant replacement progress too.
  for (const child of journal.entries) {
    if (isStrictlyInside(entry.target, child.target)) {
      child.removalPending = false;
      child.replacementStarted = false;
    }
  }
  await retireRemovalIntent(directory, journal, [entry], options);
}

function recoveryStagePath(directory: string, entry: TransactionEntry) {
  const token = createHash("sha256").update(directory).update("\\0").update(entry.backupName).digest("hex");
  return path.join(
    path.dirname(entry.target),
    `.pi-sync.json.${token}.${entry.kind === "file" ? "restore" : "restore-tree"}`,
  );
}

async function prepareRecoveryStage(
  directory: string,
  journal: TransactionJournal,
  entry: TransactionEntry,
  options: TransactionOptions,
) {
  const temporary = recoveryStagePath(directory, entry);
  if (!entry.recoveryStaged) {
    try {
      await fs.lstat(temporary);
      throw new Error("Unowned recovery staging path; preserve evidence for review.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    entry.recoveryStaged = true;
    await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: 32 * 1024 * 1024 });
    options.validateMutation?.();
    options.signal?.throwIfAborted();
  }
  return temporary;
}

async function beforeImage(directory: string, entry: TransactionEntry) {
  if (entry.kind === "missing") return "missing";
  if (entry.kind === "symlink") return `symlink:${entry.linkTarget}`;
  const value = await image(path.join(directory, "before", entry.backupName));
  if (value === "missing") throw new Error("Transaction backup is missing; preserve evidence for review.");
  return value;
}
async function image(target: string, durable = false): Promise<string> {
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(target)}`;
  if (stat.isFile()) {
    const content = await fs.readFile(target);
    if (durable) {
      // Keep POSIX read-only backup permissions; Windows flushing requires write access.
      const handle = await fs.open(target, process.platform === "win32" ? "r+" : "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return fileImage(content);
  }
  if (!stat.isDirectory()) throw new Error("Unsupported transaction image.");
  const entries = [];
  for (const name of (await fs.readdir(target)).sort())
    entries.push([name, await image(path.join(target, name), durable)]);
  if (durable) await syncDirectory(target);
  return `directory:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}
async function ownedPostTree(target: string, files: { relative: string; image: string }[], requireComplete: boolean) {
  if (!files.length) return false;
  const expected = new Map(files.map((file) => [mergePathIdentity(file.relative), file.image]));
  const prefixes = new Set<string>();
  for (const relative of expected.keys()) {
    for (
      let parent = path.dirname(relative);
      parent !== "." && parent !== path.dirname(parent);
      parent = path.dirname(parent)
    )
      prefixes.add(parent);
  }
  const seen = new Set<string>();
  async function visit(directory: string): Promise<boolean> {
    let stat: Stats;
    try {
      stat = await fs.lstat(directory);
    } catch {
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const name of await fs.readdir(directory)) {
      const child = path.join(directory, name);
      const relative = mergePathIdentity(path.relative(target, child));
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!prefixes.has(relative) || !(await visit(child))) return false;
      } else {
        if (expected.get(relative) !== (await image(child))) return false;
        seen.add(relative);
      }
    }
    return true;
  }
  return (await visit(target)) && (!requireComplete || [...expected.keys()].every((key) => seen.has(key)));
}

async function assertSafeParents(root: string, sessionRoot: string | undefined, target: string) {
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
async function completeTransaction(directory: string, journal: TransactionJournal) {
  // Publish completion before deleting any backup. A surviving journal after power loss
  // may only retry cleanup, never roll back already accepted files.
  await writeJson(
    path.join(directory, "journal.json"),
    {
      ...journal,
      version:
        journal.version === AGENT_DIRECTORY_JOURNAL_VERSION ? journal.version : journal.sessionRootTransition ? 7 : 6,
      completed: true,
    },
    {
      maxBytes: 32 * 1024 * 1024,
    },
  );
  await removeTransaction(directory);
}
async function removeTransaction(directory: string) {
  await fs.rm(directory, { recursive: true, force: true });
  // After evidence deletion, failure cannot safely trigger rollback or withhold acceptance.
  // A failed cleanup fsync may leave obsolete evidence after power loss; live file durability
  // was established before cleanup; a surviving completed journal allows only cleanup.
  await syncDirectory(transactionRoot()).catch(() => {});
}
