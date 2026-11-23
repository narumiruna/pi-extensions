import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import { GIT_MANIFEST_VERSION } from "../src/engine/backends/git/git-storage.js";
import { expectedRemoteHead } from "../src/engine/backends/sync-backend.js";
import { ignorePolicyFingerprint } from "../src/engine/ignore/ignore-source.js";
import { IGNORE_SNAPSHOT_VERSION, RULES_SNAPSHOT_VERSION } from "../src/engine/snapshot/snapshot-types.js";

const branch = "pi-sync/test";

async function withPublication(
  snapshotVersion: number,
  machineBytes: Buffer,
  run: (backend: GitSyncBackend, commit: string) => Promise<void>,
  extraTreePath?: Buffer,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-git-manifest-utf8-"));
  try {
    const remote = path.join(root, "remote.git");
    await runGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", remote]);
    const git = async (args: string[], input?: string | Buffer) =>
      (await runGit(args, { gitDir: remote, input })).stdout.toString("utf8").trim();
    const manifest = {
      version: GIT_MANIFEST_VERSION,
      snapshotVersion,
      snapshotId: "test-snapshot",
      createdAt: "2026-01-01T00:00:00.000Z",
      profile: "test",
      syncSessions: false,
      ...(snapshotVersion === IGNORE_SNAPSHOT_VERSION
        ? {
            snapshotSyncSessions: false,
            selection: { version: 4, scope: "agent-directory", fingerprint: "a".repeat(64), sessions: false },
          }
        : {}),
      files: [],
    };
    const bytes = Buffer.concat([
      Buffer.from(`${JSON.stringify(manifest).slice(0, -1)},"machine":"`),
      machineBytes,
      Buffer.from('"}\n'),
    ]);
    const blob = await git(["hash-object", "-w", "--stdin"], bytes);
    const treeEntries: Buffer[] = [Buffer.from(`100644 blob ${blob}\tmanifest.json\0`)];
    if (extraTreePath) treeEntries.push(Buffer.from(`100644 blob ${blob}\t`), extraTreePath, Buffer.from([0]));
    const tree = await git(["mktree", "-z"], Buffer.concat(treeEntries));
    const commit = await git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nauthor pi-sync <pi-sync@localhost> 1767225600 +0000\ncommitter pi-sync <pi-sync@localhost> 1767225600 +0000\n\nTest publication\n`,
    );
    await git(["update-ref", `refs/heads/${branch}`, commit]);
    const backend = new GitSyncBackend(
      {
        type: "git",
        profile: { kind: "git", remote },
        destination: { branch, namespace: "test", directory: "./" },
      },
      { cacheRoot: path.join(root, "cache"), allowLocalRemotes: true },
    );
    await run(backend, commit);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Git round-trips portable rule bytes without adding the rule file to the published tree payload", () =>
  withPublication(IGNORE_SNAPSHOT_VERSION, Buffer.from("fixture"), async (backend, commit) => {
    const prior = await backend.readSnapshot(commit);
    assert.equal(prior.ignoreRules, undefined);
    const text = "\uFEFF# Exact rules\r\n/notes/\r\n# no final newline";
    const next = {
      ...prior,
      id: "rules-v7",
      version: RULES_SNAPSHOT_VERSION,
      selection: {
        version: 4 as const,
        scope: "agent-directory" as const,
        fingerprint: ignorePolicyFingerprint(text, false),
        sessions: false,
      },
      ignoreRules: { filename: ".syncignore", text },
    };
    const result = await backend.publishSnapshot(next, expectedRemoteHead(await backend.readHead()));
    assert.deepEqual(await backend.readSnapshot(result.head.snapshotRef), next);
    assert.deepEqual(await backend.readHead(), result.head);
    assert.doesNotMatch(JSON.stringify(result.head), /Exact rules|\.syncignore/u);
    assert.equal((await backend.readSnapshot(commit)).version, 6);
  }));

const invalidUtf8 = /Git publication manifest is not valid UTF-8\./u;

test.each([
  ["an isolated continuation byte", [0x80]],
  ["an overlong encoding", [0xc0, 0xaf]],
  ["an encoded surrogate", [0xed, 0xa0, 0x80]],
  ["an incomplete multibyte sequence", [0xf0, 0x9f, 0x92]],
])("v6 Git head rejects a manifest with %s", (_description, bytes) =>
  withPublication(IGNORE_SNAPSHOT_VERSION, Buffer.from(bytes), async (backend) => {
    await assert.rejects(backend.readHead(), invalidUtf8);
  }),
);

test("v6 Git snapshot and history reads reject malformed manifest bytes", () =>
  withPublication(IGNORE_SNAPSHOT_VERSION, Buffer.from([0xff]), async (backend, commit) => {
    await assert.rejects(backend.readSnapshot(commit), invalidUtf8);
    await assert.rejects(backend.listHistory(), invalidUtf8);
  }));

test("v6 Git refuses lossy decoding of raw tree paths", () =>
  withPublication(
    IGNORE_SNAPSHOT_VERSION,
    Buffer.from("valid machine"),
    async (backend, commit) => {
      await assert.rejects(backend.readHead(), /tree paths must be valid UTF-8/u);
      await assert.rejects(backend.readSnapshot(commit), /tree paths must be valid UTF-8/u);
      await assert.rejects(backend.listHistory(), /tree paths must be valid UTF-8/u);
    },
    Buffer.from([0x61, 0xff, 0x62]),
  ));

test("v6 Git accepts actual UTF-8 for non-ASCII text and the replacement character", () => {
  const machine = "機器-�-🧪";
  return withPublication(IGNORE_SNAPSHOT_VERSION, Buffer.from(machine), async (backend, commit) => {
    assert.equal((await backend.readHead())?.machine, machine);
    assert.equal((await backend.readSnapshot(commit)).machine, machine);
    assert.equal((await backend.listHistory())[0]?.machine, machine);
  });
});

test("legacy Git manifests keep replacement decoding for invalid UTF-8", () =>
  withPublication(3, Buffer.from([0xff]), async (backend) => {
    assert.equal((await backend.readHead())?.machine, "�");
    assert.equal((await backend.listHistory())[0]?.machine, "�");
  }));
