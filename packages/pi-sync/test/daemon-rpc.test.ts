import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { findDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, describe, test, vi } from "vitest";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { configFromSettings } from "../src/settings/config.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import type { ContinuousRecord } from "../src/sync/continuous-record.js";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { snapshot, v3WebDavSettings } from "./helpers.js";

let owned: RpcFixture;
beforeEach(async (context) => {
  owned = await createRpcFixture(context);
});

describe("shared daemon lifecycle", () => {
  let first: SyncRpc;
  let second: SyncRpc;
  let before: Record<string, unknown>;
  beforeEach(() =>
    owned.prepare(async () => {
      first = await owned.connect();
      second = await owned.connect();
      [before] = await Promise.all([first.start(), second.start()]);
    }),
  );

  test("two real Pi RPC clients share a daemon through new-session, reload, and ordinary exit", async () => {
    const { agent, requests } = owned;
    const daemon = await findDaemon(agent);
    assert.ok(daemon);
    assert.notEqual(daemon.identity.pid, first.child.pid);
    assert.notEqual(daemon.identity.pid, second.child.pid);
    assert.equal((await first.call({ type: "new_session" })).cancelled, false);
    assert.notEqual((await first.call({ type: "get_state" })).sessionId, before.sessionId);
    await first.call({ type: "prompt", message: "/test-sync-reload" });
    assert.equal((await findDaemon(agent))?.identity.instance, daemon.identity.instance);
    await first.close();
    assert.equal((await findDaemon(agent))?.identity.instance, daemon.identity.instance);
    await second.call({ type: "get_state" });
    await second.close();
    assert.equal((await findDaemon(agent))?.identity.instance, daemon.identity.instance);
    assert.equal(requests.length, 0);
  });
});

describe("resource reload after a changed WebDAV pull", () => {
  let client: SyncRpc;
  let file: string;
  let original: string;

  beforeEach(() =>
    owned.prepare(async () => {
      client = await owned.connect();
      await client.start();
      file = path.join(owned.agent, "AGENTS.md");
      original = await fs.readFile(file, "utf8");
      await client.command("/sync push --yes", () => true);
      await fs.writeFile(file, "Local edit before pull.\n");
    }),
  );

  for (const accept of [true, false]) {
    test(`${accept ? "accepting" : "declining"} reload returns control`, async () => {
      const starts = client.sessionStarts;
      const confirmations: string[] = [];
      const pull = client.command("/sync pull --force --yes", (title) => {
        confirmations.push(title);
        return accept;
      });
      // The apply and confirmation must succeed even on the deadlocking baseline.
      try {
        await pull;
      } finally {
        assert.deepEqual(confirmations, ["Reload Pi resources now?"]);
        assert.equal(await fs.readFile(file, "utf8"), original);
      }
      await client.call({ type: "get_state" });
      await client.command("/sync status", () => false);
      assert.equal(client.sessionStarts, starts + (accept ? 1 : 0));
      assert.equal(owned.requests.length, 0);
    });
  }
});

for (const transition of [false, true])
  describe(`peer session roots (new destination: ${transition})`, () => {
    let first: SyncRpc;
    let destination: string;
    let session: string;
    let settingsFile: string;
    beforeEach(() =>
      owned.prepare(async () => {
        const { agent, cwd, storage } = owned;
        const oldRoot = path.join(path.dirname(agent), "old-sessions");
        const peerRoot = path.join(path.dirname(agent), "peer-sessions");
        destination = transition ? path.join(path.dirname(agent), "new-sessions") : oldRoot;
        await fs.mkdir(oldRoot);
        await fs.mkdir(peerRoot);
        settingsFile = path.join(agent, "settings.json");
        const before = { ...JSON.parse(await fs.readFile(settingsFile, "utf8")), sessionDir: oldRoot };
        const after = { ...before, sessionDir: destination };
        await fs.writeFile(settingsFile, JSON.stringify(before));
        const settings = v3WebDavSettings({ include: ["settings.json", "sessions"] });
        settings.storageConnections.dav.url = storage.url;
        await fs.writeFile(path.join(agent, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
        const config = configFromSettings(validateSettingsDocument(settings));
        assert.equal(config.backend.type, "webdav");
        if (config.backend.type !== "webdav") throw new Error("Expected fixture backend.");
        session = `${JSON.stringify({ type: "session", version: 3, id: "transferred", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
        const remote = {
          ...snapshot([
            { path: "settings.json", content: Buffer.from(JSON.stringify(after)) },
            { path: "sessions/transferred.jsonl", content: Buffer.from(session) },
          ]),
          profile: config.snapshotIdentity,
          selection: { version: 1 as const, include: ["settings.json", "sessions"] },
        };
        await new WebDavSyncBackend(config.backend).publishSnapshot(remote, { kind: "missing" });
        await owned.startDaemon();
        await adoptFixtureRoot(agent);
        first = await owned.connect(oldRoot);
        const second = await owned.connect(peerRoot);
        await Promise.all([first.start(), second.start()]);
      }),
    );

    test(`a real Pi pull coordinates different peer session roots${transition ? " and a new external destination" : ""}`, async () => {
      const confirmations: string[] = [];
      await first.command("/sync pull --force --yes", (title) => {
        confirmations.push(title);
        return false;
      });
      assert.equal(await fs.readFile(path.join(destination, "transferred.jsonl"), "utf8"), session);
      assert.equal(JSON.parse(await fs.readFile(settingsFile, "utf8")).sessionDir, destination);
      assert.ok(confirmations.every((title) => title.includes("Reload")));
      assert.equal(owned.requests.length, 0);
      assert.ok(
        !first.records.some(
          (record) =>
            record.type === "extension_ui_request" &&
            String(record.message).includes("Invalid daemon mutation targets"),
        ),
      );
    });
  });

describe("Continuous retry", () => {
  let client: SyncRpc;
  beforeEach(() =>
    owned.prepare(async () => {
      const { agent } = owned;
      const settingsFile = path.join(agent, "pi-sync.json");
      const settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      Object.assign(settings.syncSetups.home.sync, { continuous: true, agentMode: true });
      await fs.writeFile(settingsFile, JSON.stringify(settings));
      await owned.startDaemon();
      await adoptFixtureRoot(agent);
      client = await owned.connect();
      await client.start();
    }),
  );

  test("a real explicit sync resumes Continuous after repaired authentication without resetting accounting", async () => {
    const { agent, requests, storage } = owned;
    const directory = path.join(agent, "pi-sync", "continuous");
    const record = async () => {
      const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
      assert.equal(names.length, 1);
      const name = names[0];
      assert.ok(name);
      return JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as ContinuousRecord;
    };
    const phase = async (stage: string, expected: ContinuousRecord["phase"], error?: string) =>
      vi.waitFor(
        async () => {
          const current = await record();
          assert.equal(current.phase, expected, `${stage}: ${JSON.stringify(current)}`);
          assert.equal(current.error, error);
        },
        { timeout: 1_000, interval: 5 },
      );
    await client.command("/sync push --yes", () => false);
    await phase("accepted baseline", "waiting");
    storage.options.deny = true;
    await client.command("/sync status", () => false);
    await phase("backend failure", "blocked", "authentication");
    const before = await record();
    storage.options.deny = false;
    await client.command("/sync sync", () => false);
    await phase("explicit retry", "waiting");
    const after = await record();
    assert.deepEqual(after.calls, before.calls);
    assert.deepEqual(after.attempts, before.attempts);
    assert.equal(after.binding, before.binding);
    assert.equal(requests.length, 0);
  });
});

describe("request prefixes and session replacement", () => {
  let client: SyncRpc;
  beforeEach(() =>
    owned.prepare(async () => {
      client = await owned.connect();
      await client.start();
    }),
  );

  test("sync status preserves real Pi request prefixes and ordered tools", async () => {
    const { requests, storage } = owned;
    await client.prompt("prefix one");
    const before = await client.call({ type: "get_messages" });
    await client.call({ type: "prompt", message: "/sync status" });
    assert.deepEqual(await client.call({ type: "get_messages" }), before);
    await client.prompt("prefix two");
    assert.equal(requests.length, 2);
    const [first, second] = requests;
    assert.ok(first && second);
    const prefix = first.messages as unknown[];
    assert.deepEqual((second.messages as unknown[]).slice(0, prefix.length), prefix);
    assert.deepEqual(second.tools, first.tools);
    assert.ok(Array.isArray(first.tools) && first.tools.length > 0);
    assert.ok(storage.requests.every((request) => ["GET", "PROPFIND"].includes(request.method)));
  });

  test("fork and resume reattach to the existing daemon without another model request", async () => {
    const { agent, requests } = owned;
    await client.prompt("session seed");
    const original = await client.call({ type: "get_state" });
    const entries = (await client.call({ type: "get_entries" })).entries as {
      id: string;
      type: string;
      message?: { role: string };
    }[];
    const user = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
    assert.ok(user);
    const daemon = await findDaemon(agent);
    assert.ok(daemon);
    const instance = daemon.identity.instance;
    await client.call({ type: "fork", entryId: user.id });
    assert.notEqual((await client.call({ type: "get_state" })).sessionId, original.sessionId);
    assert.equal((await findDaemon(agent))?.identity.instance, instance);
    assert.equal(typeof original.sessionFile, "string");
    await client.call({ type: "switch_session", sessionPath: original.sessionFile as string });
    assert.equal((await client.call({ type: "get_state" })).sessionId, original.sessionId);
    assert.equal((await findDaemon(agent))?.identity.instance, instance);
    assert.equal(requests.length, 1);
  });
});

test("cancelling RPC bootstrap releases the child and rejects readiness", async () => {
  const controller = new AbortController();
  const client = await owned.connect(undefined, controller.signal);
  controller.abort();
  await assert.rejects(client.start(), /RPC fixture cancelled/u);
  await client.dispose();
  assert.equal((await client.exited).signal, "SIGKILL");
});

describe("pending RPC cancellation", () => {
  let client: SyncRpc;
  let controller: AbortController;
  beforeEach(() =>
    owned.prepare(async () => {
      controller = new AbortController();
      client = await owned.connect(undefined, controller.signal);
      await client.start();
    }),
  );

  test("cancelling an observed pending command rejects it and releases the child", async () => {
    const observed = once(client.child, "message");
    const rejected = assert.rejects(
      client.call({ type: "prompt", message: "/test-sync-pending" }),
      /RPC fixture cancelled/u,
    );
    const [message] = await observed;
    assert.deepEqual(message, { type: "pending" });
    controller.abort();
    await rejected;
    await client.dispose();
    assert.equal((await client.exited).signal, "SIGKILL");
    assert.equal(owned.requests.length, 0);
  });

  test("cancellation after a handled prompt response rejects the pending settled wait", async () => {
    const rejected = assert.rejects(client.prompt("/sync help"), /RPC fixture cancelled/u);
    await vi.waitFor(() => {
      assert.ok(
        client.records.some((record) => record.type === "response" && record.command === "prompt" && record.success),
      );
    });
    controller.abort();
    await rejected;
    await client.dispose();
    assert.equal((await client.exited).signal, "SIGKILL");
    assert.equal(owned.requests.length, 0);
  });
});
