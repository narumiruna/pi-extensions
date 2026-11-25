import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonError } from "../src/client.js";
import type { LatestPointer } from "../src/engine/backends/backend-types.js";
import { WebDavSyncBackend } from "../src/engine/backends/webdav/webdav-backend.js";
import { ignorePolicyFingerprint } from "../src/engine/ignore/ignore-source.js";
import { configFromSettings, syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import type { AnySyncConfig, PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import { createEngineService } from "../src/engine-service.js";
import { type Callback, OWNERSHIP_CLEANUP_REQUIRED } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

const command = { args: [] };

async function fixture(
  run: (value: {
    root: string;
    loadSettings: () => PiSyncSettingsV3;
    saveSettings: (document: PiSyncSettingsV3) => Promise<void>;
    readHead: (name?: string) => { snapshot: LatestPointer; bytes: Buffer };
    run: (operation: string, options?: object) => Promise<unknown>;
    afterRestart: (action: (retry: (options: object) => Promise<unknown>) => Promise<void>) => Promise<void>;
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
      await withRpcServer(root, service.execute, async ({ server, createConnection }) => {
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
          afterRestart: async (action) => {
            await client.dispose();
            await server.close();
            await service.hooks.close();
            const replacement = createEngineService(root, true);
            try {
              await withRpcServer(root, replacement.execute, async ({ createConnection }) => {
                const connection = await createConnection(
                  { ...client.facts, id: randomUUID() },
                  {
                    callback: (request) => callback(request),
                  },
                ).attach();
                await action((options) => connection.run("pull.foreground", options));
              });
            } finally {
              await replacement.hooks.close();
            }
          },
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

test("the documented History recovery extracts a file excluded by a narrower Push without rewriting the head", () =>
  fixture(async ({ root, run, foregroundPayload, onCallback, requests, readHead }) => {
    await fs.writeFile(path.join(root, "legacy.txt"), "excluded after Push\n");
    await run("push", { yes: true });
    const reference = readHead().snapshot.snapshot;
    await fs.appendFile(path.join(root, ".syncignore"), "/legacy.txt\n");
    onCallback(async ({ kind }) =>
      ["confirm", "directional-checkpoint", "queue-acquire", "queue-release"].includes(kind),
    );
    const outcome = (await run("push.foreground", await foregroundPayload())) as { outcome: string; message: string };
    assert.equal(outcome.outcome, "applied");
    assert.match(outcome.message, /Rollback uses the current rules and does not restore excluded files/u);
    assert.ok(outcome.message.includes(reference));
    const head = readHead().bytes;
    const readme = await fs.readFile("packages/pi-sync/README.md", "utf8");
    const example = readme.match(/### Recover excluded files from History[\s\S]*?<<'JS'\n([\s\S]*?)\nJS\n/u)?.[1];
    assert.ok(example);
    requests.length = 0;
    const child = spawn(process.execPath, ["--input-type=module", "-", root, "home", reference, "legacy.txt"], {
      env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(example);
    const [code, stdout, stderr] = await Promise.all([done, child.stdout.toArray(), child.stderr.toArray()]);
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    const output = Buffer.concat(stdout).toString().trim();
    assert.equal(await fs.readFile(output, "utf8"), "excluded after Push\n");
    if (process.platform !== "win32") assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(readHead().bytes, head);
    assert.ok(requests.length > 0 && requests.every(([method]) => method === "GET"));
  }));

test("the daemon previews a policy conflict, and only confirmed Pull adopts it without rewriting WebDAV", () =>
  fixture(async ({ root, run, foregroundPayload, loadSettings, readHead, onCallback, requests }) => {
    await run("push", { yes: true });
    const backend = fixtureBackend(loadSettings());
    const initial = await backend.readHead();
    assert.ok(initial);
    const image = await backend.readSnapshot(initial.snapshotRef);
    assert.ok(image.selection?.version === 4);
    const text = "\uFEFF# rule bytes\r\n/private.md\r\n";
    await backend.publishSnapshot(
      {
        ...image,
        id: "remote-rules",
        files: [snapshotFile("notes.md", "incoming")],
        ignoreRules: { filename: ".syncignore", text },
        selection: { ...image.selection, fingerprint: ignorePolicyFingerprint(text, false) },
      },
      { kind: "revision", revision: initial.revision },
    );
    const head = readHead().bytes;
    const rules = path.join(root, ".syncignore");
    const previous = await fs.readFile(rules, "utf8");
    const localNote = path.join(root, "notes.md");
    let approved = false;
    const reviews: string[] = [];
    onCallback(async ({ kind, payload }) => {
      if (kind === "confirm") {
        const { title, message } = payload as { title: string; message: string };
        reviews.push(`${title}\n${message}`);
        return approved;
      }
      return ["directional-checkpoint", "queue-acquire", "queue-release"].includes(kind);
    });
    await assert.rejects(run("pull", { force: true, yes: true }), /policy differs/u);
    const before = await foregroundPayload();
    assert.equal(((await run("pull.foreground", before)) as { outcome: string }).outcome, "cancelled");
    assert.equal(await fs.readFile(rules, "utf8"), previous);
    assert.equal(await fs.readFile(localNote, "utf8"), "local notes\n");
    assert.match(reviews[0] ?? "", /Overwrite local rules and pull\?/u);
    assert.match(reviews[0] ?? "", /Update locally: notes\.md/u);
    assert.match(reviews[0] ?? "", /rule bytes/u);
    approved = true;
    requests.length = 0;
    assert.equal(((await run("pull.foreground", before)) as { outcome: string }).outcome, "applied");
    assert.equal(await fs.readFile(rules, "utf8"), text);
    assert.equal(await fs.readFile(localNote, "utf8"), "incoming");
    assert.equal(await fs.readFile(path.join(root, "private.md"), "utf8"), "never publish\n");
    assert.deepEqual(readHead().bytes, head);
    assert.ok(requests.length > 0 && requests.every(([method]) => method === "GET"));
  }));

test.each(["older client", "resume adoption", "after managed writes"] as const)(
  "queue failure after journal creation: %s",
  (mode) =>
    fixture(async ({ root, run, afterRestart, foregroundPayload, loadSettings, onCallback, requests }) => {
      await run("push", { yes: true });
      const backend = fixtureBackend(loadSettings());
      const original = await backend.readHead();
      assert.ok(original);
      const snapshot = await backend.readSnapshot(original.snapshotRef);
      assert.ok(snapshot.selection?.version === 4);
      const text = "/private.md\n";
      await backend.publishSnapshot(
        {
          ...snapshot,
          id: "remote-adoption",
          files: [snapshotFile("notes.md", "incoming")],
          ignoreRules: { filename: ".syncignore", text },
          selection: { ...snapshot.selection, fingerprint: ignorePolicyFingerprint(text, false) },
        },
        { kind: "revision", revision: original.revision },
      );
      const payload = await foregroundPayload();
      const rule = path.join(root, ".syncignore");
      const before = await fs.readFile(rule, "utf8");
      const journal = path.join(root, "pi-sync", "ignore-adoption.json");
      const callbacks: string[] = [];
      onCallback(async ({ kind }) => {
        callbacks.push(kind);
        if (kind === "queue-acquire" && mode !== "after managed writes") {
          await fs.stat(journal);
          throw new Error("Injected queue acquisition failure");
        }
        if (kind === "directional-checkpoint" && mode !== "older client") return { adoptionRecovery: 1 };
        return kind !== "queue-release";
      });
      requests.length = 0;
      let fingerprint: string | undefined;
      if (mode !== "resume adoption") {
        await assert.rejects(run("pull.foreground", payload), (error: unknown) => {
          assert.ok(error instanceof DaemonError);
          assert.match(
            error.message,
            mode === "older client"
              ? /File-queue release and transfer outcome could not be verified/u
              : /Daemon ownership cleanup is uncertain/u,
          );
          assert.equal(error.remote.properties?.code, OWNERSHIP_CLEANUP_REQUIRED);
          return true;
        });
      } else {
        const result = (await run("pull.foreground", payload)) as { foregroundQueueCleanup: string; journal: string };
        assert.equal(result.foregroundQueueCleanup, "resume-adoption");
        assert.match(result.journal, /^[a-f0-9]{64}$/u);
        fingerprint = result.journal;
      }
      assert.deepEqual(callbacks, ["confirm", "directional-checkpoint", "queue-acquire", "queue-release"]);
      await fs.stat(journal);
      assert.equal(await fs.readFile(rule, "utf8"), before);
      assert.equal(
        await fs.readFile(path.join(root, "notes.md"), "utf8"),
        mode === "after managed writes" ? "incoming" : "local notes\n",
      );
      assert.ok(requests.length > 0 && requests.every(([method]) => method === "GET"));
      if (!fingerprint) return;
      const pinned = await backend.readHead();
      assert.ok(pinned);
      const recorded = await backend.readSnapshot(pinned.snapshotRef);
      await backend.publishSnapshot(
        { ...recorded, id: "unreviewed-new-head", files: [snapshotFile("notes.md", "not approved")] },
        { kind: "revision", revision: pinned.revision },
      );
      let approve = false;
      const reviews: string[] = [];
      onCallback(async ({ kind, payload }) => {
        if (kind === "confirm") {
          reviews.push((payload as { title: string }).title);
          return approve;
        }
        return true;
      });
      await afterRestart(async (retry) => {
        requests.length = 0;
        await assert.rejects(retry({ ...payload, retryAdoptionJournal: "f".repeat(64) }), /recorded Pull changed/u);
        const saved = await fs.readFile(journal);
        await fs.unlink(journal);
        await assert.rejects(retry({ ...payload, retryAdoptionJournal: fingerprint }), /recorded Pull changed/u);
        await fs.writeFile(journal, saved, { mode: 0o600 });
        assert.equal(requests.length, 0);
        const bound = { ...payload, retryAdoptionJournal: fingerprint };
        assert.deepEqual(await retry(bound), { outcome: "cancelled" });
        await fs.stat(journal);
        assert.equal(await fs.readFile(rule, "utf8"), before);
        approve = true;
        assert.equal(((await retry(bound)) as { outcome: string }).outcome, "applied");
        assert.equal(await fs.readFile(rule, "utf8"), text);
        assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "incoming");
        assert.deepEqual(reviews, ["Resume reviewed ignore-rule Pull?", "Resume reviewed ignore-rule Pull?"]);
        assert.ok(requests.length > 0 && requests.every(([method]) => method === "GET"));
      });
    }),
);

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

test("daemon routes review a legacy-to-v7 publication, merge divergent files, and roll back through current rules", () =>
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
    assert.equal(image.version, 7);
    assert.equal(image.ignoreRules?.text, await fs.readFile(path.join(root, ".syncignore"), "utf8"));
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
