import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { findDaemon, stopDaemon } from "@narumitw/sync-daemon";
import { test } from "vitest";
import { SyncRpc } from "./daemon-rpc-helpers.js";
import { v3WebDavSettings } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

async function fixture(
  run: (value: {
    agent: string;
    connect(): SyncRpc;
    requests: Record<string, unknown>[];
    storage: MockWebDavServer;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-rpc-"));
  const agent = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const clients: SyncRpc[] = [];
  const requests: Record<string, unknown>[] = [];
  const storage = new MockWebDavServer();
  const failures: unknown[] = [];
  const api = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture" };
      response.end(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  try {
    await Promise.all([
      fs.mkdir(agent, { recursive: true }),
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(path.join(root, "home"), { recursive: true }),
    ]);
    await storage.start();
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
    settings.storageConnections.dav.url = storage.url;
    await fs.writeFile(path.join(agent, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
    await fs.writeFile(
      path.join(agent, "settings.json"),
      JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "sync-rpc-fixture": {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "owned-loopback-fixture",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 65536,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(agent, "AGENTS.md"), "Test-owned parent instructions.\n");
    await run({
      agent,
      requests,
      storage,
      connect() {
        const client = new SyncRpc(root, cwd, path.resolve("packages/pi-sync/src/index.ts"));
        clients.push(client);
        return client;
      },
    });
  } catch (error) {
    failures.push(error);
  }
  const closed = await Promise.allSettled(clients.map((client) => client.close()));
  for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
  let stopped = false;
  try {
    await stopDaemon(agent);
    stopped = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await storage.close();
  } catch (error) {
    failures.push(error);
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  if (stopped) {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Pi RPC fixture or cleanup failed.");
}

test("two real Pi RPC clients share a daemon through new-session, reload, and ordinary exit", () =>
  fixture(async ({ agent, connect, requests }) => {
    const first = connect();
    const second = connect();
    const [before] = await Promise.all([first.start(), second.start()]);
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
  }));

test("sync status preserves real Pi request prefixes and ordered tools; fork and resume reattach", () =>
  fixture(async ({ agent, connect, requests, storage }) => {
    const client = connect();
    await client.start();
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
    const original = await client.call({ type: "get_state" });
    const entries = (await client.call({ type: "get_entries" })).entries as {
      id: string;
      type: string;
      message?: { role: string };
    }[];
    const user = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
    assert.ok(user);
    const instance = (await findDaemon(agent))?.identity.instance;
    await client.call({ type: "fork", entryId: user.id });
    assert.notEqual((await client.call({ type: "get_state" })).sessionId, original.sessionId);
    assert.equal((await findDaemon(agent))?.identity.instance, instance);
    assert.equal(typeof original.sessionFile, "string");
    await client.call({ type: "switch_session", sessionPath: original.sessionFile as string });
    assert.equal((await client.call({ type: "get_state" })).sessionId, original.sessionId);
    assert.equal((await findDaemon(agent))?.identity.instance, instance);
    assert.equal(requests.length, 2);
    assert.ok(storage.requests.every((request) => ["GET", "PROPFIND"].includes(request.method)));
  }));
