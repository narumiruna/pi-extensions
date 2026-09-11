import assert from "node:assert/strict";
import { test } from "vitest";
import type { ResolvedS3Backend } from "../src/backends/backend-types.js";
import { historyKey, latestKey, S3SyncBackend, snapshotKey } from "../src/backends/s3/s3-backend.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { historyPath, latestPath, snapshotPath, WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { snapshot } from "./helpers.js";
import { MockWebDavServer, webDavConfig } from "./mock-webdav-server.js";

test("WebDAV root publications and probe cleanup stay under the configured collection", async () => {
  const server = await new MockWebDavServer().start();
  try {
    server.resources.set("/dav/unrelated.txt", Buffer.from("keep"));
    const config = webDavConfig(server.url);
    config.destination = { path: "./", namespace: "root" };
    assert.throws(
      () => new WebDavSyncBackend({ ...config, destination: { path: "./", namespace: "./" } }),
      /storage location/u,
    );
    assert.equal(latestPath(config), "latest.json");
    assert.equal(historyPath(config), "history.json");
    assert.equal(snapshotPath(config, "snap"), "snapshots/snap.json.gz");
    const backend = new WebDavSyncBackend(config);
    assert.match(backend.destination, / · \.\/$/u);
    const first = {
      ...snapshot([{ path: "settings.json", content: Buffer.from("root") }]),
      profile: "root",
    };
    const result = await backend.publishSnapshot(first, { kind: "missing" });
    assert.deepEqual([...server.resources.keys()].sort(), [
      "/dav/history.json",
      "/dav/latest.json",
      "/dav/snapshots/snap.json.gz",
      "/dav/unrelated.txt",
    ]);
    const fresh = new WebDavSyncBackend(config);
    assert.deepEqual(await fresh.readHead(), result.head);
    assert.deepEqual(await fresh.readSnapshot(first.id), first);
    const second = { ...first, id: "second" };
    await fresh.publishSnapshot(second, expectedRemoteHead(result.head));
    assert.deepEqual(
      (await fresh.listHistory()).map((entry) => entry.snapshotId),
      ["snap", "second"],
    );
    assert.deepEqual(await fresh.readSnapshot(first.id), first);
    assert.ok((await fresh.diagnose()).every((entry) => entry.level !== "error"));
    assert.ok(server.requests.every((request) => request.path.startsWith("/dav/")));
    assert.ok(
      server.requests
        .filter((request) => request.method === "DELETE")
        .every((request) => /^\/dav\/\.pi-sync-probes\/[^/]+$/u.test(request.path)),
    );
    assert.ok(![...server.resources.keys()].some((key) => key.includes(".pi-sync-probes")));
    assert.deepEqual(server.resources.get("/dav/unrelated.txt"), Buffer.from("keep"));
  } finally {
    await server.close();
  }
});

for (const kind of ["r2", "s3-compatible"] as const) {
  test(`${kind} root uses plain object keys and retains history across backend instances`, async () => {
    const config: ResolvedS3Backend = {
      type: "s3",
      profile: {
        kind,
        endpoint: kind === "r2" ? "https://account.r2.cloudflarestorage.com" : "https://s3.example.com/storage",
        region: kind === "r2" ? "auto" : "us-east-1",
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
      destination: { bucket: "bucket", prefix: "./", namespace: "root" },
    };
    assert.throws(
      () => new S3SyncBackend({ ...config, destination: { ...config.destination, namespace: "./" } }),
      /storage location/u,
    );
    assert.equal(latestKey(config), "latest.json");
    assert.equal(historyKey(config), "history.json");
    assert.equal(snapshotKey(config, "snap"), "snapshots/snap.json.gz");
    const basePath = kind === "r2" ? "/bucket" : "/storage/bucket";
    const objects = new Map<string, Buffer>([[`${basePath}/unrelated.txt`, Buffer.from("keep")]]);
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (init?.method === "PUT") {
        if (new Headers(init.headers).get("if-none-match") === "*" && objects.has(url.pathname))
          return new Response(null, { status: 412 });
        objects.set(url.pathname, Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const body = objects.get(url.pathname);
      return body
        ? new Response(new Uint8Array(body), { headers: { etag: '"revision"' } })
        : new Response(null, { status: 404 });
    };
    try {
      const first = {
        ...snapshot([{ path: "settings.json", content: Buffer.from("root") }]),
        profile: "root",
      };
      const result = await new S3SyncBackend(config).publishSnapshot(first, { kind: "missing" });
      assert.deepEqual(
        [...objects.keys()].sort(),
        ["history.json", "latest.json", "snapshots/snap.json.gz", "unrelated.txt"].map((key) => `${basePath}/${key}`),
      );
      const fresh = new S3SyncBackend(config);
      assert.deepEqual(await fresh.readSnapshot(first.id), first);
      const second = { ...first, id: "second" };
      await fresh.publishSnapshot(second, expectedRemoteHead(result.head));
      assert.deepEqual(
        (await fresh.listHistory()).map((entry) => entry.snapshotId),
        ["snap", "second"],
      );
      assert.deepEqual(await fresh.readSnapshot(first.id), first);
      assert.ok(
        requests.every(
          (request) => request.startsWith(`${basePath}/`) && !request.includes("/./") && !request.includes("/pi-sync/"),
        ),
      );
      assert.deepEqual(objects.get(`${basePath}/unrelated.txt`), Buffer.from("keep"));
    } finally {
      globalThis.fetch = original;
    }
  });
}
