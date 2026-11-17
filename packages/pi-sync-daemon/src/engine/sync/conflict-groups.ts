import type { AnySyncConfig } from "../settings/settings-types.js";
import { type FileMergePlan, mergePathIdentity } from "./file-merge-planner.js";

/** Indexed connected closure; path relationships are identical to the conservative merge policy. */
export function conflictGroups(plan: Extract<FileMergePlan, { kind: "planned" }>, config: AnySyncConfig) {
  const paths = plan.decisions.map((item) => item.path);
  const parents = paths.map((_, index) => index);
  const ranks = paths.map(() => 0);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index] ?? index] ?? index;
      index = parents[index] ?? index;
    }
    return index;
  };
  const join = (left: number, right: number) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return;
    if ((ranks[a] ?? 0) < (ranks[b] ?? 0)) [a, b] = [b, a];
    parents[b] = a;
    if (ranks[a] === ranks[b]) ranks[a] = (ranks[a] ?? 0) + 1;
  };
  const identities = paths.map(mergePathIdentity);
  const byIdentity = new Map<string, number>();
  const byPath = new Map(paths.map((value, index) => [value, index]));
  identities.forEach((value, index) => {
    const previous = byIdentity.get(value);
    if (previous !== undefined) join(index, previous);
    else byIdentity.set(value, index);
  });
  const includes = new Set(
    config.include
      .filter((value) => !["settings.json", "AGENTS.md", "sessions"].includes(value))
      .map(mergePathIdentity),
  );
  const buckets = new Map<string, number>();
  const bucket = (key: string, index: number) => {
    const previous = buckets.get(key);
    if (previous === undefined) buckets.set(key, index);
    else join(index, previous);
  };
  paths.forEach((value, index) => {
    const root = value.split("/")[0] ?? "";
    if (["extensions", "themes", "skills", "prompts"].includes(root)) bucket(`resource:${root}`, index);
    const segments = (identities[index] ?? "").split("/");
    let ancestor = "";
    for (let length = 0; length < segments.length - 1; length++) {
      ancestor = ancestor ? `${ancestor}/${segments[length]}` : (segments[length] ?? "");
      const parent = byIdentity.get(ancestor);
      if (parent !== undefined) join(index, parent);
      if (includes.has(ancestor)) bucket(`include:${ancestor}`, index);
    }
  });
  const groups = new Map<number, { paths: string[]; reasons: string[] }>();
  for (const conflict of plan.conflicts) {
    const index = byPath.get(conflict.path);
    if (index === undefined) throw new Error("Conflict is missing from managed decisions.");
    const key = find(index);
    const group = groups.get(key) ?? { paths: [], reasons: [] };
    if (!group.reasons.includes(conflict.reason)) group.reasons.push(conflict.reason);
    groups.set(key, group);
  }
  paths.forEach((value, index) => {
    groups.get(find(index))?.paths.push(value);
  });
  return [...groups.values()].map((group) => ({ ...group, paths: group.paths.sort() }));
}
