import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import sync from "../src/sync.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { observeCheckCompletion } from "./startup-check-helpers.js";

test("session replacement aborts an in-flight backend operation owned by the old session", async () => {
  await withPendingStatusOperation("session_start");
});

test("session shutdown aborts an in-flight backend operation", async () => {
  await withPendingStatusOperation("session_shutdown");
});

test("WebDAV lifecycle ignores deprecated S3 auto-sync environment overrides", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3WebDavSettings({ automatic: true })));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("denied", { status: 401 });
    }) as typeof globalThis.fetch;
    process.env.PI_SYNC_AUTO_SYNC = "false";
    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx } = createMockContext({ hasUI: true });
      const completion = observeCheckCompletion(ctx);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      await completion.completed;
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
      assert.ok(requests > 0);
    } finally {
      delete process.env.PI_SYNC_AUTO_SYNC;
      globalThis.fetch = originalFetch;
    }
  });
});

test("session replacement aborts an in-flight WebDAV backend operation", async () => {
  await withPendingStatusOperation("session_start", v3WebDavSettings());
});

test("session replacement cancels a still-preparing shutdown publication", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, "sessions", "--project--"), { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
    writeFileSync(path.join(agentDir, "sessions", "--project--", "session.jsonl"), "{}\n");
    const enabled = v3S3Settings({ automatic: true, include: ["settings.json", "sessions"] });
    writeFileSync(localConfigPath(), JSON.stringify(enabled));
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;
    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx: shutdownCtx } = createMockContext({ hasUI: true });
      const shutdown = mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, shutdownCtx);
      await started;
      writeFileSync(
        localConfigPath(),
        JSON.stringify(v3S3Settings({ automatic: false, include: ["settings.json", "sessions"] })),
      );
      const { ctx: replacementCtx } = createMockContext({ hasUI: true });
      await mock.events.get("session_start")?.[0]?.({}, replacementCtx);
      await shutdown;

      assert.equal(aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("session shutdown owns an opt-in session publication with a bounded signal", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, "sessions", "--project--"), { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
    writeFileSync(path.join(agentDir, "sessions", "--project--", "session.jsonl"), "{}\n");
    writeFileSync(
      localConfigPath(),
      JSON.stringify(v3S3Settings({ automatic: true, include: ["settings.json", "sessions"] })),
    );
    let activePointer: Record<string, unknown> | undefined;
    let snapshotSignal: AbortSignal | null | undefined;
    let latestPuts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/snapshots/") && method === "PUT") {
        snapshotSignal = init?.signal;
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/latest.json")) {
        if (method === "PUT") {
          latestPuts += 1;
          activePointer = parseJsonBody(init?.body);
          return new Response(null, { status: 200 });
        }
        return activePointer ? Response.json(activePointer) : new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/history.json")) {
        return method === "PUT" ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof globalThis.fetch;
    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx } = createMockContext({ hasUI: true });
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, ctx);

      assert.equal(latestPuts, 1);
      assert.ok(snapshotSignal);
      assert.equal(snapshotSignal.aborted, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function withPendingStatusOperation(
  event: "session_start" | "session_shutdown",
  settings: Record<string, unknown> = v3S3Settings(),
) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(settings));
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;
    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx } = createMockContext({ hasUI: true });
      const operation = mock.commands.get("sync")?.handler("status", ctx);
      await started;

      const { ctx: lifecycleCtx } = createMockContext({ hasUI: true });
      if (event === "session_start") {
        await mock.events.get(event)?.[0]?.({}, lifecycleCtx);
      } else {
        await mock.events.get(event)?.[0]?.({ reason: "reload" }, lifecycleCtx);
      }
      await operation;

      assert.equal(aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

function parseJsonBody(body: BodyInit | null | undefined) {
  if (!body) throw new Error("Expected request body");
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
  }
  throw new Error("Unexpected request body");
}
