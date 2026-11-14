import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import {
  collectFiles,
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
} from "../src/snapshot/snapshot.js";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot/snapshot-codec.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { ignoreFromLegacyIncludes, normalizeSyncIgnore, syncIgnoreAllows } from "../src/sync/sync-ignore.js";
import { inspectRemoteSelection, portableSnapshotSelection } from "../src/sync/sync-policy.js";
import { snapshot, withTempHome } from "./helpers.js";

for (const [rules, name, allowed, directory] of [
  ["*.log\n", "nested/run.log", false, false],
  ["/cache/\n", "cache/data", false, false],
  ["/cache/\n", "nested/cache/data", true, false],
  ["**/cache/\n", "nested/cache/data", false, false],
  ["*.md\n!important.md\n", "important.md", true, false],
  ["private/\n!private/keep.md\n", "private/keep.md", false, false],
  ["private/*\n!private/keep.md\n", "private/keep.md", true, false],
  ["# comment\r\n\\#literal\r\n", "#literal", false, false],
  ["\\!literal\n", "!literal", false, false],
  ["space\\ \n", "space ", false, false],
  ["EXACT\n", "exact", true, false],
  ["folder/\n", "folder", false, true],
  ["folder/\n", "folder", true, false],
  ["*\n", ".syncignore", true, false],
  ["!auth.json\n", "auth.json", false, false],
  ["!pi-sync.json\n", "pi-sync.json", false, false],
  ["!pi-sync/**\n", "pi-sync/state.json", false, false],
  ["", "node_modules/pkg/index.js", false, false],
  ["", "../escape", false, false],
  ["", "nested\\escape", false, false],
] as const)
  test(`ignore rules ${JSON.stringify(rules)} match ${name} directory=${directory}`, () => {
    assert.equal(syncIgnoreAllows(rules, name, directory), allowed);
  });

test("ignore policy validation rejects unsupported fields, oversized text, and non-text values", () => {
  for (const value of [null, [], 123, "x\0", "x".repeat(256 * 1_024 + 1)])
    assert.throws(() => normalizeSyncIgnore(value));
  for (const value of [{ version: 2 }, { version: 2, ignore: "", include: [] }, { version: 3, ignore: "" }])
    assert.throws(() => portableSnapshotSelection(value));
});

test("legacy migration escapes literal paths, restores parents, and preserves only common scope", () => {
  const rules = ignoreFromLegacyIncludes([
    ["skills", "custom/[x]/file?.md", "AGENTS.md"],
    ["skills", "custom/[x]/file?.md", "settings.json"],
  ]);
  for (const name of ["skills/new/SKILL.md", "custom/[x]/file?.md"]) assert.ok(syncIgnoreAllows(rules, name));
  for (const name of ["AGENTS.md", "settings.json", "new.json", "custom/unselected", "custom/[x]/other.md"])
    assert.equal(syncIgnoreAllows(rules, name), false, name);
});

test("collection discovers arbitrary future paths, preserves literal bytes, prunes ignored directories and skips symlinks", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(path.join(root, "custom/deep"), { recursive: true });
    await fs.mkdir(path.join(root, "excluded"));
    await fs.writeFile(path.join(root, "custom/deep/new.toml"), "future = true\n");
    await fs.writeFile(path.join(root, "excluded/local.txt"), "private");
    await fs.writeFile(path.join(root, "auth.json"), "credential");
    await fs.symlink(path.join(root, "custom"), path.join(root, "linked"));
    const rules = "/excluded/\n/sessions/\n";
    const files = await collectFiles(root, { syncIgnore: rules });
    assert.deepEqual(
      files.map((file) => file.path),
      [".syncignore", "custom/deep/new.toml"],
    );
    assert.equal(Buffer.from(files[0]?.contentBase64 ?? "", "base64").toString(), rules);
  }));

test("snapshot policy carries exact rules and rejects inconsistent policy bytes and legacy formats", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const rules = "# comment\r\n/sessions/\r\n";
    await fs.writeFile(path.join(root, ".syncignore"), rules);
    const current = await createSnapshot("default", { syncIgnore: rules });
    assert.equal(current.version, 4);
    assert.deepEqual(current.selection, { version: 2, ignore: rules });
    assert.deepEqual(await decodeSnapshot(await encodeSnapshot(current)), current);
    for (const invalid of [
      { ...current, files: [] },
      { ...current, version: 1 },
      { ...current, selection: { version: 2, ignore: "" } },
    ])
      await assert.rejects(decodeSnapshot(gzipSync(JSON.stringify(invalid))), /policy|syncignore/i);
    await fs.writeFile(path.join(root, ".syncignore"), "changed\n");
    await assert.rejects(createSnapshot("default", { syncIgnore: rules }), /changed/i);
  }));

test("portable policy comparisons distinguish exact text, empty rules, and legacy include mode", () => {
  const remote = { ...snapshot([]), selection: { version: 2 as const, ignore: "" } };
  assert.equal(inspectRemoteSelection({ syncIgnore: "" }, remote).kind, "same");
  assert.equal(inspectRemoteSelection({ syncIgnore: "# comment\n" }, remote).kind, "different");
  assert.equal(inspectRemoteSelection([], remote).kind, "different");
  assert.equal(inspectRemoteSelection({ syncIgnore: "" }, snapshot([])).kind, "different");
});

test("ignored remote files are filtered from local apply but retained by publication preservation", () => {
  const remote: Snapshot = snapshot([{ path: "excluded/private.txt", content: Buffer.from("remote") }]);
  const local: Snapshot = snapshot([{ path: "new.toml", content: Buffer.from("local") }]);
  const config = { syncIgnore: "/excluded/\n" };
  assert.deepEqual(filterSnapshotForConfigPolicy(remote, config).files, []);
  assert.deepEqual(
    mergeRemotePreservedFiles(local, remote, config).files.map((file) => file.path),
    ["excluded/private.txt", "new.toml"],
  );
});
