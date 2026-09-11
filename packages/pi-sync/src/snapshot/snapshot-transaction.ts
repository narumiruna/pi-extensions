import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWithinRoot, isPathInside } from "../paths.js";
import { withLock } from "../state/lock.js";
import { stateDir } from "../state/state-directory.js";
import { agentDir } from "./session-paths.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import type { SnapshotApplyPlan } from "./snapshot-types.js";

const JOURNAL_VERSION = 1;

interface TransactionEntry {
  target: string;
  backupName: string;
  kind: "missing" | "file" | "directory" | "symlink";
  linkTarget?: string;
}

interface TransactionJournal {
  version: number;
  root: string;
  sessionRoot?: string;
  entries: TransactionEntry[];
}

export async function applySnapshotTransaction(plan: SnapshotApplyPlan, options: { sessionDir?: string } = {}) {
  await recoverPendingSnapshotTransactions();
  const transaction = await prepareTransaction(plan, options.sessionDir);
  try {
    for (const target of plan.deletes) {
      await fs.rm(target, { force: true, recursive: true });
    }
    for (const item of plan.writes) {
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await fs.writeFile(item.target, item.content);
    }
    await fs.rm(transaction.directory, { recursive: true, force: true });
  } catch (error) {
    try {
      await restoreTransaction(transaction.directory, transaction.journal);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Snapshot apply failed and automatic recovery also failed. Transaction retained at ${transaction.directory}.`,
      );
    }
    throw error;
  }
}

export async function recoverSnapshotTransactionsOnStartup() {
  if (!(await pendingTransactionEntries()).some((entry) => entry.isDirectory())) return;
  await withLock("recovery", recoverPendingSnapshotTransactions, { reclaimStale: true });
}

export async function recoverPendingSnapshotTransactions() {
  const directory = transactionRoot();
  const entries = await pendingTransactionEntries();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const transactionDirectory = path.join(directory, entry.name);
    const journalPath = path.join(transactionDirectory, "journal.json");
    let journal: TransactionJournal;
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as TransactionJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.rm(transactionDirectory, { recursive: true, force: true });
        continue;
      }
      throw new Error(`Cannot recover malformed pi-sync transaction: ${journalPath}`, {
        cause: error,
      });
    }
    await restoreTransaction(transactionDirectory, journal);
  }
}

async function pendingTransactionEntries() {
  try {
    return await fs.readdir(transactionRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function prepareTransaction(plan: SnapshotApplyPlan, sessionDir?: string) {
  const root = path.resolve(agentDir());
  const sessionRoot = sessionDir ? path.resolve(sessionStorageRoot(root, sessionDir)) : undefined;
  const directory = path.join(transactionRoot(), randomUUID());
  const backupDirectory = path.join(directory, "before");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const targets = [...new Set([...plan.deletes, ...plan.writes.map((item) => item.target)])].sort();
  const entries: TransactionEntry[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    assertAllowedTarget(root, sessionRoot, target);
    const backupName = `${index}`;
    const backupPath = path.join(backupDirectory, backupName);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        entries.push({
          target,
          backupName,
          kind: "symlink",
          linkTarget: await fs.readlink(target),
        });
      } else if (stat.isDirectory()) {
        await fs.cp(target, backupPath, {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        });
        entries.push({ target, backupName, kind: "directory" });
      } else if (stat.isFile()) {
        await fs.copyFile(target, backupPath);
        await fs.chmod(backupPath, stat.mode);
        entries.push({ target, backupName, kind: "file" });
      } else {
        throw new Error(`Unsupported existing snapshot target: ${target}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      entries.push({ target, backupName, kind: "missing" });
    }
  }
  const journal: TransactionJournal = {
    version: JOURNAL_VERSION,
    root,
    sessionRoot,
    entries,
  };
  await fs.writeFile(path.join(directory, "journal.json"), `${JSON.stringify(journal, null, "\t")}\n`, {
    mode: 0o600,
  });
  return { directory, journal };
}

async function restoreTransaction(directory: string, journal: TransactionJournal) {
  validateJournal(directory, journal);
  for (const entry of [...journal.entries].sort((left, right) => right.target.length - left.target.length)) {
    await fs.rm(entry.target, { recursive: true, force: true });
  }
  for (const entry of journal.entries) {
    if (entry.kind === "missing") continue;
    await fs.mkdir(path.dirname(entry.target), { recursive: true });
    const backupPath = path.join(directory, "before", entry.backupName);
    assertWithinRoot(directory, backupPath);
    if (entry.kind === "file") await fs.copyFile(backupPath, entry.target);
    else if (entry.kind === "directory") {
      await fs.cp(backupPath, entry.target, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
    } else if (entry.kind === "symlink" && entry.linkTarget !== undefined) {
      await fs.symlink(entry.linkTarget, entry.target);
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
}

function validateJournal(directory: string, journal: TransactionJournal) {
  if (journal.version !== JOURNAL_VERSION || !Array.isArray(journal.entries)) {
    throw new Error(`Unsupported pi-sync transaction journal: ${directory}`);
  }
  const expectedRoot = path.resolve(agentDir());
  if (path.resolve(journal.root) !== expectedRoot) {
    throw new Error(`Transaction root no longer matches the Pi agent directory: ${directory}`);
  }
  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry.target !== "string" ||
      typeof entry.backupName !== "string" ||
      !/^\d+$/u.test(entry.backupName)
    ) {
      throw new Error(`Invalid pi-sync transaction entry: ${directory}`);
    }
    assertAllowedTarget(journal.root, journal.sessionRoot, entry.target);
  }
}

function assertAllowedTarget(root: string, sessionRoot: string | undefined, target: string) {
  const resolved = path.resolve(target);
  if (isPathInside(root, resolved)) {
    assertWithinRoot(root, resolved);
    return;
  }
  if (sessionRoot && isPathInside(sessionRoot, resolved)) {
    assertWithinRoot(sessionRoot, resolved);
    return;
  }
  throw new Error(`Transaction target is outside configured roots: ${target}`);
}

function transactionRoot() {
  return path.join(stateDir(), "transactions");
}
