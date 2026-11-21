import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { compileIgnoreRules, ignorePolicyFingerprint, readIgnoreSource } from "../src/engine/ignore/ignore-source.js";
import {
  agentDirectoryInventory,
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../src/engine/snapshot/snapshot.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "../src/engine/snapshot/snapshot-bounds.js";
import { decodeSnapshot, encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import { assertUnexcludedTargets } from "../src/engine/snapshot/snapshot-exclude-safety.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";

async function fixture(run: (root: string, sessionDir: string) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-snapshot-")));
  const root = path.join(base, "agent");
  try {
    await fs.mkdir(root);
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    await run(root, path.join(base, "external-sessions"));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function put(root: string, relative: string, text = relative) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

async function scope(root: string, sessions: boolean, filename?: string, reservedNames: readonly string[] = []) {
  const source = await readIgnoreSource(root, filename);
  return {
    scope: "agent-directory" as const,
    ignorePolicy: {
      filename: source.filename,
      sourceDigest: source.sourceDigest,
      fingerprint: ignorePolicyFingerprint(source.text, sessions),
      matches: compileIgnoreRules(source.text),
      sessions,
      reservedNames,
    },
  };
}

function paths(snapshot: Snapshot) {
  return snapshot.files.map(({ path }) => path).sort();
}

test.each([
  { content: undefined, sessions: true, expected: ["notes.md"], scanSessions: false },
  { content: "", sessions: false, expected: ["notes.md", "npm/index.js", "truth.json"], scanSessions: false },
  {
    content: "",
    sessions: true,
    expected: ["notes.md", "npm/index.js", "sessions/project/keep.jsonl", "truth.json"],
    scanSessions: true,
  },
  {
    content: "/sessions/project/keep.jsonl",
    sessions: true,
    expected: ["notes.md", "npm/index.js", "truth.json"],
    scanSessions: true,
  },
])("collection honors rules ($content) and session opt-in ($sessions)", (row) =>
  fixture(async (root, sessionDir) => {
    for (const file of ["auth.json", "trust.json", "truth.json", "npm/index.js", "notes.md", "sessions/local.jsonl"]) {
      await put(root, file);
    }
    await put(sessionDir, "project/keep.jsonl");
    await put(sessionDir, "project/ignore.txt");
    if (row.content !== undefined) await put(root, ".syncignore", row.content);
    const options = await scope(root, row.sessions);
    const snapshot = await createSnapshot("test", { ...options, sessionDir });
    assert.deepEqual(paths(snapshot), row.expected);
    assert.equal(agentDirectoryInventory(snapshot)?.scanSessions, row.scanSessions);
    const includesSessions = row.expected.includes("sessions/project/keep.jsonl");
    assert.equal(snapshot.syncSessions, includesSessions);
    assert.equal(snapshotIncludesSessions(snapshot), includesSessions);
    assert.equal(snapshot.version, 6);
    assert.deepEqual(snapshot.selection, {
      version: 4,
      scope: "agent-directory",
      sessions: row.sessions,
      fingerprint: options.ignorePolicy.fingerprint,
    });
    assert.deepEqual(await decodeSnapshot(await encodeSnapshot(snapshot)), snapshot);
    if (row.content === undefined) await assert.rejects(fs.stat(path.join(root, ".syncignore")), { code: "ENOENT" });
  }),
);

test("collection prunes directory rules and preserves typed inventory, privacy, and byte bounds", () =>
  fixture(async (root) => {
    const rules = [
      "/blocked/",
      "!/blocked/visible.md",
      "directory-only/",
      "/lower/",
      "/kept",
      "!/kept/",
      "/storage/",
      "/sessions/private/",
      "!.syncignore",
      "!work.rules",
      "!other.rules",
    ].join("\n");
    await put(root, "work.rules", rules);
    for (const file of [
      ".syncignore",
      "OTHER.RULES",
      "blocked/visible.md",
      "directory-only",
      "nested/directory-only/hidden.md",
      "Lower/visible.md",
      "kept/visible.md",
      "storage/visible.jsonl",
      "storage/private/hidden.jsonl",
    ]) {
      await put(root, file);
    }
    const ignored = await put(root, "blocked/oversized.md");
    await fs.truncate(ignored, MAX_AGENT_DIRECTORY_BYTES + 1);
    const options = {
      ...(await scope(root, true, "work.rules", ["other.rules"])),
      sessionDir: path.join(root, "storage"),
    };
    const snapshot = await createSnapshot("test", options);
    assert.deepEqual(paths(snapshot), [
      "Lower/visible.md",
      "directory-only",
      "kept/visible.md",
      "sessions/visible.jsonl",
    ]);
    const inventory = agentDirectoryInventory(snapshot);
    assert.equal(inventory?.entries.get(path.join(root, "kept")), "directory");
    assert.equal(inventory?.entries.get(path.join(root, "blocked")), "unreviewed");
    assert.equal(inventory?.entries.has(ignored), false);
    const serialized = JSON.stringify(await decodeSnapshot(await encodeSnapshot(snapshot)));
    for (const privateValue of [".syncignore", "work.rules", "OTHER.RULES", rules, options.ignorePolicy.sourceDigest]) {
      assert.ok(!serialized.includes(privateValue));
    }
    await fs.truncate(path.join(root, "directory-only"), MAX_AGENT_DIRECTORY_BYTES + 1);
    await assert.rejects(createSnapshot("test", options), /64 MiB scan byte bound/);
  }));

test("projection uses reviewed local rules, never a remote fingerprint as a matcher", () =>
  fixture(async (root) => {
    for (const file of [
      "notes.md",
      "omit.md",
      ".syncignore",
      "receiving.rules",
      "other.rules",
      "disk-sessions/x.jsonl",
    ]) {
      await put(root, file);
    }
    const sessionDir = path.join(root, "sessions");
    await put(sessionDir, "x.jsonl");
    const legacy = await createSnapshot("test", { scope: "agent-directory", include: ["sessions"] });
    assert.equal(legacy.version, 5);
    assert.ok(paths(legacy).includes(".syncignore"));
    await put(root, "sending.rules", "");
    const remote = await createSnapshot("test", { ...(await scope(root, true, "sending.rules")), sessionDir });
    assert.ok(paths(remote).includes("receiving.rules"));
    assert.ok(paths(remote).includes("sessions/x.jsonl"));
    await put(root, "receiving.rules", "/omit.md\n/sessions/\n");
    const local = await scope(root, true, "receiving.rules", ["other.rules", "sending.rules"]);
    const options = { regenerateId: true, sessionDir: path.join(root, "disk-sessions") };
    for (const source of [remote, legacy]) {
      const projected = filterSnapshotForConfigPolicy(source, local, options);
      assert.notEqual(projected.id, source.id);
      assert.deepEqual(paths(projected), ["notes.md"]);
      assert.equal(projected.syncSessions, false);
      assert.equal(snapshotIncludesSessions(projected), false);
      assert.equal(projected.version, 6);
      assert.deepEqual(projected.selection, {
        version: 4,
        scope: "agent-directory",
        sessions: true,
        fingerprint: local.ignorePolicy.fingerprint,
      });
      assert.deepEqual(filterSnapshotForConfigPolicy(projected, local, options), projected);
      assert.deepEqual(mergeRemotePreservedFiles(projected, remote, local, options), projected);
      assert.deepEqual(await decodeSnapshot(await encodeSnapshot(projected)), projected);
    }
    for (const withoutRules of [{}, { scope: "agent-directory" as const }]) {
      assert.throws(() => filterSnapshotForConfigPolicy(remote, withoutRules), /reviewed local ignore policy/);
      assert.throws(() => mergeRemotePreservedFiles(legacy, remote, withoutRules), /reviewed local ignore policy/);
    }
    assert.throws(() => snapshotWithoutSessions(remote), /reviewed local ignore policy/);
  }));

test("preflight distinguishes directories from files and protects ignored descendants at either root", () =>
  fixture(async (root, sessionDir) => {
    await put(root, ".syncignore", "type-only/\n/allowed\n!/allowed/\n/parent/hidden\n/sessions/project/cache/\n");
    const file = await put(root, "type-only");
    const allowed = await put(root, "allowed/content");
    const directoryChild = await put(root, "sub/type-only/content");
    const hidden = await put(root, "parent/hidden");
    const reservedChild = await put(root, "tree/rules/child");
    const session = await put(sessionDir, "project/keep.jsonl");
    const excludedSession = await put(sessionDir, "project/cache/excluded.jsonl");
    const options = { ...(await scope(root, true, undefined, ["tree"])), sessionDir };
    await assertUnexcludedTargets(
      root,
      [file, path.dirname(allowed), session, path.join(root, "new/type-only")],
      options,
    );
    for (const target of [path.dirname(hidden), path.dirname(path.dirname(excludedSession))]) {
      await assertUnexcludedTargets(root, [target], options, { recursive: false });
      await assert.rejects(assertUnexcludedTargets(root, [target], options), /excluded path or directory descendant/);
    }
    for (const target of [
      path.dirname(directoryChild),
      reservedChild,
      path.join(sessionDir, "project/cache/new.jsonl"),
    ]) {
      await assert.rejects(
        assertUnexcludedTargets(root, [target], options, { recursive: false }),
        /excluded path or directory descendant/,
      );
    }
    await assert.rejects(
      createSnapshot("test", { ...options, sessionDir: path.join(root, "tree/rules") }),
      /session storage overlaps protected agent files/,
    );
    assert.equal(await fs.readFile(hidden, "utf8"), "parent/hidden");
    assert.equal(await fs.readFile(excludedSession, "utf8"), "project/cache/excluded.jsonl");
  }));
