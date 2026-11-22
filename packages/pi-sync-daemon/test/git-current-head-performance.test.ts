import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { ResolvedGitBackend } from "../src/engine/backends/backend-types.js";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import { expectedRemoteHead, SyncBackendConflictError } from "../src/engine/backends/sync-backend.js";
import type { SyncConfig } from "../src/engine/settings/settings-types.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { readRemoteSnapshot } from "../src/engine/sync/remote-snapshot.js";

vi.mock(import("node:child_process"), { spy: true });

const branch = "pi-sync/performance";
const branchRef = `refs/heads/${branch}`;
const observedCommands = () =>
  vi.mocked(spawn).mock.calls.map(([, args]) => args?.find((arg) => /^[a-z]+(-[a-z]+)*$/u.test(arg)));

function snapshot(id: string, scoped = true): Snapshot {
  const content = Buffer.from(id);
  return {
    version: scoped ? 5 : 3,
    id,
    profile: "test",
    createdAt: "2026-11-01T00:00:00Z",
    machine: "test",
    selection: scoped
      ? { version: 3, scope: "agent-directory", include: [], exclude: [], reinclude: [] }
      : { version: 1, include: ["test.txt"] },
    files: [
      {
        path: "test.txt",
        contentBase64: content.toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
}

async function withGitRemote(
  run: (fixture: {
    remote: string;
    reader: GitSyncBackend;
    writer: GitSyncBackend;
    config: SyncConfig<ResolvedGitBackend>;
    readerCache: string;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-git-current-head-"));
  try {
    const remote = path.join(root, "remote.git");
    await runGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", remote]);
    const backend: ResolvedGitBackend = {
      type: "git",
      profile: { kind: "git", remote },
      destination: { branch, namespace: "test", directory: "./" },
    };
    const readerCache = path.join(root, "reader");
    const reader = new GitSyncBackend(backend, { cacheRoot: readerCache, allowLocalRemotes: true });
    const writer = new GitSyncBackend(backend, { cacheRoot: path.join(root, "writer"), allowLocalRemotes: true });
    assert.equal(await reader.readHead(), undefined); // Warm the bare repository, not the publication data.
    await run({
      remote,
      reader,
      writer,
      readerCache,
      config: {
        setupName: "test",
        connectionName: "test",
        storagePath: "./",
        snapshotIdentity: "test",
        scope: "agent-directory",
        include: [],
        automatic: false,
        onSwitch: "switch-only",
        skipSecretScan: false,
        showStatus: false,
        debug: false,
        backend,
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const fetchCommands = ["ls-remote", "fetch", "rev-parse", "update-ref"];

test("Git pairs the head and immutable data with one fetch and one tree/manifest validation", () =>
  withGitRemote(async ({ reader, writer, config }) => {
    await writer.publishSnapshot(snapshot("first"), { kind: "missing" });
    vi.mocked(spawn).mockClear();
    const first = await readRemoteSnapshot(reader, config);
    assert.equal(first.head?.snapshotId, "first");
    assert.deepEqual(first.snapshot?.files, snapshot("first").files);
    assert.deepEqual(observedCommands(), [...fetchCommands, "show", "ls-tree", "cat-file", "cat-file"]);
    assert.ok(first.head?.selection?.include);
    first.head.selection.include.push("untrusted.txt");
    assert.ok(first.snapshot?.selection?.include);
    first.snapshot.selection.include.push("another.txt");

    vi.mocked(spawn).mockClear();
    const second = await readRemoteSnapshot(reader, config);
    assert.deepEqual(second.head?.selection, snapshot("first").selection);
    assert.deepEqual(second.snapshot?.selection, snapshot("first").selection);
    assert.deepEqual(observedCommands(), [...fetchCommands, "cat-file", "cat-file"]);

    vi.mocked(spawn).mockClear();
    assert.ok(second.head);
    assert.equal((await reader.readSnapshot(second.head.snapshotRef)).id, "first");
    assert.deepEqual(observedCommands(), [...fetchCommands, "cat-file", "merge-base", "cat-file"]);
  }));

test("Git selected-path observation keeps a separate ancestry check for legacy baseline acceptance", () =>
  withGitRemote(async ({ reader, writer, config }) => {
    await writer.publishSnapshot(snapshot("legacy", false), { kind: "missing" });
    vi.mocked(spawn).mockClear();
    const observed = await readRemoteSnapshot(reader, { ...config, scope: undefined, include: ["test.txt"] });
    assert.equal(observed.head?.snapshotId, "legacy");
    assert.deepEqual(observedCommands(), [
      ...fetchCommands,
      "show",
      "ls-tree",
      ...fetchCommands,
      "cat-file",
      "merge-base",
      "cat-file",
    ]);
  }));

test("Git checks reachability after advance, rewrite, and deletion despite having cached the exact commit", () =>
  withGitRemote(async ({ remote, reader, writer, config }) => {
    const first = await writer.publishSnapshot(snapshot("first"), { kind: "missing" });
    assert.equal((await reader.readHeadAndSnapshot())?.head.snapshotRef, first.head.snapshotRef);
    const second = await writer.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head));
    assert.equal((await reader.readSnapshot(first.head.snapshotRef)).id, "first");
    assert.equal((await readRemoteSnapshot(reader, config)).head?.snapshotRef, second.head.snapshotRef);
    await assert.rejects(
      reader.publishSnapshot(snapshot("stale"), expectedRemoteHead(first.head)),
      SyncBackendConflictError,
    );
    await runGit(["update-ref", "-d", branchRef], { gitDir: remote });
    assert.equal(await reader.readHeadAndSnapshot(), undefined);
    await assert.rejects(reader.readSnapshot(second.head.snapshotRef), /not found/u);
    assert.deepEqual(await reader.listHistory(), []);

    const rewritten = await writer.publishSnapshot(snapshot("rewritten"), { kind: "missing" });
    await assert.rejects(reader.readSnapshot(second.head.snapshotRef), /not found/u);
    assert.equal((await reader.readHeadAndSnapshot())?.head.snapshotRef, rewritten.head.snapshotRef);
    assert.deepEqual(
      (await reader.listHistory()).map((entry) => entry.snapshotRef),
      [rewritten.head.snapshotRef],
    );
  }));

test("a cached Git commit cannot be read through a local replacement object", () =>
  withGitRemote(async ({ reader, readerCache, writer, remote }) => {
    const first = await writer.publishSnapshot(snapshot("first"), { kind: "missing" });
    const second = await writer.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head));
    assert.equal((await reader.readHeadAndSnapshot())?.snapshot.id, "second");
    const gitDir = path.join(readerCache, reader.identity.slice("git:".length), "repository.git");
    await runGit(["update-ref", `refs/replace/${second.head.snapshotRef}`, first.head.snapshotRef], { gitDir });
    assert.equal((await reader.readHeadAndSnapshot())?.snapshot.id, "second");
    const freshReader = new GitSyncBackend(
      { type: "git", profile: { kind: "git", remote }, destination: { branch, namespace: "test", directory: "./" } },
      { cacheRoot: readerCache, allowLocalRemotes: true },
    );
    assert.equal((await freshReader.readHeadAndSnapshot())?.snapshot.id, "second");
  }));
