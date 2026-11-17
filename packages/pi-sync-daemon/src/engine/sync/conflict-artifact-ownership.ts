import fs from "node:fs/promises";
import path from "node:path";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { syncDirectory } from "../state/json-file.js";
import { readStateForConfig, statePathForConfig } from "../state/sync-state-store.js";
import {
  type ConflictArtifact,
  type CreatedConflictArtifact,
  conflictArtifactFingerprint,
  conflictDirectory,
} from "./conflict-artifacts.js";
import { readMergeJournal } from "./merge-journal.js";

/** Attempt-owned cleanup only: unknown evidence remains the retention policy's responsibility. */
export async function releaseConflictArtifacts(
  config: AnySyncConfig,
  statePath: string,
  created: readonly CreatedConflictArtifact[],
) {
  if (!created.length || statePathForConfig(config) !== statePath) return;
  try {
    const state = await readStateForConfig(config);
    if (statePathForConfig(config) !== statePath) return;
    const journal = await readMergeJournal(config);
    if (statePathForConfig(config) !== statePath) return;
    const referenced = new Set([
      ...(state.unresolved ?? []).map((group) => group.artifact),
      ...(journal?.progress?.groups ?? []).map((group) => group.artifact),
    ]);
    for (const lease of created) {
      if (referenced.has(lease.token) || lease.target !== path.join(conflictDirectory(config), `${lease.token}.json`))
        continue;
      try {
        const stat = await fs.lstat(lease.target);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.dev !== lease.dev ||
          stat.ino !== lease.ino ||
          stat.size !== lease.size
        )
          continue;
        const artifact = JSON.parse(await fs.readFile(lease.target, "utf8")) as ConflictArtifact;
        if (conflictArtifactFingerprint(artifact) !== lease.fingerprint || statePathForConfig(config) !== statePath)
          continue;
        const latest = await fs.lstat(lease.target);
        if (
          latest.dev !== lease.dev ||
          latest.ino !== lease.ino ||
          latest.nlink !== 1 ||
          statePathForConfig(config) !== statePath
        )
          continue;
        await fs.unlink(lease.target);
        await syncDirectory(path.dirname(lease.target));
      } catch {
        /* Missing, replaced or unreadable evidence is not ours to delete. */
      }
    }
  } catch {
    /* Invalid state/journal or unavailable storage cannot prove lack of references. */
  }
}
