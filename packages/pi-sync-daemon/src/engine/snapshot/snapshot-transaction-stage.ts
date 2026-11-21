import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory, writeJson } from "../state/json-file.js";
import {
  matchesScopedFilePrefix,
  ownedScopedSubset,
  readTransactionJournal,
  removeScopedImage,
  type ScopedImage,
  scopedIdentity,
  scopedPathIdentity,
  scopedTransactionImage,
} from "./snapshot-transaction-images.js";
import { isScopedIdentity, type TransactionEntry } from "./snapshot-transaction-policy.js";

interface Guards {
  signal?: AbortSignal;
  validateMutation?: () => void;
}

function validate(options: Guards) {
  options.validateMutation?.();
  options.signal?.throwIfAborted();
}

function unrecognizedStage(): never {
  throw new Error("Unrecognized recovery staging image; preserve evidence for review.");
}

export function recoveryStagePath(directory: string, entry: TransactionEntry) {
  const token = createHash("sha256").update(directory).update("\\0").update(entry.backupName).digest("hex");
  return path.join(
    path.dirname(entry.target),
    `.pi-sync.json.${token}.${entry.kind === "file" ? "restore" : "restore-tree"}`,
  );
}

export async function prepareLegacyRecoveryStage(
  directory: string,
  entry: TransactionEntry,
  options: Guards,
  persist: () => Promise<void>,
) {
  const temporary = recoveryStagePath(directory, entry);
  if (!entry.recoveryStaged) {
    try {
      await fs.lstat(temporary);
      throw new Error("Unowned recovery staging path; preserve evidence for review.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    validate(options);
    entry.recoveryStaged = true;
    await persist();
    validate(options);
  }
  return temporary;
}

export async function assertNoUnclaimedLegacyStage(directory: string, entry: TransactionEntry, options: Guards) {
  if (entry.recoveryStaged) return;
  validate(options);
  try {
    await fs.lstat(recoveryStagePath(directory, entry));
  } catch (error) {
    validate(options);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  unrecognizedStage();
}

export async function cleanScopedLegacyStage(directory: string, entry: TransactionEntry, options: Guards) {
  const temporary = recoveryStagePath(directory, entry);
  const staged = await scopedTransactionImage(temporary, options);
  if (staged.kind === "missing") return;
  if (staged.kind !== entry.kind || staged.value !== entry.beforeImage) unrecognizedStage();
  await removeScopedImage(temporary, staged, options);
  await syncDirectory(path.dirname(temporary));
}

function workspacePath(directory: string, entry: TransactionEntry) {
  return `${recoveryStagePath(directory, entry)}.workspace`;
}

async function existingWorkspace(workspace: string, entry: TransactionEntry, options: Guards) {
  validate(options);
  try {
    const stat = await fs.lstat(workspace, { bigint: true });
    validate(options);
    if (!stat.isDirectory() || scopedIdentity(stat) !== entry.recoveryWorkspace) unrecognizedStage();
    return true;
  } catch (error) {
    validate(options);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function fileKey(relative: string) {
  return createHash("sha256").update(relative).digest("hex");
}

function findFile(node: ScopedImage, key: string, relative = ""): [string, ScopedImage] | undefined {
  if (node.kind === "file" && fileKey(relative) === key) return [relative, node];
  if (node.kind !== "directory") return;
  for (const [name, child] of node.children) {
    const found = findFile(child, key, path.join(relative, name));
    if (found) return found;
  }
}

const SCRATCH_EVIDENCE_BYTES = 1024;

export async function inspectScopedRecoveryStage(directory: string, entry: TransactionEntry, options: Guards) {
  const workspace = workspacePath(directory, entry);
  if (!(await existingWorkspace(workspace, entry, options))) return;
  const backup = path.join(directory, "before", entry.backupName);
  const source = await scopedTransactionImage(backup, options);
  if (source.kind !== entry.kind || source.value !== entry.beforeImage) unrecognizedStage();
  const payload = path.join(workspace, "image");
  const scratch = path.join(workspace, "scratch");
  const evidence = path.join(directory, `scratch-${entry.backupName}.json`);
  for await (const child of await fs.opendir(workspace)) {
    validate(options);
    if (child.name !== "image" && child.name !== "scratch") unrecognizedStage();
  }
  const image = await scopedTransactionImage(payload, options);
  if (image.kind !== "missing" && !ownedScopedSubset(image, source)) unrecognizedStage();
  const partial = await scopedTransactionImage(scratch, options);
  if (partial.kind !== "missing") {
    if (partial.kind !== "file") unrecognizedStage();
    // Only the one file opened exclusively by our copier may contain incomplete bytes.
    const saved = JSON.parse((await readTransactionJournal(evidence, options, SCRATCH_EVIDENCE_BYTES)) ?? "null");
    if (!isScopedIdentity(saved?.identity) || typeof saved.file !== "string") unrecognizedStage();
    if (scopedIdentity(partial.stat) !== saved.identity || findFile(image, saved.file)) unrecognizedStage();
    const expected = findFile(source, saved.file);
    if (!expected || !(await matchesScopedFilePrefix(path.join(backup, expected[0]), expected[1], partial, options)))
      unrecognizedStage();
  }
  if (!(await existingWorkspace(workspace, entry, options))) unrecognizedStage();
  return { workspace, backup, source, payload, image, scratch, partial, evidence };
}

export async function buildScopedRecoveryStage(
  directory: string,
  entry: TransactionEntry,
  options: Guards,
  persist: () => Promise<void>,
) {
  const workspace = workspacePath(directory, entry);
  if (!entry.recoveryWorkspace) {
    validate(options);
    // Do not claim an existing directory, including a crash before ownership was recorded.
    await fs.mkdir(workspace, { mode: 0o700 });
    const identity = await scopedPathIdentity(workspace, options);
    await syncDirectory(path.dirname(workspace));
    validate(options);
    entry.recoveryWorkspace = identity;
    await persist();
  }
  const stage = (await inspectScopedRecoveryStage(directory, entry, options)) ?? unrecognizedStage();
  await removeScopedImage(stage.scratch, stage.partial, options);
  async function copy(source: ScopedImage, existing: ScopedImage | undefined, relative: string): Promise<void> {
    if (!(await existingWorkspace(workspace, entry, options))) unrecognizedStage();
    const destination = path.join(stage.payload, relative);
    if (source.kind === "file") {
      if (existing && existing.kind !== "missing") return;
      let identity: string | undefined;
      const copied = await scopedTransactionImage(
        path.join(stage.backup, relative),
        options,
        stage.scratch,
        undefined,
        async (handle) => {
          identity = scopedIdentity(await handle.stat({ bigint: true }));
          if ((await scopedPathIdentity(stage.scratch, options)) !== identity) unrecognizedStage();
          await syncDirectory(workspace);
          validate(options);
          await writeJson(stage.evidence, { identity, file: fileKey(relative) }, { maxBytes: SCRATCH_EVIDENCE_BYTES });
        },
      );
      if (copied.value !== source.value) unrecognizedStage();
      // Keep partial files out of the payload. Recheck both names before renaming
      // within the identity-bound private workspace.
      const ready = await scopedTransactionImage(stage.scratch, options);
      if (
        ready.kind !== "file" ||
        ready.value !== source.value ||
        scopedIdentity(ready.stat) !== identity ||
        (await scopedTransactionImage(destination, options)).kind !== "missing" ||
        !(await existingWorkspace(workspace, entry, options))
      )
        unrecognizedStage();
      validate(options);
      await fs.rename(stage.scratch, destination);
      await syncDirectory(path.dirname(destination));
      if (path.dirname(destination) !== workspace) await syncDirectory(workspace);
    } else if (source.kind === "directory") {
      if (!existing || existing.kind === "missing") {
        await fs.mkdir(destination, { mode: 0o700 });
        await syncDirectory(path.dirname(destination));
      }
      const children = new Map(existing?.kind === "directory" ? existing.children : []);
      for (const [name, child] of source.children) await copy(child, children.get(name), path.join(relative, name));
      validate(options);
      await fs.chmod(destination, Number(source.stat.mode & 0o777n));
      validate(options);
      await fs.utimes(destination, source.stat.atime, source.stat.mtime);
      await syncDirectory(destination);
    }
  }
  await copy(stage.source, stage.image, "");
}

export async function cleanScopedWorkspace(directory: string, entry: TransactionEntry, options: Guards) {
  const stage = await inspectScopedRecoveryStage(directory, entry, options);
  if (!stage) return;
  await removeScopedImage(stage.scratch, stage.partial, options);
  await removeScopedImage(stage.payload, stage.image, options);
  if (!(await existingWorkspace(stage.workspace, entry, options))) unrecognizedStage();
  validate(options);
  await fs.rmdir(stage.workspace);
  await syncDirectory(path.dirname(stage.workspace));
}
