import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { syncStateFingerprint } from "../state/sync-state-store.js";
import { conflictArtifactFingerprint, readConflictArtifact } from "./conflict-artifacts.js";
import { type FileMergePlan, mergePathIdentity, planFileMerge } from "./file-merge-planner.js";
import { fileHashMap } from "./sync-state.js";
export interface ConflictResolution {
  token: string;
  group: number;
  source: "local" | "remote";
  stateIdentity: string;
  artifactIdentity: string;
}
export async function resolveReviewedGroup(
  config: AnySyncConfig,
  backend: SyncBackend,
  state: SyncState,
  local: Snapshot,
  remote: Snapshot,
  head: RemoteHead,
  plan: FileMergePlan,
  resolution: ConflictResolution,
  protectedPaths: ReadonlySet<string>,
): Promise<FileMergePlan> {
  const artifact = await readConflictArtifact(config, backend.identity, resolution.token);
  const group = artifact.groups[resolution.group];
  if (
    conflictArtifactFingerprint(artifact) !== resolution.artifactIdentity ||
    !group ||
    plan.kind !== "planned" ||
    !state.unresolved?.some(
      (item) => item.artifact === resolution.token && JSON.stringify(item.paths) === JSON.stringify(group.paths),
    ) ||
    syncStateFingerprint(state) !== resolution.stateIdentity ||
    state.lastObservedSnapshot !== head.snapshotId ||
    !state.lastObservedRevision ||
    !backend.sameRevision(state.lastObservedRevision, head.revision)
  )
    throw new Error("Conflict review is stale; refresh sync and review again.");
  const ours = fileHashMap(local);
  const theirs = fileHashMap(remote);
  const oldOurs = fileHashMap(artifact.local);
  const oldTheirs = fileHashMap(artifact.remote);
  if (
    group.paths.some(
      (filePath) =>
        ours[filePath] !== oldOurs[filePath] ||
        theirs[filePath] !== oldTheirs[filePath] ||
        state.lastFileHashes[filePath] !== artifact.state.lastFileHashes[filePath],
    )
  )
    throw new Error("Conflict versions changed; no resolution was applied.");
  if (
    group.paths.some((filePath) =>
      [...protectedPaths].some((value) => mergePathIdentity(value) === mergePathIdentity(filePath)),
    )
  )
    throw new Error(
      "Current session conflict cannot be resolved from the loaded session; preserve evidence and close Pi.",
    );
  const selected = resolution.source === "local" ? local : remote;
  const paths = new Set(group.paths);
  for (const snapshot of [selected, local]) {
    const layout = planFileMerge({
      baseline: {},
      local: snapshot.files.filter((file) => paths.has(file.path)),
      remote: [],
      selectionCompatible: true,
    });
    if (layout.kind !== "planned" || layout.conflicts.length)
      throw new Error(
        "Selected/current local group still has path collisions; preserve evidence, repair the layout manually and refresh sync.",
      );
  }
  const selectedFiles = new Map(selected.files.map((file) => [file.path, file]));
  const decisions = plan.decisions.map((item) =>
    paths.has(item.path)
      ? {
          kind: "accepted" as const,
          path: item.path,
          source: resolution.source,
          file: selectedFiles.get(item.path),
        }
      : item,
  );
  return {
    kind: "planned",
    decisions,
    conflicts: decisions.filter((item): item is Extract<typeof item, { kind: "conflict" }> => item.kind === "conflict"),
  };
}
