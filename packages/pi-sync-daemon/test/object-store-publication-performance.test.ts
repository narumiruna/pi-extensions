import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { S3SyncBackend } from "../src/engine/backends/s3/s3-backend.js";
import { expectedRemoteHead, SyncBackendConflictError } from "../src/engine/backends/sync-backend.js";
import { WebDavSyncBackend } from "../src/engine/backends/webdav/webdav-backend.js";
import { encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";

vi.mock(import("../src/engine/snapshot/snapshot-codec.js"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, encodeSnapshot: vi.fn(original.encodeSnapshot) };
});

afterEach(() => {
  vi.mocked(encodeSnapshot).mockReset();
});

const kinds = ["webdav", "s3"] as const;
type StoreKind = (typeof kinds)[number];
type RequestRecord = { method: string; path: string; probe: boolean };
type StoreOptions = {
  delayMs?: number;
  beforeRequest?: (request: RequestRecord) => void | Promise<void>;
  missingParentStatus?: 404 | 409;
  ignoreConditions?: boolean;
  failCleanup?: boolean;
};

class ObjectStoreFixture {
  readonly collections = new Set(["/storage"]);
  readonly objects = new Map<string, Buffer>();
  readonly requests: RequestRecord[] = [];
  private readonly errors: unknown[] = [];
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error: unknown) => {
      this.errors.push(error);
      response.destroy();
    });
  });

  constructor(
    readonly kind: StoreKind,
    readonly options: StoreOptions,
  ) {}

  async start(prefix: string) {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    return this.kind === "webdav"
      ? new WebDavSyncBackend({
          type: "webdav",
          profile: { kind: "webdav", url: `${origin}/storage/`, username: "user", password: "pass" },
          destination: { path: prefix, namespace: "test" },
        })
      : new S3SyncBackend({
          type: "s3",
          profile: {
            kind: "s3-compatible",
            endpoint: origin,
            region: "us-east-1",
            accessKeyId: "test",
            secretAccessKey: "test",
          },
          destination: { bucket: "storage", prefix, namespace: "test" },
        });
  }

  async close() {
    const closed = once(this.server, "close");
    this.server.close();
    this.server.closeAllConnections();
    await closed;
    assert.deepEqual(this.errors, []);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/\/$/u, "");
    const record = { method, path, probe: path.includes("/.pi-sync-probes/") };
    this.requests.push(record);
    await this.options.beforeRequest?.(record);
    if (this.options.delayMs) await delay(this.options.delayMs);
    if (response.destroyed) return;
    const parent = path.slice(0, path.lastIndexOf("/"));
    const current = this.objects.get(path);
    const etag = current === undefined ? undefined : objectEtag(current);
    const send = (status: number, body?: Buffer | string, headers?: Record<string, string>) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    switch (method) {
      case "MKCOL": {
        if (this.collections.has(path)) return send(405);
        if (!this.collections.has(parent)) return send(this.options.missingParentStatus ?? 409);
        this.collections.add(path);
        return send(201);
      }
      case "PROPFIND": {
        if (!this.collections.has(path)) return send(404);
        return send(
          207,
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href></d:response></d:multistatus>`,
        );
      }
      case "PUT": {
        if (this.kind === "webdav" && !this.collections.has(parent)) return send(409);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (
          !this.options.ignoreConditions &&
          ((request.headers["if-none-match"] === "*" && current !== undefined) ||
            (request.headers["if-match"] !== undefined && request.headers["if-match"] !== etag))
        )
          return send(412);
        const value = Buffer.concat(chunks);
        this.objects.set(path, value);
        return send(201, undefined, { etag: objectEtag(value) });
      }
      case "GET":
        return current && etag ? send(200, current, { etag }) : send(404);
      case "DELETE": {
        if (this.options.failCleanup) return send(403);
        this.collections.delete(path);
        for (const key of this.objects.keys()) {
          if (key === path || key.startsWith(`${path}/`)) this.objects.delete(key);
        }
        return send(204);
      }
      default:
        return send(405);
    }
  }
}

function objectEtag(value: Buffer) {
  return `"${createHash("sha256").update(value).digest("hex")}"`;
}

function snapshot(id = "first"): Snapshot {
  return {
    id,
    version: 3,
    profile: "test",
    createdAt: "2026-11-01T00:00:00Z",
    machine: "test",
    selection: { version: 1, include: ["test.txt"] },
    files: [
      { path: "test.txt", contentBase64: "ZXhhY3Q=", sha256: createHash("sha256").update("exact").digest("hex") },
    ],
  };
}

function gate() {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    async wait() {
      reached.resolve();
      await release.promise;
    },
    open: release.resolve,
  };
}

function publicationRequests(store: ObjectStoreFixture) {
  return store.requests.filter(({ path, method }) => method === "PUT" && /\/snapshots\/|\/latest\.json$/u.test(path));
}

const operations = [
  { kind: "webdav", prefix: "./", cold: 19, warm: 17, coldCollections: 4, warmCollections: 2 },
  { kind: "webdav", prefix: "one/two/three", cold: 22, warm: 17, coldCollections: 7, warmCollections: 2 },
  { kind: "s3", prefix: "./", cold: 16, warm: 16, coldCollections: 0, warmCollections: 0 },
  { kind: "s3", prefix: "one/two/three", cold: 16, warm: 16, coldCollections: 0, warmCollections: 0 },
] as const;

test.for(operations)(
  "$kind $prefix: counts cold and warm requests with injected latency",
  async ({ kind, prefix, cold, warm, coldCollections, warmCollections }, { annotate }) => {
    const store = new ObjectStoreFixture(kind, { delayMs: 5 });
    try {
      const backend = await store.start(prefix);
      const start = performance.now();
      const first = await backend.publishSnapshot(snapshot(), { kind: "missing" });
      const firstMs = performance.now() - start;
      assert.equal(store.requests.length, cold);
      assert.equal(store.requests.filter(({ method }) => method === "MKCOL").length, coldCollections);
      assert.equal(store.requests.filter(({ method, probe }) => method === "DELETE" && probe).length, 1);
      store.requests.length = 0;
      const warmStart = performance.now();
      await backend.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head));
      const secondMs = performance.now() - warmStart;
      assert.equal(store.requests.length, warm);
      assert.equal(store.requests.filter(({ method }) => method === "MKCOL").length, warmCollections);
      assert.equal(store.requests.filter(({ method, probe }) => method === "DELETE" && probe).length, 1);
      await annotate(`cold ${firstMs.toFixed(1)} ms; warm ${secondMs.toFixed(1)} ms (5 ms per request)`);
    } finally {
      await store.close();
    }
  },
);

test.each(kinds)("%s restores the previous head to History before replacing it", async (kind) => {
  const store = new ObjectStoreFixture(kind, {});
  try {
    const backend = await store.start("./");
    const first = await backend.publishSnapshot(snapshot(), { kind: "missing" });
    store.objects.delete("/storage/history.json");
    store.requests.length = 0;
    const second = await backend.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head), {
      preservePreviousHead: true,
      onCommit() {
        const historyWrite = store.requests.findIndex(
          ({ path, method }) => path.endsWith("/history.json") && method === "PUT",
        );
        const historyVerification = store.requests.findIndex(
          ({ path, method }, index) => index > historyWrite && path.endsWith("/history.json") && method === "GET",
        );
        assert.ok(historyWrite >= 0 && historyVerification > historyWrite);
        assert.ok(
          store.requests.some(
            ({ path, method }, index) =>
              index > historyVerification && path.endsWith("/first.json.gz") && method === "GET",
          ),
        );
      },
    });
    assert.deepEqual(
      (await backend.listHistory()).map(({ snapshotId }) => snapshotId),
      [first.head.snapshotId, second.head.snapshotId],
    );
    assert.deepEqual(await backend.readSnapshot(first.head.snapshotRef), snapshot());
  } finally {
    await store.close();
  }
});

test.each(kinds)("%s refuses to replace an active head with unsafe History evidence", async (kind) => {
  const store = new ObjectStoreFixture(kind, {});
  try {
    const backend = await store.start("./");
    const first = await backend.publishSnapshot(snapshot(), { kind: "missing" });
    store.objects.set("/storage/snapshots/first.json.gz", Buffer.from("not the verified snapshot"));
    store.requests.length = 0;
    const onCommit = vi.fn();
    await assert.rejects(
      backend.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head), {
        preservePreviousHead: true,
        onCommit,
      }),
      /Cannot verify the previous remote snapshot .* in History/u,
    );
    assert.equal(onCommit.mock.calls.length, 0);
    assert.ok(!store.requests.some(({ method, path }) => method === "PUT" && path.endsWith("/latest.json")));
    assert.equal((await backend.readHead())?.revision, first.head.revision);
  } finally {
    await store.close();
  }
});

test("WebDAV retries parent setup for 404 and recreates a removed subtree", async () => {
  const store = new ObjectStoreFixture("webdav", { missingParentStatus: 404 });
  try {
    const backend = await store.start("parent/child");
    await backend.publishSnapshot(snapshot(), { kind: "missing" });
    for (const path of store.collections) if (path !== "/storage") store.collections.delete(path);
    store.objects.clear();
    store.requests.length = 0;
    await backend.publishSnapshot(snapshot("second"), { kind: "missing" });
    assert.ok(store.collections.has("/storage/parent/child/snapshots"));
    assert.equal(store.requests.filter(({ method }) => method === "MKCOL").length, 6);
  } finally {
    await store.close();
  }
});

test.for(kinds)(
  "%s overlaps encoding and probe, waits for cleanup, and uses an owned snapshot image",
  async (kind, { signal }) => {
    const probe = gate();
    const cleanup = gate();
    const encoding = Promise.withResolvers<void>();
    let probeStarted = false;
    const store = new ObjectStoreFixture(kind, {
      beforeRequest: ({ method, probe: isProbe }) => {
        if (!isProbe) return;
        if (!probeStarted) {
          probeStarted = true;
          return probe.wait();
        }
        if (method === "DELETE") return cleanup.wait();
      },
    });
    const encode = vi.mocked(encodeSnapshot).getMockImplementation();
    assert.ok(encode);
    vi.mocked(encodeSnapshot).mockImplementation(async (image) => {
      const result = await encode(image);
      encoding.resolve();
      return result;
    });
    const abort = new AbortController();
    const release = () => {
      probe.open();
      cleanup.open();
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      const backend = await store.start("one/two");
      const input = snapshot();
      const publishing = backend.publishSnapshot(
        input,
        { kind: "missing" },
        { signal: AbortSignal.any([abort.signal, signal]) },
      );
      try {
        await Promise.race([Promise.all([probe.reached, encoding.promise]), publishing]);
        input.id = "mutated";
        assert.ok(input.selection?.include);
        input.selection.include.push("mutated.txt");
        probe.open();
        await Promise.race([cleanup.reached, publishing]);
        assert.deepEqual(publicationRequests(store), []);
        cleanup.open();
        const result = await publishing;
        assert.equal(result.head.snapshotId, "first");
        assert.deepEqual(await backend.readSnapshot(result.head.snapshotRef), snapshot());
      } finally {
        release();
        abort.abort();
        await publishing.catch(() => undefined);
      }
    } finally {
      signal.removeEventListener("abort", release);
      await store.close();
    }
  },
);

const failures = kinds.flatMap((kind) =>
  (["ignoreConditions", "failCleanup"] as const).map((failure) => ({ kind, failure })),
);

test.each(failures)("$kind never stages a snapshot after $failure", async ({ kind, failure }) => {
  const store = new ObjectStoreFixture(kind, { [failure]: true });
  try {
    const backend = await store.start("one/two");
    await assert.rejects(
      backend.publishSnapshot(snapshot(), { kind: "missing" }),
      failure === "failCleanup" ? /cleanup (?:also )?failed/u : /ignored/u,
    );
    assert.deepEqual(publicationRequests(store), []);
  } finally {
    await store.close();
  }
});

const interruptions = kinds.flatMap((kind) => (["cancel", "encode failure"] as const).map((mode) => ({ kind, mode })));

test.for(interruptions)(
  "$kind drains probe cleanup on $mode without staging or committing",
  async ({ kind, mode }, { signal }) => {
    const cleanup = gate();
    const encoding = gate();
    const release = () => {
      cleanup.open();
      encoding.open();
    };
    signal.addEventListener("abort", release, { once: true });
    if (mode === "encode failure") {
      vi.mocked(encodeSnapshot).mockImplementation(async () => {
        await encoding.wait();
        throw new Error("encoding failed");
      });
    }
    const store = new ObjectStoreFixture(kind, {
      beforeRequest: ({ method }) => (method === "DELETE" ? cleanup.wait() : undefined),
    });
    const controller = new AbortController();
    try {
      const backend = await store.start("one/two");
      let committed = false;
      const publishing = backend.publishSnapshot(
        snapshot(),
        { kind: "missing" },
        {
          signal: AbortSignal.any([controller.signal, signal]),
          onCommit: () => {
            committed = true;
          },
        },
      );
      const rejected = assert.rejects(publishing, mode === "cancel" ? { name: "AbortError" } : /encoding failed/u);
      const finished = publishing.then(
        () => "finished",
        () => "finished",
      );
      try {
        await Promise.race([cleanup.reached, publishing]);
        if (mode === "cancel") controller.abort();
        else {
          await encoding.reached;
          encoding.open();
        }
        assert.equal(await Promise.race([finished, nextTurn("cleanup pending")]), "cleanup pending");
        assert.deepEqual(publicationRequests(store), []);
        cleanup.open();
        await rejected;
        assert.equal(committed, false);
        assert.deepEqual(publicationRequests(store), []);
        assert.equal(store.objects.size, 0);
      } finally {
        release();
        controller.abort();
        await rejected.catch(() => undefined);
      }
    } finally {
      signal.removeEventListener("abort", release);
      await store.close();
    }
  },
);

test.each(kinds)("%s still rejects a stale expected revision before the active-head PUT", async (kind) => {
  const store = new ObjectStoreFixture(kind, {});
  try {
    const backend = await store.start("./");
    const first = await backend.publishSnapshot(snapshot(), { kind: "missing" });
    await backend.publishSnapshot(snapshot("second"), expectedRemoteHead(first.head));
    store.requests.length = 0;
    await assert.rejects(
      backend.publishSnapshot(snapshot("stale"), expectedRemoteHead(first.head)),
      SyncBackendConflictError,
    );
    assert.deepEqual(
      publicationRequests(store).map(({ path }) => path),
      ["/storage/snapshots/stale.json.gz"],
    );
    assert.equal((await backend.readHead())?.snapshotId, "second");
  } finally {
    await store.close();
  }
});
