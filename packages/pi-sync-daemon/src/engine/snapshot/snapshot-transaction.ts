import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory, writeJson } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { syncMutationParents } from "../state/mutation-directory-sync.js";
import { stateDir } from "../state/state-directory.js";
import { normalizeSyncExclude } from "../sync/exclude-policy.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { includeFromSelectionConfig, selectionForSnapshot } from "../sync/sync-policy.js";
import { agentDir, configuredSessionDir } from "./session-paths.js";
import { agentDirectoryConfiguredSessionDir, scanAgentDirectoryInventory } from "./snapshot.js";
import { caseReplacementSpelling, coalesceCaseReplacements } from "./snapshot-case-replacement.js";
import { assertProjectedAgentDirectoryBudget, recheckAgentDirectoryBudget } from "./snapshot-entry-projection.js";
import { assertUnexcludedTargets } from "./snapshot-exclude-safety.js";
import { withMissingTargetQueues, withTargetQueues } from "./snapshot-mutation-queues.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import {
  prepareSessionRootTransition,
  resolveTransitionSessionRoot,
  stableAgentDirectorySettingsImage,
} from "./snapshot-root-transition.js";
import { pendingTransactionEntries, transactionRoot } from "./snapshot-transaction-directory.js";
import {
  legacyImage,
  MAX_TRANSACTION_JOURNAL_BYTES,
  ownedScopedPostTree,
  readTransactionJournal,
  recheckScopedImage,
  recheckUnchangedFile,
  removeScopedImage,
  scopedDescendant,
  scopedIdentity,
  scopedPathIdentity,
  scopedTransactionImage,
  stableScopedIdentity,
  verifyUnchangedFile,
} from "./snapshot-transaction-images.js";
import { indexTransactionPlan } from "./snapshot-transaction-plan.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  assertAllowedTarget,
  assertRecoveryPolicy,
  assertSafeParents,
  BOUND_DIRECTORY_JOURNAL_VERSION,
  BOUND_INCLUDED_PATHS_JOURNAL_VERSION,
  IGNORE_POLICY_JOURNAL_VERSION,
  ignorePolicyValidator,
  ignoreSourceBinding,
  isScopedJournal,
  isStrictlyInside,
  recoveryPolicyKey,
  StaleIgnorePolicyError,
  type TransactionEntry,
  type TransactionJournal,
  type TransactionOptions,
  touchesProtectedTarget,
  transactionHasSessionTargets,
  validateJournal,
  validateJournalPolicy,
} from "./snapshot-transaction-policy.js";
import {
  assertNoUnclaimedLegacyStage,
  buildScopedRecoveryStage,
  cleanScopedLegacyStage,
  cleanScopedWorkspace,
  inspectScopedRecoveryStage,
  prepareLegacyRecoveryStage,
  recoveryStagePath,
} from "./snapshot-transaction-stage.js";
import { verifyTarget } from "./snapshot-transaction-verification.js";
import type { SnapshotApplyPlan } from "./snapshot-types.js";

const JOURNAL_VERSION = 4;
class ScopedRemovalError extends Error {}

export type SkippedSnapshotWrite = SnapshotApplyPlan["writes"][number] & { preimage: string };

export async function applySnapshotTransaction(
  plan: SnapshotApplyPlan,
  options: TransactionOptions = {},
  skipped: readonly SkippedSnapshotWrite[] = [],
) {
  options.validateMutation?.();
  const root = path.resolve(agentDir());
  if (options.scope === "agent-directory") {
    const sessionDir = options.sessionDir ?? (await agentDirectoryConfiguredSessionDir(options.signal, root, options));
    options = { ...options, sessionDir: sessionStorageRoot(root, sessionDir) };
  }
  const validateIgnorePolicy = ignorePolicyValidator(options);
  await recoverPendingSnapshotTransactions(options);
  const coalesced = await coalesceCaseReplacements(root, plan);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  const targets = [...new Set([...coalesced.plan.deletes, ...coalesced.plan.writes.map((item) => item.target)])].sort();
  if (targets.length > 16_384)
    throw new Error("Snapshot transaction exceeds its target bound; review a smaller transfer.");
  return withTargetQueues(targets, options, async (heldKeys) => {
    if (validateIgnorePolicy) await validateIgnorePolicy();
    await assertUnexcludedTargets(root, [...targets, ...coalesced.replacements.values()], options);
    options.signal?.throwIfAborted();
    if (targets.some((target) => touchesProtectedTarget(target, options.protectedTargets)))
      throw new Error("Snapshot transaction targets the current session; review is required.");
    for (const [before, after] of coalesced.replacements) {
      if ((await caseReplacementSpelling(before, after)) !== before)
        throw new Error("Case replacement changed before preparation; review is required.");
      options.validateMutation?.();
      options.signal?.throwIfAborted();
    }
    const originalTargets = new Map([...coalesced.replacements].map(([before, after]) => [after, before]));
    const scoped = options.scope === "agent-directory";
    /** Fresh apply authorization only; recovery remains bound to durable journal images. */
    const expectedPreimages = new Map(
      [...(options.expectedPreimages ?? [])]
        .filter(([target]) => !scoped || !originalTargets.has(target))
        .map(([target, expected]) => [originalTargets.get(target) ?? target, expected]),
    );
    // A case-sensitive spelling replacement has two targets, unlike a coalesced physical alias.
    // Bind both the source bytes and destination absence/bytes before capturing their backups.
    for (const [target, expected] of scoped ? [] : (options.expectedPreimages ?? [])) {
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
      const destination = await legacyImage(target);
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
    const skippedPreimages = new Map(skipped.map(({ target, preimage }) => [target, preimage]));
    for (const [target, expected] of expectedPreimages) {
      if (skippedPreimages.get(target) === expected) continue;
      if (scoped || options.reservedIgnoreNames?.length) await assertUnexcludedTargets(root, [target], options);
      const current = scoped ? (await scopedTransactionImage(target, options)).value : await legacyImage(target);
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      if (current !== expected)
        throw new Error("Reviewed file preimage changed before apply; snapshot installation refused.");
    }
    if (validateIgnorePolicy) await validateIgnorePolicy();
    const mutationTargets = skipped.length ? targets.filter((target) => !skippedPreimages.has(target)) : targets;
    const writes = skipped.length ? plan.writes.filter(({ target }) => !skippedPreimages.has(target)) : plan.writes;
    if (mutationTargets.length === 0) {
      if (options.validateApplyReview) await options.validateApplyReview();
      if (scoped) {
        const pendingStateEntry = stateDir(root);
        const inventory = await scanAgentDirectoryInventory(root, options, pendingStateEntry);
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        assertProjectedAgentDirectoryBudget(
          inventory,
          { deletes: [], writes: [{ target: pendingStateEntry }] },
          options,
        );
      }
      if (validateIgnorePolicy) await validateIgnorePolicy();
      await verifySkippedWrites(root, skipped, heldKeys, options);
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      return;
    }
    const mutationPlan = skipped.length
      ? { ...coalesced.plan, writes: coalesced.plan.writes.filter(({ target }) => !skippedPreimages.has(target)) }
      : coalesced.plan;
    const transaction = await prepareTransaction(
      mutationPlan,
      mutationTargets,
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
      if (options.validateApplyReview) await options.validateApplyReview();
      if (scoped && transaction.deletes.length) await recheckAgentDirectoryBudget(root, plan, options, stateDir(root));
      for (const target of transaction.deletes.sort((a, b) => a.length - b.length)) {
        options.signal?.throwIfAborted();
        const entry = entriesByTarget.get(target);
        if (!entry) throw new Error("Unowned transaction target.");
        await removeOwnedTarget(transaction.directory, entry, transaction.journal, options, { apply: true });
        await syncDirectory(path.dirname(target));
      }
      await withMissingTargetQueues(
        transaction.journal.entries
          .filter((entry) => entry.removalPending)
          .flatMap((entry) => [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])]),
        heldKeys,
        options,
        async () => {
          if (options.validateApplyReview && transaction.journal.entries.some((entry) => entry.removalPending))
            await options.validateApplyReview();
          if (validateIgnorePolicy) await validateIgnorePolicy();
          if (scoped && plan.writes.length)
            await recheckAgentDirectoryBudget(root, { deletes: [], writes: plan.writes }, options);
          if (validateIgnorePolicy) await validateIgnorePolicy();
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
          for (const item of writes) {
            options.signal?.throwIfAborted();
            const entry = entriesByTarget.get(item.target);
            if (!entry) throw new Error("Unowned transaction target.");
            const deletedByThisCall = uninstalledWrites.delete(entry.target);
            if (options.scope === "agent-directory" || options.reservedIgnoreNames?.length)
              await assertUnexcludedTargets(transaction.journal.root, [item.target], options);
            await verifyTarget(transaction.directory, entry, transaction.journal, options, deletedByThisCall);
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            if (validateIgnorePolicy) await validateIgnorePolicy();
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
              const verified = await verifyTarget(
                transaction.directory,
                entry,
                transaction.journal,
                options,
                deletedByThisCall,
              );
              options.signal?.throwIfAborted();
              options.validateMutation?.();
              if (validateIgnorePolicy) {
                await validateIgnorePolicy();
                if (verified.scoped) await recheckScopedImage(item.target, verified.scoped, options);
                else {
                  await assertUnexcludedTargets(root, [item.target], options);
                  await verifyTarget(transaction.directory, entry, transaction.journal, options, deletedByThisCall);
                }
              }
              options.validateMutation?.();
              options.signal?.throwIfAborted();
              await fs.rename(temp, item.target);
              await syncDirectory(path.dirname(item.target));
            } finally {
              await fs.rm(temp, { force: true });
            }
          }
          options.validateMutation?.();
          options.signal?.throwIfAborted();
          await syncMutationParents(
            mutationTargets,
            [transaction.journal.root, ...(transaction.journal.sessionRoot ? [transaction.journal.sessionRoot] : [])],
            options,
          );
          options.validateMutation?.();
          options.signal?.throwIfAborted();
          if (validateIgnorePolicy) await validateIgnorePolicy();
        },
      );
      if (validateIgnorePolicy) await validateIgnorePolicy();
      await verifySkippedWrites(root, skipped, heldKeys, options);
      options.validateMutation?.();
      options.signal?.throwIfAborted();
    } catch (error) {
      // Aborted owners cannot roll back files after another session has replaced them.
      if (options.signal?.aborted)
        throw new Error("Snapshot apply cancelled; guarded transaction evidence retained for review.");
      if (error instanceof ScopedRemovalError || error instanceof StaleIgnorePolicyError) throw error;
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

async function verifySkippedWrites(
  root: string,
  skipped: readonly SkippedSnapshotWrite[],
  heldKeys: ReadonlySet<string>,
  options: TransactionOptions,
) {
  if (!skipped.length) return;
  await assertUnexcludedTargets(
    root,
    skipped.map(({ target }) => target),
    options,
    { recursive: false },
  );
  const sessionRoot = options.sessionDir ? sessionStorageRoot(root, options.sessionDir) : undefined;
  const verified = [];
  for (const { target, content } of skipped) {
    if (!heldKeys.has(target) || touchesProtectedTarget(target, options.protectedTargets))
      throw new Error("Skipped file lost its transaction queue or session protection changed; review is required.");
    await assertSafeParents(root, sessionRoot, target);
    verified.push({ target, stat: await verifyUnchangedFile(target, content, options) });
  }
  for (const { target, stat } of verified) await recheckUnchangedFile(target, stat, options);
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
      const content = await readTransactionJournal(path.join(directory, "journal.json"), options);
      // Unknown evidence is not disposable, including interrupted preparation directories.
      if (content === undefined) continue;
      journal = JSON.parse(content) as TransactionJournal;
    } catch {
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      throw new Error("Cannot recover malformed pi-sync transaction; preserve private evidence for review.");
    }
    validateJournalPolicy(journal);
    if (!journal.completed) {
      assertRecoveryPolicy(journal, options);
      ignorePolicyValidator(options);
    }
    let sessionDir = options.sessionDir;
    if (sessionDir === undefined && !journal.completed) {
      if (options.scope === "agent-directory")
        sessionDir = await agentDirectoryConfiguredSessionDir(options.signal, agentDir(), options);
      else if (options.resolveConfiguredSessionDir && transactionHasSessionTargets(journal))
        sessionDir = await configuredSessionDir(options);
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

async function prepareTransaction(
  plan: SnapshotApplyPlan,
  targets: string[],
  options: TransactionOptions,
  replacements = new Map<string, string>(),
) {
  const { sessionDir } = options;
  const root = path.resolve(agentDir());
  const wholeDirectory = options.scope === "agent-directory";
  const ignoreSource = options.ignorePolicy ? ignoreSourceBinding(options.ignorePolicy) : undefined;
  const localPolicyKey = recoveryPolicyKey(options);
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
    if (wholeDirectory || options.reservedIgnoreNames?.length) await assertUnexcludedTargets(root, [target], options);
    const entry: TransactionEntry = { target, backupName: `${index}`, kind: "missing" };
    if (replacements.has(target)) entry.afterTarget = replacements.get(target);
    const backup = path.join(backupDirectory, entry.backupName);
    if (wholeDirectory) {
      const captured = await scopedTransactionImage(target, options, backup, (source) =>
        assertUnexcludedTargets(root, [source], options, { recursive: false }),
      );
      entry.kind = captured.kind;
      entry.beforeImage = captured.value;
    } else {
      await captureLegacyBackup(target, backup, entry, options);
    }
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    const expected = options.expectedPreimages?.get(target);
    if (wholeDirectory && entry.kind === "directory" && expected === undefined)
      throw new Error("Scoped directory replacement requires a reviewed preimage.");
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
    version: localPolicyKey
      ? wholeDirectory
        ? BOUND_DIRECTORY_JOURNAL_VERSION
        : BOUND_INCLUDED_PATHS_JOURNAL_VERSION
      : ignoreSource
        ? IGNORE_POLICY_JOURNAL_VERSION
        : wholeDirectory
          ? AGENT_DIRECTORY_JOURNAL_VERSION
          : sessionRootTransition
            ? 7
            : replacements.size
              ? 5
              : JOURNAL_VERSION,
    root,
    ignoreSource,
    localPolicyKey,
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
  await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: MAX_TRANSACTION_JOURNAL_BYTES });
  await syncDirectory(transactionRoot());
  await syncDirectory(stateDir());
  await syncDirectory(path.dirname(stateDir()));
  return { directory, journal, deletes: indexed.deletes, deletedWrites: indexed.deletedWrites };
}

async function captureLegacyBackup(
  target: string,
  backup: string,
  entry: TransactionEntry,
  options: TransactionOptions,
) {
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
        filter: () => {
          options.signal?.throwIfAborted();
          options.validateMutation?.();
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
        : await legacyImage(backup, true);
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
  const scoped = isScopedJournal(journal);
  const validateIgnorePolicy = ignorePolicyValidator(options);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (validateIgnorePolicy) {
    assertRecoveryPolicy(journal, options);
    await validateIgnorePolicy();
  }
  await assertUnexcludedTargets(
    journal.root,
    journal.entries.flatMap((entry) => [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])]),
    options,
  );
  for (const entry of journal.entries) {
    if (touchesProtectedTarget(entry.target, options.protectedTargets))
      throw new Error(
        "Pending transaction touches the current session; resume a different session before guarded recovery.",
      );
    const { value, before } = await verifyTarget(directory, entry, journal, options);
    if (scoped) {
      await assertNoUnclaimedLegacyStage(directory, entry, options);
      const stage = await inspectScopedRecoveryStage(directory, entry, options);
      if (entry.recoveryWorkspace && !stage && value !== before)
        throw new Error("Recovery workspace is missing; preserve evidence for review.");
      if (entry.vacantInstall && value === "missing") {
        if (
          !stage ||
          stage.image.kind === "missing" ||
          stage.image.value !== before ||
          stage.partial.kind !== "missing" ||
          scopedIdentity(stage.image.stat) !== entry.vacantInstall
        )
          throw new Error("Recovery vacancy has no verified staging image; preserve evidence for review.");
      }
    }
  }
  for (const entry of journal.entries) {
    if (!entry.recoveryStaged) continue;
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    if (scoped) await cleanScopedLegacyStage(directory, entry, options);
    else await fs.rm(recoveryStagePath(directory, entry), { recursive: true, force: true });
    options.validateMutation?.();
    options.signal?.throwIfAborted();
  }
  if (scoped && journal.version < AGENT_DIRECTORY_JOURNAL_VERSION) {
    journal.version = AGENT_DIRECTORY_JOURNAL_VERSION;
    for (const entry of journal.entries) delete entry.recoveryStaged;
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    await persistJournal(directory, journal);
  }
  // Verify the complete group before removing any path. Recheck each destructive boundary.
  for (const entry of [...journal.entries].sort((a, b) => a.target.length - b.target.length)) {
    const { value: current, before } = await verifyTarget(directory, entry, journal, options);
    const spellingMatches = async () =>
      !entry.afterTarget || (await caseReplacementSpelling(entry.target, entry.afterTarget)) === entry.target;
    if (current === before && (await spellingMatches())) {
      if (entry.recoveryWorkspace) {
        if (validateIgnorePolicy) await validateIgnorePolicy();
        await cleanScopedWorkspace(directory, entry, options);
      }
      continue;
    }
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    if (entry.kind === "missing") {
      await removeOwnedTarget(directory, entry, journal, options, { restoringBefore: before });
      continue;
    }
    if (scoped) {
      await restoreScopedEntry(directory, journal, entry, options, heldKeys, before, spellingMatches);
      continue;
    }
    const temporary = await prepareLegacyRecoveryStage(directory, entry, options, () =>
      persistJournal(directory, journal),
    );
    if (entry.kind === "file") {
      try {
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        await fs.mkdir(path.dirname(entry.target), { recursive: true });
        await fs.copyFile(path.join(directory, "before", entry.backupName), temporary);
        // Windows requires write access to flush an existing regular file.
        const handle = await fs.open(temporary, process.platform === "win32" ? "r+" : "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const { value: verified } = await verifyTarget(directory, entry, journal, options);
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
          !(await removeOwnedTarget(directory, entry, journal, options, { restoringBefore: before }))
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
            const { value: atRename } = await verifyTarget(directory, entry, journal, options);
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            if (atRename === before && (await spellingMatches())) return;
            await retireRestorationIntent(directory, journal, entry, options);
            const { value: atInstall } = await verifyTarget(directory, entry, journal, options, atRename === "missing");
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            if (atInstall === before && (await spellingMatches())) return;
            if (validateIgnorePolicy) {
              await validateIgnorePolicy();
              await assertUnexcludedTargets(journal.root, [entry.target], options);
              await verifyTarget(directory, entry, journal, options, atRename === "missing");
            }
            options.validateMutation?.();
            options.signal?.throwIfAborted();
            await fs.rename(temporary, entry.target);
            await syncDirectory(path.dirname(entry.target));
          },
        );
      } finally {
        await fs.rm(temporary, { force: true });
      }
      continue;
    }
    try {
      options.validateMutation?.();
      options.signal?.throwIfAborted();
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
      if ((await legacyImage(temporary, true)) !== before)
        throw new Error("Staged recovery image differs from the backup; evidence retained.");
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      if (!(await removeOwnedTarget(directory, entry, journal, options, { restoringBefore: before }))) continue;
      await withMissingTargetQueues([entry.target], heldKeys, options, async () => {
        const { value: atRename } = await verifyTarget(directory, entry, journal, options);
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (atRename === before) return;
        await retireRestorationIntent(directory, journal, entry, options);
        const { value: atInstall } = await verifyTarget(directory, entry, journal, options, atRename === "missing");
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (atInstall === before) return;
        if (validateIgnorePolicy) {
          await validateIgnorePolicy();
          await assertUnexcludedTargets(journal.root, [entry.target], options);
          await verifyTarget(directory, entry, journal, options, atRename === "missing");
        }
        options.validateMutation?.();
        options.signal?.throwIfAborted();
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
  if (validateIgnorePolicy) await validateIgnorePolicy();
  await completeTransaction(directory, journal);
}

async function restoreScopedEntry(
  directory: string,
  journal: TransactionJournal,
  entry: TransactionEntry,
  options: TransactionOptions,
  heldKeys: ReadonlySet<string>,
  before: string,
  spellingMatches: () => Promise<boolean>,
) {
  const validateIgnorePolicy = ignorePolicyValidator(options);
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (validateIgnorePolicy) await validateIgnorePolicy();
  await fs.mkdir(path.dirname(entry.target), { recursive: true });
  await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
  if (!entry.vacantInstall) {
    if (validateIgnorePolicy) await validateIgnorePolicy();
    await buildScopedRecoveryStage(directory, entry, options, () => persistJournal(directory, journal));
  }
  const verifyStage = async () => {
    const stage = await inspectScopedRecoveryStage(directory, entry, options, true);
    if (!stage || stage.image.kind === "missing" || stage.image.value !== before || stage.partial.kind !== "missing")
      throw new Error("Staged recovery image changed; evidence retained.");
    if (entry.vacantInstall && scopedIdentity(stage.image.stat) !== entry.vacantInstall)
      throw new Error("Recovery vacancy has a different staging image; preserve evidence for review.");
    const identity = stableScopedIdentity(stage.payload, stage.image.stat);
    return { payload: stage.payload, identity, image: stage.image };
  };
  await verifyStage();
  const { value: verified } = await verifyTarget(directory, entry, journal, options);
  if (verified !== before || !(await spellingMatches())) {
    const needsCaseQueue =
      entry.afterTarget !== undefined &&
      (await caseReplacementSpelling(entry.target, entry.afterTarget)) === entry.afterTarget;
    const needsRemoval =
      verified !== "missing" && (needsCaseQueue || verified.startsWith("directory:") || entry.kind === "directory");
    const needsVacantTarget = needsRemoval || verified === "missing";
    if (
      !needsRemoval ||
      (await removeOwnedTarget(directory, entry, journal, options, {
        restoringBefore: needsCaseQueue ? undefined : before,
      }))
    ) {
      const queueTargets = needsVacantTarget ? [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])] : [];
      await withMissingTargetQueues(queueTargets, heldKeys, options, async () => {
        if (validateIgnorePolicy) await validateIgnorePolicy();
        const { value: atRename } = await verifyTarget(directory, entry, journal, options);
        if (atRename === before && (await spellingMatches())) return;
        if (needsVacantTarget && atRename !== "missing")
          throw new Error("Transaction target changed after removal; preserve evidence for review.");
        const stage = await verifyStage();
        if (needsVacantTarget && !entry.vacantInstall) {
          if (validateIgnorePolicy) await validateIgnorePolicy();
          entry.vacantInstall = stage.identity;
          delete entry.removalPending;
          delete entry.replacementStarted;
          delete entry.scopedRemoval;
          for (const child of journal.entries) {
            if (isStrictlyInside(entry.target, child.target)) delete child.scopedRemoval;
          }
          options.validateMutation?.();
          options.signal?.throwIfAborted();
          await syncDirectory(path.dirname(entry.target));
          options.validateMutation?.();
          options.signal?.throwIfAborted();
          await persistJournal(directory, journal);
          await verifyStage();
        }
        if ((await scopedPathIdentity(stage.payload, options)) !== stage.identity)
          throw new Error("Staged recovery image changed before restoration; preserve evidence for review.");
        const atInstall = await verifyTarget(directory, entry, journal, options);
        if (atInstall.value === before && (await spellingMatches())) return;
        if (atInstall.value !== atRename)
          throw new Error("Transaction target changed before restoration; preserve evidence for review.");
        options.validateMutation?.();
        options.signal?.throwIfAborted();
        if (validateIgnorePolicy && atInstall.scoped) {
          await validateIgnorePolicy();
          await recheckScopedImage(stage.payload, stage.image, options);
          await recheckScopedImage(entry.target, atInstall.scoped, options);
        }
        await fs.rename(stage.payload, entry.target);
        await syncDirectory(path.dirname(entry.target));
        await syncDirectory(path.dirname(stage.payload));
        if ((await verifyTarget(directory, entry, journal, options)).value !== before)
          throw new Error("Restored transaction image changed; evidence retained.");
      });
    }
  }
  if (validateIgnorePolicy) await validateIgnorePolicy();
  await cleanScopedWorkspace(directory, entry, options);
}

async function removeOwnedTarget(
  directory: string,
  entry: TransactionEntry,
  journal: TransactionJournal,
  options: TransactionOptions,
  { apply, restoringBefore }: { apply?: boolean; restoringBefore?: string } = {},
) {
  const scoped = isScopedJournal(journal);
  const validateIgnorePolicy = ignorePolicyValidator(options);
  try {
    if (validateIgnorePolicy) await validateIgnorePolicy();
    await assertUnexcludedTargets(
      journal.root,
      [entry.target, ...(entry.afterTarget ? [entry.afterTarget] : [])],
      options,
    );
    const current = await verifyTarget(directory, entry, journal, options);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    if (restoringBefore !== undefined && current.value === restoringBefore) return false;
    if (scoped && apply && current.value !== current.before)
      throw new Error("Reviewed removal image changed; preserve evidence for review.");
    // Until replacement is armed, interrupted removal can recognize absence without accepting unknown bytes.
    upgradeRemovalEvidence(journal);
    for (const affected of journal.entries) {
      if (affected.target !== entry.target && !isStrictlyInside(entry.target, affected.target)) continue;
      affected.removalPending = true;
      affected.replacementStarted = false;
      if (affected.vacantInstall)
        throw new Error("Transaction removal overlaps a recovery vacancy; preserve evidence for review.");
      if (!current.scoped) continue;
      const relative = path.relative(entry.target, affected.target);
      const observed = scopedDescendant(current.scoped, relative);
      if (!observed || observed.kind === "missing") continue;
      const observedPath = path.join(entry.target, relative);
      const mayChange = observed.kind === "directory" && observed.children.length > 0;
      if (affected.scopedRemoval) {
        if (mayChange) stableScopedIdentity(observedPath, observed.stat);
        continue;
      }
      const image =
        observed.value === affected.beforeImage
          ? "before"
          : observed.value === affected.afterImage || ownedScopedPostTree(observed, affected.postFiles ?? [], true)
            ? "after"
            : undefined;
      if (!image) continue;
      affected.scopedRemoval = {
        image,
        identity: mayChange ? stableScopedIdentity(observedPath, observed.stat) : scopedIdentity(observed.stat),
      };
    }
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    await persistJournal(directory, journal);
    const verified = await verifyTarget(directory, entry, journal, options);
    options.validateMutation?.();
    options.signal?.throwIfAborted();
    if (restoringBefore !== undefined && verified.value === restoringBefore) return false;
    if (current.scoped) {
      if (current.value !== verified.value) throw new Error("Transaction removal image changed.");
      await assertUnexcludedTargets(journal.root, [entry.target], options);
      await removeScopedImage(entry.target, current.scoped, options, validateIgnorePolicy);
    } else {
      if (validateIgnorePolicy) {
        await validateIgnorePolicy();
        await assertUnexcludedTargets(journal.root, [entry.target], options);
        await verifyTarget(directory, entry, journal, options);
      }
      options.validateMutation?.();
      options.signal?.throwIfAborted();
      await fs.rm(entry.target, { recursive: true, force: true });
    }
    await syncDirectory(path.dirname(entry.target));
    return true;
  } catch (error) {
    if (!scoped || error instanceof StaleIgnorePolicyError) throw error;
    throw new ScopedRemovalError("Scoped transaction removal stopped; preserve transaction and backup for review.", {
      cause: error,
    });
  }
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
    delete entry.scopedRemoval;
  }
  await writeJson(path.join(directory, "journal.json"), journal, { maxBytes: MAX_TRANSACTION_JOURNAL_BYTES });
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

function persistJournal(directory: string, journal: TransactionJournal) {
  return writeJson(path.join(directory, "journal.json"), journal, { maxBytes: MAX_TRANSACTION_JOURNAL_BYTES });
}

async function completeTransaction(directory: string, journal: TransactionJournal) {
  // Publish completion before deleting any backup. A surviving journal after power loss
  // may only retry cleanup, never roll back already accepted files.
  await writeJson(
    path.join(directory, "journal.json"),
    {
      ...journal,
      version:
        isScopedJournal(journal) || journal.localPolicyKey ? journal.version : journal.sessionRootTransition ? 7 : 6,
      completed: true,
    },
    {
      maxBytes: MAX_TRANSACTION_JOURNAL_BYTES,
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
