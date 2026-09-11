import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { GitSyncBackend, gitBackendIdentity, isSupportedGitVersion } from "../src/backends/git/git-backend.js";
import { isGitPayloadSizeAllowed } from "../src/backends/git/git-storage.js";
import {
  expectedRemoteHead,
  SyncBackendConflictError,
  SyncBackendPublicationOutcomeUnknownError,
} from "../src/backends/sync-backend.js";
import { createBareRemote, gitConfig } from "./git-test-helpers.js";
import { snapshot } from "./helpers.js";

test("Git backend publishes lease-protected commits and preserves repeated-content history", async () => {
  const fixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const content = {
      ...snapshot([
        { path: "settings.json", content: Buffer.from("one") },
        { path: "keybindings.json", content: Buffer.from("shared") },
        { path: "copies/keybindings.json", content: Buffer.from("shared") },
      ]),
      selection: {
        version: 1 as const,
        include: ["settings.json", "keybindings.json", "copies", "missing.toml"],
      },
    };
    const first = await backend.publishSnapshot(content, { kind: "missing" });
    assert.match(first.head.revision, new RegExp(`^${gitBackendIdentity(gitConfig(fixture.remote))}:[0-9a-f]{40}$`));
    const second = await backend.publishSnapshot(content, expectedRemoteHead(first.head));
    const changed = {
      ...content,
      id: "changed",
      files: content.files.map((file) =>
        file.path === "settings.json"
          ? (snapshot([{ path: "settings.json", content: Buffer.from("two") }]).files[0] ?? file)
          : file,
      ),
    };
    const third = await backend.publishSnapshot(changed, expectedRemoteHead(second.head));
    assert.notEqual(first.head.snapshotRef, second.head.snapshotRef);
    assert.equal(first.head.snapshotId, second.head.snapshotId);
    assert.deepEqual(
      (await backend.listHistory()).map((entry) => entry.snapshotRef),
      [first.head.snapshotRef, second.head.snapshotRef, third.head.snapshotRef],
    );
    const firstTree = publicationTree(fixture.remote, first.head.snapshotRef);
    const thirdTree = publicationTree(fixture.remote, third.head.snapshotRef);
    assert.deepEqual([...firstTree.keys()].sort(), [
      "pi-sync/files/copies/keybindings.json",
      "pi-sync/files/keybindings.json",
      "pi-sync/files/settings.json",
      "pi-sync/manifest.json",
    ]);
    assert.equal(
      firstTree.get("pi-sync/files/keybindings.json"),
      firstTree.get("pi-sync/files/copies/keybindings.json"),
    );
    assert.equal(firstTree.get("pi-sync/files/keybindings.json"), thirdTree.get("pi-sync/files/keybindings.json"));
    assert.notEqual(firstTree.get("pi-sync/files/settings.json"), thirdTree.get("pi-sync/files/settings.json"));
    assert.deepEqual(
      execFileSync("git", [
        "--git-dir",
        fixture.remote,
        "show",
        `${third.head.snapshotRef}:pi-sync/files/settings.json`,
      ]),
      Buffer.from("two"),
    );
    assert.deepEqual(await backend.readSnapshot(first.head.snapshotRef), content);
    assert.deepEqual(await backend.readSnapshot(third.head.snapshotRef), changed);
    assert.deepEqual(await backend.readSnapshot("changed"), changed);
    await assert.rejects(backend.readSnapshot("snap"), /ambiguous.*commit reference/i);
    const freshBackend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "fresh-cache"),
      allowLocalRemotes: true,
    });
    assert.deepEqual(await freshBackend.readSnapshot(first.head.snapshotRef), content);
    assert.equal(
      execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/pi-sync/default"], {
        encoding: "utf8",
      }).trim(),
      third.head.snapshotRef,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend publishes and reads snapshots with a relative cache root", async () => {
  const fixture = createBareRemote();
  const cacheDirectory = mkdtempSync(path.join(process.cwd(), "node_modules", ".pi-sync-relative-cache-"));
  try {
    const cacheRoot = path.relative(process.cwd(), path.join(cacheDirectory, "relative cache"));
    assert.equal(path.isAbsolute(cacheRoot), false);
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot,
      allowLocalRemotes: true,
    });
    const content = snapshot([{ path: "settings.json", content: Buffer.from("relative") }]);
    const publication = await backend.publishSnapshot(content, { kind: "missing" });
    assert.deepEqual(await backend.readHead(), publication.head);
    assert.deepEqual(await backend.readSnapshot(publication.head.snapshotRef), content);
    const identityDirectory = path.join(cacheRoot, gitBackendIdentity(gitConfig(fixture.remote)).slice("git:".length));
    assert.deepEqual(readdirSync(identityDirectory), ["repository.git"]);
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend reads literal publication paths containing pathspec metacharacters", async () => {
  const fixture = createBareRemote();
  try {
    const config = gitConfig(fixture.remote);
    config.destination.directory = ":(glob)archive*";
    config.destination.namespace = "[home]?";
    const backend = new GitSyncBackend(config, {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const content = snapshot([{ path: "settings.json", content: Buffer.from("literal") }]);
    content.profile = "[home]?";
    const publication = await backend.publishSnapshot(content, { kind: "missing" });
    assert.equal((await backend.readHead())?.snapshotRef, publication.head.snapshotRef);
    assert.deepEqual(await backend.readSnapshot(publication.head.snapshotRef), content);
    assert.equal((await backend.listHistory()).length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend writes quoted publication paths through NUL-delimited index input", async () => {
  const fixture = createBareRemote();
  try {
    const config = gitConfig(fixture.remote);
    config.destination.directory = '"archive';
    const backend = new GitSyncBackend(config, {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const content = snapshot([{ path: "settings.json", content: Buffer.from("quoted") }]);
    const publication = await backend.publishSnapshot(content, { kind: "missing" });
    assert.deepEqual(await backend.readSnapshot(publication.head.snapshotRef), content);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend rejects cached publications removed from owned-branch history", async () => {
  const fixture = createBareRemote();
  try {
    const first = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "first-cache"),
      allowLocalRemotes: true,
    });
    const old = await first.publishSnapshot(snapshot([]), { kind: "missing" });
    execFileSync("git", ["--git-dir", fixture.remote, "update-ref", "-d", "refs/heads/pi-sync/default"]);
    const replacement = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "replacement-cache"),
      allowLocalRemotes: true,
    });
    await replacement.publishSnapshot({ ...snapshot([]), id: "replacement" }, { kind: "missing" });
    await assert.rejects(first.readSnapshot(old.head.snapshotRef), /not found/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend returns the ref fetched after an ls-remote race", async () => {
  const fixture = createBareRemote();
  try {
    const writer = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "writer"),
      allowLocalRemotes: true,
    });
    const first = await writer.publishSnapshot(snapshot([]), { kind: "missing" });
    let secondSnapshotRef: string | undefined;
    let advanced = false;
    const reader = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "reader"),
      allowLocalRemotes: true,
      afterLsRemoteForTest: async () => {
        if (advanced) return;
        advanced = true;
        const second = await writer.publishSnapshot({ ...snapshot([]), id: "second" }, expectedRemoteHead(first.head));
        secondSnapshotRef = second.head.snapshotRef;
      },
    });
    const head = await reader.readHead();
    assert.equal(head?.snapshotRef, secondSnapshotRef);
    assert.equal(head?.snapshotId, "second");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend rejects stale independent writers with an exact lease", async () => {
  const fixture = createBareRemote();
  try {
    const first = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "first"),
      allowLocalRemotes: true,
    });
    const second = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "second"),
      allowLocalRemotes: true,
    });
    assert.equal(await first.readHead(), undefined);
    assert.equal(await second.readHead(), undefined);
    await first.publishSnapshot(snapshot([]), { kind: "missing" });
    await assert.rejects(
      second.publishSnapshot({ ...snapshot([]), id: "other" }, { kind: "missing" }),
      SyncBackendConflictError,
    );
    assert.equal((await second.readHead())?.snapshotId, "snap");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend retries cache initialization after an aborted first attempt", async () => {
  const fixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(
      backend.readHead(controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(await backend.readHead(), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend serializes shared-cache initialization and ref fetches", async () => {
  const fixture = createBareRemote();
  try {
    const cacheRoot = path.join(fixture.root, "shared-cache");
    const options = { cacheRoot, allowLocalRemotes: true };
    const first = new GitSyncBackend(gitConfig(fixture.remote), options);
    const second = new GitSyncBackend(gitConfig(fixture.remote), options);
    assert.deepEqual(await Promise.all([first.readHead(), second.readHead()]), [undefined, undefined]);
    await first.publishSnapshot(snapshot([]), { kind: "missing" });
    const heads = await Promise.all([first.readHead(), second.readHead()]);
    assert.equal(heads[0]?.snapshotRef, heads[1]?.snapshotRef);
    const gitDir = path.join(
      cacheRoot,
      gitBackendIdentity(gitConfig(fixture.remote)).slice("git:".length),
      "repository.git",
    );
    assert.equal(
      execFileSync("git", ["--git-dir", gitDir, "for-each-ref", "refs/pisync/fetch"], {
        encoding: "utf8",
      }),
      "",
    );
    assert.doesNotMatch(readFileSync(path.join(gitDir, "config"), "utf8"), /remote\.git/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend bootstraps its owned branch in an existing non-empty repository", async () => {
  const fixture = createBareRemote();
  const work = path.join(fixture.root, "existing-work");
  try {
    mkdirSync(work);
    execFileSync("git", ["init"], { cwd: work, stdio: "ignore" });
    writeFileSync(path.join(work, "README.md"), "existing repository\n");
    execFileSync("git", ["add", "README.md"], { cwd: work });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "existing"], {
      cwd: work,
      stdio: "ignore",
    });
    const existingSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["remote", "add", "origin", fixture.remote], { cwd: work });
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: work,
      stdio: "ignore",
    });
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    const empty = snapshot([]);
    const publication = await backend.publishSnapshot(empty, { kind: "missing" });
    assert.deepEqual(await backend.readSnapshot(publication.head.snapshotRef), empty);
    assert.deepEqual(
      [...publicationTree(fixture.remote, publication.head.snapshotRef).keys()],
      ["pi-sync/manifest.json"],
    );
    assert.equal(
      execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim(),
      existingSha,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend rejects unrelated owned refs and does not inspect a working tree", async () => {
  const fixture = createBareRemote();
  const work = path.join(fixture.root, "work");
  try {
    mkdirSync(work);
    execFileSync("git", ["init"], { cwd: work, stdio: "ignore" });
    writeFileSync(path.join(work, "unrelated.txt"), "unrelated");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: work });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "unrelated"], {
      cwd: work,
      stdio: "ignore",
    });
    execFileSync("git", ["remote", "add", "origin", fixture.remote], { cwd: work });
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/pi-sync/default"], {
      cwd: work,
      stdio: "ignore",
    });
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    await assert.rejects(backend.readHead(), /manifest|publication/i);
    assert.equal(existsSync(path.join(work, "unrelated.txt")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend repairs a corrupt private cache but refuses a symlinked cache", async () => {
  const fixture = createBareRemote();
  const config = gitConfig(fixture.remote);
  const identity = gitBackendIdentity(config).slice("git:".length);
  try {
    const corruptRoot = path.join(fixture.root, "corrupt-cache");
    const corrupt = path.join(corruptRoot, identity, "repository.git");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(path.join(corrupt, "bad"), "bad");
    const repaired = new GitSyncBackend(config, {
      cacheRoot: corruptRoot,
      allowLocalRemotes: true,
    });
    assert.equal(await repaired.readHead(), undefined);
    assert.equal(
      execFileSync("git", ["--git-dir", corrupt, "rev-parse", "--is-bare-repository"], {
        encoding: "utf8",
      }).trim(),
      "true",
    );

    const sha256Root = path.join(fixture.root, "sha256-cache");
    const sha256Cache = path.join(sha256Root, identity, "repository.git");
    mkdirSync(path.dirname(sha256Cache), { recursive: true });
    execFileSync("git", ["init", "--bare", "--object-format=sha256", sha256Cache], {
      stdio: "ignore",
    });
    const repairedFormat = new GitSyncBackend(config, {
      cacheRoot: sha256Root,
      allowLocalRemotes: true,
    });
    assert.equal(await repairedFormat.readHead(), undefined);
    assert.equal(
      execFileSync("git", ["--git-dir", sha256Cache, "rev-parse", "--show-object-format"], {
        encoding: "utf8",
      }).trim(),
      "sha1",
    );

    if (process.platform !== "win32") {
      const symlinkRoot = path.join(fixture.root, "symlink-cache");
      const cache = path.join(symlinkRoot, identity, "repository.git");
      mkdirSync(path.dirname(cache), { recursive: true });
      symlinkSync(fixture.remote, cache);
      const unsafe = new GitSyncBackend(config, {
        cacheRoot: symlinkRoot,
        allowLocalRemotes: true,
      });
      await assert.rejects(unsafe.readHead(), /symlinked Git cache/i);

      const external = path.join(fixture.root, "external-cache");
      mkdirSync(external);
      const cacheRootLink = path.join(fixture.root, "cache-root-link");
      symlinkSync(external, cacheRootLink);
      const unsafeRoot = new GitSyncBackend(config, {
        cacheRoot: cacheRootLink,
        allowLocalRemotes: true,
      });
      await assert.rejects(unsafeRoot.readHead(), /symlinked Git cache root/i);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend rejects unsafe metadata, duplicate paths, and non-canonical content", async () => {
  const fixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), machine: `bad\u001b[31m` }, { kind: "missing" }),
      /invalid Git snapshot/i,
    );
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), createdAt: "\n2026-01-01" }, { kind: "missing" }),
      /invalid Git snapshot/i,
    );
    const file = snapshot([{ path: "settings.json", content: Buffer.from("one") }]).files[0];
    assert.ok(file);
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), files: [file, file] }, { kind: "missing" }),
      /invalid Git snapshot file/i,
    );
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), files: [{ ...file, path: "../escape" }] }, { kind: "missing" }),
      /invalid Git snapshot file/i,
    );
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), files: [{ ...file, path: ".git/config" }] }, { kind: "missing" }),
      /invalid Git snapshot file/i,
    );
    await assert.rejects(
      backend.publishSnapshot(
        {
          ...snapshot([]),
          files: [file, { ...file, path: "settings.json/nested" }],
        },
        { kind: "missing" },
      ),
      /path conflict/i,
    );
    await assert.rejects(
      backend.publishSnapshot(
        { ...snapshot([]), files: [{ ...file, contentBase64: `${file.contentBase64}=` }] },
        { kind: "missing" },
      ),
      /checksum/i,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend removes private payload temporaries after cancellation", async () => {
  const fixture = createBareRemote();
  const cacheRoot = path.join(fixture.root, "cache");
  const config = gitConfig(fixture.remote);
  const controller = new AbortController();
  try {
    const backend = new GitSyncBackend(config, {
      cacheRoot,
      allowLocalRemotes: true,
      afterPayloadWriteForTest: () => controller.abort(new DOMException("cancelled", "AbortError")),
    });
    await assert.rejects(
      backend.publishSnapshot(
        snapshot([{ path: "settings.json", content: Buffer.from("private") }]),
        { kind: "missing" },
        { signal: controller.signal },
      ),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    const identityDirectory = path.join(cacheRoot, gitBackendIdentity(config).slice("git:".length));
    assert.equal(
      readdirSync(identityDirectory).some((entry) => entry.startsWith(".index-")),
      false,
    );
    assert.equal(await backend.readHead(), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend reconciles a lost success response and reports unreachable outcomes as unknown", async () => {
  const committedFixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(committedFixture.remote), {
      cacheRoot: path.join(committedFixture.root, "cache"),
      allowLocalRemotes: true,
      afterPushForTest: () => {
        throw new Error("simulated lost response");
      },
    });
    const result = await backend.publishSnapshot(snapshot([]), { kind: "missing" });
    assert.equal(result.head.snapshotId, "snap");
  } finally {
    rmSync(committedFixture.root, { recursive: true, force: true });
  }

  const unknownFixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(unknownFixture.remote), {
      cacheRoot: path.join(unknownFixture.root, "cache"),
      allowLocalRemotes: true,
      afterPushForTest: () => {
        rmSync(unknownFixture.remote, { recursive: true, force: true });
        throw new Error("simulated transport loss password=top-secret Bearer bearer-secret");
      },
    });
    await assert.rejects(backend.publishSnapshot(snapshot([]), { kind: "missing" }), (error: unknown) => {
      assert.ok(error instanceof SyncBackendPublicationOutcomeUnknownError);
      assert.doesNotMatch(error.message, /top-secret|bearer-secret/);
      return true;
    });
  } finally {
    rmSync(unknownFixture.root, { recursive: true, force: true });
  }
});

test("Git backend disables local pre-push hooks in its private cache", async () => {
  if (process.platform === "win32") return;
  const fixture = createBareRemote();
  const config = gitConfig(fixture.remote);
  const identity = gitBackendIdentity(config).slice("git:".length);
  const cacheRoot = path.join(fixture.root, "cache");
  const gitDir = path.join(cacheRoot, identity, "repository.git");
  const marker = path.join(fixture.root, "hook-ran");
  try {
    const backend = new GitSyncBackend(config, { cacheRoot, allowLocalRemotes: true });
    await backend.readHead();
    mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
    const hook = path.join(gitDir, "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    await backend.publishSnapshot(snapshot([]), { kind: "missing" });
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("Git backend fails closed on malformed native publication trees", () => {
  const cases: Array<{
    name: string;
    expected: RegExp;
    mutate: (work: string, manifestPath: string, filePath: string) => void;
    verify?: (backend: GitSyncBackend, commit: string) => Promise<unknown>;
    skip?: boolean;
  }> = [
    {
      name: "missing payload",
      expected: /missing or extra/i,
      mutate: (_work, _manifestPath, filePath) => rmSync(filePath),
      verify: (backend) => backend.listHistory(),
    },
    {
      name: "extra payload",
      expected: /missing or extra/i,
      mutate: (work) => writeFileSync(path.join(work, "pi-sync/files/extra"), "x"),
      verify: (backend) => backend.readHead(),
    },
    {
      name: "entry outside the owned publication",
      expected: /missing or extra/i,
      mutate: (work) => writeFileSync(path.join(work, "unowned.txt"), "must not be deleted"),
      verify: (backend) => backend.readHead(),
    },
    {
      name: "non-regular payload",
      expected: /non-regular/i,
      skip: process.platform === "win32",
      mutate: (_work, _manifestPath, filePath) => {
        rmSync(filePath);
        symlinkSync("target", filePath);
      },
    },
    {
      name: "checksum mismatch",
      expected: /checksum/i,
      mutate: (_work, _manifestPath, filePath) => writeFileSync(filePath, "other"),
    },
    {
      name: "declared size mismatch",
      expected: /manifest size|size mismatch/i,
      mutate: (_work, manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          files: Array<{ size: number }>;
        };
        if (manifest.files[0]) manifest.files[0].size -= 1;
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      name: "oversized declared payload",
      expected: /manifest file is malformed/i,
      mutate: (_work, manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          files: Array<{ size: number }>;
        };
        if (manifest.files[0]) manifest.files[0].size = 100 * 1024 * 1024 + 1;
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      name: "oversized aggregate declaration",
      expected: /snapshot content exceeds/i,
      mutate: (_work, manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          files: Array<{ path: string; sha256: string; size: number }>;
        };
        const original = manifest.files[0];
        assert.ok(original);
        manifest.files = Array.from({ length: 6 }, (_, index) => ({
          ...original,
          path: `file-${index}`,
          size: 100 * 1024 * 1024,
        }));
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      name: "unknown manifest field",
      expected: /manifest.*malformed/i,
      mutate: (_work, manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        manifest.unknown = true;
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      name: "control character in timestamp",
      expected: /manifest.*malformed/i,
      mutate: (_work, manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        manifest.createdAt = "\n2026-01-01";
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    },
    {
      name: "pre-release gzip manifest",
      expected: /pre-release gzip format.*recreate/i,
      mutate: (_work, manifestPath) => {
        writeFileSync(manifestPath, `${JSON.stringify({ version: 1, snapshotId: "old", sha256: "0".repeat(64) })}\n`);
      },
    },
  ];
  for (const entry of cases) {
    test(entry.name, { skip: entry.skip }, async () => {
      const error = await malformedPublicationError(entry.mutate, entry.verify);
      assert.match(error, entry.expected);
    });
  }
});

test("Git doctor rejects a corrupt active snapshot blob", async () => {
  const fixture = createBareRemote();
  const corruptWork = path.join(fixture.root, "corrupt-work");
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    await backend.publishSnapshot(snapshot([{ path: "settings.json", content: Buffer.from("valid") }]), {
      kind: "missing",
    });
    execFileSync("git", ["clone", "--branch", "pi-sync/default", fixture.remote, corruptWork], {
      stdio: "ignore",
    });
    writeFileSync(path.join(corruptWork, "pi-sync", "files", "settings.json"), "corrupt");
    execFileSync("git", ["add", "."], { cwd: corruptWork });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "corrupt"], {
      cwd: corruptWork,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/pi-sync/default"], {
      cwd: corruptWork,
      stdio: "ignore",
    });
    const diagnostics = await backend.diagnose();
    const errors = diagnostics
      .filter((item) => item.level === "error")
      .map((item) => item.message)
      .join("\n");
    assert.match(errors, /checksum|snapshot file/i, JSON.stringify(diagnostics));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend redacts direct Git transport failures", async () => {
  const fixture = createBareRemote();
  const secretRemote = path.join(fixture.root, "password=top-secret.git");
  try {
    renameSync(fixture.remote, secretRemote);
    const backend = new GitSyncBackend(gitConfig(secretRemote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    rmSync(secretRemote, { recursive: true, force: true });
    await assert.rejects(backend.readHead(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /top-secret|password=/i);
      return true;
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git diagnostics redact remote and private cache paths", async () => {
  const fixture = createBareRemote();
  const cacheRoot = path.join(fixture.root, "private-cache");
  const backend = new GitSyncBackend(gitConfig(fixture.remote), {
    cacheRoot,
    allowLocalRemotes: true,
  });
  rmSync(fixture.remote, { recursive: true, force: true });
  try {
    const output = (await backend.diagnose()).map((item) => item.message).join("\n");
    assert.doesNotMatch(output, new RegExp(fixture.remote.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.doesNotMatch(output, new RegExp(cacheRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(output, /git remote:/i);
    assert.match(output, /Write access is not tested/u);
    assert.match(output, /Check setup/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend rejects malformed opaque revisions instead of treating them as missing", async () => {
  const fixture = createBareRemote();
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    assert.throws(() => backend.sameRevision("bad", "also-bad"), /invalid Git remote revision/i);
    await assert.rejects(
      backend.publishSnapshot(snapshot([]), { kind: "revision", revision: "bad" }),
      SyncBackendConflictError,
    );
    assert.equal(await backend.readHead(), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Git backend enforces the GitHub regular-Git payload boundary", () => {
  assert.equal(isGitPayloadSizeAllowed(100 * 1024 * 1024), true);
  assert.equal(isGitPayloadSizeAllowed(100 * 1024 * 1024 + 1), false);
});

test("Git backend requires a supported Git version", () => {
  assert.equal(isSupportedGitVersion("git version 2.29.9"), false);
  assert.equal(isSupportedGitVersion("git version 2.30.0"), true);
  assert.equal(isSupportedGitVersion("git version 3.0.0.windows.1"), true);
  assert.equal(isSupportedGitVersion("malformed"), false);
});

async function malformedPublicationError(
  mutate: (work: string, manifestPath: string, filePath: string) => void,
  verify?: (backend: GitSyncBackend, commit: string) => Promise<unknown>,
) {
  const fixture = createBareRemote();
  const work = path.join(fixture.root, "mutated-work");
  try {
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      cacheRoot: path.join(fixture.root, "cache"),
      allowLocalRemotes: true,
    });
    await backend.publishSnapshot(snapshot([{ path: "settings.json", content: Buffer.from("valid") }]), {
      kind: "missing",
    });
    execFileSync("git", ["clone", "--branch", "pi-sync/default", fixture.remote, work], {
      stdio: "ignore",
    });
    mutate(work, path.join(work, "pi-sync", "manifest.json"), path.join(work, "pi-sync", "files", "settings.json"));
    execFileSync("git", ["add", "--all"], { cwd: work });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "mutate"], {
      cwd: work,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/pi-sync/default"], {
      cwd: work,
      stdio: "ignore",
    });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    try {
      await (verify?.(backend, commit) ?? backend.readSnapshot(commit));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    assert.fail("Expected malformed Git publication to be rejected.");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function publicationTree(gitDir: string, commit: string) {
  const output = execFileSync("git", ["--git-dir", gitDir, "ls-tree", "-r", commit], {
    encoding: "utf8",
  });
  return new Map(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [metadata, filePath] = line.split("\t");
        const object = metadata?.split(" ")[2];
        assert.ok(object && filePath);
        return [filePath, object] as const;
      }),
  );
}

test("Git backend production validation rejects local and credential-bearing remotes", () => {
  const local = gitConfig("/tmp/private.git");
  assert.throws(() => new GitSyncBackend(local), /SSH or HTTPS/i);
  const credential = gitConfig("https://user:token@example.com/private.git");
  assert.throws(() => new GitSyncBackend(credential), /credentials/i);
});
