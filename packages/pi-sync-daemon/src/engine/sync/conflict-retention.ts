import fs from "node:fs/promises";
import path from "node:path";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { syncDirectory } from "../state/json-file.js";
import type { SyncState } from "../state/state-types.js";
import { conflictDirectory, readConflictArtifact } from "./conflict-artifacts.js";
import { fileHashMap } from "./sync-state.js";
/** Only after accepted state and journal retirement, under the operation lock. Unknown/unresolved evidence is never pruned. */
export async function pruneCompletedConflicts(
  config: AnySyncConfig,
  backend: string,
  state: SyncState,
  local: Snapshot,
  remote: Snapshot,
  validate: () => void,
) {
  validate();
  const directory = conflictDirectory(config);
  let names: string[];
  try {
    const stat = await fs.lstat(directory);
    validate();
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe conflict retention directory.");
    names = await fs.readdir(directory);
    validate();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const pinned = new Set(state.unresolved?.map((group) => group.artifact) ?? []);
  const ours = fileHashMap(local);
  const theirs = fileHashMap(remote);
  const completed: { token: string; modified: number }[] = [];
  for (const name of names) {
    validate();
    const token = name.replace(/\.json$/u, "");
    if (!/^[a-f0-9-]{36}\.json$/u.test(name) || pinned.has(token)) continue;
    try {
      const artifact = await readConflictArtifact(config, backend, token);
      validate();
      const originalLocal = fileHashMap(artifact.local);
      const originalRemote = fileHashMap(artifact.remote);
      if (
        !artifact.groups.every((group) =>
          group.paths.every(
            (filePath) =>
              state.lastFileHashes[filePath] === ours[filePath] &&
              ours[filePath] === theirs[filePath] &&
              (ours[filePath] === originalLocal[filePath] || ours[filePath] === originalRemote[filePath]),
          ),
        )
      )
        continue;
      const stat = await fs.lstat(path.join(directory, name));
      validate();
      if (stat.isFile()) completed.push({ token, modified: stat.mtimeMs });
    } catch {
      validate(); /* Corrupt/unknown evidence remains. */
    }
  }
  completed.sort((left, right) => right.modified - left.modified || left.token.localeCompare(right.token));
  for (const entry of completed.slice(32)) {
    validate();
    await fs.rm(path.join(directory, `${entry.token}.json`));
    validate();
  }
  if (completed.length > 32) {
    await syncDirectory(directory);
    validate();
  }
}
