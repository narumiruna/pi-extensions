import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { LatestPointer } from "../src/engine/backends/backend-types.js";
import { WebDavSyncBackend } from "../src/engine/backends/webdav/webdav-backend.js";
import { configFromSettings, syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import type { AnySyncConfig, PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import { createEngineService } from "../src/engine-service.js";
import type { Callback } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

const command = { args: [] };

async function fixture(
  run: (value: {
    root: string;
    loadSettings: () => PiSyncSettingsV3;
    saveSettings: (document: PiSyncSettingsV3) => Promise<void>;
    readHead: (name?: string) => { snapshot: LatestPointer; bytes: Buffer };
    run: (operation: string, options?: object) => Promise<unknown>;
    foregroundPayload: () => Promise<{ setup: string; fingerprint: string }>;
    onCallback: (answer: (callback: Callback) => Promise<unknown>) => void;
    onBackend: (action: (method: string, url: string) => Promise<void>) => void;
    requests: [string, string][];
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-foreground-")));
  const collections = new Set<string>();
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const requests: [string, string][] = [];
  let onRequest: ((method: string, url: string) => Promise<void>) | undefined;
  let error: unknown;
  let revision = 0;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const url = request.url ?? "";
    const method = request.method ?? "";
    requests.push([method, url]);
    await onRequest?.(method, url);
    const object = objects.get(url);
    switch (method) {
      case "GET":
        if (!object) return response.writeHead(404).end();
        return response.writeHead(200, { etag: object.etag }).end(object.bytes);
      case "MKCOL": {
        const status = collections.has(url) ? 405 : 201;
        collections.add(url);
        return response.writeHead(status).end();
      }
      case "PROPFIND":
        return response
          .writeHead(207)
          .end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/probe</d:href></d:response></d:multistatus>');
      case "PUT": {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (
          (request.headers["if-none-match"] === "*" && object) ||
          (request.headers["if-match"] && request.headers["if-match"] !== object?.etag)
        )
          return response.writeHead(412).end();
        const etag = `"${++revision}"`;
        objects.set(url, { bytes: Buffer.concat(chunks), etag });
        return response.writeHead(201, { etag }).end();
      }
      case "DELETE":
        for (const item of objects.keys()) if (item.startsWith(`${url}/`)) objects.delete(item);
        collections.delete(url);
        return response.writeHead(204).end();
      default:
        return response.writeHead(501).end();
    }
  }
  const http = createServer((request, response) => {
    void respond(request, response).catch((failure: unknown) => {
      error = failure;
      response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    assert.ok(address && typeof address === "object");
    const document: PiSyncSettingsV3 = {
      version: 8,
      onSwitch: "switch-only",
      activeSyncSetup: "home",
      storageConnections: {
        storage: {
          type: "webdav",
          url: `http://127.0.0.1:${address.port}/dav`,
          credentials: { username: "fixture", password: "fixture" },
        },
      },
      syncSetups: {
        home: {
          storage: { connection: "storage", path: "shared" },
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
        },
        legacy: {
          storage: { connection: "storage", path: "legacy" },
          sync: { include: ["notes.md", "new.rules"], automatic: false },
        },
        other: {
          storage: { connection: "storage", path: "other" },
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", ignoreFile: "other.rules", automatic: false },
        },
      },
    };
    const loadSettings = () => structuredClone(document);
    const saveSettings = (value: PiSyncSettingsV3) =>
      fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(value), { mode: 0o600 });
    await saveSettings(document);
    await fs.writeFile(path.join(root, ".syncignore"), "# local rule evidence\n/private.md\n/new.rules\n");
    await fs.writeFile(path.join(root, "other.rules"), "# reserved inactive source\n");
    await fs.writeFile(path.join(root, "notes.md"), "local notes\n");
    await fs.writeFile(path.join(root, "private.md"), "never publish\n");
    const service = createEngineService(root, true);
    let callback = async (request: Callback): Promise<unknown> => {
      if (request.kind === "queue-acquire" || request.kind === "queue-release" || request.kind === "merge-review")
        return true;
      if (request.kind === "confirm" && String((request.payload as { title: string }).title).startsWith("Adopt"))
        return true;
      return assert.fail(`Unexpected callback: ${request.kind}`);
    };
    try {
      await withRpcServer(root, service.execute, async ({ createConnection }) => {
        const client = await createConnection(
          {
            id: randomUUID(),
            generation: randomUUID(),
            pid: process.pid,
            cwd: root,
            mode: "rpc",
            hasUI: true,
            idle: true,
            ready: true,
          },
          { callback: (request) => callback(request) },
        ).attach();
        await client.run("daemon.handover", {});
        await run({
          root,
          loadSettings,
          saveSettings,
          requests,
          run: (operation, options) =>
            client.run(operation, operation.endsWith(".foreground") ? options : { ...command, ...options }),
          foregroundPayload: async () => {
            const { config } = (await client.run("initialize", {})) as { config: AnySyncConfig };
            return { setup: config.setupName, fingerprint: syncCheckConfigFingerprint(config) };
          },
          onCallback: (answer) => {
            callback = answer;
          },
          onBackend: (action) => {
            onRequest = action;
          },
          readHead: (name = "shared") => {
            const pointer = objects.get(`/dav/${name}/latest.json`);
            assert.ok(pointer);
            return { snapshot: JSON.parse(pointer.bytes.toString()) as LatestPointer, bytes: pointer.bytes };
          },
        });
      });
      if (error) throw error;
    } finally {
      await service.hooks.close();
    }
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fixtureBackend(document: PiSyncSettingsV3, setup?: string) {
  const { backend } = configFromSettings(document, setup);
  assert.equal(backend.type, "webdav");
  if (backend.type !== "webdav") throw new Error("Expected WebDAV fixture.");
  return new WebDavSyncBackend(backend);
}

function snapshotFile(path: string, text: string) {
  const bytes = Buffer.from(text);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") };
}

for (const direction of ["push", "pull"] as const) {
  test(`the foreground ${direction} IPC path accepts divergence without a second approval`, () =>
    fixture(async ({ root, run, foregroundPayload, loadSettings, onCallback }) => {
      await run("push", { yes: true });
      const backend = fixtureBackend(loadSettings());
      const original = await backend.readHead();
      assert.ok(original);
      const snapshot = await backend.readSnapshot(original.snapshotRef);
      const local = path.join(root, "notes.md");
      await fs.writeFile(local, "local edit\n");
      const newer = "20260101T000000Z-eeeeeeee";
      await backend.publishSnapshot(
        { ...snapshot, id: newer, files: [snapshotFile("notes.md", "remote edit\n")] },
        { kind: "revision", revision: original.revision },
      );
      const payload = await foregroundPayload();
      const seen: string[] = [];
      onCallback(async ({ kind }) => {
        seen.push(kind);
        return ["directional-checkpoint", "queue-acquire", "queue-release"].includes(kind);
      });
      const result = (await run(`${direction}.foreground`, payload)) as { outcome?: string; message?: string };
      assert.equal(result.outcome, "applied");
      assert.match(result.message ?? "", direction === "push" ? /History/u : /backup/iu);
      assert.ok(seen.includes("directional-checkpoint"));
      assert.ok(seen.every((kind) => ["directional-checkpoint", "queue-acquire", "queue-release"].includes(kind)));
      const final = await backend.readHead();
      assert.ok(final);
      if (direction === "push") {
        assert.ok((await backend.listHistory()).some(({ snapshotRef }) => snapshotRef === newer));
        assert.equal(
          Buffer.from(
            (await backend.readSnapshot(final.snapshotRef)).files[0]?.contentBase64 ?? "",
            "base64",
          ).toString(),
          "local edit\n",
        );
      } else {
        assert.equal(final.snapshotId, newer);
        assert.equal(await fs.readFile(local, "utf8"), "remote edit\n");
      }
    }));
}

test("a foreground request rejects unbound actions or replay under a different checkpoint", () =>
  fixture(async ({ run, foregroundPayload, requests, root, onCallback }) => {
    await run("push", { yes: true });
    const payload = await foregroundPayload();
    const notes = path.join(root, "notes.md");
    await fs.writeFile(notes, "local changed after last sync\n");
    onCallback(async ({ kind }) => assert.fail(`Unexpected callback: ${kind}`));
    requests.length = 0;
    await assert.rejects(
      run("pull.foreground", { ...payload, force: true }),
      /Invalid foreground directional request/u,
    );
    await assert.rejects(run("pull.foreground", { ...payload, setup: "other" }), /setup changed/u);
    assert.equal(requests.length, 0);
    await assert.rejects(run("pull.foreground", { ...payload, retryCheckpoint: "0".repeat(64) }), /not replayed/u);
    assert.ok(requests.every(([method]) => method === "GET"));
    assert.equal(await fs.readFile(notes, "utf8"), "local changed after last sync\n");
  }));

test("daemon routes review a legacy-to-v6 publication, merge divergent files, and roll back through current rules", () =>
  fixture(async ({ root, run, loadSettings, saveSettings, readHead, onCallback }) => {
    const legacy = loadSettings();
    const home = legacy.syncSetups.home;
    assert.ok(home);
    home.sync = { include: ["notes.md"], automatic: false };
    await saveSettings(legacy);
    assert.equal(await run("push", { yes: true }), "applied");
    await saveSettings(loadSettings());
    const legacyHead = readHead().bytes;
    await assert.rejects(run("push", { force: true, yes: true }), /remote uses a legacy content policy/i);
    assert.deepEqual(readHead().bytes, legacyHead);
    const reviews: string[] = [];
    onCallback(async ({ kind, payload }) => {
      if (kind === "merge-review") reviews.push((payload as { content: string }).content);
      else if (kind === "confirm") reviews.push((payload as { message: string }).message);
      else assert.ok(kind === "queue-acquire" || kind === "queue-release", `Unexpected callback: ${kind}`);
      return true;
    });
    assert.equal(await run("push", { force: true }), "applied");
    assert.match(reviews[0] ?? "", /legacy content policy/i);
    const backend = fixtureBackend(loadSettings());
    const first = await backend.readHead();
    assert.ok(first);
    const image = await backend.readSnapshot(first.snapshotRef);
    assert.equal(image.version, 6);
    assert.deepEqual(Object.keys(image.selection ?? {}).sort(), ["fingerprint", "scope", "sessions", "version"]);
    assert.deepEqual(
      image.files.map(({ path }) => path),
      ["notes.md"],
    );
    await saveSettings(legacy);
    await assert.rejects(run("pull", { force: true, yes: true }), /remote uses an ignore-file policy/i);
    await saveSettings(loadSettings());
    await fs.writeFile(path.join(root, "notes.md"), "locally diverged before pull\n");
    assert.equal(await run("pull", { force: true, yes: true }), "applied");
    assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "local notes\n");
    await fs.writeFile(path.join(root, "notes.md"), "independent local edit\n");
    await backend.publishSnapshot(
      {
        ...image,
        id: "20260101T000000Z-bbbbbbbb",
        files: [...image.files, snapshotFile("remote.md", "remote edit\n")],
      },
      { kind: "revision", revision: first.revision },
    );
    assert.equal(await run("sync"), "applied");
    assert.equal(await fs.readFile(path.join(root, "remote.md"), "utf8"), "remote edit\n");
    const mergedHead = readHead().bytes;
    await assert.rejects(run("rollback", { args: [first.snapshotId], yes: true }), /separate foreground review/i);
    assert.deepEqual(readHead().bytes, mergedHead);
    await run("rollback", { args: [first.snapshotId] });
    assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "local notes\n");
    await assert.rejects(fs.stat(path.join(root, "remote.md")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, "private.md"), "utf8"), "never publish\n");
    const last = await backend.readHead();
    assert.ok(last);
    assert.deepEqual(
      (await backend.readSnapshot(last.snapshotRef)).files.map(({ path }) => path),
      ["notes.md"],
    );
  }));

test("mixed legacy push rechecks newly reserved names inside a real backend publication", () =>
  fixture(async ({ root, run, loadSettings, saveSettings, onBackend, readHead, requests }) => {
    await run("push", { setup: "legacy", yes: true });
    const before = readHead("legacy").bytes;
    await fs.writeFile(path.join(root, "new.rules"), "newly reserved\n");
    let invalidated = false;
    onBackend(async (method, url) => {
      if (invalidated || method !== "MKCOL" || !url.endsWith("/snapshots")) return;
      const next = loadSettings();
      const other = next.syncSetups.other;
      assert.ok(other?.sync.pathPolicy === "ignore-file");
      other.sync.ignoreFile = "new.rules";
      await saveSettings(next);
      invalidated = true;
    });
    requests.length = 0;
    await assert.rejects(run("push", { setup: "legacy", yes: true }), /policy changed|settings changed/i);
    assert.ok(invalidated);
    assert.deepEqual(readHead("legacy").bytes, before);
    assert.ok(!requests.some(([method, url]) => method === "PUT" && url.endsWith(".json.gz")));
  }));

test("mixed legacy pull rechecks reserved names after daemon queue acquisition", () =>
  fixture(async ({ root, run, loadSettings, saveSettings, onCallback, readHead }) => {
    const notes = path.join(root, "notes.md");
    const rules = path.join(root, "new.rules");
    await fs.writeFile(rules, "remote content\n");
    await run("push", { setup: "legacy", yes: true });
    const before = readHead("legacy").bytes;
    await fs.writeFile(notes, "keep newer notes\n");
    await fs.writeFile(rules, "keep newly reserved content\n");
    let sawReservation = false;
    onCallback(async ({ kind, payload }) => {
      if (kind === "queue-acquire") {
        assert.ok((payload as { targets: string[] }).targets.includes(rules));
        const next = loadSettings();
        const other = next.syncSetups.other;
        assert.ok(other?.sync.pathPolicy === "ignore-file");
        other.sync.ignoreFile = "new.rules";
        await saveSettings(next);
        sawReservation = true;
      } else assert.equal(kind, "queue-release");
      return true;
    });
    await assert.rejects(run("pull", { setup: "legacy", force: true, yes: true }), /policy changed/i);
    assert.ok(sawReservation);
    assert.deepEqual(readHead("legacy").bytes, before);
    assert.equal(await fs.readFile(notes, "utf8"), "keep newer notes\n");
    assert.equal(await fs.readFile(rules, "utf8"), "keep newly reserved content\n");
  }));

test("mixed legacy reviewed push retains ordinary unmanaged remote files, not reserved rule files", () =>
  fixture(async ({ root, run, loadSettings, onCallback }) => {
    onCallback(async ({ kind }) => {
      assert.equal(kind, "confirm");
      return true;
    });
    const backend = fixtureBackend(loadSettings(), "legacy");
    const { snapshotIdentity } = configFromSettings(loadSettings(), "legacy");
    const image = {
      version: 1,
      profile: snapshotIdentity,
      id: "20260101T000000Z-cccccccc",
      createdAt: "2026-01-01T00:00:00.000Z",
      machine: "legacy peer",
      selection: { version: 1 as const, include: ["notes.md", "other.rules", "unmanaged.md"] },
      files: [snapshotFile("other.rules", "old private bytes"), snapshotFile("unmanaged.md", "remote-only bytes")],
    };
    await backend.publishSnapshot(image, { kind: "missing" });
    await run("push", { setup: "legacy", force: true });
    const head = await backend.readHead();
    assert.ok(head);
    const published = await backend.readSnapshot(head.snapshotRef);
    assert.equal(published.version, 1);
    assert.deepEqual(
      published.files.map(({ path }) => path),
      ["notes.md", "unmanaged.md"],
    );
    assert.equal(await fs.readFile(path.join(root, "other.rules"), "utf8"), "# reserved inactive source\n");
    assert.deepEqual((await backend.readSnapshot(image.id)).files, image.files);
  }));

test("a v6 head advance while waiting for daemon mutation queues refuses the reviewed pull", () =>
  fixture(async ({ root, run, loadSettings, onCallback, readHead }) => {
    await run("push", { yes: true });
    const backend = fixtureBackend(loadSettings());
    const first = await backend.readHead();
    assert.ok(first);
    const image = await backend.readSnapshot(first.snapshotRef);
    const local = path.join(root, "notes.md");
    await fs.writeFile(local, "protect local bytes\n");
    const newer = "20260101T000000Z-dddddddd";
    onCallback(async ({ kind }) => {
      if (kind === "queue-acquire") {
        await backend.publishSnapshot(
          { ...image, id: newer, files: [snapshotFile("notes.md", "new remote bytes")] },
          {
            kind: "revision",
            revision: first.revision,
          },
        );
      } else assert.equal(kind, "queue-release");
      return true;
    });
    await assert.rejects(run("pull", { force: true, yes: true }), /remote changed before local apply/i);
    assert.equal(readHead().snapshot.snapshot, newer);
    assert.equal(await fs.readFile(local, "utf8"), "protect local bytes\n");
  }));

test("a same-byte replacement of the ignore source invalidates pending foreground approval", () =>
  fixture(async ({ root, run, onCallback, requests }) => {
    const source = path.join(root, ".syncignore");
    await run("push", { yes: true });
    const original = await fs.readFile(source);
    await fs.writeFile(path.join(root, "notes.md"), "another edit\n");
    let reviewed = false;
    onCallback(async ({ kind }) => {
      assert.equal(kind, "confirm");
      const replacement = path.join(root, "rule-replacement.tmp");
      await fs.writeFile(replacement, original);
      await fs.rename(replacement, source);
      reviewed = true;
      return true;
    });
    requests.length = 0;
    await assert.rejects(run("push"), /policy changed|settings changed/i);
    assert.ok(reviewed);
    assert.ok(requests.every(([method]) => method === "GET"));
    assert.deepEqual(await fs.readFile(source), original);
  }));
