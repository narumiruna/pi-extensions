import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { DaemonError, requestDaemon } from "../src/client.js";
import { parseDiffReviewInventory } from "../src/diff-review-protocol.js";
import { createLatestPointer } from "../src/engine/backends/snapshot-pointer.js";
import { configFromSettings, syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";
import { encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import {
  type ClientEvent,
  type ClientFacts,
  OWNERSHIP_CLEANUP_REQUIRED,
  operationPrefix,
  type PollReply,
} from "../src/protocol.js";
import { type RpcFixture, withRpcServer } from "./rpc-server-fixture.js";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const LOCAL = "LOCAL_REVIEW_BODY";
const REMOTE = "REMOTE_REVIEW_BODY";
const SESSION = "SESSION_PRIVATE_BODY";
const FIELD = "MACHINE_PRIVATE_BODY";
const EXCLUDED = "EXCLUDED_PRIVATE_BODY";
const BODY_MARKERS = new RegExp([LOCAL, REMOTE, SESSION, FIELD, EXCLUDED].join("|"), "u");
const latest = "/dav/home/latest.json";
const bundle = "/dav/home/snapshots/fixture.json.gz";
const legacyOptions = { args: [] };

async function remoteBundle() {
  const snapshot: Snapshot = {
    version: 5,
    profile: "home",
    id: "fixture",
    createdAt: "2026-11-28T00:00:00.000Z",
    machine: "fixture",
    selection: {
      version: 3,
      scope: "agent-directory",
      include: ["sessions"],
      exclude: ["remote-filter.md"],
      reinclude: [],
    },
    localFields: ["machineField"],
    files: Object.entries({
      "AGENTS.md": `${REMOTE}\n`,
      "zero.txt": "",
      "settings.json": '{"portable":"remote"}\n',
      "private.md": EXCLUDED,
      "sessions/a/session.jsonl": SESSION,
    }).map(([path, value]) => {
      const bytes = Buffer.from(value);
      return { path, sha256: sha256(bytes), contentBase64: bytes.toString("base64") };
    }),
  };
  const bytes = await encodeSnapshot(snapshot);
  return new Map([
    [latest, Buffer.from(JSON.stringify(createLatestPointer("home", snapshot, sha256(bytes))))],
    [bundle, bytes],
  ]);
}

function config(storage: string, activeSyncSetup = "home") {
  const setup = {
    storage: { connection: "dav", path: "home" },
    sync: {
      scope: "agent-directory",
      sessions: true,
      exclude: ["private.md"],
      localFields: ["machineField"],
      automatic: false,
    },
  };
  return {
    version: 7,
    activeSyncSetup,
    onSwitch: "switch-only",
    debug: true,
    storageConnections: {
      dav: { type: "webdav", url: storage, credentials: { username: "fixture", password: "synthetic" } },
    },
    syncSetups: { home: setup, away: { ...setup, storage: { ...setup.storage, path: "away" } } },
  };
}

async function fixture(
  run: (
    test: RpcFixture & {
      root: string;
      requests: string[];
      objects: Map<string, Buffer>;
      gates: Map<string, (response: ServerResponse) => Promise<void>>;
      diagnostics: unknown[];
      save(active?: string): Promise<void>;
      fingerprint: string;
      facts(mode?: ClientFacts["mode"]): ClientFacts;
    },
  ) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-diff-loopback-")));
  await using resources = new AsyncDisposableStack();
  resources.defer(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = await runtimePaths(root);
  resources.defer(() => fs.rm(runtime.directory, { recursive: true, force: true }));
  const objects = await remoteBundle();
  const gates = new Map<string, (response: ServerResponse) => Promise<void>>();
  const requests: string[] = [];
  const remote = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const url = request.url ?? "";
    await gates.get(url)?.(response);
    if (response.destroyed) return;
    const body = request.method === "GET" ? objects.get(url) : undefined;
    response.writeHead(body ? 200 : request.method === "GET" ? 404 : 405);
    response.end(body);
  });
  resources.defer(async () => {
    if (!remote.listening) return;
    const closed = new Promise<void>((resolve) => remote.close(() => resolve()));
    remote.closeAllConnections();
    await closed;
  });
  await new Promise<void>((resolve, reject) => remote.listen(0, "127.0.0.1", resolve).once("error", reject));
  const bound = remote.address();
  assert.ok(bound && typeof bound !== "string");
  const storage = `http://127.0.0.1:${bound.port}/dav/`;
  const save = async (active?: string) => {
    const staged = path.join(root, ".fixture-setup.tmp");
    await fs.writeFile(staged, JSON.stringify(config(storage, active)), { mode: 0o600 });
    await fs.rename(staged, path.join(root, "pi-sync.json"));
  };
  await save();
  await fs.writeFile(path.join(root, "AGENTS.md"), `${LOCAL}\n`);
  await fs.writeFile(path.join(root, "local.txt"), "local-only\n");
  await fs.writeFile(path.join(root, "auth.json"), '{"synthetic":"not synced"}\n');
  await fs.writeFile(path.join(root, "private.md"), EXCLUDED);
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ portable: "local", machineField: FIELD }));
  const fingerprint = syncCheckConfigFingerprint(configFromSettings(validateSettingsDocument(config(storage))));
  const facts = (mode: ClientFacts["mode"] = "tui") => ({
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    idle: true,
  });
  const diagnostics: unknown[] = [];
  const service = createEngineService(root);
  await withRpcServer(
    root,
    service.execute,
    async (api) => {
      service.bind(api.server);
      await run({ ...api, root, requests, objects, gates, diagnostics, save, fingerprint, facts });
    },
    {
      diagnostic(event) {
        diagnostics.push(event);
      },
    },
  );
}

const noCallbacks = {
  callback: async () => {
    throw new Error("Read reviews cannot ask for callbacks.");
  },
};

test("loopback comparison preserves policy and capture identity without patch text in ordinary RPC", () =>
  fixture(async ({ createConnection, facts, fingerprint, requests, root, diagnostics, server }) => {
    const events: ClientEvent[] = [];
    const tui = await createConnection(facts(), { ...noCallbacks, event: (event) => events.push(event) }).attach();
    const rpc = await createConnection(facts("rpc"), { ...noCallbacks, event: (event) => events.push(event) }).attach();
    const configFile = path.join(root, "pi-sync.json");
    if (process.platform !== "win32") await fs.chmod(configFile, 0o644);
    let job: string | undefined;
    const result = await tui.run("diff.review", { setup: "home", fingerprint }, undefined, undefined, (id) => {
      job = id;
    });
    const inventory = parseDiffReviewInventory(result);
    assert.equal(inventory.kind, "review");
    assert.match(inventory.lines.join("\n"), /remote included content: differs from this setup.*session JSONL/su);
    assert.deepEqual(
      inventory.files.map(({ path, status }) => [path, status]),
      [
        ["AGENTS.md", "different"],
        ["local.txt", "local-only"],
        ["sessions/a/session.jsonl", "remote-only"],
        ["settings.json", "different"],
        ["zero.txt", "remote-only"],
      ],
    );
    assert.deepEqual(requests, [`GET ${latest}`, `GET ${bundle}`]);
    assert.equal(tui.hasPendingWork, false);
    assert.ok(server.isIdle());
    const idFor = (name: string) => {
      const row = inventory.files.find((row) => row.path === name);
      assert.ok(row);
      return row.id;
    };
    const bound = { client: tui.facts.id, generation: tui.facts.generation, id: inventory.id };
    const call = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
    const fileId = idFor("AGENTS.md");
    assert.deepEqual(await call("diff-review-read", { ...bound, generation: randomUUID(), fileId }), { kind: "stale" });
    assert.deepEqual(
      await call("diff-review-read", { ...bound, client: rpc.facts.id, generation: rpc.facts.generation, fileId }),
      { kind: "stale" },
    );
    assert.deepEqual(await call("diff-review-read", { ...bound, fileId: randomUUID() }), { kind: "stale" });
    await assert.rejects(
      call("diff-review-read", { ...bound, fileId: "../auth.json" }),
      /Invalid diff review request/u,
    );
    await call("diff-review-close", { ...bound, generation: randomUUID() });
    await assert.rejects(rpc.run("diff.review", {}), /Could not open/u);
    assert.deepEqual(requests, [`GET ${latest}`, `GET ${bundle}`]);
    assert.equal((await tui.readDiffReview(inventory.id, fileId)).kind, "diff");
    if (process.platform !== "win32") assert.equal((await fs.stat(configFile)).mode & 0o777, 0o644);

    await rpc.run("diff", legacyOptions);
    assert.ok(events.some((event) => JSON.stringify(event).includes("Different: AGENTS.md")));
    assert.ok(server.isIdle());
    const reads = requests.length;
    await fs.writeFile(path.join(root, "AGENTS.md"), "edited after capture\n");
    assert.deepEqual(await tui.readDiffReview(inventory.id, fileId), {
      kind: "diff",
      content: `--- Local\n+++ Remote\n@@ -1 +1 @@\n-${LOCAL}\n+${REMOTE}\n`,
    });
    const settings = await tui.readDiffReview(inventory.id, idFor("settings.json"));
    assert.equal(settings.kind, "diff");
    assert.match(settings.content, /-\{"portable":"local"\}\n\+\{"portable":"remote"\}/u);
    assert.doesNotMatch(settings.content, /machineField|MACHINE_PRIVATE_BODY/u);
    const session = await tui.readDiffReview(inventory.id, idFor("sessions/a/session.jsonl"));
    assert.equal(session.kind, "notice");
    assert.match(session.message, /metadata-only/u);
    assert.equal((await tui.readDiffReview(inventory.id, idFor("zero.txt"))).kind, "notice");
    assert.equal(requests.length, reads);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "edited after capture\n");
    assert.ok(requests.every((request) => request.startsWith("GET ")));
    assert.ok(job);
    const polled = (await call("poll", { client: bound.client, cursor: 0, job })) as PollReply;
    assert.deepEqual(polled.job?.result, inventory);
    assert.doesNotMatch(JSON.stringify([polled, events, diagnostics]), BODY_MARKERS);
    await tui.closeDiffReview(inventory.id);
    await tui.closeDiffReview(inventory.id);
    assert.deepEqual(await tui.readDiffReview(inventory.id, fileId), { kind: "stale" });
    const next = parseDiffReviewInventory(
      await tui.run("diff.review", {}, undefined, undefined, (id) => {
        job = id;
      }),
    );
    assert.equal(next.kind, "review");
    await call("cancel", { client: bound.client, id: job });
    assert.deepEqual(await tui.readDiffReview(next.id, next.files[0].id), { kind: "stale" });
  }));

test("setup validation rejects before backend access and invalidates the retained pair after setup switch", () =>
  fixture(async ({ createConnection, facts, fingerprint, save, requests, server }) => {
    const clientFacts = facts();
    const tui = await createConnection(clientFacts, noCallbacks).attach();
    const invalid = parseDiffReviewInventory(
      await tui.run("diff.review", { setup: "home", fingerprint: "0".repeat(64) }),
    );
    assert.equal(invalid.kind, "unavailable");
    assert.match(invalid.message, /setup changed/u);
    assert.deepEqual(requests, []);
    const first = parseDiffReviewInventory(await tui.run("diff.review", { setup: "home", fingerprint }));
    assert.equal(first.kind, "review");
    await save("away");
    assert.deepEqual(await tui.readDiffReview(first.id, first.files[0].id), { kind: "stale" });
    assert.equal(requests.length, 2);
    await save();
    const next = parseDiffReviewInventory(await tui.run("diff.review", {}));
    assert.equal(next.kind, "review");
    assert.deepEqual(await tui.readDiffReview(first.id, first.files[0].id), { kind: "stale" });
    await tui.update({ ...clientFacts, sessionId: randomUUID() });
    assert.deepEqual(await tui.readDiffReview(next.id, next.files[0].id), { kind: "stale" });
    const newest = parseDiffReviewInventory(await tui.run("diff.review", {}));
    assert.equal(newest.kind, "review");
    await tui.dispose();
    assert.deepEqual(
      await requestDaemon(server.paths, server.identity, "diff-review-read", {
        client: clientFacts.id,
        generation: clientFacts.generation,
        id: newest.id,
        fileId: newest.files[0].id,
      }),
      { kind: "stale" },
    );
  }));

test("legacy review refuses aliased ancestors, session roots, and hard links before a remote read", () =>
  fixture(async ({ root, createConnection, facts, requests }) => {
    await using paths = new AsyncDisposableStack();
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-outside-review-")));
    paths.defer(() => fs.rm(outside, { recursive: true, force: true }));
    const externalDir = path.join(outside, "files");
    const external = path.join(externalDir, "notes.txt");
    const aliasDir = path.join(root, "links", "outside");
    await fs.mkdir(externalDir);
    await fs.writeFile(external, EXCLUDED);
    await fs.writeFile(path.join(externalDir, "session.jsonl"), SESSION);
    await fs.mkdir(path.dirname(aliasDir));
    await fs.symlink(outside, aliasDir, "junction");
    const configFile = path.join(root, "pi-sync.json");
    const existing = JSON.parse(await fs.readFile(configFile, "utf8")) as ReturnType<typeof config>;
    const save = async (include: string[]) => {
      const config = {
        version: 3,
        activeSyncSetup: "home",
        onSwitch: "ask-before-pull",
        storageConnections: existing.storageConnections,
        syncSetups: { home: { storage: existing.syncSetups.home.storage, sync: { include, automatic: false } } },
      };
      assert.deepEqual(configFromSettings(validateSettingsDocument(config)).include, include);
      await fs.writeFile(configFile, JSON.stringify(config));
    };
    const tui = await createConnection(facts(), noCallbacks).attach();
    const verifyRefusal = async (include: string[]) => {
      await save(include);
      const reply = parseDiffReviewInventory(await tui.run("diff.review", {}));
      assert.equal(reply.kind, "unavailable");
      assert.doesNotMatch(JSON.stringify(reply), BODY_MARKERS);
      assert.deepEqual(requests, []);
    };
    await verifyRefusal(["links/outside/files/notes.txt"]);
    await verifyRefusal(["links/outside/files"]);
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ sessionDir: path.join(aliasDir, "files") }));
    await verifyRefusal(["sessions"]);
    await fs.link(external, path.join(root, "linked.txt"));
    await verifyRefusal(["linked.txt"]);
  }));

test("a disconnected preview request aborts outside the job queue without releasing a current comparison", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-diff-transport-")));
  await using resources = new AsyncDisposableStack();
  resources.defer(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = await runtimePaths(root);
  resources.defer(() => fs.rm(runtime.directory, { recursive: true, force: true }));
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let hold = true;
  const row = { id: randomUUID(), path: "document", status: "local-only" } as const;
  const inventory = { kind: "review", id: randomUUID(), lines: [], files: [row] } as const;
  await withRpcServer(
    root,
    async (operation, payload, execution) => {
      if (operation === "queued-work") return "finished";
      assert.equal(operation, "diff.review");
      if (payload === "queued-ownership-cleanup") {
        throw Object.assign(new Error(SESSION), { code: OWNERSHIP_CLEANUP_REQUIRED });
      }
      assert.ok(execution.diffReview);
      assert.equal(
        execution.diffReview.retain({
          inventory,
          rows: new Map([[row.id, { local: Buffer.from("private\n"), remote: undefined }]]),
          bytes: 100,
          async staleSetup(signal) {
            if (hold) {
              signal.throwIfAborted();
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
                started.resolve();
              });
              stopped.resolve();
            }
            return false;
          },
        }),
        true,
      );
      return inventory;
    },
    async ({ createConnection }) => {
      const tui = await createConnection(
        {
          id: randomUUID(),
          generation: randomUUID(),
          pid: process.pid,
          cwd: root,
          mode: "tui",
          hasUI: true,
          idle: true,
        },
        noCallbacks,
      ).attach();
      await assert.rejects(
        tui.run("diff.review", "queued-ownership-cleanup"),
        (error: unknown) =>
          error instanceof DaemonError &&
          error.remote.properties?.code === OWNERSHIP_CLEANUP_REQUIRED &&
          !error.message.includes(SESSION),
      );
      const live = parseDiffReviewInventory(await tui.run("diff.review", {}));
      assert.equal(live.kind, "review");
      const abort = new AbortController();
      const preview = tui.readDiffReview(live.id, row.id, abort.signal);
      const rejected = assert.rejects(preview, { name: "AbortError" });
      await started.promise;
      assert.equal(await tui.run("queued-work", {}), "finished");
      abort.abort();
      await rejected;
      await stopped.promise;
      hold = false;
      assert.equal((await tui.readDiffReview(live.id, row.id)).kind, "diff");
    },
  );
});

test("cancel, disconnect, and malformed storage do not leak a preview or response body", () =>
  fixture(async ({ createConnection, facts, gates, objects, server }) => {
    const tui = await createConnection(facts(), noCallbacks).attach();
    const reached = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    gates.set(latest, async (response) => {
      response.once("close", () => closed.resolve());
      reached.resolve();
      await closed.promise;
    });
    const abort = new AbortController();
    const running = tui.run("diff.review", {}, abort.signal);
    const rejection = assert.rejects(running, { name: "AbortError" });
    await reached.promise;
    abort.abort();
    await rejection;
    await closed.promise;
    gates.delete(latest);
    const pointer = objects.get(latest);
    assert.ok(pointer);
    objects.set(latest, Buffer.from(`invalid json ${SESSION}`));
    const malformed = parseDiffReviewInventory(await tui.run("diff.review", {}));
    assert.equal(malformed.kind, "unavailable");
    assert.doesNotMatch(malformed.message, BODY_MARKERS);
    objects.set(latest, pointer);
    const raw = facts();
    const call = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
    await call("attach", raw);
    const id = `${operationPrefix(server.identity)}${randomUUID()}`;
    const client = raw.id;
    await call("submit", { id, client, operation: "diff.review", payload: {} });
    const reply = await vi.waitFor(async () => {
      const polled = (await call("poll", { client, job: id, cursor: 0 })) as PollReply;
      assert.equal(polled.job?.phase, "done");
      return polled;
    });
    const inventory = parseDiffReviewInventory(reply.job?.result);
    assert.equal(inventory.kind, "review");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    try {
      await server.expireClients();
    } finally {
      clock.mockRestore();
    }
    await call("resume-contact", raw);
    assert.deepEqual(
      await call("diff-review-read", {
        client,
        generation: raw.generation,
        id: inventory.id,
        fileId: inventory.files[0].id,
      }),
      { kind: "stale" },
    );
    await call("detach", { client });
  }));
