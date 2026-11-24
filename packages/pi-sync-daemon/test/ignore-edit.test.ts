import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { DEFAULT_IGNORE_CREATION_RECORD, MAX_IGNORE_BYTES } from "../src/engine/ignore/ignore-source.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import type { ClientFacts, Execution } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

function setup(directory: string, filename?: string) {
  return {
    storage: { connection: "main", path: directory, branch: "main" },
    sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false, ignoreFile: filename },
  };
}

function client(root: string): ClientFacts {
  return {
    id: randomUUID(),
    pid: process.pid,
    generation: randomUUID(),
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: true,
  };
}

async function fixture(version: 8 | 9 = 8) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-edit-")));
  const service = createEngineService(root);
  onTestFinished(async () => {
    await service.hooks.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const settingsPath = path.join(root, "pi-sync.json");
  const target = path.join(root, ".syncignore");
  const settings = {
    version,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    future: { arbitrary: [1, 2] },
    storageConnections: { main: { type: "git", remote: "https://example.invalid/sync.git" } },
    syncSetups: { home: setup("home"), shared: setup("shared"), work: setup("work", ".work.syncignore") },
  };
  await fs.writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const origin = client(root);
  const signal = new AbortController().signal;
  const callbacks: string[] = [];
  const execution: Execution = {
    root,
    clientId: origin.id,
    signal,
    facts: () => origin,
    participants: () => [origin],
    liveClients: () => [origin],
    withParticipants: (action) => action([origin]),
    validate: () => signal.throwIfAborted(),
    request: async (kind) => {
      callbacks.push(kind);
      return true;
    },
    emit: () => undefined,
    committed: () => callbacks.push("commit"),
  };
  const read = (name = "home") => service.execute("ignore.read", { setup: name }, execution);
  return { root, service, origin, settings, settingsPath, target, callbacks, read };
}

function proposal(result: unknown, text = "/edited/\n") {
  assert.ok(result && typeof result === "object" && "sourceDigest" in result && "identity" in result);
  return { setup: "home", text, sourceDigest: result.sourceDigest, identity: result.identity };
}

test.each([8, 9] as const)("version %i reads existing, shared and missing rules without writes", async (version) => {
  const { root, target, read, callbacks, settingsPath } = await fixture(version);
  const originalSettings = await fs.readFile(settingsPath);
  assert.deepEqual(await read(), { filename: ".syncignore", path: target, sharingSetups: ["shared"] });
  assert.deepEqual(await read("work"), {
    filename: ".work.syncignore",
    path: path.join(root, ".work.syncignore"),
    sharingSetups: [],
  });
  assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
  const text = "\uFEFF# literal  \r\n/work/\r\n";
  await fs.writeFile(target, text);
  const source = await read();
  const review = proposal(source);
  assert.deepEqual(source, {
    filename: ".syncignore",
    path: target,
    sharingSetups: ["shared"],
    text,
    sourceDigest: review.sourceDigest,
    identity: review.identity,
  });
  assert.notEqual(proposal(await read("shared")).sourceDigest, review.sourceDigest);
  assert.deepEqual(await fs.readFile(settingsPath), originalSettings);
  assert.equal(await fs.readFile(target, "utf8"), text);
  assert.deepEqual(callbacks, []);
});

test("absent or legacy settings do not expose an ignore editor or rewrite settings", async () => {
  const { root, target, settings, settingsPath, read } = await fixture();
  await fs.rm(settingsPath);
  await assert.rejects(read(), /setup no longer exists/u);
  assert.deepEqual(await fs.readdir(root), []);
  const legacy = JSON.stringify({
    ...settings,
    version: 7,
    syncSetups: {
      home: { storage: settings.syncSetups.home.storage, sync: { include: ["skills"], automatic: false } },
    },
  });
  const legacyPath = path.join(root, "pi-sync.local.json");
  await fs.writeFile(legacyPath, legacy, { mode: 0o600 });
  await assert.rejects(read(), /does not use an ignore file/u);
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  await assert.rejects(fs.lstat(settingsPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacy);
});

test("blocks a live file even when the client reports it through an aliased directory", async () => {
  const { root, target, read, origin, callbacks } = await fixture();
  const directory = path.join(root, "alias");
  await fs.symlink(root, directory, "junction");
  origin.sessionFile = path.join(directory, ".syncignore");
  assert.deepEqual(await read(), { filename: ".syncignore", path: target, sharingSetups: ["shared"] });
  await fs.writeFile(target, "# original\n");
  await assert.rejects(read(), /protected live session/u);
  origin.sessionFile = target;
  await assert.rejects(read(), /protected live session/u);
  assert.equal(await fs.readFile(target, "utf8"), "# original\n");
  assert.deepEqual(callbacks, []);
});

test("rejects unsafe settings or content before showing rules", async () => {
  const { root, settings, settingsPath, target, read, callbacks } = await fixture();
  await fs.writeFile(target, Buffer.from([0xc3, 0x28]));
  await assert.rejects(read(), /\.syncignore.*valid UTF-8/u);
  await fs.writeFile(target, "x".repeat(MAX_IGNORE_BYTES + 1));
  await assert.rejects(read(), /\.syncignore.*byte limit/u);
  await fs.writeFile(path.join(root, DEFAULT_IGNORE_CREATION_RECORD), "pending");
  await assert.rejects(read(), /unfinished creation record/u);
  await fs.writeFile(settingsPath, "not JSON");
  await assert.rejects(read(), /Invalid JSON/u);
  assert.equal(await fs.readFile(settingsPath, "utf8"), "not JSON");
  settings.syncSetups.home.sync.ignoreFile = "trust.json";
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  await assert.rejects(read(), /reserved filename/u);
  assert.deepEqual(callbacks, []);
});

test.skipIf(process.platform === "win32")("never exposes a configured symlink or linked alias", async () => {
  const { root, target, read } = await fixture();
  const protectedFile = path.join(root, "auth.json");
  await fs.writeFile(protectedFile, "private\n");
  await fs.symlink(protectedFile, target);
  await assert.rejects(read(), /use a regular file with no symlinks or hard links/u);
  await fs.unlink(target);
  await fs.link(protectedFile, target);
  await assert.rejects(read(), /use a regular file with no symlinks or hard links/u);
  assert.equal(await fs.readFile(protectedFile, "utf8"), "private\n");
});

test("RPC refuses saves without touching unchanged, replaced or missing rules", async () => {
  const { root, service, target, settingsPath } = await fixture();
  await fs.writeFile(target, "# original\n");
  const originalSettings = await fs.readFile(settingsPath);
  const paths = await runtimePaths(root);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  const callbacks: string[] = [];
  await withRpcServer(root, service.execute, async ({ createConnection }) => {
    const connection = await createConnection(client(root), {
      callback: async ({ kind }) => {
        callbacks.push(kind);
        return false;
      },
    }).attach();
    assert.deepEqual(await connection.run("ignore.capabilities", {}), { available: false });
    const request = proposal(await connection.run("ignore.read", { setup: "home" }));
    const unavailable = /saves are unavailable.*edit the existing rule file manually/iu;
    await assert.rejects(connection.run("ignore.save", request), unavailable);
    assert.equal(await fs.readFile(target, "utf8"), "# original\n");
    await fs.writeFile(target, "# external\n");
    await assert.rejects(connection.run("ignore.save", request), unavailable);
    assert.equal(await fs.readFile(target, "utf8"), "# external\n");
    await fs.rm(target);
    await assert.rejects(connection.run("ignore.save", request), unavailable);
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(settingsPath), originalSettings);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
    assert.deepEqual(callbacks, []);
  });
});
