import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import { GIT_MANIFEST_VERSION } from "../src/engine/backends/git/git-storage.js";

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
      ...(snapshotVersion >= 6
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

test.each([6, 7])("Git refuses retired snapshot v%i in head, read, and history", (version) =>
  withPublication(version, Buffer.from("fixture"), async (backend, commit) => {
    await assert.rejects(backend.readHead(), /retired ignore-file.*configure-pi-sync/u);
    await assert.rejects(backend.readSnapshot(commit), /retired ignore-file.*configure-pi-sync/u);
    await assert.rejects(backend.listHistory(), /retired ignore-file.*configure-pi-sync/u);
  }),
);

test("legacy Git manifests keep replacement decoding for invalid UTF-8", () =>
  withPublication(3, Buffer.from([0xff]), async (backend) => {
    assert.equal((await backend.readHead())?.machine, "�");
    assert.equal((await backend.listHistory())[0]?.machine, "�");
  }));
