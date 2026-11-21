import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot/snapshot-codec.js";
import {
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  inspectRemoteSelection,
  normalizeDirectoryRules,
  selectionForSnapshot,
  syncSessionsSelected,
} from "../src/sync/sync-policy.js";
import { snapshot } from "./helpers.js";

const directory = {
  scope: "agent-directory",
  include: [],
  exclude: ["sessions/", "bin", "npm", "skills/private"],
} as const;

test("agent-directory rules restore descendants without exposing siblings or protected files", () => {
  const policy = {
    ...directory,
    reinclude: ["skills/private/**/shared.md", "AUTH.JSON", "trust.json.lock", "sessions/**"],
  };
  const selected = configuredSnapshotPathMatcher(policy);
  const descends = compileSyncPolicyTraversal(policy);
  assert.equal(descends("skills/private"), true);
  assert.equal(descends("skills/private/nested"), true);
  assert.equal(descends("bin"), false);
  for (const file of ["custom.toml", "skills/private/shared.md", "skills/private/nested/shared.md"]) {
    assert.equal(selected(file), true, file);
  }
  for (const file of [
    "auth.json",
    "AUTH.JSON.LOCK",
    "trust.json",
    "trust.json.lock",
    "settings.json.lock",
    "models-store.json",
    "crashes.json",
    "pi-debug.log",
    "pi-sync/private",
    "skills/private/other.md",
    "sessions/project/session.jsonl",
    "../escape",
    "bin/tool",
  ]) {
    assert.equal(selected(file), false, file);
  }
  assert.equal(syncSessionsSelected(policy), false);
  assert.equal(syncSessionsSelected({ ...policy, include: ["sessions"] }), true);
});

test("agent-directory rule identity ignores order, case and optional directory slash", () => {
  const selection = selectionForSnapshot([], ["Skills/Private", "sessions/"], { ...directory, reinclude: ["Z", "a/"] });
  const scope = { scope: directory.scope, reinclude: ["A", "z"] };
  const remote = { selection, files: [] };
  assert.equal(inspectRemoteSelection([], remote, ["SESSIONS", "skills/private"], scope).kind, "same");
  assert.equal(
    inspectRemoteSelection([], remote, ["SESSIONS", "skills/private"], { ...scope, reinclude: ["a"] }).kind,
    "different",
  );
  assert.equal(inspectRemoteSelection([], remote, ["SESSIONS", "skills/private"]).kind, "different");
  assert.equal(inspectRemoteSelection([], { files: [] }, [], scope).kind, "different");
  assert.deepEqual(normalizeDirectoryRules(["npm/", "bin", "sessions/"]), ["bin", "npm", "sessions"]);
  for (const rule of ["/", "skills//", "../", "skills/\n"]) assert.throws(() => normalizeDirectoryRules([rule]));
});

test("snapshot v5 requires directory metadata and rejects local-only content even under broad reinclude", async () => {
  const selection = selectionForSnapshot([], [], { ...directory, reinclude: ["**"] });
  const good = { ...snapshot([{ path: "notes.md", content: Buffer.from("portable") }]), version: 5, selection };
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(good)), good);
  for (const file of ["auth.json", "auth.json.", "trust.json", "SETTINGS.JSON", "sessions/private.jsonl"]) {
    const bad = { ...good, files: snapshot([{ path: file, content: Buffer.from("private") }]).files };
    await assert.rejects(encodeSnapshot(bad), /excluded or unsafe agent-directory paths/);
    await assert.rejects(decodeSnapshot(gzipSync(JSON.stringify(bad))), /excluded or unsafe agent-directory paths/);
  }
  await assert.rejects(encodeSnapshot({ ...good, version: 4 }), /policy requires snapshot version/);
  await assert.rejects(encodeSnapshot({ ...good, selection: undefined }), /policy requires snapshot version/);
  for (const paths of [
    ["Notes/A.md", "notes/B.md"],
    ["file", "file/child"],
    ["é.md", "e\u0301.md"],
  ]) {
    const files = snapshot(paths.map((path) => ({ path, content: Buffer.from("fixture") }))).files;
    await assert.rejects(encodeSnapshot({ ...good, files }), /conflicting portable paths/);
  }
});
