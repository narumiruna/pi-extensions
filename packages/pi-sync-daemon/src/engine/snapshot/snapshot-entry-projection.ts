import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import { compileSyncPolicyTraversal, MAX_AGENT_DIRECTORY_ENTRIES } from "../sync/sync-policy.js";
import type { AgentDirectoryInventory, SnapshotApplyPlan, SnapshotOptions } from "./snapshot-types.js";

/** Count the entries that the next scan actually visits, not just portable file prefixes. */
export function assertProjectedAgentDirectoryEntries(
  { root, sessionRoot, scanSessions, entries, routingDirectories, walkedDirectories }: AgentDirectoryInventory,
  plan: Pick<SnapshotApplyPlan, "deletes"> & { writes: readonly { target: string }[] },
  options: SnapshotOptions,
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
  for (const target of entries.keys()) {
    if (!isRemoved(target)) count++;
  }

  // A write can recreate a removed file as a directory and introduce its parents.
  // Ordinary ancestors of an in-tree session root may also be created by the write.
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
