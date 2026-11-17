import type { Snapshot } from "../snapshot/snapshot-types.js";
import { fileHashMap } from "../sync/sync-state.js";

export interface TransferChange {
  path: string;
  action: "Add" | "Update" | "Delete";
}

/** Compare effective before/after snapshots, not raw planner decisions. */
export function transferChanges(
  before: Snapshot | undefined,
  after: Snapshot,
  protectedPaths: ReadonlySet<string> = new Set(),
): TransferChange[] {
  const beforeMap = before ? fileHashMap(before) : {};
  const afterMap = fileHashMap(after);
  return [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])]
    .sort()
    .flatMap((filePath): TransferChange[] => {
      if (protectedPaths.has(filePath)) return [];
      if (!Object.hasOwn(beforeMap, filePath)) return [{ path: filePath, action: "Add" }];
      if (!Object.hasOwn(afterMap, filePath)) return [{ path: filePath, action: "Delete" }];
      return beforeMap[filePath] !== afterMap[filePath] ? [{ path: filePath, action: "Update" }] : [];
    });
}

export function transferCounts(changes: readonly TransferChange[]) {
  return {
    add: changes.filter((change) => change.action === "Add").length,
    update: changes.filter((change) => change.action === "Update").length,
    remove: changes.filter((change) => change.action === "Delete").length,
  };
}
