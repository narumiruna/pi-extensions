import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { DaemonConnection, DaemonError, requestDaemon } from "../src/client.js";
import { parseDiffReviewInventory, readDiffReviewPreview } from "../src/diff-review-protocol.js";
import { daemonPaths, privateDirectory, readJsonBody, runtimePaths } from "../src/identity.js";
import { type ClientFacts, type Request, remoteError } from "../src/protocol.js";
import { type RpcFixture, withRpcServer } from "./rpc-server-fixture.js";

const callbacks = { callback: async () => true };
const stale = { kind: "stale" };
const privateFailure = "Synthetic RPC failure with a private detail";

async function withReviewServer<T>(
  run: (fixture: RpcFixture, facts: ClientFacts, signals: Map<string, AbortSignal>) => Promise<T>,
) {
  await using resources = new AsyncDisposableStack();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "drl-"));
  resources.defer(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  const runtime = await runtimePaths(root);
  resources.defer(() => fs.rm(runtime.directory, { recursive: true, force: true }));
  const facts: ClientFacts = {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode: "tui",
    hasUI: true,
    idle: true,
    sessionId: randomUUID(),
    sessionDir: path.join(root, "sessions"),
    sessionFile: path.join(root, "sessions", "fixture.jsonl"),
  };
  const signals = new Map<string, AbortSignal>();
  return await withRpcServer(
    root,
    async (operation, _payload, execution) => {
      assert.equal(operation, "diff.review");
      const row = { id: randomUUID(), path: "fixture.txt", status: "local-only" } as const;
      const inventory = { kind: "review", id: randomUUID(), lines: [], files: [row] } as const;
      assert.ok(
        execution.diffReview?.retain({
          inventory,
          rows: new Map([[row.id, { local: Buffer.from("synthetic preview\n"), remote: undefined }]]),
          bytes: 64,
          staleSetup: async () => false,
        }),
      );
      signals.set(inventory.id, execution.signal);
      return inventory;
    },
    (fixture) => run(fixture, facts, signals),
  );
}

type RpcInterceptor = (call: Request, response: ServerResponse, forward: () => Promise<unknown>) => Promise<unknown>;

async function withRelay<T>(
  { server }: RpcFixture,
  facts: ClientFacts,
  intercept: RpcInterceptor,
  run: (client: DaemonConnection) => Promise<T>,
) {
  await using resources = new AsyncDisposableStack();
  const paths = daemonPaths({ ...server.paths, directory: path.join(facts.cwd, "relay") }, server.identity.instance);
  if (paths.endpointDirectory) {
    await privateDirectory(paths.endpointDirectory);
    const directory = paths.endpointDirectory;
    resources.defer(() => fs.rm(directory, { recursive: true, force: true }));
  }
  const relay = createServer(async (request, response) => {
    const disconnected = new AbortController();
    response.once("close", () => disconnected.abort());
    try {
      const body = (await readJsonBody(request)) as Request;
      const result = await intercept(body, response, () =>
        requestDaemon(server.paths, server.identity, body.method, body.params, disconnected.signal),
      );
      if (!response.destroyed) response.end(JSON.stringify({ result }));
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: error instanceof DaemonError ? error.remote : remoteError(error) }));
      }
    }
  });
  const listening = once(relay, "listening");
  relay.listen(paths.endpoint);
  await listening;
  resources.defer(async () => {
    const closed = once(relay, "close");
    relay.close();
    relay.closeAllConnections();
    await closed;
  });
  const client = new DaemonConnection(paths, server.identity, { ...facts }, callbacks);
  resources.defer(() => client.dispose());
  await client.attach();
  return await run(client);
}

async function openReview(client: DaemonConnection) {
  const inventory = parseDiffReviewInventory(await client.run("diff.review", {}));
  assert.equal(inventory.kind, "review");
  return { id: inventory.id, fileId: inventory.files[0].id };
}

function holdPreviewReply() {
  const reached = Promise.withResolvers<unknown>();
  const release = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const intercept: RpcInterceptor = async ({ method }, response, forward) => {
    if (method !== "diff-review-read") return forward();
    response.once("close", () => disconnected.resolve());
    const reply = await forward();
    reached.resolve(reply);
    await Promise.race([release.promise, disconnected.promise]);
    return reply;
  };
  return { reached: reached.promise, release: release.resolve, disconnected: disconnected.promise, intercept };
}

const bindingChanges: [string, (facts: ClientFacts) => ClientFacts][] = [
  ["mode", (facts) => ({ ...facts, mode: "rpc" })],
  ["hasUI", (facts) => ({ ...facts, hasUI: false })],
  ["cwd", (facts) => ({ ...facts, cwd: path.dirname(facts.cwd) })],
  ["sessionId", (facts) => ({ ...facts, sessionId: randomUUID() })],
  ["sessionDir", (facts) => ({ ...facts, sessionDir: path.join(facts.cwd, "other-sessions") })],
  ["sessionFile removal", ({ sessionFile: _previous, ...facts }) => facts],
];

test.each(bindingChanges)("retires already-published previews after a same-generation %s update", (field, change) =>
  withReviewServer(async (fixture, facts) => {
    const gate = holdPreviewReply();
    await withRelay(fixture, facts, gate.intercept, async (client) => {
      const { id, fileId } = await openReview(client);
      const preview = client.readDiffReview(id, fileId);
      try {
        assert.equal(readDiffReviewPreview(await gate.reached).kind, "diff");
        const next = change(facts);
        const factsReference = client.facts;
        const updating = client.update(next);
        next.sessionId = "mutated-after-submission";
        await updating;
        assert.equal(client.facts, factsReference);
        assert.notEqual(client.facts.sessionId, next.sessionId);
        if (field === "sessionFile removal") assert.equal(client.facts.sessionFile, undefined);
        await client.update(facts);
        // Restoring the original values cannot resurrect the old preview request.
        gate.release();
        assert.deepEqual(await preview, stale);
        await gate.disconnected;
      } finally {
        gate.release();
      }
    });
  }),
);

test.each(["delayed", "lost"] as const)("review RPCs are gated when a binding acknowledgement is %s", (ack) =>
  withReviewServer(async (fixture, facts) => {
    const published = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstUpdate = true;
    let previewCalls = 0;
    let submissions = 0;
    await withRelay(
      fixture,
      facts,
      async ({ method }, response, forward) => {
        if (method === "update" && firstUpdate) {
          firstUpdate = false;
          const result = await forward();
          published.resolve();
          await release.promise;
          if (ack === "lost") response.destroy();
          return result;
        }
        if (method === "submit") submissions++;
        if (method === "diff-review-read" || method === "diff-review-close") previewCalls++;
        return forward();
      },
      async (client) => {
        const previous = await openReview(client);
        const next = { ...facts, sessionId: randomUUID() };
        const updating = client.update(next);
        const settled = ack === "lost" ? assert.rejects(updating, /socket hang up/u) : updating;
        const assertGated = async () => {
          assert.deepEqual(await client.readDiffReview(previous.id, previous.fileId), stale);
          await client.closeDiffReview(previous.id);
          await assert.rejects(client.run("diff.review", {}), /file review session is unconfirmed/u);
          assert.equal(previewCalls, 0);
          assert.equal(submissions, 1);
        };
        try {
          await published.promise;
          assert.equal(fixture.server.participants()[0].sessionId, next.sessionId);
          assert.equal(client.facts.sessionId, facts.sessionId);
          await assertGated();
          release.resolve();
          await settled;
          if (ack === "lost") {
            await assertGated();
            await client.update({ ...facts, idle: false });
            assert.equal(fixture.server.participants()[0].sessionId, facts.sessionId);
          }
          const { id, fileId } = await openReview(client);
          assert.equal((await client.readDiffReview(id, fileId)).kind, "diff");
          await client.closeDiffReview(id);
          assert.equal(previewCalls, 2);
          assert.equal(submissions, 2);
        } finally {
          release.resolve();
          await Promise.allSettled([settled]);
        }
      },
    );
  }),
);

test("a metadata-only update preserves a preview, but direct facts mutation does not", () =>
  withReviewServer(async (fixture, facts) => {
    const gates = [holdPreviewReply(), holdPreviewReply()];
    let reads = 0;
    await withRelay(
      fixture,
      facts,
      (call, response, forward) =>
        call.method === "diff-review-read" ? gates[reads++].intercept(call, response, forward) : forward(),
      async (client) => {
        const { id, fileId } = await openReview(client);
        const first = client.readDiffReview(id, fileId);
        try {
          await gates[0].reached;
          await client.update({ ...facts, idle: false, ready: true });
          gates[0].release();
          assert.equal((await first).kind, "diff");
          const second = client.readDiffReview(id, fileId);
          await gates[1].reached;
          client.facts.sessionId = randomUUID();
          gates[1].release();
          assert.deepEqual(await second, stale);
        } finally {
          for (const gate of gates) gate.release();
        }
      },
    );
  }));

test.each(["fails", "succeeds", "fails during disposal"] as const)(
  "retired preview transport follows the current connection when pause %s",
  (outcome) =>
    withReviewServer(async (fixture, facts) => {
      const pauseSeen = Promise.withResolvers<void>();
      const releasePause = Promise.withResolvers<void>();
      const gate = holdPreviewReply();
      let reads = 0;
      let closes = 0;
      await withRelay(
        fixture,
        facts,
        async (call, response, forward) => {
          if (call.method === "pause") {
            pauseSeen.resolve();
            await releasePause.promise;
            if (outcome !== "succeeds") {
              response.destroy();
              return;
            }
          }
          if (call.method === "diff-review-read" && ++reads === 1) return gate.intercept(call, response, forward);
          if (call.method === "diff-review-close") closes++;
          return forward();
        },
        async (client) => {
          const { id, fileId } = await openReview(client);
          const preview = client.readDiffReview(id, fileId);
          try {
            await gate.reached;
            const pausing = client.pause();
            const paused = outcome === "succeeds" ? pausing : assert.rejects(pausing, /socket hang up/u);
            await pauseSeen.promise;
            assert.deepEqual(await client.readDiffReview(id, fileId), stale);
            await client.closeDiffReview(id);
            if (outcome === "fails during disposal") await client.dispose();
            releasePause.resolve();
            await paused;
            gate.release();
            assert.deepEqual(await preview, stale);
            await gate.disconnected;
            if (outcome === "fails") {
              assert.equal((await client.readDiffReview(id, fileId)).kind, "diff");
              await client.closeDiffReview(id);
              assert.deepEqual(await client.readDiffReview(id, fileId), stale);
              assert.equal(reads, 3);
              assert.equal(closes, 1);
              return;
            }
            assert.deepEqual(await client.readDiffReview(id, fileId), stale);
            await client.closeDiffReview(id);
            assert.equal(reads, 1);
            assert.equal(closes, 0);
            if (outcome === "succeeds") {
              await client.attach();
              const replacement = await openReview(client);
              assert.equal((await client.readDiffReview(replacement.id, replacement.fileId)).kind, "diff");
            }
          } finally {
            releasePause.resolve();
            gate.release();
          }
        },
      );
    }),
);

test.each([false, true])("sanitizes a diff review poll failure with cancel failure = %s", (cancelFails) =>
  withReviewServer(async (fixture, facts) => {
    let fail = true;
    let cancels = 0;
    let submissions = 0;
    await withRelay(
      fixture,
      facts,
      async ({ method, params }, _response, forward) => {
        if (method === "submit") submissions++;
        if (method === "poll" && fail && (params as { job?: string }).job) throw new Error(privateFailure);
        if (method === "cancel") {
          cancels++;
          if (cancelFails) throw new Error(privateFailure);
        }
        return forward();
      },
      async (client) => {
        await assert.rejects(client.run("diff.review", {}), {
          message: cancelFails
            ? "The daemon diff review outcome is uncertain. Reload Pi to reconnect before opening a review."
            : "Could not open the daemon diff review. Check the connection and try again.",
        });
        assert.equal(cancels, 1);
        assert.equal(client.hasPendingWork, cancelFails);
        fail = false;
        if (cancelFails) await assert.rejects(client.run("diff.review", {}), /unavailable/u);
        else await openReview(client);
        assert.equal(submissions, cancelFails ? 1 : 2);
      },
    );
  }),
);

const rollbackCases = ["update", "superseded update", "attach"] as const;

test.each(rollbackCases)("review ownership follows the binding that survives a failed %s", (kind) =>
  withReviewServer(async ({ server, createConnection }, facts, signals) => {
    const client = await createConnection({ ...facts }, callbacks).attach();
    const original = await openReview(client);
    const bound = { client: facts.id, generation: facts.generation };
    const raw = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
    const read = (review: Awaited<ReturnType<typeof openReview>>) => raw("diff-review-read", { ...bound, ...review });
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rename = fs.rename.bind(fs);
    const ledger = path.join(server.paths.directory, "clients.json");
    let first = true;
    const fault = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === ledger && first) {
        first = false;
        saving.resolve();
        await release.promise;
        throw new Error(privateFailure);
      }
      return rename(source, target);
    });
    const next = { ...facts, sessionId: randomUUID() };
    const update = kind === "attach" ? raw("attach", next) : raw("update", { facts: next });
    const failed = assert.rejects(update, { message: privateFailure });
    let later: Promise<unknown> | undefined;
    try {
      await saving.promise;
      assert.deepEqual(await read(original), stale);
      const provisional = await openReview(client);
      assert.equal(readDiffReviewPreview(await read(provisional)).kind, "diff");
      if (kind === "superseded update") {
        const latest = { ...facts, sessionId: randomUUID() };
        later = raw("update", { facts: latest });
        await vi.waitFor(() => assert.equal(server.participants()[0].sessionId, latest.sessionId));
        assert.deepEqual(await read(provisional), stale);
        const surviving = await openReview(client);
        release.resolve();
        await failed;
        await later;
        assert.equal(server.participants()[0].sessionId, latest.sessionId);
        assert.equal(signals.get(surviving.id)?.aborted, false);
        assert.equal(readDiffReviewPreview(await read(surviving)).kind, "diff");
      } else {
        release.resolve();
        await failed;
        assert.equal(server.participants()[0].sessionId, facts.sessionId);
        assert.equal(signals.get(provisional.id)?.aborted, true);
        assert.deepEqual(await read(provisional), stale);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([failed, later]);
      fault.mockRestore();
    }
  }),
);
