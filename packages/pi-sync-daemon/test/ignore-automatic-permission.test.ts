import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { type DocumentView, documentFingerprint } from "../src/document.js";
import { syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import type { AnySyncConfig } from "../src/engine/settings/settings-types.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import type { Callback, ClientFacts } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

test("automatic permission requires a separate review and does not survive settings or rule source replacement", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-ignore-automatic-")));
  const rule = path.join(root, ".syncignore");
  const rules = "/private/\n";
  const backendCalls: string[] = [];
  const backend = createServer((request, response) => {
    backendCalls.push(request.method ?? "");
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(0, "127.0.0.1", resolve);
    });
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    const settings = {
      version: 8,
      activeSyncSetup: "home",
      onSwitch: "switch-only",
      storageConnections: {
        dav: {
          type: "webdav",
          url: `http://127.0.0.1:${address.port}/dav`,
          credentials: { username: "fixture", password: "fixture" },
        },
      },
      syncSetups: {
        home: {
          storage: { connection: "dav", path: "home" },
          sync: {
            scope: "agent-directory",
            pathPolicy: "ignore-file",
            sessions: true,
            automatic: true,
            automaticTransfer: true,
          },
        },
      },
    };
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
    await fs.writeFile(rule, rules, { mode: 0o600 });
    const service = createEngineService(root, true);
    let approve = false;
    let changeAtReview = false;
    let reviews = 0;
    async function confirm({ kind, payload }: Callback) {
      assert.equal(kind, "confirm");
      const { title } = payload as { title: string };
      if (title === "Adopt pi-sync-daemon as the synchronization owner?") return true;
      assert.equal(title, "Allow the enabled automatic sync modes for this setup?");
      reviews++;
      if (changeAtReview) {
        await fs.rename(rule, `${rule}.original`);
        await fs.writeFile(rule, rules, { mode: 0o600 });
      }
      return approve;
    }
    try {
      await withRpcServer(root, service.execute, async ({ createConnection }) => {
        const facts: ClientFacts = {
          id: randomUUID(),
          generation: randomUUID(),
          pid: process.pid,
          cwd: root,
          mode: "rpc",
          hasUI: true,
          idle: true,
          ready: true,
        };
        const client = await createConnection(facts, { callback: confirm }).attach();
        await client.run("daemon.handover", {});
        const policy = async () =>
          (await client.run("daemon.policy", {})) as { fingerprint: string; automatic: boolean };
        const eligibleConfig = async () => ((await client.run("initialize", {})) as { config: AnySyncConfig }).config;
        const checkDenied = async (operation: "startup-transfer" | "shutdown") => {
          const automaticFingerprint = syncCheckConfigFingerprint(await eligibleConfig());
          await assert.rejects(client.run(operation, { args: [], automaticFingerprint }), /separate approval/i);
        };
        assert.equal((await policy()).automatic, false);
        await checkDenied("startup-transfer");
        await checkDenied("shutdown");
        assert.equal(
          await client.run("daemon.authorize-connected", { fingerprint: (await policy()).fingerprint }),
          false,
        );
        assert.equal((await policy()).automatic, false);
        approve = true;
        changeAtReview = true;
        await assert.rejects(
          client.run("daemon.authorize-connected", { fingerprint: (await policy()).fingerprint }),
          /changed/i,
        );
        assert.equal((await policy()).automatic, false);
        changeAtReview = false;
        assert.equal(
          await client.run("daemon.authorize-connected", { fingerprint: (await policy()).fingerprint }),
          true,
        );
        const granted = await policy();
        assert.equal(granted.automatic, true);
        const document = (await client.run("settings.read", {})) as DocumentView;
        await client.run("settings.cas", {
          expected: documentFingerprint(document),
          next: { ...document.parsed, showStatus: false },
        });
        assert.equal((await policy()).automatic, false);
        await assert.rejects(
          client.run("daemon.authorize-connected", { fingerprint: granted.fingerprint }),
          /Setup changed/u,
        );
        await checkDenied("startup-transfer");
        await checkDenied("shutdown");
        assert.equal(reviews, 3);
        assert.deepEqual(backendCalls, []);
        assert.equal(await fs.readFile(rule, "utf8"), rules);
      });
    } finally {
      await service.hooks.close();
    }
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
