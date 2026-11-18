import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { ensureDaemon, findDaemon, stopDaemon } from "@narumitw/pi-sync-daemon";
import { SyncRpc } from "./daemon-rpc-helpers.js";
import { v3WebDavSettings } from "./data-fixtures.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

export interface RpcFixture {
  agent: string;
  cwd: string;
  connect(sessionDir?: string, signal?: AbortSignal): Promise<SyncRpc>;
  startDaemon(): Promise<void>;
  prepare<T>(action: () => Promise<T>): Promise<T>;
  requests: Record<string, unknown>[];
  storage: MockWebDavServer;
}

/** Own setup and teardown separately from each five-second operation test. */
export async function createRpcFixture(
  context: { signal: AbortSignal; onTestFinished(cleanup: () => Promise<void>): void },
  extension = path.resolve("packages/pi-sync/src/index.ts"),
  startOwner: (agent: string) => Promise<() => Promise<unknown>> = async (agent) => {
    await ensureDaemon(agent);
    return () => stopDaemon(agent);
  },
): Promise<RpcFixture> {
  context.signal.throwIfAborted();
  let root: string | undefined;
  let agent = "";
  let cwd = "";
  let closing = false;
  let storageStarted = false;
  let daemonAttempted = false;
  let stopOwner: (() => Promise<unknown>) | undefined;
  let daemonStartup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const clients: SyncRpc[] = [];
  const preparations = new Set<Promise<unknown>>();
  const requests: Record<string, unknown>[] = [];
  const storage = new MockWebDavServer();
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
  const cancel = () => {
    closing = true;
    for (const client of clients) void client.dispose().catch(() => {});
  };
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(() => {
    disposal ??= (async () => {
      cancel();
      const failures: unknown[] = [];
      // Join creators before stopping: stopDaemon alone cannot fence a late ensureDaemon publication.
      await setup.catch(() => {});
      await Promise.allSettled([...preparations]);
      const closed = await Promise.allSettled(clients.map((client) => client.dispose()));
      for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
      let stopped = !daemonAttempted;
      if (stopOwner) {
        try {
          await stopOwner();
          assert.equal(await findDaemon(agent), undefined);
          stopped = true;
        } catch (error) {
          failures.push(error);
        }
      } else if (daemonAttempted) {
        failures.push(new Error(`Daemon startup was uncertain; fixture root retained: ${root}`));
      }
      try {
        if (storageStarted) await storage.close();
      } catch (error) {
        failures.push(error);
      }
      if (api.listening) {
        api.closeAllConnections();
        await new Promise<void>((resolve) => api.close(() => resolve()));
      }
      if (stopped && root) {
        try {
          await fs.rm(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      context.signal.removeEventListener("abort", cancel);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Pi RPC fixture cleanup failed.");
    })();
    return disposal;
  });
  const setup = (async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-rpc-"));
    context.signal.throwIfAborted();
    agent = path.join(root, "agent");
    cwd = path.join(root, "project");
    await Promise.all([
      fs.mkdir(agent, { recursive: true }),
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(path.join(root, "home"), { recursive: true }),
    ]);
    context.signal.throwIfAborted();
    await storage.start();
    storageStarted = true;
    context.signal.throwIfAborted();
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    context.signal.throwIfAborted();
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
    context.signal.throwIfAborted();
  })();
  await setup;
  return {
    agent,
    cwd,
    requests,
    storage,
    connect(sessionDir, signal = context.signal) {
      return prepare(async () => {
        await startDaemon();
        if (closing) throw new Error("Pi RPC fixture is closing.");
        context.signal.throwIfAborted();
        assert.ok(root);
        const client = new SyncRpc(root, cwd, extension, sessionDir, signal);
        clients.push(client);
        return client;
      });
    },
    startDaemon,
    prepare,
  };

  function startDaemon(): Promise<void> {
    return prepare(async () => {
      // Own startup before either adoption or a Pi child can create a detached owner.
      daemonAttempted = true;
      daemonStartup ??= startOwner(agent).then((stop) => {
        stopOwner = stop;
      });
      await daemonStartup;
      if (closing) throw new Error("Pi RPC fixture is closing.");
      context.signal.throwIfAborted();
    });
  }

  function prepare<T>(action: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("Pi RPC fixture is closing."));
    const task = Promise.resolve().then(() => {
      if (closing) throw new Error("Pi RPC fixture is closing.");
      context.signal.throwIfAborted();
      return action();
    });
    preparations.add(task);
    void task.finally(() => preparations.delete(task)).catch(() => {});
    return task;
  }
}
