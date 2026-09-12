import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import * as runner from "../src/backends/git/git-runner.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { withLock } from "../src/state/lock.js";
import { lockPath, statePathForConfig } from "../src/state/sync-state-store.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { createBareRemote, gitConfig } from "./git-test-helpers.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { deferred } from "./startup-check-helpers.js";

test("Git inspection fetches privately without changing managed files, baseline, or remote refs", async () => {
  await withTempHome(async (agentDir) => {
    const fixture = createBareRemote();
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
      await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n");
      const config = {
        ...(await loadConfig()),
        backend: gitConfig("git@example.com:private/sync.git"),
        snapshotIdentity: "default",
      };
      const backend = new GitSyncBackend(gitConfig(fixture.remote), {
        allowLocalRemotes: true,
        cacheRoot: path.join(fixture.root, "cache"),
      });
      await backend.publishSnapshot(
        {
          ...snapshot([{ path: "settings.json", content: Buffer.from("{}\n") }]),
          selection: { version: 1, include: config.include },
        },
        { kind: "missing" },
      );
      const refs = () => execFileSync("git", ["--git-dir", fixture.remote, "show-ref"], { encoding: "utf8" });
      const before = refs();
      const settingsBefore = await fs.readFile(localConfigPath());
      const cold = new GitSyncBackend(gitConfig(fixture.remote), {
        allowLocalRemotes: true,
        cacheRoot: path.join(fixture.root, "cold-cache"),
      });
      const result = await inspectSync(config, { include: config.include }, undefined, async () => cold);
      assert.equal(result.firstSync, true);
      assert.equal(result.selectionState?.kind, "same");
      assert.equal(refs(), before);
      assert.deepEqual(await fs.readFile(localConfigPath()), settingsBefore);
      assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), "{}\n");
      await assert.rejects(fs.access(statePathForConfig(config)), { code: "ENOENT" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("queued Git cancellation is immediate; running cancellation drains cleanup before unlock", async () => {
  await withTempHome(async (agentDir) => {
    const fixture = createBareRemote();
    await fs.mkdir(agentDir, { recursive: true });
    const backend = new GitSyncBackend(gitConfig(fixture.remote), {
      allowLocalRemotes: true,
      cacheRoot: path.join(fixture.root, "cache"),
    });
    await backend.publishSnapshot(snapshot([{ path: "settings.json", content: Buffer.from("{}") }]), {
      kind: "missing",
    });
    const fetching = deferred();
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const original = runner.runGit;
    let fetches = 0;
    const spy = vi.spyOn(runner, "runGit").mockImplementation(async (args, options) => {
      if (args[0] === "fetch") {
        fetches++;
        fetching.resolve();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        options?.signal?.throwIfAborted();
      }
      if (args[0] === "update-ref" && args[1] === "-d") {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      }
      return original(args, options);
    });
    const controller = new AbortController();
    let settled = false;
    const operation = withLock("startup-check", () => backend.readHead(controller.signal));
    const outcome = operation.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        assert.equal(error.name, "AbortError");
      },
    );
    try {
      await fetching.promise;
      const queuedController = new AbortController();
      const queued = backend.readHead(queuedController.signal);
      queuedController.abort();
      await assert.rejects(queued, { name: "AbortError" });
      assert.equal(settled, false);
      assert.equal(fetches, 1);
      await fs.access(lockPath());
      controller.abort();
      await cleanupStarted.promise;
      assert.equal(settled, false);
      await fs.access(lockPath());
      releaseCleanup.resolve();
      await outcome;
      assert.equal(fetches, 1);
      await assert.rejects(fs.access(lockPath()), { code: "ENOENT" });
    } finally {
      controller.abort();
      releaseCleanup.resolve();
      await outcome;
      spy.mockRestore();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
