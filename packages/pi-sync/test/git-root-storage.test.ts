import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { createBareRemote, gitConfig } from "./git-test-helpers.js";
import { snapshot } from "./helpers.js";

test("Git root publication uses literal root files and survives a fresh cache", async () => {
  const fixture = createBareRemote();
  try {
    const config = gitConfig(fixture.remote);
    config.destination = { branch: "main", directory: "./", namespace: "root" };
    const backend = new GitSyncBackend(config, {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const content = {
      ...snapshot([{ path: "settings.json", content: Buffer.from("root") }]),
      profile: "root",
    };
    const first = await backend.publishSnapshot(content, { kind: "missing" });
    const tree = execFileSync("git", ["--git-dir", fixture.remote, "ls-tree", "-r", "--name-only", "main"], {
      encoding: "utf8",
    });
    assert.deepEqual(tree.trim().split("\n"), ["files/settings.json", "manifest.json"]);
    const fresh = new GitSyncBackend(config, {
      cacheRoot: path.join(fixture.root, "fresh-cache"),
      allowLocalRemotes: true,
    });
    assert.deepEqual(await fresh.readSnapshot(first.head.snapshotRef), content);
    const empty = { ...snapshot([]), id: "empty", profile: "root" };
    await fresh.publishSnapshot(empty, expectedRemoteHead(first.head));
    assert.deepEqual(await fresh.readSnapshot("empty"), empty);
    assert.deepEqual(await fresh.readSnapshot(first.head.snapshotRef), content);
    assert.equal((await fresh.listHistory()).length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git root refuses an unrelated existing main branch without changing it", async () => {
  const fixture = createBareRemote();
  try {
    const blob = execFileSync("git", ["--git-dir", fixture.remote, "hash-object", "-w", "--stdin"], {
      input: "unrelated",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["--git-dir", fixture.remote, "mktree"], {
      input: `100644 blob ${blob}\tREADME.md\n`,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["--git-dir", fixture.remote, "commit-tree", tree, "-m", "existing"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
    execFileSync("git", ["--git-dir", fixture.remote, "update-ref", "refs/heads/main", commit]);
    const config = gitConfig(fixture.remote);
    config.destination = { branch: "main", directory: "./", namespace: "root" };
    const backend = new GitSyncBackend(config, {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    await assert.rejects(backend.readHead(), /manifest|publication/iu);
    await assert.rejects(backend.publishSnapshot({ ...snapshot([]), profile: "root" }, { kind: "missing" }));
    assert.equal(
      execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "main"], {
        encoding: "utf8",
      }).trim(),
      commit,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
