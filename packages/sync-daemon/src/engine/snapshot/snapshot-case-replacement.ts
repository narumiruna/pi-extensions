import fs from "node:fs/promises";
import path from "node:path";
import type { SnapshotApplyPlan } from "./snapshot-types.js";

/** Only the top-level file correction produced by addTopLevelCaseVariantDeletes is eligible. */
export function isCaseReplacement(root: string, before: string, after: string) {
  return (
    before !== after &&
    path.dirname(before) === root &&
    path.dirname(after) === root &&
    path.basename(before).toLowerCase() === path.basename(after).toLowerCase()
  );
}

/** Absence is handled by the journal's removal/replacement evidence, never by naming evidence. */
export async function caseReplacementSpelling(before: string, after: string): Promise<string | undefined> {
  const observations = await Promise.all(
    [before, after].map(async (target) => {
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe case replacement target.");
        return await fs.realpath(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }),
  );
  if (observations.every((value) => value === undefined)) return undefined;
  if (!observations[0] || observations[0] !== observations[1])
    throw new Error("Case replacement no longer identifies one physical file; preserve evidence for review.");
  const names = (await fs.readdir(path.dirname(before))).filter(
    (name) => name.toLowerCase() === path.basename(before).toLowerCase(),
  );
  if (names.length !== 1 || (names[0] !== path.basename(before) && names[0] !== path.basename(after)))
    throw new Error("Case replacement spelling changed; preserve evidence for review.");
  return path.join(path.dirname(before), names[0]);
}

export async function coalesceCaseReplacements(root: string, plan: SnapshotApplyPlan) {
  const replacements = new Map<string, string>();
  const deletesByCase = new Map<string, string[]>();
  const writeTargets = new Set(plan.writes.map((item) => item.target));
  for (const target of new Set(plan.deletes)) {
    if (path.dirname(target) !== root || writeTargets.has(target)) continue;
    const key = path.basename(target).toLowerCase();
    const group = deletesByCase.get(key) ?? [];
    group.push(target);
    deletesByCase.set(key, group);
  }
  for (const item of plan.writes) {
    if (path.dirname(item.target) !== root) continue;
    const candidates = deletesByCase.get(path.basename(item.target).toLowerCase()) ?? [];
    if (candidates.length !== 1) continue;
    const before = candidates[0];
    if (!before || !isCaseReplacement(root, before, item.target)) continue;
    // Different real paths on a case-sensitive filesystem remain independent targets.
    let beforePath: string;
    let afterPath: string;
    try {
      [beforePath, afterPath] = await Promise.all([fs.realpath(before), fs.realpath(item.target)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (beforePath !== afterPath) continue;
    if (replacements.has(before)) throw new Error("Multiple writes alias a case replacement target.");
    if ((await caseReplacementSpelling(before, item.target)) !== before)
      throw new Error("Case replacement preimage spelling changed; review is required.");
    replacements.set(before, item.target);
  }
  const beforeByAfter = new Map([...replacements].map(([before, after]) => [after, before]));
  return {
    replacements,
    plan: {
      deletes: plan.deletes,
      writes: plan.writes.map((item) => ({ ...item, target: beforeByAfter.get(item.target) ?? item.target })),
    },
  };
}
