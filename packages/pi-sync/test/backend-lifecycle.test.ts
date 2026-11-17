import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pushSessionsOnShutdown } from "@narumitw/pi-sync-daemon/engine/sync/session-push";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import sync from "../src/sync.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { S3ProbeHarness } from "./s3-probe-harness.js";
import { deferred, observeCheckCompletion } from "./startup-check-helpers.js";

async function pendingStatus(event: "session_start" | "session_shutdown", webdav = false) {
  await withTempHome(async (agentDir) => {
    const entered = deferred();
    const disconnected = deferred();
    let aborted = false;
    const server = createServer((_request, response) => {
      entered.resolve();
      response.on("close", () => {
        if (!response.writableEnded) {
          aborted = true;
          disconnected.resolve();
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    mkdirSync(agentDir, { recursive: true });
    const settings = webdav ? v3WebDavSettings() : v3S3Settings();
    const endpoint = `http://127.0.0.1:${address.port}`;
    if ("dav" in settings.storageConnections) settings.storageConnections.dav.url = `${endpoint}/dav`;
    else settings.storageConnections.r2.endpoint = endpoint;
    writeFileSync(localConfigPath(), JSON.stringify(settings));
    const mock = createMockPi();
    sync(mock.pi);
    const context = createMockContext({ mode: "rpc" });
    const replacement = createMockContext({ mode: "rpc" });
    let operation: Promise<unknown> | undefined;
    try {
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      operation = Promise.resolve(mock.commands.get("sync")?.handler("status", context.ctx));
      void operation.catch(() => {});
      await entered.promise;
      await mock.events.get(event)?.[0]?.(
        { reason: event === "session_start" ? "new" : "reload" },
        event === "session_start" ? replacement.ctx : context.ctx,
      );
      await operation;
      await disconnected.promise;
      assert.equal(aborted, true);
    } finally {
      server.closeAllConnections();
      await mock.events.get("session_shutdown")?.[0]?.(
        { reason: "reload" },
        event === "session_start" ? replacement.ctx : context.ctx,
      );
      await operation?.catch(() => {});
      server.close();
      await once(server, "close");
    }
  });
}
test("session replacement aborts an actual in-flight S3 backend operation", () => pendingStatus("session_start"));
test("session shutdown aborts an actual in-flight S3 backend operation", () => pendingStatus("session_shutdown"));
test("session replacement aborts an actual in-flight WebDAV backend operation", () =>
  pendingStatus("session_start", true));

test("WebDAV lifecycle ignores deprecated S3 auto-sync environment overrides", () =>
  withTempHome(async (agentDir) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(401);
      response.end("denied");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    mkdirSync(agentDir, { recursive: true });
    const settings = v3WebDavSettings({ automatic: true });
    settings.storageConnections.dav.url = `http://127.0.0.1:${address.port}/dav`;
    writeFileSync(localConfigPath(), JSON.stringify(settings));
    const previous = process.env.PI_SYNC_AUTO_SYNC;
    process.env.PI_SYNC_AUTO_SYNC = "false";
    const mock = createMockPi();
    const context = createMockContext({ mode: "rpc" });
    try {
      await adoptFixtureRoot(agentDir);
      sync(mock.pi);
      const completion = observeCheckCompletion(context.ctx);
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await completion.completed;
      assert.ok(requests > 0);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      if (previous === undefined) delete process.env.PI_SYNC_AUTO_SYNC;
      else process.env.PI_SYNC_AUTO_SYNC = previous;
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  }));

const shutdownOptions = { args: [], yes: true, force: false, stale: false, silent: true, reload: false, auto: true };
function prepareSessions(agentDir: string) {
  mkdirSync(path.join(agentDir, "sessions", "--project--"), { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  writeFileSync(path.join(agentDir, "sessions", "--project--", "session.jsonl"), "{}\n");
  writeFileSync(
    localConfigPath(),
    JSON.stringify(v3S3Settings({ automatic: true, include: ["settings.json", "sessions"] })),
  );
}
test("replacement cancellation drains an engine-owned still-preparing shutdown publication", () =>
  withTempHome(async (agentDir) => {
    prepareSessions(agentDir);
    const entered = deferred();
    let aborted = false;
    const owner = new AbortController();
    const original = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal?.reason);
          },
          { once: true },
        ),
      );
    }) as typeof fetch;
    const context = createMockContext({ mode: "rpc" });
    const shutdown = pushSessionsOnShutdown(context.ctx, {
      ...shutdownOptions,
      signal: AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]),
    });
    void shutdown.catch(() => {});
    try {
      await entered.promise;
      writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["settings.json", "sessions"] })));
      owner.abort(new DOMException("Session replaced", "AbortError"));
      await assert.rejects(shutdown);
      assert.equal(aborted, true);
    } finally {
      owner.abort();
      await shutdown.catch(() => {});
      globalThis.fetch = original;
    }
  }));

test("engine shutdown owns an opt-in session publication with a bounded signal", () =>
  withTempHome(async (agentDir) => {
    prepareSessions(agentDir);
    let active: Record<string, unknown> | undefined;
    let snapshotSignal: AbortSignal | null | undefined;
    let latestPuts = 0;
    const original = globalThis.fetch;
    const probes = new S3ProbeHarness();
    globalThis.fetch = (async (input, init) => {
      const probe = probes.handle(input, init);
      if (probe) return probe;
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/snapshots/") && method === "PUT") {
        snapshotSignal = init?.signal;
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/latest.json")) {
        if (method === "PUT") {
          latestPuts++;
          active = parseJsonBody(init?.body);
          return new Response(null, { status: 200 });
        }
        return active ? Response.json(active) : new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/history.json")) return new Response(null, { status: method === "PUT" ? 200 : 404 });
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;
    try {
      const context = createMockContext({ mode: "rpc" });
      await pushSessionsOnShutdown(context.ctx, { ...shutdownOptions, signal: AbortSignal.timeout(30_000) });
      assert.equal(latestPuts, 1);
      assert.ok(snapshotSignal);
      assert.equal(snapshotSignal.aborted, false);
    } finally {
      globalThis.fetch = original;
    }
  }));
function parseJsonBody(body: BodyInit | null | undefined) {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
  throw new Error("Expected request body");
}
