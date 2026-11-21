import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection } from "../src/client.js";
import { DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import { createEngineService } from "../src/engine-service.js";
import type { Callback, ClientFacts } from "../src/protocol.js";
import { startServer } from "../src/server.js";

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
      const server = await startServer(root, service.execute);
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
      const connection = new DaemonConnection(server.paths, server.identity, facts, {
        callback: (request) => onCallback(request),
      });
      try {
        await connection.attach();
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
      } finally {
        try {
          await connection.dispose();
        } finally {
          await server.close();
        }
      }
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
  (scenario, { skip }) => {
    const shouldCreate = scenario === "new starter after deferral";
    if (shouldCreate && process.platform !== "linux") skip("Native automatic creation is only verified on Linux.");
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
