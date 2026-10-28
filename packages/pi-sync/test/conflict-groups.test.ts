import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, vi } from "vitest";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import { conflictGroups } from "../src/sync/conflict-groups.js";
import { type FileMergePlan, mergePathIdentity } from "../src/sync/file-merge-planner.js";

const config = (include: string[]) => ({ include }) as AnySyncConfig;
const plan = (paths: string[], conflicts: Set<string>): Extract<FileMergePlan, { kind: "planned" }> => {
  const decisions = paths.map((path) =>
    conflicts.has(path)
      ? { kind: "conflict" as const, path, reason: "both-changed" as const }
      : { kind: "accepted" as const, path, source: "equal" as const, file: undefined },
  );
  return {
    kind: "planned",
    decisions,
    conflicts: decisions.filter((item): item is Extract<typeof item, { kind: "conflict" }> => item.kind === "conflict"),
  };
};
/** Independent reference for the previous conservative connected-closure policy. */
function reference(input: ReturnType<typeof plan>, include: string[]) {
  const related = (left: string, right: string) => {
    const a = mergePathIdentity(left);
    const b = mergePathIdentity(right);
    if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    const root = left.split("/")[0];
    return (
      (["extensions", "themes", "skills", "prompts"].includes(root ?? "") && right.split("/")[0] === root) ||
      include.some(
        (value) =>
          !["settings.json", "AGENTS.md", "sessions"].includes(value) &&
          a.startsWith(`${mergePathIdentity(value)}/`) &&
          b.startsWith(`${mergePathIdentity(value)}/`),
      )
    );
  };
  const groups: { paths: string[]; reasons: string[] }[] = [];
  for (const conflict of input.conflicts) {
    if (groups.some((group) => group.paths.includes(conflict.path))) continue;
    const members = new Set([conflict.path]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of input.decisions.map((item) => item.path))
        if (!members.has(candidate) && [...members].some((member) => related(member, candidate))) {
          members.add(candidate);
          changed = true;
        }
    }
    groups.push({
      paths: [...members].sort(),
      reasons: [...new Set(input.conflicts.filter((item) => members.has(item.path)).map((item) => item.reason))],
    });
  }
  return groups;
}
const paths = [
  "sessions/a.jsonl",
  "sessions/b.jsonl",
  "prompts/a.md",
  "prompts/b.md",
  "PROMPTS/a.md",
  "custom/a",
  "custom/a/one.md",
  "custom/a/two.md",
  "custom/b.md",
  "x/é.md",
  "x/é.md",
  "x/a",
  "x/a/deep/b.md",
  "AGENTS.md",
  "settings.json",
];
for (const include of [[], ["sessions"], ["custom"], ["custom/a"], ["CUSTOM/a", "prompts"], ["x/a", "custom"]])
  test(`indexed closure preserves case/Unicode/ancestor/resource/include semantics: ${include.join(",")}`, () => {
    for (let seed = 1; seed <= 16; seed++) {
      const conflicts = new Set(paths.filter((_, index) => (seed + index * 7) % 5 < 2));
      const input = plan(paths, conflicts);
      assert.deepEqual(conflictGroups(input, config(include)), reference(input, include));
    }
  });

for (const count of [16, 32])
  test(`small independent groups have linear normalization cost: ${count}`, () => {
    const values = Array.from({ length: count }, (_, index) => `sessions/${index}.jsonl`);
    const input = plan(values, new Set(values));
    const normalize = vi.spyOn(Buffer, "from");
    let calls: number;
    try {
      conflictGroups(input, config(["sessions"]));
      calls = normalize.mock.calls.length;
    } finally {
      normalize.mockRestore();
    }
    assert.equal(calls, count);
  });

test("16,384 independent session conflicts use one normalization per path, not pairwise rescans", () => {
  const values = Array.from({ length: 16_384 }, (_, index) => `sessions/${index}.jsonl`);
  const input = plan(values, new Set(values));
  const normalize = vi.spyOn(Buffer, "from");
  const started = performance.now();
  let result: ReturnType<typeof conflictGroups>;
  let calls: number;
  try {
    result = conflictGroups(input, config(["sessions"]));
    calls = normalize.mock.calls.length;
  } finally {
    normalize.mockRestore();
  }
  console.log(`Indexed conflict grouping: 16,384 paths in ${(performance.now() - started).toFixed(1)} ms`);
  assert.equal(result.length, values.length);
  assert.equal(calls, values.length);
  assert.deepEqual(result[0]?.paths, [values[0]]);
  assert.deepEqual(result.at(-1)?.paths, [values.at(-1)]);
});
