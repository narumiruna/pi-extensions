import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { EngineContext as ExtensionCommandContext, EngineContext as ExtensionContext } from "../host.js";
import { sessionDirFromContext } from "../snapshot/session-paths.js";
import { createSnapshot, sessionSnapshotPathFromAbsolute } from "../snapshot/snapshot.js";
import { encodeSnapshot } from "../snapshot/snapshot-codec.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import { syncDirectory } from "../state/json-file.js";
import { stateDir } from "../state/state-directory.js";
import { throwIfAborted } from "./signals.js";

export function protectedSessionPaths(
  ctx: ExtensionCommandContext | ExtensionContext,
  sessionRoot = sessionDirFromContext(ctx),
) {
  const sessions = [...(ctx.protectedSessionFiles ?? [])];
  const current = ctx.sessionManager.getSessionFile?.();
  if (current) sessions.push(current);
  return new Set(
    sessions.flatMap((file) => {
      const relative = sessionSnapshotPathFromAbsolute(file, sessionRoot);
      return relative ? [relative] : [];
    }),
  );
}

import { captureMutationOwner } from "./mutation-owner.js";

export { captureMutationOwner };

export async function maybeReload(
  ctx: ExtensionCommandContext | ExtensionContext,
  signal?: AbortSignal,
  validateMutation = captureMutationOwner(ctx, signal),
) {
  if (signal?.aborted || typeof ctx.reload !== "function") return;
  validateMutation();
  if (
    ctx.hasUI &&
    (await ctx.ui.confirm(
      "Reload Pi resources now?",
      "This reloads extensions, skills, prompts, themes, and context files.",
    ))
  ) {
    if (signal?.aborted) return;
    validateMutation();
    await ctx.reload();
  }
}

export async function backupLocal(profile: string, options: SnapshotOptions = {}, signal?: AbortSignal) {
  throwIfAborted(signal);
  return backupSnapshot(await createSnapshot(profile, { ...options, signal }), signal);
}

export async function backupSnapshot(snapshot: Snapshot, signal?: AbortSignal) {
  return (await writeSnapshotBackup(snapshot, signal)).backupPath;
}

export class LocalBackupVerificationError extends Error {}

export async function backupDirectionalSnapshot(snapshot: Snapshot, signal?: AbortSignal) {
  const { backupPath, encoded } = await writeSnapshotBackup(snapshot, signal, true);
  const validate = async () => {
    throwIfAborted(signal);
    try {
      if (
        stateDir() !== path.dirname(path.dirname(backupPath)) ||
        !(await fs.lstat(path.dirname(backupPath))).isDirectory()
      )
        throw new Error("Local backup directory changed before Pull.");
      const handle = await fs.open(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== encoded.length || !(await handle.readFile()).equals(encoded))
          throw new Error("Local backup no longer matches the exact pre-Pull bytes.");
      } finally {
        await handle.close();
      }
    } catch (error) {
      throwIfAborted(signal);
      throw new LocalBackupVerificationError(`Local backup could not be verified at ${backupPath}.`, { cause: error });
    }
    throwIfAborted(signal);
  };
  await validate();
  return { backupPath, validate };
}

async function writeSnapshotBackup(snapshot: Snapshot, signal?: AbortSignal, durableParent = false) {
  throwIfAborted(signal);
  const root = stateDir();
  const backupDirectory = path.join(root, "backups");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if (durableParent && !(await fs.lstat(backupDirectory)).isDirectory())
    throw new Error("Refusing to write to a linked local backup directory.");
  throwIfAborted(signal);
  const backupPath = path.join(backupDirectory, `${snapshot.id}.json.gz`);
  const encoded = await encodeSnapshot(snapshot);
  throwIfAborted(signal);
  const handle = await fs.open(backupPath, "wx", 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(backupDirectory);
  if (durableParent) {
    await syncDirectory(root);
    await syncDirectory(path.dirname(root));
  }
  return { backupPath, encoded };
}
