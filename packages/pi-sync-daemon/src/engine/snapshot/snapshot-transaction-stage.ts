import { createHash, randomUUID } from "node:crypto";
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
  stableScopedIdentity,
} from "./snapshot-transaction-images.js";
import { isRecoveryStageId, isScopedIdentity, type TransactionEntry } from "./snapshot-transaction-policy.js";

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

function workspacePath(directory: string, entry: TransactionEntry, slot = entry.recoveryWorkspaceId) {
  const base = `${recoveryStagePath(directory, entry)}.workspace`;
  return slot ? `${base}.${slot}` : base;
}

function scratchPath(workspace: string, slot: string) {
  return `${workspace}.scratch.${slot}`;
}

async function existingDirectory(workspace: string, identity: string, options: Guards, requireStable = false) {
  validate(options);
  try {
    const stat = await fs.lstat(workspace, { bigint: true });
    validate(options);
    if (!stat.isDirectory() || scopedIdentity(stat) !== identity) unrecognizedStage();
    if (requireStable) stableScopedIdentity(workspace, stat);
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

function parseScratchEvidence(content: string | undefined) {
  if (content === undefined) return;
  const saved = JSON.parse(content) as {
    identity?: unknown;
    file?: unknown;
    slot?: unknown;
    container?: unknown;
  } | null;
  if (
    !saved ||
    !isScopedIdentity(saved.identity) ||
    typeof saved.file !== "string" ||
    !/^[0-9a-f]{64}$/u.test(saved.file)
  )
    unrecognizedStage();
  const { identity, file, slot, container } = saved;
  if (slot === undefined && container === undefined) return { identity, file };
  if (!isRecoveryStageId(slot) || !isScopedIdentity(container)) unrecognizedStage();
  return { identity, file, slot, container };
}

async function createPrivateStageDirectory(directory: string, options: Guards) {
  validate(options);
  await fs.mkdir(directory, { mode: 0o700 });
  validate(options);
  const stat = await fs.lstat(directory, { bigint: true });
  validate(options);
  if (!stat.isDirectory()) unrecognizedStage();
  return stableScopedIdentity(directory, stat);
}

async function removeScratchContainer(container: string, identity: string, options: Guards) {
  if (!(await existingDirectory(container, identity, options))) return;
  validate(options);
  await fs.rmdir(container);
  await syncDirectory(path.dirname(container));
}

export async function inspectScopedRecoveryStage(
  directory: string,
  entry: TransactionEntry,
  options: Guards,
  requireStableWorkspace = false,
) {
  if (!entry.recoveryWorkspace) return;
  const workspace = workspacePath(directory, entry);
  if (!(await existingDirectory(workspace, entry.recoveryWorkspace, options))) return;
  const backup = path.join(directory, "before", entry.backupName);
  const source = await scopedTransactionImage(backup, options);
  if (source.kind !== entry.kind || source.value !== entry.beforeImage) unrecognizedStage();
  const payload = path.join(workspace, "image");
  const evidence = path.join(directory, `scratch-${entry.backupName}.json`);
  const saved = parseScratchEvidence(await readTransactionJournal(evidence, options, SCRATCH_EVIDENCE_BYTES));
  const container = saved?.slot ? scratchPath(workspace, saved.slot) : undefined;
  const hasContainer = container && saved?.container && (await existingDirectory(container, saved.container, options));
  if (hasContainer) {
    for await (const child of await fs.opendir(container)) {
      validate(options);
      if (child.name !== "bytes") unrecognizedStage();
    }
  }
  const scratch = container ? path.join(container, "bytes") : path.join(workspace, "scratch");
  for await (const child of await fs.opendir(workspace)) {
    validate(options);
    if (child.name !== "image" && (child.name !== "scratch" || saved?.slot)) unrecognizedStage();
  }
  const image = await scopedTransactionImage(payload, options);
  if (image.kind !== "missing" && !ownedScopedSubset(image, source)) unrecognizedStage();
  const partial: ScopedImage =
    !container || hasContainer ? await scopedTransactionImage(scratch, options) : { kind: "missing", value: "missing" };
  if (partial.kind !== "missing") {
    if (
      partial.kind !== "file" ||
      !saved ||
      scopedIdentity(partial.stat) !== saved.identity ||
      findFile(image, saved.file)
    )
      unrecognizedStage();
    const expected = findFile(source, saved.file);
    if (!expected || !(await matchesScopedFilePrefix(path.join(backup, expected[0]), expected[1], partial, options)))
      unrecognizedStage();
  }
  if (!(await existingDirectory(workspace, entry.recoveryWorkspace, options, requireStableWorkspace)))
    unrecognizedStage();
  return {
    workspace,
    backup,
    source,
    payload,
    image,
    scratch,
    partial,
    evidence,
    container,
    containerIdentity: saved?.container,
  };
}

async function clearScratch(
  stage: NonNullable<Awaited<ReturnType<typeof inspectScopedRecoveryStage>>>,
  options: Guards,
) {
  if (stage.container && stage.containerIdentity) {
    if (!(await existingDirectory(stage.container, stage.containerIdentity, options))) {
      if (stage.partial.kind !== "missing") unrecognizedStage();
      return;
    }
    await removeScopedImage(stage.scratch, stage.partial, options);
    await removeScratchContainer(stage.container, stage.containerIdentity, options);
  } else {
    await removeScopedImage(stage.scratch, stage.partial, options);
  }
}

export async function buildScopedRecoveryStage(
  directory: string,
  entry: TransactionEntry,
  options: Guards,
  persist: () => Promise<void>,
) {
  if (!entry.recoveryWorkspace) {
    const slot = randomUUID();
    const workspace = workspacePath(directory, entry, slot);
    const identity = await createPrivateStageDirectory(workspace, options);
    await syncDirectory(path.dirname(workspace));
    validate(options);
    entry.recoveryWorkspace = identity;
    entry.recoveryWorkspaceId = slot;
    await persist();
  }
  const stage = (await inspectScopedRecoveryStage(directory, entry, options, true)) ?? unrecognizedStage();
  const { workspace } = stage;
  const workspaceIdentity = entry.recoveryWorkspace;
  await clearScratch(stage, options);
  async function copy(source: ScopedImage, existing: ScopedImage | undefined, relative: string): Promise<void> {
    if (!workspaceIdentity || !(await existingDirectory(workspace, workspaceIdentity, options))) unrecognizedStage();
    const destination = path.join(stage.payload, relative);
    if (source.kind === "file") {
      if (existing && existing.kind !== "missing") return;
      let identity: string | undefined;
      const slot = randomUUID();
      const container = scratchPath(workspace, slot);
      const containerIdentity = await createPrivateStageDirectory(container, options);
      const scratch = path.join(container, "bytes");
      const copied = await scopedTransactionImage(
        path.join(stage.backup, relative),
        options,
        scratch,
        undefined,
        async (handle) => {
          const stat = await handle.stat({ bigint: true });
          validate(options);
          if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n) unrecognizedStage();
          identity = stableScopedIdentity(scratch, stat);
          if ((await scopedPathIdentity(scratch, options)) !== identity) unrecognizedStage();
          if (!(await existingDirectory(container, containerIdentity, options))) unrecognizedStage();
          await syncDirectory(container);
          await syncDirectory(path.dirname(container));
          if (!(await existingDirectory(workspace, workspaceIdentity, options))) unrecognizedStage();
          validate(options);
          await writeJson(
            stage.evidence,
            { identity, file: fileKey(relative), slot, container: containerIdentity },
            { maxBytes: SCRATCH_EVIDENCE_BYTES },
          );
        },
      );
      if (copied.value !== source.value) unrecognizedStage();
      const ready = await scopedTransactionImage(scratch, options);
      if (
        ready.kind !== "file" ||
        ready.value !== source.value ||
        scopedIdentity(ready.stat) !== identity ||
        (await scopedTransactionImage(destination, options)).kind !== "missing" ||
        !(await existingDirectory(workspace, workspaceIdentity, options)) ||
        !(await existingDirectory(container, containerIdentity, options))
      )
        unrecognizedStage();
      if ((await scopedPathIdentity(scratch, options)) !== identity) unrecognizedStage();
      validate(options);
      await fs.rename(scratch, destination);
      await syncDirectory(path.dirname(destination));
      await removeScratchContainer(container, containerIdentity, options);
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
  const identity = entry.recoveryWorkspace;
  if (!identity) unrecognizedStage();
  if (
    (stage.image.kind !== "missing" ||
      (stage.partial.kind !== "missing" && path.dirname(stage.scratch) === stage.workspace)) &&
    !(await existingDirectory(stage.workspace, identity, options, true))
  )
    unrecognizedStage();
  await clearScratch(stage, options);
  await removeScopedImage(stage.payload, stage.image, options);
  if (!(await existingDirectory(stage.workspace, identity, options))) unrecognizedStage();
  validate(options);
  await fs.rmdir(stage.workspace);
  await syncDirectory(path.dirname(stage.workspace));
}
