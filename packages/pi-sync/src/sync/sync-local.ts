import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionDirFromContext } from "../snapshot/session-paths.js";
import { createSnapshot, sessionSnapshotPathFromAbsolute } from "../snapshot/snapshot.js";
import { encodeSnapshot } from "../snapshot/snapshot-codec.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { syncDirectory } from "../state/json-file.js";
import { stateDir } from "../state/state-directory.js";
import { throwIfAborted } from "./signals.js";

export function protectedSessionPaths(
  ctx: ExtensionCommandContext | ExtensionContext,
  sessionRoot = sessionDirFromContext(ctx),
) {
  const getSessionFile = ctx.sessionManager.getSessionFile;
  if (typeof getSessionFile !== "function") return new Set<string>();
  const sessionFile = getSessionFile.call(ctx.sessionManager) as string | undefined;
  const snapshotPath = sessionFile ? sessionSnapshotPathFromAbsolute(sessionFile, sessionRoot) : undefined;
  return snapshotPath ? new Set([snapshotPath]) : new Set<string>();
}

export { captureMutationOwner } from "./mutation-owner.js";

export async function backupLocal(profile: string, options: SnapshotOptions = {}, signal?: AbortSignal) {
  throwIfAborted(signal);
  const snapshot = await createSnapshot(profile, { ...options, signal });
  throwIfAborted(signal);
  const backupDirectory = path.join(stateDir(), "backups");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
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
  return backupPath;
}
