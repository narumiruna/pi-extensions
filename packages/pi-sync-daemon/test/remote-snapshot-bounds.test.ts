import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test, vi } from "vitest";
import type { ResolvedSyncBackend } from "../src/engine/backends/backend-types.js";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import { S3SyncBackend } from "../src/engine/backends/s3/s3-backend.js";
import { createLatestPointer } from "../src/engine/backends/snapshot-pointer.js";
import { WebDavSyncBackend } from "../src/engine/backends/webdav/webdav-backend.js";
import type { AnySyncConfig } from "../src/engine/settings/settings-types.js";
import { SnapshotCaptureLimitError } from "../src/engine/snapshot/snapshot-capture-limit.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { readRemoteSnapshot } from "../src/engine/sync/remote-snapshot.js";

vi.mock(import("node:child_process"), { spy: true });

const include = ["keep.txt", "drop.txt"];
const contents = ["keep", "drop".repeat(512)];
const payloadBytes = contents.reduce((total, text) => total + Buffer.byteLength(text), 0);

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(scoped = false): Snapshot {
  return {
    version: scoped ? 5 : 3,
    id: "sample",
    profile: "test",
    createdAt: "2026-11-01T00:00:00Z",
    machine: "test",
    selection: scoped
      ? { version: 3, scope: "agent-directory", include: [], exclude: [], reinclude: [] }
      : { version: 1, include },
    files: include.map((path, index) => {
      const content = Buffer.from(contents[index] ?? "");
      return { path, contentBase64: content.toString("base64"), sha256: sha256(content) };
    }),
  };
}

function selectedConfig(backend: ResolvedSyncBackend): AnySyncConfig {
  return {
    backend,
    setupName: "test",
    connectionName: "test",
    storagePath: "./",
    snapshotIdentity: "test",
    include: ["keep.txt"],
    automatic: false,
    onSwitch: "switch-only",
    skipSecretScan: false,
    showStatus: false,
  };
}

test.each(["webdav", "s3"] as const)(
  "%s bounds the HTTP artifact and JSON before remote policy filtering",
  async (kind) => {
    const image = snapshot();
    const json = JSON.stringify(image);
    const artifact = gzipSync(json);
    const pointer = createLatestPointer("test", image, sha256(artifact));
    let mode: "normal" | "advertised" | "chunked" | "transport gzip" | "corrupt" = "normal";
    let requests: { method?: string; acceptEncoding?: string }[] = [];
    let streamClosed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      requests.push({ method: request.method, acceptEncoding: request.headers["accept-encoding"] });
      if (request.url?.endsWith("/latest.json")) {
        response.writeHead(200, { etag: '"revision"' }).end(JSON.stringify(pointer));
      } else if (request.url?.endsWith("/snapshots/sample.json.gz")) {
        if (mode === "advertised" || mode === "chunked") {
          response.once("close", streamClosed.resolve);
          if (mode === "advertised") {
            response.writeHead(200, { "content-length": artifact.length });
            response.flushHeaders();
          } else {
            response.writeHead(200).write(artifact);
          }
        } else if (mode === "transport gzip") {
          response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(artifact));
        } else if (mode === "corrupt") {
          response.writeHead(200).end(Buffer.alloc(artifact.length));
        } else {
          response.writeHead(200).end(artifact);
        }
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const backend =
        kind === "webdav"
          ? ({
              type: "webdav",
              profile: { kind: "webdav", url: `${origin}/storage/`, username: "fixture", password: "fixture" },
              destination: { path: "./", namespace: "test" },
            } as const)
          : ({
              type: "s3",
              profile: {
                kind: "s3-compatible",
                endpoint: origin,
                region: "us-east-1",
                accessKeyId: "fixture",
                secretAccessKey: "fixture",
              },
              destination: { bucket: "storage", prefix: "./", namespace: "test" },
            } as const);
      const storage = backend.type === "webdav" ? new WebDavSyncBackend(backend) : new S3SyncBackend(backend);
      const config = selectedConfig(backend);
      const read = (maxBytes?: number) =>
        readRemoteSnapshot(storage, config, AbortSignal.timeout(2_000), {
          maxBytes,
          allowSelectionDifference: true,
        });
      assert.ok(artifact.length < Buffer.byteLength(json) - 1);
      for (const streaming of ["advertised", "chunked"] as const) {
        mode = streaming;
        streamClosed = Promise.withResolvers<void>();
        requests = [];
        await assert.rejects(read(artifact.length - 1), SnapshotCaptureLimitError);
        await streamClosed.promise;
        assert.deepEqual(
          requests.map(({ method }) => method),
          ["GET", "GET"],
        );
        assert.equal(requests[1]?.acceptEncoding, "identity");
      }
      mode = "normal";
      await assert.rejects(read(Buffer.byteLength(json) - 1), SnapshotCaptureLimitError);
      const bounded = await read(Buffer.byteLength(json));
      assert.equal(bounded.head?.snapshotRef, image.id);
      assert.equal(bounded.selectionState?.kind, "different");
      assert.deepEqual(bounded.snapshot?.files, image.files.slice(0, 1));
      assert.deepEqual(await read(), bounded);
      mode = "corrupt";
      await assert.rejects(read(Buffer.byteLength(json)), /checksum mismatch/u);
      mode = "transport gzip";
      await assert.rejects(read(Buffer.byteLength(json)), SnapshotCaptureLimitError);
      assert.deepEqual(await read(), bounded);
    } finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  },
);

test.each([false, true])(
  "Git bounds the manifest total before payload cat-file (agent-directory: %s)",
  async (scoped) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-remote-bound-"));
    try {
      const remote = path.join(root, "remote.git");
      await runGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", remote]);
      const backend = {
        type: "git",
        profile: { kind: "git", remote },
        destination: { branch: "pi-sync/test", directory: "./", namespace: "test" },
      } as const;
      const reader = new GitSyncBackend(backend, { cacheRoot: path.join(root, "cache"), allowLocalRemotes: true });
      const config: AnySyncConfig = scoped
        ? { ...selectedConfig(backend), scope: "agent-directory", include: [], exclude: ["drop.txt"] }
        : selectedConfig(backend);
      const image = snapshot(scoped);
      const { head } = await reader.publishSnapshot(image, { kind: "missing" });
      const read = (maxBytes?: number) =>
        readRemoteSnapshot(reader, config, undefined, { maxBytes, allowSelectionDifference: true });
      const sawPayloadBatch = () => vi.mocked(spawn).mock.calls.some(([, args]) => args?.includes("--batch"));
      vi.mocked(spawn).mockClear();
      await assert.rejects(read(payloadBytes - 1), SnapshotCaptureLimitError);
      assert.equal(sawPayloadBatch(), false);
      assert.ok(vi.mocked(spawn).mock.calls.some(([, args]) => args?.includes("fetch")));
      const bounded = await read(payloadBytes);
      assert.equal(sawPayloadBatch(), true);
      assert.equal(bounded.head?.snapshotRef, head.snapshotRef);
      assert.equal(bounded.selectionState?.kind, "different");
      assert.deepEqual(bounded.snapshot?.files, image.files.slice(0, 1));
      assert.deepEqual(await read(), bounded);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
