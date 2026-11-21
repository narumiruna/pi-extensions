import fs from "node:fs/promises";
import path from "node:path";
import { caseReplacementSpelling } from "./snapshot-case-replacement.js";
import {
  installedVacancyIdentityMatches,
  legacyImage,
  ownedLegacyPostTree,
  ownedScopedPostTree,
  ownedScopedSubset,
  recheckScopedImage,
  type ScopedImage,
  scopedIdentity,
  scopedTransactionImage,
} from "./snapshot-transaction-images.js";
import {
  assertSafeParents,
  isScopedJournal,
  type TransactionEntry,
  type TransactionJournal,
  type TransactionOptions,
} from "./snapshot-transaction-policy.js";

export async function verifyTarget(
  directory: string,
  entry: TransactionEntry,
  journal: TransactionJournal,
  options: TransactionOptions,
  deletedByThisCall = false,
) {
  await assertSafeParents(journal.root, journal.sessionRoot, entry.target);
  const isScoped = isScopedJournal(journal);
  const backup =
    isScoped && entry.kind !== "missing"
      ? await scopedTransactionImage(path.join(directory, "before", entry.backupName), options)
      : undefined;
  const before = isScoped ? (backup?.value ?? "missing") : await legacyBeforeImage(directory, entry);
  if ((backup && backup.kind !== entry.kind) || (journal.version >= 2 && before !== entry.beforeImage))
    throw new Error("Transaction backup changed; preserve evidence for review.");
  const spelling = entry.afterTarget ? await caseReplacementSpelling(entry.target, entry.afterTarget) : entry.target;
  const scoped = isScoped ? await scopedTransactionImage(entry.target, options) : undefined;
  const value = scoped?.value ?? (await legacyImage(entry.target));
  const result = { value, before, scoped };
  const postFiles = entry.postFiles ?? [];
  if (entry.vacantInstall) {
    if (
      scoped?.kind === "missing" ||
      (scoped &&
        value === before &&
        spelling === entry.target &&
        (await installedVacancyMatches(entry.target, scoped, entry.vacantInstall, options)))
    )
      return result;
  } else if (value === "missing") {
    if (
      value === before ||
      deletedByThisCall ||
      (journal.version >= 4 && entry.removalPending && !entry.replacementStarted)
    )
      return result;
  } else if (scoped && entry.scopedRemoval) {
    const removal = entry.scopedRemoval;
    if (
      (removal.image === "before"
        ? backup && ownedScopedSubset(scoped, backup)
        : value === entry.afterImage || ownedScopedPostTree(scoped, postFiles, false)) &&
      scoped.kind !== "missing" &&
      scopedIdentity(scoped.stat) === removal.identity
    )
      return result;
  } else if (value === before || (journal.version >= 2 && value === entry.afterImage)) {
    return result;
  } else if (journal.version >= 2) {
    const requireComplete = journal.version < 4 || entry.replacementStarted === true || !entry.removalPending;
    if (
      scoped
        ? ownedScopedPostTree(scoped, postFiles, true)
        : await ownedLegacyPostTree(entry.target, postFiles, requireComplete)
    )
      return result;
  }
  throw new Error(
    "Transaction target has unrecognized or newer bytes; automatic rollback refused. Preserve the transaction and review its backup with Pi closed.",
  );
}

async function installedVacancyMatches(
  target: string,
  image: ScopedImage,
  expected: string,
  options: TransactionOptions,
) {
  if (!installedVacancyIdentityMatches(image, expected) || image.kind === "missing") return false;
  if (scopedIdentity(image.stat) === expected) return true;
  const names = await fs.readdir(path.dirname(target));
  options.validateMutation?.();
  options.signal?.throwIfAborted();
  if (!names.includes(path.basename(target))) return false;
  await recheckScopedImage(target, image, options);
  return true;
}

async function legacyBeforeImage(directory: string, entry: TransactionEntry) {
  if (entry.kind === "missing") return "missing";
  const backup = path.join(directory, "before", entry.backupName);
  if (entry.kind === "symlink") return `symlink:${entry.linkTarget}`;
  const value = await legacyImage(backup);
  if (value === "missing") throw new Error("Transaction backup is missing; preserve evidence for review.");
  return value;
}
