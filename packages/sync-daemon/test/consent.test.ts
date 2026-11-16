import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection, ensureDaemon, stopDaemon } from "../dist/client.js";
import { runtimePaths } from "../src/identity.js";

const config = {
  version: 3,
  activeSyncSetup: "home",
  onSwitch: "switch-only",
  storageConnections: {
    dav: { type: "webdav", url: "http://127.0.0.1:9/dav", credentials: { username: "fixture", password: "fixture" } },
  },
  syncSetups: {
    home: {
      storage: { connection: "dav", path: "sync" },
      sync: { include: ["settings.json"], automatic: true, continuous: true, agentMode: true },
    },
  },
};
async function fixture(
  run: (state: {
    root: string;
    client: DaemonConnection;
    approve: (fn: () => Promise<boolean>) => void;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-daemon-consent-"));
  await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(config), { mode: 0o600 });
  let approval = async () => true;
  const daemon = await ensureDaemon(root);
  const client = await new DaemonConnection(
    daemon.paths,
    daemon.identity,
    {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd: root,
      mode: "rpc",
      hasUI: true,
      idle: false,
      ready: false,
      model: {
        provider: "unavailable-fixture",
        id: "unavailable-fixture",
        signature: "a".repeat(64),
        authSource: "models_json_key",
      },
    },
    {
      callback: async (callback) => {
        assert.equal(callback.kind, "confirm");
        if ((callback.payload as { title?: string }).title === "Adopt sync-daemon as the synchronization owner?")
          return true;
        return approval();
      },
    },
  ).attach();
  try {
    await client.run("daemon.handover", undefined);
    await run({
      root,
      client,
      approve: (fn) => {
        approval = fn;
      },
    });
  } finally {
    await client.dispose();
    await stopDaemon(root);
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}
type Policy = { fingerprint: string; afterExit: boolean };
async function readPolicy(client: DaemonConnection): Promise<Policy> {
  const value = (await client.run("daemon.policy", undefined)) as Policy;
  assert.equal(typeof value.fingerprint, "string");
  assert.equal(typeof value.afterExit, "boolean");
  return value;
}

test("unattended permission defaults off and reviewed enable/revoke preserves unknown fields", () =>
  fixture(async ({ root, client }) => {
    const target = path.join(root, "pi-sync", "daemon.json");
    const existing = JSON.parse(await fs.readFile(target, "utf8"));
    existing.future = { retain: true };
    existing.setups.home = { future: "retained", fingerprint: "f".repeat(64), afterExit: false };
    await fs.writeFile(target, JSON.stringify(existing), { mode: 0o600 });
    const policy = await readPolicy(client);
    assert.equal(policy.afterExit, false);
    assert.equal(await client.run("daemon.authorize", { ...policy, afterExit: true }), true);
    assert.equal((await readPolicy(client)).afterExit, true);
    assert.equal(await client.run("daemon.authorize", { ...policy, afterExit: false }), true);
    assert.equal((await readPolicy(client)).afterExit, false);
    const saved = JSON.parse(await fs.readFile(target, "utf8"));
    assert.deepEqual(saved.future, { retain: true });
    assert.equal(saved.setups.home.future, "retained");
  }));

for (const change of ["config", "model", "consent"] as const)
  test(`authorization cannot publish after ${change} changes during confirmation`, () =>
    fixture(async ({ root, client, approve }) => {
      const policy = await readPolicy(client);
      approve(async () => {
        if (change === "model") {
          const model = client.facts.model;
          assert.ok(model);
          await client.update({ ...client.facts, model: { ...model, signature: "b".repeat(64) } });
        } else if (change === "config") {
          const changed = structuredClone(config);
          changed.syncSetups.home.sync.include = ["AGENTS.md"];
          await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(changed), { mode: 0o600 });
        } else {
          const target = path.join(root, "pi-sync", "daemon.json");
          const document = JSON.parse(await fs.readFile(target, "utf8"));
          document.future = "external edit";
          await fs.writeFile(target, JSON.stringify(document), { mode: 0o600 });
        }
        return true;
      });
      await assert.rejects(client.run("daemon.authorize", { ...policy, afterExit: true }));
      const saved = JSON.parse(await fs.readFile(path.join(root, "pi-sync", "daemon.json"), "utf8"));
      assert.equal(saved.setups.home, undefined);
      if (change === "consent") assert.equal(saved.future, "external edit");
    }));

test("a changed interactive model permanently revokes the prior grant across restart", () =>
  fixture(async ({ root, client }) => {
    const policy = await readPolicy(client);
    await client.run("daemon.authorize", { ...policy, afterExit: true });
    const original = client.facts.model;
    assert.ok(original);
    await client.update({ ...client.facts, model: { ...original, signature: "c".repeat(64) } });
    await client.update({ ...client.facts, model: original });
    assert.equal((await readPolicy(client)).afterExit, false);
    await client.dispose();
    await stopDaemon(root);
    const owner = await ensureDaemon(root);
    const next = await new DaemonConnection(
      owner.paths,
      owner.identity,
      {
        ...client.facts,
        id: randomUUID(),
        generation: randomUUID(),
      },
      {
        callback: async () => {
          throw new Error("Unexpected policy review after restart.");
        },
      },
    ).attach();
    try {
      assert.equal((await readPolicy(next)).afterExit, false);
    } finally {
      await next.dispose();
    }
  }));

test("obsolete policy review is rejected before asking for approval", () =>
  fixture(async ({ root, client, approve }) => {
    const policy = await readPolicy(client);
    let approvals = 0;
    approve(async () => {
      approvals++;
      return true;
    });
    const changed = structuredClone(config);
    changed.syncSetups.home.sync.include = ["AGENTS.md"];
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(client.run("daemon.authorize", { ...policy, afterExit: true }), /Setup changed/u);
    assert.equal(approvals, 0);
  }));
