import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import {
  compileSyncPolicyTraversal,
  MAX_AGENT_DIRECTORY_ENTRIES,
  MAX_AGENT_DIRECTORY_FILES,
  type SyncSelectionConfig,
} from "../sync/sync-policy.js";
import { type AgentDirectoryScanOptions, scanAgentDirectoryInventory } from "./snapshot.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "./snapshot-bounds.js";
import type { AgentDirectoryInventory, SnapshotApplyPlan } from "./snapshot-types.js";

export async function recheckAgentDirectoryBudget(
  root: string,
  plan: SnapshotApplyPlan,
  options: AgentDirectoryScanOptions,
  pendingStateEntry?: string,
) {
  const inventory = await scanAgentDirectoryInventory(root, options, pendingStateEntry);
  options.signal?.throwIfAborted();
  options.validateMutation?.();
  assertProjectedAgentDirectoryBudget(
    inventory,
    { deletes: plan.deletes, writes: plan.writes.map(({ target, content }) => ({ target, size: content.length })) },
    options,
  );
}

export function assertProjectedAgentDirectoryBudget(
  {
    root,
    sessionRoot,
    scanSessions,
    entries,
    fileSizes,
    routingDirectories,
    walkedDirectories,
  }: AgentDirectoryInventory,
  plan: Pick<SnapshotApplyPlan, "deletes"> & { writes: readonly { target: string; size?: number }[] },
  options: SyncSelectionConfig,
) {
  const removed = new Map(plan.deletes.map((target) => [target, true]));
  const isRemoved = (target: string): boolean => {
    const known = removed.get(target);
    if (known !== undefined) return known;
    const parent = path.dirname(target);
    const value = parent !== target && isRemoved(parent);
    removed.set(target, value);
    return value;
  };
  let count = 0;
  const files = new Map(
    plan.writes.flatMap(({ target, size }) => (size === undefined ? [] : [[target, size] as const])),
  );
  for (const target of entries.keys()) {
    if (!isRemoved(target)) {
      count++;
      const size = fileSizes.get(target);
      if (size !== undefined && !files.has(target)) files.set(target, size);
    }
  }
  if (files.size > MAX_AGENT_DIRECTORY_FILES) throw new Error("Projected agent directory exceeds the scan file bound.");
  let bytes = 0;
  for (const size of files.values()) bytes += size;
  if (bytes > MAX_AGENT_DIRECTORY_BYTES)
    throw new Error("Projected agent directory exceeds the 64 MiB scan byte bound.");

  const introduced = new Set<string>();
  for (const { target } of plan.writes) {
    const boundary = isPathInside(root, target) ? root : sessionRoot;
    for (let entry = target; entry !== boundary; entry = path.dirname(entry)) {
      if (introduced.has(entry) || (!isRemoved(entry) && (entries.has(entry) || routingDirectories.has(entry)))) break;
      introduced.add(entry);
    }
  }

  const canTraverse = compileSyncPolicyTraversal(options);
  const walked = new Map<string, boolean>([
    [root, true],
    [sessionRoot, scanSessions],
  ]);
  const willWalk = (directory: string): boolean => {
    const known = walked.get(directory);
    if (known !== undefined) return known;
    let value = false;
    if (!introduced.has(directory)) value = walkedDirectories.has(directory) && !isRemoved(directory);
    else if (isPathInside(sessionRoot, directory)) {
      value =
        canTraverse(`sessions/${toPosix(path.relative(sessionRoot, directory))}`) && willWalk(path.dirname(directory));
    } else if (isPathInside(root, directory)) {
      const relative = toPosix(path.relative(root, directory));
      value = !/^sessions(?:\/|$)/iu.test(relative) && canTraverse(relative) && willWalk(path.dirname(directory));
    }
    walked.set(directory, value);
    return value;
  };
  for (const target of introduced) {
    if (willWalk(path.dirname(target))) count++;
  }
  if (count > MAX_AGENT_DIRECTORY_ENTRIES) throw new Error("Projected agent directory exceeds the scan entry bound.");
}
