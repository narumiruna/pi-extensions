import { createHash } from "node:crypto";
import path from "node:path";
import { isPathInside } from "../paths.js";
import type { SnapshotApplyPlan } from "./snapshot-types.js";

export function fileImage(content: Buffer) {
  return `file:${createHash("sha256").update(content).digest("hex")}`;
}

/** Work follows path depth and emitted evidence, not every target/write pair. */
export function indexTransactionPlan(plan: SnapshotApplyPlan, targets: readonly string[]) {
  const targetIndex = indexTargets(targets);
  const writeImages = new Map<string, string>();
  const postFiles = new Map(targets.map((target) => [target, [] as { relative: string; image: string }[]]));
  for (const write of plan.writes) {
    const image = fileImage(write.content);
    // Preserve the first exact write and the original descendant order, including duplicates.
    if (!writeImages.has(write.target)) writeImages.set(write.target, image);
    for (const ancestor of ancestorTargets(write.target, targetIndex, false)) {
      if (ancestor !== write.target && isStrictDescendant(ancestor, write.target)) {
        postFiles.get(ancestor)?.push({ relative: path.relative(ancestor, write.target), image });
      }
    }
  }
  const deleteIndex = indexTargets(plan.deletes);
  const deletes = plan.deletes.filter((target) => {
    for (const ancestor of ancestorTargets(target, deleteIndex, false)) {
      if (ancestor !== target && isStrictDescendant(ancestor, target)) return false;
    }
    return true;
  });
  const deletedWrites = new Set<string>();
  const outerDeleteIndex = indexTargets(deletes);
  for (const write of plan.writes) {
    for (const ancestor of ancestorTargets(write.target, outerDeleteIndex)) {
      if (ancestor === write.target || isPathInside(ancestor, write.target)) {
        deletedWrites.add(write.target);
        break;
      }
    }
  }
  return { writeImages, postFiles, deletes, deletedWrites };
}

function isStrictDescendant(parent: string, target: string) {
  return path.relative(path.resolve(parent), path.resolve(target)) !== "" && isPathInside(parent, target);
}

function pathKey(target: string) {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function indexTargets(targets: readonly string[]) {
  const index = new Map<string, string[]>();
  for (const target of new Set(targets)) {
    const key = pathKey(target);
    const rows = index.get(key) ?? [];
    rows.push(target);
    index.set(key, rows);
  }
  return index;
}

function* ancestorTargets(target: string, index: Map<string, string[]>, includeSelf = true) {
  const resolved = path.resolve(target);
  // Strict-descendant queries skip the same-address bucket, including native case aliases.
  for (let ancestor = includeSelf ? resolved : path.dirname(resolved); ; ancestor = path.dirname(ancestor)) {
    yield* index.get(pathKey(ancestor)) ?? [];
    if (path.dirname(ancestor) === ancestor) return;
  }
}
