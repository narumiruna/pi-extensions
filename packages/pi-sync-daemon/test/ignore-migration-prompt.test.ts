import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fstatSync, fsync, openSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { DaemonConnection } from "../src/client.js";
import { isDeniedPath } from "../src/engine/paths.js";
import { withLockedLocalConfigDocument } from "../src/engine/settings/config-file.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import type { ClientFacts, Execution } from "../src/protocol.js";
import { startServer } from "../src/server.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, fsync: vi.fn(original.fsync), openSync: vi.fn(original.openSync) };
});

const OFFER = "ignore.migration-offer";
const DEFER = "ignore.migration-defer";

function client(root: string): ClientFacts {
  return {
    id: randomUUID(),
    pid: process.pid,
    generation: randomUUID(),
    cwd: root,
    mode: "tui",
    hasUI: true,
    idle: true,
  };
}

function markerPath(root: string, setup = "home") {
  const key = createHash("sha256")
    .update(JSON.stringify([setup, 1]))
    .digest("hex");
  return path.join(root, `.pi-sync.json.ignore-migration-${key}.deferred`);
}

function token(result: unknown) {
  assert.ok(result && typeof result === "object" && "token" in result && typeof result.token === "string");
  assert.match(result.token, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(result), ["token"]);
  return result.token;
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-migration-prompt-")));
  const service = createEngineService(root);
  onTestFinished(async () => {
    await service.hooks.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const settingsPath = path.join(root, "pi-sync.json");
  const settings = {
    version: 7,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    future: { keep: [1, 2] },
    storageConnections: { main: { type: "git", remote: "https://example.invalid/sync.git" } },
    syncSetups: {
      home: {
        storage: { connection: "main", path: "home", branch: "main" },
        sync: { include: ["skills"], automatic: false },
      },
      work: {
        storage: { connection: "main", path: "work", branch: "main" },
        sync: { scope: "agent-directory", exclude: ["sessions"], automatic: false },
      },
    },
  };
  const writeSettings = () => fs.writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  await writeSettings();
  const facts = client(root);
  const abort = new AbortController();
  let generation = facts.generation;
  const execution: Execution = {
    root,
    clientId: facts.id,
    signal: abort.signal,
    facts: () => facts,
    participants: () => [facts],
    liveClients: () => [facts],
    withParticipants: () => {
      throw new Error("Unexpected participant reservation.");
    },
    validate: () => {
      abort.signal.throwIfAborted();
      if (generation !== facts.generation) throw new Error("Client session generation changed.");
    },
    request: async (kind) => {
      throw new Error(`Unexpected callback: ${kind}`);
    },
    emit: () => {
      throw new Error("Unexpected client event.");
    },
    committed: () => {
      throw new Error("Unexpected sync commit.");
    },
  };
  const offer = (setup = "home") => service.execute(OFFER, { setup }, execution);
  const defer = (token: string, setup = "home") => service.execute(DEFER, { setup, token }, execution);
  return {
    root,
    service,
    execution,
    facts,
    abort,
    adoptCurrentGeneration: () => {
      generation = facts.generation;
    },
    settings,
    settingsPath,
    writeSettings,
    offer,
    defer,
  };
}

test("only offers the active legacy setup, including legacy policies in a mixed v8 document", async () => {
  const { root, settingsPath, settings, offer } = await fixture();
  assert.equal(await offer("missing"), null);
  assert.equal(await offer("work"), null);
  const offered = token(await offer());
  assert.equal(token(await offer()), offered);
  const mixed = {
    ...settings,
    version: 8,
    syncSetups: {
      ...settings.syncSetups,
      home: {
        ...settings.syncSetups.home,
        sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
      },
    },
  };
  await fs.writeFile(settingsPath, JSON.stringify(mixed));
  assert.equal(await offer(), null);
  mixed.activeSyncSetup = "work";
  await fs.writeFile(settingsPath, JSON.stringify(mixed));
  token(await offer("work"));
  assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
});

test("validates absent, legacy-filename, invalid JSON, invalid setup and unsupported version documents", async () => {
  const { root, settingsPath, settings, offer, defer, writeSettings } = await fixture();
  const oldToken = token(await offer());
  await fs.rm(settingsPath);
  assert.equal(await offer(), null);
  await assert.rejects(defer(oldToken), /offer is stale/u);
  assert.deepEqual(await fs.readdir(root), []);
  const legacy = path.join(root, "pi-sync.local.json");
  await fs.writeFile(legacy, JSON.stringify(settings), { mode: 0o600 });
  token(await offer());
  assert.deepEqual(await fs.readdir(root), ["pi-sync.local.json"]);
  await fs.writeFile(settingsPath, "{");
  await assert.rejects(offer(), /Invalid JSON/u);
  await assert.rejects(defer(oldToken), /Invalid JSON/u);
  assert.equal(await fs.readFile(settingsPath, "utf8"), "{");
  settings.activeSyncSetup = "missing";
  await writeSettings();
  await assert.rejects(offer(), /activeSyncSetup must reference/u);
  settings.version = 9;
  await writeSettings();
  await assert.rejects(offer(), /Unsupported pi-sync settings/u);
  assert.deepEqual((await fs.readdir(root)).sort(), ["pi-sync.json", "pi-sync.local.json"]);
});

test.each(["active setup", "document bytes", "document path", "identical replacement"] as const)(
  "declining with a stale %s leaves no deferral",
  async (change) => {
    const { root, settingsPath, settings, writeSettings, offer, defer } = await fixture();
    const oldToken = token(await offer());
    if (change === "active setup") {
      settings.activeSyncSetup = "work";
      await writeSettings();
      assert.equal(await offer(), null);
      await assert.rejects(defer(oldToken, "work"), /offer is stale/u);
    } else if (change === "document bytes") {
      settings.future.keep.reverse();
      await writeSettings();
      assert.notEqual(token(await offer()), oldToken);
    } else if (change === "document path") {
      await fs.rename(settingsPath, path.join(root, "pi-sync.local.json"));
      assert.notEqual(token(await offer()), oldToken);
    } else {
      const alternate = path.join(root, "alternate");
      await fs.copyFile(settingsPath, alternate);
      await fs.rename(alternate, settingsPath);
      assert.notEqual(token(await offer()), oldToken);
    }
    await assert.rejects(defer(oldToken), /offer is stale/u);
    assert.deepEqual(await fs.readdir(root), [change === "document path" ? "pi-sync.local.json" : "pi-sync.json"]);
  },
);

test.skipIf(process.platform === "win32")(
  "rechecks the exact settings source immediately before publication",
  async () => {
    const { root, settings, settingsPath, offer, defer } = await fixture();
    const reviewed = token(await offer());
    const changed = JSON.stringify({ ...settings, activeSyncSetup: "work" });
    const realOpen = vi.mocked(openSync).getMockImplementation();
    assert.ok(realOpen);
    vi.mocked(openSync).mockImplementationOnce((target, flags, mode) => {
      assert.equal(target, root);
      writeFileSync(settingsPath, changed);
      return realOpen(target, flags, mode);
    });
    await assert.rejects(defer(reviewed), /settings changed/iu);
    assert.equal(await fs.readFile(settingsPath, "utf8"), changed);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
  },
);

test("requires an attached TUI with UI, validates input, and leaves activation unavailable", async () => {
  const { root, execution, service, offer } = await fixture();
  const reviewed = { setup: "home", token: token(await offer()) };
  const facts = execution.facts();
  assert.ok(facts);
  const unattached = [
    { ...execution, clientId: undefined },
    { ...execution, facts: () => undefined },
  ];
  const nonTui = ["rpc", "json", "print"].map(
    (mode) => ({ ...execution, facts: () => ({ ...facts, mode }) }) as Execution,
  );
  for (const origin of [...unattached, ...nonTui, { ...execution, facts: () => ({ ...facts, hasUI: false }) }]) {
    await assert.rejects(service.execute(OFFER, { setup: "home" }, origin), /attached TUI/u);
    await assert.rejects(service.execute(DEFER, reviewed, origin), /attached TUI/u);
  }
  await assert.rejects(service.execute(OFFER, { setup: "home", extra: true }, execution), /Invalid/u);
  await assert.rejects(service.execute(DEFER, { setup: "home", token: {} }, execution), /Invalid/u);
  await assert.rejects(service.execute(OFFER, { setup: "constructor" }, execution), /invalid sync setup name/u);
  assert.deepEqual(await service.execute("ignore.capabilities", {}, execution), { available: false });
  await assert.rejects(service.execute("ignore.migrate", reviewed, execution), /Unsupported engine operation/u);
  assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
});

test.each(["cancelled", "replaced"] as const)(
  "does not persist a %s decline queued behind settings",
  async (change) => {
    const { root, offer, defer, abort, facts, adoptCurrentGeneration } = await fixture();
    const reviewed = token(await offer());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withLockedLocalConfigDocument(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = defer(reviewed);
    const refused = assert.rejects(pending, /cancelled|generation changed/u);
    await entered.promise;
    if (change === "cancelled") abort.abort(new Error("Cancelled before publication: cancelled"));
    else facts.generation = randomUUID();
    release.resolve();
    await Promise.all([held, refused]);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
    if (change === "replaced") {
      adoptCurrentGeneration();
      assert.equal(token(await offer()), reviewed);
    }
  },
);

test("a live session at the marker path is not created or claimed", async () => {
  const { root, facts, offer, defer } = await fixture();
  const reviewed = token(await offer());
  facts.sessionFile = markerPath(root);
  await assert.rejects(defer(reviewed), /protected live session/u);
  assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
});

test.skipIf(process.platform === "win32").each(["directory", "nonempty", "public", "symlink", "hardlink"] as const)(
  "refuses a %s marker and preserves the existing path",
  async (kind) => {
    const { root, offer, defer } = await fixture();
    const reviewed = token(await offer());
    const marker = markerPath(root);
    const alias = path.join(root, "alias");
    if (kind === "directory") await fs.mkdir(marker);
    else if (kind === "nonempty") await fs.writeFile(marker, "unrelated", { mode: 0o600 });
    else if (kind === "public") {
      await fs.writeFile(marker, "");
      await fs.chmod(marker, 0o644);
    } else {
      await fs.writeFile(alias, "", { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(alias, marker);
      else await fs.link(alias, marker);
    }
    const before = await fs.lstat(marker);
    await assert.rejects(offer(), /Unsafe ignore migration deferral marker/u);
    await assert.rejects(defer(reviewed), /Unsafe ignore migration deferral marker/u);
    const after = await fs.lstat(marker);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.equal(after.size, before.size);
  },
);

test.skipIf(process.platform === "win32")("refuses a replaced agent root before publishing", async () => {
  const { root, offer, defer } = await fixture();
  const reviewed = token(await offer());
  const moved = `${root}-moved`;
  onTestFinished(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.rename(root, moved);
  await fs.symlink(moved, root);
  await assert.rejects(defer(reviewed), /Canonical agent root changed/u);
  assert.deepEqual(await fs.readdir(moved), ["pi-sync.json"]);
});

test("reopening the authenticated IPC service keeps Not now scoped to the setup", async () => {
  const { root, service, settingsPath, settings, writeSettings } = await fixture();
  const paths = await runtimePaths(root);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  const rules = path.join(root, ".syncignore");
  const source = await fs.readFile(settingsPath);
  await fs.writeFile(rules, "unrelated rules\n");
  if (process.platform !== "win32") await fs.chmod(settingsPath, 0o640);
  const marker = markerPath(root);
  assert.ok(isDeniedPath(path.basename(marker)));
  async function usingService(execute: typeof service.execute, run: (connection: DaemonConnection) => Promise<void>) {
    const server = await startServer(root, execute);
    const connection = new DaemonConnection(server.paths, server.identity, client(root), {
      callback: async ({ kind }) => {
        throw new Error(`Unexpected callback: ${kind}`);
      },
    });
    try {
      await connection.attach();
      await run(connection);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }
  await usingService(service.execute, async (connection) => {
    assert.deepEqual(await connection.run("ignore.capabilities", {}), { available: false });
    const setup = { setup: "home" };
    const first = token(await connection.run(OFFER, setup));
    assert.deepEqual((await fs.readdir(root)).sort(), [".syncignore", "pi-sync.json"]);
    assert.equal(token(await connection.run(OFFER, setup)), first);
    assert.equal(await connection.run(DEFER, { ...setup, token: first }), true);
    await assert.rejects(connection.run(DEFER, { ...setup, token: first }), /offer is stale/u);
  });
  assert.deepEqual(await fs.readFile(marker), Buffer.alloc(0));
  const metadata = await fs.lstat(marker);
  assert.ok(metadata.isFile());
  assert.equal(metadata.nlink, 1);
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o640);
  }
  assert.deepEqual(await fs.readFile(settingsPath), source);
  assert.equal(await fs.readFile(rules, "utf8"), "unrelated rules\n");
  assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(marker), ".syncignore", "pi-sync.json"]);
  const reopened = createEngineService(root);
  onTestFinished(() => reopened.hooks.close());
  await usingService(reopened.execute, async (connection) => {
    assert.equal(await connection.run(OFFER, { setup: "home" }), null);
    settings.activeSyncSetup = "work";
    await writeSettings();
    token(await connection.run(OFFER, { setup: "work" }));
    assert.equal(await connection.run(OFFER, { setup: "home" }), null);
    settings.activeSyncSetup = "home";
    await writeSettings();
    assert.equal(await connection.run(OFFER, { setup: "home" }), null);
  });
});

test("exclusive publication preserves a marker created by another writer", async () => {
  const { root, offer, defer } = await fixture();
  const reviewed = token(await offer());
  const marker = markerPath(root);
  const realOpen = vi.mocked(openSync).getMockImplementation();
  assert.ok(realOpen);
  vi.mocked(openSync).mockImplementation((target, flags, mode) => {
    if (target === marker) writeFileSync(marker, "concurrent evidence", { flag: "wx", mode: 0o600 });
    return realOpen(target, flags, mode);
  });
  try {
    await assert.rejects(defer(reviewed), /offer is stale/u);
    assert.equal(await fs.readFile(marker, "utf8"), "concurrent evidence");
  } finally {
    vi.mocked(openSync).mockImplementation(realOpen);
  }
});

test.skipIf(process.platform === "win32")(
  "failed directory flush reports uncertainty and retains the marker",
  async () => {
    const { root, offer, defer } = await fixture();
    const reviewed = token(await offer());
    const realFsync = vi.mocked(fsync).getMockImplementation();
    assert.ok(realFsync);
    vi.mocked(fsync)
      .mockImplementationOnce(realFsync)
      .mockImplementationOnce((fd, done) => {
        assert.ok(fstatSync(fd).isDirectory());
        done(new Error("Directory fsync failed"));
      });
    await assert.rejects(defer(reviewed), /marker durability could not be verified/u);
    assert.deepEqual(await fs.readFile(markerPath(root)), Buffer.alloc(0));
    assert.equal(await offer(), null);
  },
);

test.skipIf(process.platform === "win32")("success waits for file and directory flush", async () => {
  const { root, offer, defer } = await fixture();
  const reviewed = token(await offer());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const realFsync = vi.mocked(fsync).getMockImplementation();
  assert.ok(realFsync);
  const flushed: string[] = [];
  vi.mocked(fsync)
    .mockImplementationOnce((fd, done) => {
      flushed.push(fstatSync(fd).isFile() ? "file" : "other");
      return realFsync(fd, done);
    })
    .mockImplementationOnce((fd, done) => {
      flushed.push(fstatSync(fd).isDirectory() ? "directory" : "other");
      entered.resolve();
      void release.promise.then(() => realFsync(fd, done), done);
    });
  let complete = false;
  const publishing = defer(reviewed).finally(() => {
    complete = true;
  });
  try {
    await Promise.race([entered.promise, publishing]);
    assert.equal(complete, false);
    assert.deepEqual(flushed, ["file", "directory"]);
    assert.deepEqual(await fs.readFile(markerPath(root)), Buffer.alloc(0));
  } finally {
    release.resolve();
    await publishing;
  }
  assert.equal(await offer(), null);
});
