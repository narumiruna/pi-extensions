import assert from "node:assert/strict";
import { test } from "vitest";
import { compileSyncExclude, normalizeSyncExclude, sameSyncExclude } from "../src/sync/exclude-policy.js";
import {
  inspectRemoteSelection,
  portableSnapshotSelection,
  selectionForSnapshot,
  validateSnapshotSelection,
} from "../src/sync/sync-policy.js";
import { snapshot } from "./data-fixtures.js";

for (const [rule, relative, expected] of [
  ["skills/private", "skills/private", true],
  ["skills/private", "skills/private/nested/a.md", true],
  ["skills/private", "skills/private-copy/a.md", false],
  ["skills/private", "other/skills/private/a.md", false],
  ["skills/*.md", "skills/a.md", true],
  ["skills/*.md", "skills/nested/a.md", false],
  ["skills/*.md", "skills/.hidden.md", true],
  ["extensions/**/*.test.ts", "extensions/a.test.ts", true],
  ["extensions/**/*.test.ts", "extensions/a/b.test.ts", true],
  ["extensions/**/*.test.ts", "extensions/a/b.ts", false],
  ["**/cache", "cache/file", true],
  ["**/cache", "skills/.hidden/cache/file", true],
  ["*.toml", "custom.toml", true],
  ["*.toml", "nested/custom.toml", false],
  ["skills/a?.md", "skills/ab.md", true],
  ["skills/a?.md", "skills/abc.md", false],
  ["sessions/**/scratch-*.jsonl", "sessions/project/scratch-a.jsonl", true],
  ["SKILLS/Private", "skills/private/A.md", true],
  ["**", "skills/a.md", true],
  ["sessions/**", "sessions", true],
  ["skills/**/**", "skills", true],
  ["skills/**/private/**", "skills/private", true],
] as const)
  test(`exclude ${rule} matches ${relative}: ${expected}`, () => {
    assert.equal(compileSyncExclude([rule])(relative), expected);
  });

for (const value of [
  null,
  true,
  {},
  "skills",
  [1],
  [""],
  [" "],
  ["../x"],
  ["skills/../x"],
  ["/skills"],
  ["C:/x"],
  ["c:relative"],
  ["\\\\server\\x"],
  ["skills\\x"],
  ["skills//x"],
  ["skills/"],
  ["./skills"],
  ["skills/./x"],
  ["!skills"],
  ["#skills"],
  ["skills/[ab]"],
  ["skills/{a,b}"],
  ["skills/+(a)"],
  ["skills/a**b"],
  ["skills/***"],
  ["skills/\u001b[0m"],
  ["skills/\u009b"],
  ["skills", "SKILLS"],
]) {
  test(`invalid exclude input ${JSON.stringify(value)}`, () => assert.throws(() => normalizeSyncExclude(value)));
}

test("exclude rules are bounded by item and UTF-8 byte counts", () => {
  assert.throws(() => normalizeSyncExclude(Array.from({ length: 1025 }, (_, i) => `p${i}`)), /rules/);
  assert.throws(() => normalizeSyncExclude(["é".repeat(2049)]), /byte/);
  assert.throws(() => normalizeSyncExclude(Array.from({ length: 1024 }, (_, i) => `${i}-${"a".repeat(260)}`)), /byte/);
  assert.equal(normalizeSyncExclude(["a".repeat(4096)])[0]?.length, 4096);
});

test("overlap, missing paths, case and ordering do not expand scope", () => {
  assert.deepEqual(normalizeSyncExclude(undefined), []);
  assert.equal(sameSyncExclude(undefined, []), true);
  assert.equal(sameSyncExclude(["SKILLS/private", "future"], ["future", "skills/private"]), true);
  assert.equal(compileSyncExclude(["skills", "skills/private"])("skills/new/file.md"), true);
});

test("portable policy v1 remains unchanged; v2 requires exact keys and the outer version boundary", () => {
  assert.deepEqual(selectionForSnapshot(["skills"]), { version: 1, include: ["skills"] });
  const selection = selectionForSnapshot(["skills"], ["skills/private"]);
  assert.deepEqual(portableSnapshotSelection(selection), selection);
  validateSnapshotSelection({ version: 4, selection });
  for (const value of [
    { version: 2, include: ["skills"] },
    { version: 2, include: ["skills"], exclude: null },
    { version: 2, include: ["skills"], exclude: [], extra: true },
    { version: 1, include: ["skills"], exclude: [] },
    { version: 3, include: ["skills"], exclude: [] },
  ])
    assert.throws(() => portableSnapshotSelection(value));
  assert.throws(() => validateSnapshotSelection({ version: 1, selection }));
  assert.throws(() => validateSnapshotSelection({ version: 4, selection: selectionForSnapshot(["skills"]) }));
  assert.equal(inspectRemoteSelection(["skills"], { ...snapshot([]), selection }, ["skills/private"]).kind, "same");
  assert.equal(inspectRemoteSelection(["skills"], { ...snapshot([]), selection }).kind, "different");
});
