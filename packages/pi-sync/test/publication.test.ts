import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import sync from "../src/sync.js";
import { v3S3Settings as requiredConfig, snapshot, withTempHome } from "./helpers.js";

test("snapshot staging failure leaves the prior latest pointer active", async () => {
  await withPublicationHarness({ failSnapshot: true }, async ({ counts, notifications }) => {
    assert.equal(counts.snapshotPuts, 1);
    assert.equal(counts.latestPuts, 0);
    assert.match(notifications(), /S3 PUT failed/);
  });
});

test("history failure reports the newly published snapshot as active and repairable", async () => {
  await withPublicationHarness({ failHistory: true }, async ({ counts, notifications }) => {
    assert.equal(counts.snapshotPuts, 1);
    assert.equal(counts.latestPuts, 1);
    assert.equal(counts.historyPuts, 1);
    assert.match(notifications(), /Remote snapshot is active, but history could not be updated/);
  });
});

test("active-head write failure reports an unknown publication outcome", async () => {
  await withPublicationHarness({ failLatest: true }, async ({ counts, notifications }) => {
    assert.equal(counts.snapshotPuts, 1);
    assert.equal(counts.latestPuts, 1);
    assert.equal(counts.historyPuts, 0);
    assert.match(notifications(), /publication outcome is unknown/i);
  });
});

test("post-publication verification reports an observed competing head", async () => {
  await withPublicationHarness({ replaceAfterLatest: true }, async ({ counts, notifications }) => {
    assert.equal(counts.snapshotPuts, 1);
    assert.equal(counts.latestPuts, 1);
    assert.equal(counts.historyPuts, 0);
    assert.match(notifications(), /changed immediately after push/i);
  });
});

async function withPublicationHarness(
  failures: {
    failSnapshot?: boolean;
    failHistory?: boolean;
    failLatest?: boolean;
    replaceAfterLatest?: boolean;
  },
  assertions: (state: {
    counts: { snapshotPuts: number; latestPuts: number; historyPuts: number };
    notifications: () => string;
  }) => Promise<void>,
) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), '{"local":"new"}\n');
    writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
    const remote = {
      ...snapshot([{ path: "settings.json", content: Buffer.from('{"remote":"old"}\n') }]),
      profile: "home",
    };
    const remoteEncoded = gzipSync(Buffer.from(JSON.stringify(remote)));
    let activePointer: Record<string, unknown> = {
      version: 1,
      profile: "home",
      snapshot: remote.id,
      sha256: createHash("sha256").update(remoteEncoded).digest("hex"),
      createdAt: remote.createdAt,
      machine: remote.machine,
    };
    let replaceOnNextLatestRead = false;
    const counts = { snapshotPuts: 0, latestPuts: 0, historyPuts: 0 };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/latest.json")) {
        if (method === "PUT") {
          counts.latestPuts += 1;
          if (failures.failLatest) return new Response("latest failed", { status: 503 });
          activePointer = parseRequestJson(init?.body);
          replaceOnNextLatestRead = failures.replaceAfterLatest === true;
          return new Response(null, { status: 200 });
        }
        if (replaceOnNextLatestRead) {
          replaceOnNextLatestRead = false;
          return Response.json(
            { ...activePointer, snapshot: "concurrent-writer" },
            {
              headers: { etag: '"concurrent"' },
            },
          );
        }
        return Response.json(activePointer, { headers: { etag: '"latest"' } });
      }
      if (url.pathname.includes("/snapshots/")) {
        if (method === "PUT") {
          counts.snapshotPuts += 1;
          return failures.failSnapshot
            ? new Response("staging failed", { status: 503 })
            : new Response(null, { status: 200 });
        }
        return new Response(new Uint8Array(remoteEncoded), { headers: { etag: '"snapshot"' } });
      }
      if (url.pathname.endsWith("/history.json")) {
        if (method === "PUT") {
          counts.historyPuts += 1;
          return failures.failHistory
            ? new Response("history failed", { status: 503 })
            : new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof globalThis.fetch;
    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx, notifications } = createMockContext({ hasUI: true });

      await mock.commands.get("sync")?.handler("push --yes --force", ctx);

      await assertions({
        counts,
        notifications: () => notifications.map((item) => item.message).join("\n"),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

function parseRequestJson(body: BodyInit | null | undefined) {
  if (!body) throw new Error("Expected request body");
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
  }
  throw new Error("Unexpected request body");
}
