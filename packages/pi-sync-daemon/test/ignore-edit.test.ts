import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fstatSync, fsync, renameSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { DaemonConnection } from "../src/client.js";
import { DEFAULT_IGNORE_CREATION_RECORD, MAX_IGNORE_BYTES } from "../src/engine/ignore/ignore-source.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import type { ClientFacts, Execution } from "../src/protocol.js";
import { startServer } from "../src/server.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, fsync: vi.fn(original.fsync), renameSync: vi.fn(original.renameSync) };
});

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

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-edit-")));
  const service = createEngineService(root);
  onTestFinished(async () => {
    await service.hooks.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const settingsPath = path.join(root, "pi-sync.json");
  const target = path.join(root, ".syncignore");
  const settings = {
    version: 8,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    future: { arbitrary: [1, 2] },
    storageConnections: { main: { type: "git", remote: "https://example.invalid/sync.git" } },
    syncSetups: { home: setup("home"), shared: setup("shared"), work: setup("work", ".work.syncignore") },
  };
  const writeSettings = () => fs.writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  await writeSettings();
  const origin = client(root);
  const abort = new AbortController();
  const callbacks: string[] = [];
  let current = true;
  const execution: Execution = {
    root,
    clientId: origin.id,
    signal: abort.signal,
    facts: () => (current ? origin : undefined),
    participants: () => [origin],
    liveClients: () => [origin],
    withParticipants: (action) => action([origin]),
    validate: () => {
      abort.signal.throwIfAborted();
      if (!current) throw new Error("Client session generation changed.");
    },
    request: async (kind, payload) => {
      callbacks.push(kind);
      if (kind === "queue-acquire") assert.deepEqual((payload as { targets: string[] }).targets, [target]);
      return true;
    },
    emit: () => undefined,
    committed: () => callbacks.push("commit"),
  };
  const read = (name = "home") => service.execute("ignore.read", { setup: name }, execution);
  const save = (payload: unknown) => service.execute("ignore.save", payload, execution);
  return {
    root,
    service,
    execution,
    settings,
    settingsPath,
    target,
    writeSettings,
    callbacks,
    read,
    save,
    replaceClient: () => {
      current = false;
    },
    restoreClient: () => {
      current = true;
    },
  };
}

function proposal(result: unknown, text = "/edited/\n") {
  assert.ok(result && typeof result === "object" && "sourceDigest" in result && "identity" in result);
  return { setup: "home", text, sourceDigest: result.sourceDigest, identity: result.identity };
}

function onStage(action: () => Promise<unknown>) {
  const realFlush = vi.mocked(fsync).getMockImplementation();
  assert.ok(realFlush);
  vi.mocked(fsync).mockImplementationOnce((fd, done) => {
    assert.equal(fstatSync(fd).isFile(), true);
    void action().then(() => realFlush(fd, done), done);
  });
}

async function assertNoStage(root: string) {
  assert.equal(
    (await fs.readdir(root)).some((name) => name.includes("ignore-edit-")),
    false,
  );
}

test("reads existing, shared and missing sources without creating or changing settings or rules", async () => {
  const { root, target, read, callbacks, settingsPath } = await fixture();
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

test("does not expose or replace a live file configured as an ignore source", async () => {
  const { target, read, save, execution, callbacks } = await fixture();
  await fs.writeFile(target, "# original\n");
  const request = proposal(await read());
  const facts = execution.facts();
  assert.ok(facts);
  facts.sessionFile = target;
  await assert.rejects(read(), /protected live session/u);
  await assert.rejects(save(request), /protected live session/u);
  assert.equal(await fs.readFile(target, "utf8"), "# original\n");
  assert.deepEqual(callbacks, []);
});

test("saves privately with handover and queue release, without a settings write or transfer", async () => {
  const { root, target, read, save, callbacks, settingsPath } = await fixture();
  const settings = await fs.readFile(settingsPath);
  await fs.writeFile(target, "/old/\n");
  const request = proposal(await read(), "\uFEFF# new\r\n/changed/\r\n");
  const result = await save(request);
  assert.deepEqual(callbacks, ["confirm", "queue-acquire", "commit", "queue-release"]);
  assert.equal(await fs.readFile(target, "utf8"), request.text);
  assert.deepEqual(await read(), result);
  assert.notEqual(proposal(result).identity, request.identity);
  assert.notEqual(proposal(result).sourceDigest, request.sourceDigest);
  assert.deepEqual(await fs.readFile(settingsPath), settings);
  if (process.platform !== "win32") assert.equal((await fs.stat(target)).mode & 0o077, 0);
  await assertNoStage(root);
  assert.deepEqual(await save(proposal(result, request.text)), result);
  assert.deepEqual(callbacks.slice(4), ["queue-acquire", "queue-release"]);
});

test("requires a current client, approved handover, and acknowledged queue release", async () => {
  const { root, target, service, execution, read, callbacks } = await fixture();
  await fs.writeFile(target, "original\n");
  const request = proposal(await read());
  await assert.rejects(
    service.execute("ignore.save", request, {
      ...execution,
      clientId: undefined,
      facts: () => undefined,
    }),
    /requires a current client/u,
  );
  await assert.rejects(
    service.execute("ignore.save", request, { ...execution, request: async () => false }),
    /handover was not approved/u,
  );
  assert.deepEqual(callbacks, []);
  assert.equal(await fs.readFile(target, "utf8"), "original\n");
  await assert.rejects(
    service.execute("ignore.save", request, {
      ...execution,
      request: async (kind, payload) => {
        if (kind === "queue-release") throw new Error("Lost release acknowledgement");
        return execution.request(kind, payload);
      },
    }),
    /release is uncertain/u,
  );
  assert.deepEqual(callbacks, ["confirm", "queue-acquire", "commit"]);
  assert.equal(await fs.readFile(target, "utf8"), request.text);
  await assertNoStage(root);
});

test.each(["bytes", "identity", "missing", "pointer", "sharing", "setup"] as const)(
  "refuses an editor whose reviewed %s no longer matches without taking ownership",
  async (change) => {
    const { root, target, settings, writeSettings, read, save, callbacks } = await fixture();
    const old = "/before/\n";
    await fs.writeFile(target, old);
    const request = proposal(await read());
    if (change === "bytes") await fs.writeFile(target, "# changed\n");
    if (change === "identity" || change === "pointer") {
      const filename = ".other.syncignore";
      const alternate = path.join(root, filename);
      await fs.writeFile(alternate, old);
      if (change === "identity") await fs.rename(alternate, target);
      else {
        settings.syncSetups.home.sync.ignoreFile = filename;
        await writeSettings();
      }
    }
    if (change === "missing") await fs.rm(target);
    if (change === "sharing") {
      settings.syncSetups.shared.sync.ignoreFile = ".shared.syncignore";
      await writeSettings();
    }
    if (change === "setup") request.setup = "shared";
    await assert.rejects(save(request), /changed or disappeared/u);
    assert.deepEqual(callbacks, []);
    if (change === "missing") await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    else assert.equal(await fs.readFile(target, "utf8"), change === "bytes" ? "# changed\n" : old);
  },
);

test.each([
  "external edit",
  "disappearance",
  "settings pointer",
  "session replacement",
  "write failure",
  "rename failure",
] as const)("checks late %s before publishing and drains the reservation", async (change) => {
  const { root, target, settings, writeSettings, read, save, callbacks, replaceClient, restoreClient } =
    await fixture();
  await fs.writeFile(target, "/before/\n");
  const request = proposal(await read());
  if (change === "rename failure") {
    const rename = vi.mocked(renameSync).getMockImplementation();
    assert.ok(rename);
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === target) {
        vi.mocked(renameSync).mockImplementation(rename);
        throw new Error("Failed replacement");
      }
      return rename(from, to);
    });
    onTestFinished(() => {
      vi.mocked(renameSync).mockImplementation(rename);
    });
  } else {
    onStage(async () => {
      if (change === "external edit") await fs.writeFile(target, "# external\n");
      else if (change === "disappearance") await fs.rm(target);
      else if (change === "write failure") throw new Error("Failed staging write");
      else if (change === "settings pointer") {
        settings.syncSetups.home.sync.ignoreFile = ".other.syncignore";
        await writeSettings();
      } else replaceClient();
    });
  }
  await assert.rejects(save(request), /changed|Failed replacement|Failed staging write/u);
  assert.deepEqual(callbacks, ["confirm", "queue-acquire", "queue-release"]);
  await assertNoStage(root);
  if (change === "disappearance") {
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    await fs.writeFile(target, "/before/\n");
  } else assert.equal(await fs.readFile(target, "utf8"), change === "external edit" ? "# external\n" : "/before/\n");
  if (change === "settings pointer") {
    settings.syncSetups.home.sync.ignoreFile = undefined;
    await writeSettings();
  }
  restoreClient();
  await save(proposal(await read()));
  assert.equal(await fs.readFile(target, "utf8"), request.text);
});

test("rejects malformed requests and unsafe settings or content before handover", async () => {
  const { root, settings, settingsPath, target, read, save, callbacks } = await fixture();
  await fs.writeFile(target, "# original\n");
  const request = proposal(await read());
  await assert.rejects(save({ ...request, filename: ".different" }), /Invalid ignore-file request/u);
  await assert.rejects(save({ ...request, text: "bad\0text" }), /without NULs/u);
  await assert.rejects(save({ ...request, text: "\ud800" }), /must be UTF-8/u);
  await assert.rejects(save({ ...request, text: "é".repeat(MAX_IGNORE_BYTES / 2 + 1) }), /byte limit/u);
  await assert.rejects(save({ ...request, identity: {} }), /review evidence/u);
  await fs.writeFile(target, Buffer.from([0xc3, 0x28]));
  await assert.rejects(read(), /\.syncignore.*valid UTF-8/u);
  await fs.writeFile(target, "x".repeat(MAX_IGNORE_BYTES + 1));
  await assert.rejects(read(), /\.syncignore.*byte limit/u);
  await fs.writeFile(path.join(root, DEFAULT_IGNORE_CREATION_RECORD), "pending");
  await assert.rejects(read(), /unfinished creation record/u);
  await fs.writeFile(settingsPath, "not JSON");
  await assert.rejects(save(request), /Invalid JSON/u);
  assert.equal(await fs.readFile(settingsPath, "utf8"), "not JSON");
  settings.syncSetups.home.sync.ignoreFile = "trust.json";
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  await assert.rejects(read(), /reserved filename/u);
  assert.deepEqual(callbacks, []);
});

test.skipIf(process.platform === "win32")("never exposes a configured symlink or linked alias", async () => {
  const { root, target, read, save } = await fixture();
  const protectedFile = path.join(root, "auth.json");
  await fs.writeFile(protectedFile, "private\n");
  await fs.writeFile(target, "# original\n");
  const request = proposal(await read());
  await fs.unlink(target);
  await fs.symlink(protectedFile, target);
  await assert.rejects(read(), /use a regular file with no symlinks or hard links/u);
  await assert.rejects(save(request), /use a regular file with no symlinks or hard links/u);
  await fs.unlink(target);
  await fs.link(protectedFile, target);
  await assert.rejects(read(), /use a regular file with no symlinks or hard links/u);
  assert.equal(await fs.readFile(protectedFile, "utf8"), "private\n");
});

test.skipIf(process.platform === "win32")(
  "reports uncertain directory durability only after marking the write committed",
  async () => {
    const { root, target, read, save, callbacks } = await fixture();
    await fs.writeFile(target, "# original\n");
    const request = proposal(await read());
    const realFlush = vi.mocked(fsync).getMockImplementation();
    assert.ok(realFlush);
    vi.mocked(fsync)
      .mockImplementationOnce(realFlush)
      .mockImplementationOnce((fd, done) => {
        assert.equal(fstatSync(fd).isDirectory(), true);
        done(new Error("Directory fsync failed"));
      });
    await assert.rejects(save(request), /was replaced but its durability could not be verified/u);
    assert.deepEqual(callbacks, ["confirm", "queue-acquire", "commit", "queue-release"]);
    assert.equal(await fs.readFile(target, "utf8"), request.text);
    await assertNoStage(root);
    await assert.rejects(save(request), /changed or disappeared/u);
  },
);

test.skipIf(process.platform === "win32")(
  "keeps a newer external edit made during committed directory sync",
  async () => {
    const { root, target, read, save, callbacks } = await fixture();
    await fs.writeFile(target, "# original\n");
    const request = proposal(await read());
    const realFlush = vi.mocked(fsync).getMockImplementation();
    assert.ok(realFlush);
    vi.mocked(fsync)
      .mockImplementationOnce(realFlush)
      .mockImplementationOnce((fd, done) => {
        assert.equal(fstatSync(fd).isDirectory(), true);
        void fs.writeFile(target, "# external\n").then(() => realFlush(fd, done), done);
      });
    await assert.rejects(save(request), /changed or disappeared/u);
    assert.deepEqual(callbacks, ["confirm", "queue-acquire", "commit", "queue-release"]);
    assert.equal(await fs.readFile(target, "utf8"), "# external\n");
    await assertNoStage(root);
  },
);

test("real RPC serializes two clients' proposals and finishes the winning job only after queue release", async () => {
  const { root, service, target } = await fixture();
  await fs.writeFile(target, "# original\n");
  const server = await startServer(root, service.execute);
  const paths = await runtimePaths(root);
  const connections: DaemonConnection[] = [];
  const releaseEntered = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  try {
    for (const index of [0, 1]) {
      const connection = new DaemonConnection(server.paths, server.identity, client(root), {
        callback: async ({ kind }) => {
          if (index === 1 && kind === "queue-release") {
            releaseEntered.resolve();
            await acknowledge.promise;
          }
          return true;
        },
      });
      connections.push(connection);
      await connection.attach();
    }
    const [first, second] = connections;
    const [firstSource, secondSource] = await Promise.all([
      first.run("ignore.read", { setup: "home" }),
      second.run("ignore.read", { setup: "home" }),
    ]);
    const winner = proposal(firstSource, "# winner\n");
    const loser = proposal(secondSource, "# loser\n");
    let finished = false;
    const winning = first.run("ignore.save", winner).finally(() => {
      finished = true;
    });
    void winning.catch(() => undefined);
    await Promise.race([releaseEntered.promise, winning]);
    assert.equal(finished, false);
    assert.equal(await fs.readFile(target, "utf8"), winner.text);
    const losing = assert.rejects(second.run("ignore.save", loser), /changed or disappeared/u);
    acknowledge.resolve();
    await Promise.all([winning, losing]);
    assert.equal(await fs.readFile(target, "utf8"), winner.text);
  } finally {
    acknowledge.resolve();
    for (const connection of connections) await connection.dispose();
    await server.close();
    await fs.rm(paths.directory, { recursive: true, force: true });
  }
});
