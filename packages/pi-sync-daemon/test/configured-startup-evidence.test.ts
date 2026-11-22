import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { documentFingerprint } from "../src/document.js";
import { configureEngineHost } from "../src/engine/host.js";
import { captureStartupReviewLock, withLock } from "../src/engine/state/lock.js";
import { captureStartupBootstrap } from "../src/engine/sync/startup-bootstrap.js";

const settings = {
  version: 6,
  onSwitch: "switch-only",
  activeSyncSetup: "home",
  storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
  syncSetups: {
    home: {
      storage: { connection: "git", branch: "sync", path: "./" },
      sync: { include: ["settings.json"], automatic: false },
    },
  },
};

async function fixture(run: (root: string, settingsFile: string, fingerprint: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-startup-evidence-")));
  configureEngineHost({
    root: () => root,
    async mutate() {
      throw new Error("Startup must not mutate Pi files.");
    },
    async review() {
      throw new Error("Startup must not request review.");
    },
  });
  try {
    const settingsFile = path.join(root, "pi-sync.json");
    const bytes = Buffer.from(JSON.stringify(settings));
    await fs.writeFile(settingsFile, bytes, { mode: 0o600 });
    await fs.mkdir(path.join(root, "pi-sync"));
    await fs.writeFile(
      path.join(root, "pi-sync", "daemon.json"),
      JSON.stringify({
        version: 1,
        root,
        handover: true,
        nonce: "0".repeat(64),
        setups: {},
      }),
      { mode: 0o600 },
    );
    const { dev, ino } = await fs.stat(settingsFile);
    const fingerprint = documentFingerprint({ bytes: bytes.toString("base64"), identity: { dev, ino } });
    assert.ok(fingerprint);
    await run(root, settingsFile, fingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("startup reuses the validated canonical document and does not publish recovery or settings writes", () =>
  fixture(async (root, settingsFile, fingerprint) => {
    const signal = new AbortController().signal;
    const stat = await fs.lstat(settingsFile, { bigint: true });
    const evidence = captureStartupBootstrap(root, fingerprint, signal);
    assert.ok(evidence?.());
    assert.deepEqual((await fs.readdir(root)).sort(), ["pi-sync", "pi-sync.json"]);
    assert.deepEqual(await fs.readdir(path.join(root, "pi-sync")), ["daemon.json"]);
    assert.equal((await fs.lstat(settingsFile, { bigint: true })).ctimeNs, stat.ctimeNs);
  }));

test.each(["settings bytes", "settings identity", "settings lock", "orphan journal", "migration lock"])(
  "startup proof does not authorize readiness after %s changes",
  (change) =>
    fixture(async (root, settingsFile, fingerprint) => {
      const signal = new AbortController().signal;
      const evidence = captureStartupBootstrap(root, fingerprint, signal);
      assert.ok(evidence);
      if (change === "settings bytes")
        await fs.writeFile(settingsFile, JSON.stringify(settings).replace("home", "away"));
      if (change === "settings identity") {
        const replacement = `${settingsFile}.replacement`;
        await fs.writeFile(replacement, await fs.readFile(settingsFile), { mode: 0o600 });
        await fs.rename(replacement, settingsFile);
      }
      if (change === "settings lock") await fs.mkdir(`${settingsFile}.mutation-lock`);
      if (change === "orphan journal")
        await fs.mkdir(path.join(root, "pi-sync", "transactions", "orphan"), { recursive: true });
      if (change === "migration lock") await fs.mkdir(path.join(root, ".pi-sync-state-migration.lock"));
      assert.equal(evidence(), false);
      assert.equal(captureStartupBootstrap(root, fingerprint, signal), undefined);
    }),
);

test("only the exact current operation lock can supply review evidence", () =>
  fixture(async (root, _file, fingerprint) => {
    const signal = new AbortController().signal;
    const evidence = await withLock("pull", async () => {
      assert.equal(captureStartupBootstrap(root, fingerprint, signal), undefined);
      const reviewLock = captureStartupReviewLock();
      assert.ok(reviewLock);
      const evidence = captureStartupBootstrap(root, fingerprint, signal, reviewLock);
      assert.ok(evidence?.());
      return evidence;
    });
    assert.equal(evidence?.(), false);
    await fs.writeFile(
      path.join(root, "pi-sync", "lock"),
      JSON.stringify({ id: "old", pid: process.pid, command: "pull", startedAt: new Date().toISOString() }),
    );
    assert.equal(captureStartupReviewLock(), undefined);
    assert.equal(captureStartupBootstrap(root, fingerprint, signal), undefined);
  }));

test("an external process operation lease invalidates in-flight readiness", () =>
  fixture(async (root, _file, fingerprint) => {
    const signal = new AbortController().signal;
    const evidence = captureStartupBootstrap(root, fingerprint, signal);
    assert.ok(evidence);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import fs from "node:fs/promises";
    const lock = process.argv[1];
    await fs.mkdir(lock + ".guard");
    await fs.writeFile(lock, JSON.stringify({ id: "other", pid: process.pid, command: "recovery", startedAt: new Date().toISOString() }));
    process.on("message", () => {});
    process.send("locked");
  `,
        path.join(root, "pi-sync", "lock"),
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const ended = once(child, "exit");
    try {
      await Promise.race([
        once(child, "message"),
        ended.then(() => {
          throw new Error("Child exited before acquiring the operation lock.");
        }),
      ]);
      assert.equal(evidence(), false);
      assert.equal(captureStartupBootstrap(root, fingerprint, signal), undefined);
    } finally {
      child.kill();
      await ended;
    }
  }));

test("cancelled startup evidence cannot later authorize readiness", () =>
  fixture(async (root, _file, fingerprint) => {
    const abort = new AbortController();
    const evidence = captureStartupBootstrap(root, fingerprint, abort.signal);
    assert.ok(evidence);
    abort.abort(new Error("session replaced"));
    assert.throws(evidence, /session replaced/u);
    assert.throws(() => captureStartupBootstrap(root, fingerprint, abort.signal), /session replaced/u);
  }));
