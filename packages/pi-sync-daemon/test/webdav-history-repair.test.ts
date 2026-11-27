import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { ConnectionOptions, DaemonConnection } from "../src/client.js";
import type { LatestPointer } from "../src/engine/backends/backend-types.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import { withRpcServer } from "./rpc-server-fixture.js";

const options = { args: [], yes: true };
const repairChoice = "Repair active snapshot history";
const storage = "https://history-fixture.invalid/dav/";
const latestPath = "/dav/home/latest.json";
const historyPath = "/dav/home/history.json";
const active: LatestPointer = {
  version: 1,
  snapshot: "active",
  profile: "home",
  createdAt: "2026-11-27T00:00:00.000Z",
  machine: "fixture",
  sha256: "a".repeat(64),
};
const earlier = { ...active, snapshot: "previous", createdAt: "2026-11-26T00:00:00.000Z" };
const newer = { ...active, snapshot: "new-active", createdAt: "2026-11-28T00:00:00.000Z" };
const historyBody = (...snapshots: LatestPointer[]) => Buffer.from(JSON.stringify({ version: 1, snapshots }));
const etag = (body: Buffer) => `"${createHash("sha256").update(body).digest("hex")}"`;

type Request = { method: string; path: string; headers: Headers; signal?: AbortSignal | null };
function mockStorage() {
  const objects = new Map<string, Buffer>([[latestPath, Buffer.from(JSON.stringify(active))]]);
  const requests: Request[] = [];
  const rules = {
    ignoresConditionals: false,
    cleanupFails: false,
    weakHistoryEtag: false,
    beforeRequest: (_request: Request): void | Promise<void> => undefined,
  };
  const fetch = async (input: URL, init: RequestInit) => {
    assert.equal(input.origin, new URL(storage).origin);
    const request = {
      method: init.method ?? "GET",
      path: input.pathname,
      headers: new Headers(init.headers),
      signal: init.signal,
    };
    requests.push(request);
    await rules.beforeRequest(request);
    request.signal?.throwIfAborted();
    const existing = objects.get(request.path);
    if (request.method === "GET") {
      return existing
        ? new Response(existing.toString(), {
            headers: { etag: `${request.path === historyPath && rules.weakHistoryEtag ? "W/" : ""}${etag(existing)}` },
          })
        : new Response(null, { status: 404 });
    }
    if (request.method === "PUT") {
      if (!rules.ignoresConditionals) {
        const ifMatch = request.headers.get("if-match");
        if (
          (existing && request.headers.get("if-none-match") === "*") ||
          (ifMatch && (!existing || ifMatch !== etag(existing)))
        )
          return new Response(null, { status: 412 });
      }
      assert.ok(Buffer.isBuffer(init.body));
      objects.set(request.path, init.body);
      return new Response(null, { status: existing ? 204 : 201, headers: { etag: etag(init.body) } });
    }
    if (request.method === "DELETE") {
      assert.ok(request.path.includes("/.pi-sync-probes/"));
      if (rules.cleanupFails) return new Response(null, { status: 500 });
      for (const key of objects.keys()) if (key.startsWith(`${request.path}/`)) objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.method === "MKCOL") return new Response(null, { status: 201 });
    assert.equal(request.method, "PROPFIND");
    return new Response("<multistatus><response><href>/fixture</href></response></multistatus>", { status: 207 });
  };
  return {
    objects,
    rules,
    fetch,
    writes: () => requests.filter(({ method }) => ["PUT", "MKCOL", "DELETE"].includes(method)),
    historyWrites: () => requests.filter(({ method, path }) => method === "PUT" && path === historyPath),
    assertProbeCleaned() {
      assert.equal(requests.filter(({ method }) => method === "DELETE").length, 1);
      assert.ok(![...objects.keys()].some((key) => key.includes("/.pi-sync-probes/")));
    },
  };
}

function settings(password: string) {
  return {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    storageConnections: { dav: { type: "webdav", url: storage, credentials: { username: "fixture-user", password } } },
    syncSetups: {
      home: { storage: { connection: "dav", path: "home" }, sync: { include: ["settings.json"], automatic: false } },
    },
  };
}

async function fixture(
  mode: "tui" | "rpc",
  run: (fixture: {
    remote: ReturnType<typeof mockStorage>;
    save: (password: string) => Promise<void>;
    attach: (handlers: ConnectionOptions) => Promise<DaemonConnection>;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-history-repair-")));
  await using resources = new AsyncDisposableStack();
  resources.defer(() => fs.rm(root, { recursive: true, force: true }));
  resources.defer(async () => fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true }));
  const save = async (password: string) => {
    const draft = path.join(root, "fixture-settings.tmp");
    await fs.writeFile(draft, JSON.stringify(settings(password)), { mode: 0o600 });
    await fs.rename(draft, path.join(root, "pi-sync.json"));
  };
  await save("fixture-password");
  const remote = mockStorage();
  vi.stubGlobal("fetch", remote.fetch);
  resources.defer(() => {
    vi.unstubAllGlobals();
  });
  const service = createEngineService(root);
  await withRpcServer(root, service.execute, async ({ server, createConnection }) => {
    service.bind(server);
    await run({
      remote,
      save,
      attach: (handlers) =>
        createConnection(
          { id: randomUUID(), pid: process.pid, generation: randomUUID(), cwd: root, mode, hasUI: true, idle: true },
          handlers,
        ).attach(),
    });
  });
}

test.each(["tui", "rpc"] as const)("History repairs the reviewed WebDAV entry in %s only after confirmation", (mode) =>
  fixture(mode, async ({ attach, remote }) => {
    remote.objects.set(historyPath, historyBody(earlier));
    const confirmed = vi.fn();
    const commit = vi.fn();
    const event = vi.fn();
    let allowRepair = true;
    const client = await attach({
      event,
      callback: async ({ kind, payload }) => {
        if (kind === "select") {
          const items = (payload as { items: string[] }).items;
          assert.equal(items.includes(repairChoice), allowRepair);
          if (mode === "tui" && allowRepair) assert.ok(items.every((item) => !item.includes("(current)")));
          return allowRepair ? repairChoice : "Back";
        }
        assert.equal(kind, "confirm");
        assert.deepEqual(remote.writes(), []);
        confirmed(payload);
        return true;
      },
    });
    await client.run("history", options, undefined, commit);
    assert.equal(commit.mock.calls.length, 1);
    assert.equal(confirmed.mock.calls.length, 1);
    const review = JSON.stringify(confirmed.mock.calls[0]);
    assert.match(review, /home.*history-fixture\.invalid.*active.*temporary conditional write\/delete probe/u);
    assert.doesNotMatch(review, /fixture-(?:user|password)/u);
    assert.deepEqual(remote.objects.get(latestPath), Buffer.from(JSON.stringify(active)));
    assert.deepEqual(remote.objects.get(historyPath), historyBody(earlier, active));
    assert.equal(remote.historyWrites().length, 1);
    assert.equal(remote.historyWrites()[0]?.headers.get("if-match"), etag(historyBody(earlier)));
    assert.ok(remote.writes().every(({ path }) => path === historyPath || path.includes("/.pi-sync-probes/")));
    remote.assertProbeCleaned();
    assert.ok(
      event.mock.calls.some(([event]) => JSON.stringify(event).includes("Active WebDAV snapshot added to History.")),
    );

    allowRepair = false;
    const writes = remote.writes();
    await client.run("history", options);
    assert.deepEqual(remote.writes(), writes);
    assert.equal(confirmed.mock.calls.length, 1);
  }),
);

test.each(["back", "decline", "present", "no head"])(
  "History does not probe or write when the repair is %s",
  (action) =>
    fixture("rpc", async ({ attach, remote }) => {
      if (action === "no head") remote.objects.delete(latestPath);
      const callbacks: string[] = [];
      const commit = vi.fn();
      const client = await attach({
        callback: async ({ kind }) => {
          callbacks.push(kind);
          if (kind === "select") return action === "back" ? "Back" : repairChoice;
          assert.equal(kind, "confirm");
          if (action === "present") remote.objects.set(historyPath, historyBody(active));
          return action === "present";
        },
      });
      await client.run("history", options, undefined, commit);
      assert.deepEqual(callbacks, action === "no head" ? [] : action === "back" ? ["select"] : ["select", "confirm"]);
      assert.deepEqual(remote.writes(), []);
      assert.equal(commit.mock.calls.length, 0);
    }),
);

test("An unreadable active pointer does not hide existing WebDAV History or offer repair", () =>
  fixture("tui", async ({ attach, remote }) => {
    remote.objects.set(latestPath, Buffer.from("malformed"));
    remote.objects.set(historyPath, historyBody(earlier));
    const reviewed = vi.fn();
    const client = await attach({
      callback: async ({ kind, payload }) => {
        assert.equal(kind, "select");
        reviewed(payload);
        return "Back";
      },
    });
    await client.run("history", options);
    assert.equal(reviewed.mock.calls.length, 1);
    const items = reviewed.mock.calls[0]?.[0].items as string[];
    assert.ok(items[0]?.includes("previous"));
    assert.ok(!items.includes(repairChoice));
    assert.deepEqual(remote.writes(), []);
  }));

test.each([
  ["credentials", "confirmation"],
  ["head", "confirmation"],
  ["credentials", "probe cleanup"],
  ["head", "probe cleanup"],
  ["session", "confirmation"],
  ["session", "probe cleanup"],
  ["UI", "confirmation"],
] as const)("History aborts when reviewed %s change during %s", (change, stage) =>
  fixture("tui", async ({ attach, remote, save }) => {
    const changeReviewedTarget = async () => {
      if (change === "credentials") await save("changed-password");
      else if (change === "session") await client.update({ ...client.facts, sessionId: randomUUID() });
      else if (change === "UI") await client.update({ ...client.facts, hasUI: false });
      else remote.objects.set(latestPath, Buffer.from(JSON.stringify(newer)));
    };
    if (stage === "probe cleanup") {
      remote.rules.beforeRequest = async ({ method }) => {
        if (method === "DELETE") await changeReviewedTarget();
      };
    }
    const client = await attach({
      callback: async ({ kind }) => {
        if (kind === "select") return repairChoice;
        assert.equal(kind, "confirm");
        if (stage === "confirmation") await changeReviewedTarget();
        return true;
      },
    });
    const commit = vi.fn();
    const message = {
      head: /active WebDAV snapshot changed/u,
      credentials: /setup settings changed/u,
      session: /Session changed during file mutation/u,
      UI: /no longer has an observable TUI or RPC client/u,
    };
    await assert.rejects(client.run("history", options, undefined, commit), message[change]);
    assert.equal(commit.mock.calls.length, 0);
    assert.deepEqual(remote.historyWrites(), []);
    if (stage === "probe cleanup") remote.assertProbeCleaned();
    else assert.deepEqual(remote.writes(), []);
  }),
);

test.each(["ignoresConditionals", "cleanupFails"] as const)("History fails closed when WebDAV %s", (failure) =>
  fixture("rpc", async ({ attach, remote }) => {
    remote.rules[failure] = true;
    const client = await attach({ callback: async ({ kind }) => (kind === "select" ? repairChoice : true) });
    const commit = vi.fn();
    await assert.rejects(
      client.run("history", options, undefined, commit),
      failure === "ignoresConditionals" ? /ignored If-None-Match/u : /probe cleanup.*failed/u,
    );
    assert.deepEqual(remote.historyWrites(), []);
    assert.equal(commit.mock.calls.length, 0);
    if (failure === "ignoresConditionals") remote.assertProbeCleaned();
  }),
);

test("History fails closed when the existing History has no strong ETag", () =>
  fixture("rpc", async ({ attach, remote }) => {
    remote.objects.set(historyPath, historyBody(earlier));
    remote.rules.weakHistoryEtag = true;
    const client = await attach({ callback: async ({ kind }) => (kind === "select" ? repairChoice : true) });
    await assert.rejects(client.run("history", options), /WebDAV history has no strong ETag/u);
    assert.deepEqual(remote.writes(), []);
  }));

test("History does not commit if another client repairs it during the probe", () =>
  fixture("rpc", async ({ attach, remote }) => {
    remote.rules.beforeRequest = ({ method }) => {
      if (method === "DELETE") remote.objects.set(historyPath, historyBody(active));
    };
    const client = await attach({ callback: async ({ kind }) => (kind === "select" ? repairChoice : true) });
    const commit = vi.fn();
    await client.run("history", options, undefined, commit);
    assert.equal(commit.mock.calls.length, 0);
    assert.deepEqual(remote.historyWrites(), []);
    remote.assertProbeCleaned();
  }));

test.each(["create", "replace"] as const)(
  "History uses a conditional write to %s the document and does not overwrite concurrent data",
  (operation) =>
    fixture("rpc", async ({ attach, remote }) => {
      const replacing = operation === "replace";
      if (replacing) remote.objects.set(historyPath, historyBody(earlier));
      const concurrent = historyBody(earlier, newer);
      remote.rules.beforeRequest = ({ path, method }) => {
        if (path === historyPath && method === "PUT") remote.objects.set(path, concurrent);
      };
      const client = await attach({ callback: async ({ kind }) => (kind === "select" ? repairChoice : true) });
      await assert.rejects(client.run("history", options), /Remote History changed during repair/u);
      assert.deepEqual(remote.objects.get(historyPath), concurrent);
      assert.equal(remote.historyWrites().length, 1);
      const put = remote.historyWrites()[0];
      assert.equal(
        put?.headers.get(replacing ? "if-match" : "if-none-match"),
        replacing ? etag(historyBody(earlier)) : "*",
      );
      remote.assertProbeCleaned();
    }),
);

test.each(["confirm", "probe"] as const)(
  "Cancelling a WebDAV History repair during %s drains work before returning",
  (stage) =>
    fixture(stage === "confirm" ? "tui" : "rpc", async ({ attach, remote }) => {
      const ready = Promise.withResolvers<void>();
      const controller = new AbortController();
      const commit = vi.fn();
      const waitForCancel = async (signal: AbortSignal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          ready.resolve();
        });
      };
      if (stage === "probe") {
        remote.rules.beforeRequest = async ({ path, method, signal }) => {
          if (path.includes("/.pi-sync-probes/") && method === "GET" && signal) await waitForCancel(signal);
        };
      }
      const client = await attach({
        callback: async ({ kind }, signal) => {
          if (kind === "select") return repairChoice;
          assert.equal(kind, "confirm");
          if (stage === "confirm") await waitForCancel(signal);
          return true;
        },
      });
      const running = client.run("history", options, controller.signal, commit);
      const cancelled = assert.rejects(running, /cancelled|AbortError/iu);
      try {
        await Promise.race([
          ready.promise,
          cancelled.then(() => assert.fail("Repair stopped before the cancellation point.")),
        ]);
        controller.abort(new DOMException("Fixture cancelled", "AbortError"));
        await cancelled;
        assert.equal(commit.mock.calls.length, 0);
        assert.deepEqual(remote.historyWrites(), []);
        if (stage === "probe") remote.assertProbeCleaned();
        else assert.deepEqual(remote.writes(), []);
      } finally {
        controller.abort();
        await running.catch(() => {});
      }
    }),
);

test("Legacy daemon status and doctor requests retain their WebDAV behavior", () =>
  fixture("rpc", async ({ attach, remote }) => {
    remote.objects.delete(latestPath);
    const client = await attach({ callback: async ({ kind }) => assert.fail(`Unexpected legacy callback ${kind}`) });
    await client.run("status", options);
    assert.deepEqual(remote.writes(), []);

    remote.objects.set(latestPath, Buffer.from(JSON.stringify(active)));
    await client.run("doctor", options);
    assert.deepEqual(remote.objects.get(historyPath), historyBody(active));
    remote.assertProbeCleaned();
  }));
