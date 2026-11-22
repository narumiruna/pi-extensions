import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { DaemonConnection } from "../src/client.js";
import { type DocumentView, documentFingerprint } from "../src/document.js";
import { DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import { syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import type { AnySyncConfig } from "../src/engine/settings/settings-types.js";
import { createEngineService } from "../src/engine-service.js";
import type { Callback, ClientFacts } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

async function fixture(
  available: boolean,
  run: (state: {
    root: string;
    settingsPath: string;
    source: string;
    methods: string[];
    connection: DaemonConnection;
    answer: (callback: (request: Callback) => Promise<boolean>) => void;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-ignore-ipc-")));
  const methods: string[] = [];
  const backend = createServer((request, response) => {
    methods.push(request.method ?? "");
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(0, "127.0.0.1", resolve);
    });
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    const settingsPath = path.join(root, "pi-sync.json");
    const source = JSON.stringify({
      version: 7,
      activeSyncSetup: "home",
      onSwitch: "switch-only",
      storageConnections: {
        origin: {
          type: "webdav",
          url: `http://127.0.0.1:${address.port}/dav`,
          credentials: { username: "fixture", password: "fixture" },
        },
      },
      syncSetups: {
        home: { storage: { connection: "origin", path: "home" }, sync: { include: ["skills"], automatic: false } },
      },
    });
    await fs.writeFile(settingsPath, source, { mode: 0o600 });
    await fs.writeFile(path.join(root, "notes.md"), "local-only fixture\n");
    const service = createEngineService(root, available);
    try {
      const facts: ClientFacts = {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: root,
        mode: "tui",
        hasUI: true,
        idle: true,
      };
      let onCallback = async (request: Callback): Promise<boolean> => assert.fail(`Unexpected ${request.kind}`);
      await withRpcServer(root, service.execute, async ({ createConnection }) => {
        const connection = await createConnection(facts, { callback: (request) => onCallback(request) }).attach();
        await run({
          root,
          settingsPath,
          source,
          methods,
          connection,
          answer: (callback) => {
            onCallback = callback;
          },
        });
      });
    } finally {
      await service.hooks.close();
    }
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const setup = { setup: "home" };
const rulesMissing = (root: string) => assert.rejects(fs.lstat(path.join(root, ".syncignore")), { code: "ENOENT" });

async function acquireOffer(connection: DaemonConnection) {
  const result = await connection.run("ignore.migration-offer", setup);
  assert.ok(result && typeof result === "object" && "token" in result && typeof result.token === "string");
  return { ...setup, offerToken: result.token };
}

test("published capability and IPC reject migration and switch without callback or backend access", () =>
  fixture(false, async ({ root, connection, methods, settingsPath, source }) => {
    assert.deepEqual(await connection.run("ignore.capabilities", {}), { available: false });
    await assert.rejects(connection.run("ignore.migrate", setup), /Unsupported engine operation/u);
    await assert.rejects(connection.run("ignore.switch", setup), /Unsupported engine operation/u);
    assert.deepEqual(methods, []);
    assert.deepEqual((await fs.readdir(root)).sort(), ["notes.md", "pi-sync.json"]);
    assert.equal(await fs.readFile(settingsPath, "utf8"), source);
  }));

test("reviewed first setup uses the existing settings writer without starting a transfer", () =>
  fixture(true, async ({ root, connection, methods, settingsPath, source, answer }) => {
    const base = JSON.parse(source);
    const next = {
      ...base,
      version: 8,
      syncSetups: {
        home: {
          ...base.syncSetups.home,
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
        },
      },
    };
    await fs.unlink(settingsPath);
    const rules = path.join(root, ".syncignore");
    await fs.writeFile(rules, "/private/\n");
    let accept = false;
    let reviews = 0;
    answer(async ({ kind, payload }) => {
      if (kind === "confirm") return true;
      assert.equal(kind, "merge-review");
      assert.match((payload as { content: string }).content, /Keep the existing rule file unchanged/u);
      await assert.rejects(fs.lstat(settingsPath), { code: "ENOENT" });
      reviews++;
      return accept;
    });
    await assert.rejects(connection.run("settings.cas", { expected: null, next }), /cancelled/u);
    await assert.rejects(fs.lstat(settingsPath), { code: "ENOENT" });
    accept = true;
    await connection.run("settings.cas", { expected: null, next });
    assert.equal(reviews, 2);
    assert.equal(await fs.readFile(rules, "utf8"), "/private/\n");
    assert.deepEqual(methods, []);

    const document = (await connection.run("settings.read", {})) as DocumentView;
    const expected = documentFingerprint(document);
    await assert.rejects(
      connection.run("settings.cas", { expected, next: base }),
      /reviewed Pi Sync ignore-file settings/u,
    );
    const edited = { ...next, debug: true, custom: { untouched: "allowed" } };
    await connection.run("settings.cas", { expected, next: edited });
    assert.equal(reviews, 2);
    assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).custom.untouched, "allowed");
    assert.deepEqual(methods, []);
  }));

test("inspection uses the active local source and a stale local fingerprint never contacts storage", () =>
  fixture(true, async ({ root, connection, methods, settingsPath, source, answer }) => {
    const base = JSON.parse(source);
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        ...base,
        version: 8,
        syncSetups: {
          ...base.syncSetups,
          private: {
            ...base.syncSetups.home,
            storage: { ...base.syncSetups.home.storage, path: "private" },
            sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
          },
        },
        activeSyncSetup: "private",
      }),
    );
    await assert.rejects(connection.run("inspect", { fingerprint: "unused" }), /Ignore file is missing/u);
    assert.deepEqual(methods, []);
    const rules = path.join(root, ".syncignore");
    await fs.writeFile(rules, "# private rule bytes\n/notes.md\n");
    answer(async ({ kind }) => {
      assert.equal(kind, "confirm");
      return true;
    });
    await connection.run("daemon.handover", {});
    const { config } = (await connection.run("initialize", {})) as { config: AnySyncConfig };
    assert.equal(config.pathPolicy, "ignore-file");
    assert.ok(config.ignorePolicy?.sourceDigest);
    assert.doesNotMatch(JSON.stringify(config), /private rule bytes/u);
    const fingerprint = syncCheckConfigFingerprint(config);
    await fs.appendFile(rules, "# changed after inspect token\n");
    await assert.rejects(connection.run("inspect", { fingerprint }), /Settings changed before inspection/u);
    assert.deepEqual(methods, []);
    const { config: latest } = (await connection.run("initialize", {})) as { config: AnySyncConfig };
    await connection.run("inspect", { fingerprint: syncCheckConfigFingerprint(latest) });
    assert.deepEqual(methods, ["GET"]);
  }));

test("available IPC validates inputs and a deferred or cancelled offer does not change settings", () =>
  fixture(true, async ({ root, connection, methods, settingsPath, source, answer }) => {
    assert.deepEqual(await connection.run("ignore.capabilities", {}), { available: true });
    await assert.rejects(connection.run("ignore.migrate", { ...setup, offerToken: "bad" }), /Invalid.*request/u);
    await assert.rejects(connection.run("ignore.migrate", { ...setup, yes: true }), /Invalid.*request/u);
    await assert.rejects(
      connection.run("ignore.switch", { ...setup, filename: "../rules", expectedFilename: ".syncignore" }),
      /safe filename/u,
    );
    assert.deepEqual(methods, []);
    const offered = await acquireOffer(connection);
    assert.deepEqual(methods, []);
    let reviews = 0;
    answer(async ({ kind, payload }) => {
      if (kind === "confirm") return true;
      assert.equal(kind, "merge-review");
      assert.match((payload as { content: string }).content, /Local — enters scope:\n {2}notes\.md/u);
      await rulesMissing(root);
      assert.equal(await fs.readFile(settingsPath, "utf8"), source);
      reviews += 1;
      return false;
    });
    assert.equal(await connection.run("ignore.migrate", offered), "cancelled");
    assert.equal(reviews, 1);
    assert.deepEqual(methods, ["GET"]);
    assert.equal(await connection.run("ignore.migration-defer", { ...setup, token: offered.offerToken }), true);
    await assert.rejects(connection.run("ignore.migrate", offered), /offer is stale/u);
    assert.deepEqual(methods, ["GET"]);
    assert.equal(await connection.run("ignore.migration-offer", setup), null);
    await rulesMissing(root);
    assert.equal(await fs.readFile(settingsPath, "utf8"), source);
  }));

test.for(["existing rule file", "new starter after deferral"] as const)(
  "confirmed IPC changes only local settings with an %s",
  (scenario) => {
    const shouldCreate = scenario === "new starter after deferral";
    return fixture(true, async ({ root, connection, methods, settingsPath, source, answer }) => {
      const defaultPath = path.join(root, ".syncignore");
      const alternative = path.join(root, "work.rules");
      if (!shouldCreate) await fs.writeFile(defaultPath, DEFAULT_IGNORE_RULES);
      const offered = await acquireOffer(connection);
      if (shouldCreate) {
        await connection.run("ignore.migration-defer", { ...setup, token: offered.offerToken });
        assert.equal(await connection.run("ignore.migration-offer", setup), null);
      }
      let reviews = 0;
      answer(async ({ kind, payload }) => {
        if (kind === "confirm") return true;
        assert.equal(kind, "merge-review");
        const { content } = payload as { content: string };
        if (reviews++ === 0) {
          if (shouldCreate) {
            assert.match(content, /Create the default rule file with the starter rules/u);
            await rulesMissing(root);
          } else {
            assert.match(content, /Keep the existing rule file unchanged/u);
          }
          assert.equal(await fs.readFile(settingsPath, "utf8"), source);
        } else {
          assert.match(content, /Existing rule file to use: .*work\.rules/u);
          assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).syncSetups.home.sync.ignoreFile, undefined);
        }
        return true;
      });
      assert.equal(await connection.run("ignore.migrate", shouldCreate ? setup : offered), "saved");
      assert.equal(await connection.run("ignore.migration-offer", setup), null);
      assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).syncSetups.home.sync.pathPolicy, "ignore-file");
      await fs.writeFile(alternative, "/notes.md\n");
      const switchRequest = { ...setup, filename: "work.rules", expectedFilename: ".syncignore" };
      assert.equal(await connection.run("ignore.switch", switchRequest), "saved");
      await assert.rejects(connection.run("ignore.switch", switchRequest), /changed.*reopen/iu);
      assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).syncSetups.home.sync.ignoreFile, "work.rules");
      assert.equal(await fs.readFile(defaultPath, "utf8"), DEFAULT_IGNORE_RULES);
      assert.equal(await fs.readFile(alternative, "utf8"), "/notes.md\n");
      assert.equal(reviews, 2);
      assert.ok(methods.length > 0);
      assert.ok(methods.every((method) => method === "GET"));
    });
  },
);
