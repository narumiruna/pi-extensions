import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { requestDaemon } from "../src/client.js";
import { runtimePaths } from "../src/identity.js";
import { type ClientFacts, DAEMON_JOB_CAPACITY, type Request } from "../src/protocol.js";
import { stateWaitJobs } from "../src/state-wait-jobs.js";
import { withRpcServer } from "./rpc-server-fixture.js";

async function temporaryFacts(): Promise<ClientFacts> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-wait-performance-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await runtimePaths(root);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: paths.root,
    mode: "rpc",
    hasUI: true,
    idle: true,
    ready: true,
  };
}

function observeRequests(root: string) {
  const requests: Request[] = [];
  let next = Promise.withResolvers<void>();
  const onRequest = (value: unknown) => {
    const { request } = value as { request: IncomingMessage };
    const parts: Uint8Array[] = [];
    request.on("data", (chunk) => parts.push(chunk));
    request.once("end", () => {
      const message = JSON.parse(Buffer.concat(parts).toString("utf8")) as Request;
      if (message.root !== root) return;
      requests.push(message);
      next.resolve();
      next = Promise.withResolvers<void>();
    });
  };
  const diagnostics = channel("http.server.request.start");
  diagnostics.subscribe(onRequest);
  onTestFinished(() => {
    diagnostics.unsubscribe(onRequest);
  });
  return {
    requests,
    async until(predicate: (requests: Request[]) => boolean) {
      while (!predicate(requests)) await next.promise;
    },
  };
}

test("overflow waiters rotate into the bounded request even when new jobs arrive", () => {
  const ids = Array.from({ length: DAEMON_JOB_CAPACITY + 1 }, (_, index) => `job-${index}`);
  const waiters = new Map(ids.map((id) => [id, { id }]));
  const initial = stateWaitJobs(waiters);
  assert.deepEqual(initial, ids.slice(0, DAEMON_JOB_CAPACITY));
  const extra = { id: "another-job" };
  waiters.set(extra.id, extra);
  for (const id of initial.slice(0, 2)) waiters.delete(id);
  const second = stateWaitJobs(waiters);
  assert.equal(second.length, DAEMON_JOB_CAPACITY);
  assert.equal(second[0], ids.at(-1));
  assert.ok(second.includes(extra.id));
  assert.equal(waiters.get(extra.id), extra);
});

function jobPolls(requests: Request[]) {
  return requests.filter(({ method, params }) => method === "poll" && Boolean((params as { job?: string }).job));
}

test("one negotiated wait carries callbacks and the job only polls once for its terminal result", async () => {
  const facts = await temporaryFacts();
  const received = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<boolean>();
  const messages = observeRequests(facts.cwd);
  await withRpcServer(
    facts.cwd,
    async (_operation, _payload, execution) => execution.request("confirm", {}),
    async ({ createConnection }) => {
      const client = await createConnection(facts, {
        callback: async () => {
          received.resolve();
          return answer.promise;
        },
      }).attach();
      const idleWait = (requests: Request[]) =>
        requests.filter(({ method, params }) => method === "state-wait" && (params as { revision?: string }).revision);
      await messages.until((requests) => idleWait(requests).length >= 1);
      const before = idleWait(messages.requests).length;
      const result = client.run("confirm", {});
      try {
        await received.promise;
        await messages.until((requests) => idleWait(requests).length >= before + 2);
        assert.equal(jobPolls(messages.requests).length, 0);
      } finally {
        answer.resolve(true);
        assert.equal(await result, true);
      }
      assert.equal(jobPolls(messages.requests).length, 1);
    },
  );
});

test("the state wait observes a terminal job that produces no event or callback", async () => {
  const facts = await temporaryFacts();
  const messages = observeRequests(facts.cwd);
  await withRpcServer(
    facts.cwd,
    async () => "ready",
    async ({ createConnection }) => {
      const client = await createConnection(facts, { callback: async () => false }).attach();
      await messages.until((requests) => requests.some(({ method }) => method === "state-wait"));
      assert.equal(await client.run("read", {}), "ready");
      assert.equal(jobPolls(messages.requests).length, 1);
    },
  );
});

test("the negotiated wait drains a cancelled job and delivers committed release callbacks", async () => {
  const facts = await temporaryFacts();
  const messages = observeRequests(facts.cwd);
  const entered = Promise.withResolvers<void>();
  let releases = 0;
  await withRpcServer(
    facts.cwd,
    async (_operation, _payload, execution) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (execution.signal.aborted) resolve();
        else execution.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      assert.equal(await execution.request("queue-release", { reservation: randomUUID() }), true);
      execution.signal.throwIfAborted();
    },
    async ({ createConnection }) => {
      const client = await createConnection(facts, {
        callback: async (callback) => {
          assert.equal(callback.kind, "queue-release");
          releases++;
          return true;
        },
      }).attach();
      await messages.until((requests) => requests.some(({ method }) => method === "state-wait"));
      const stop = new AbortController();
      const result = client.run("transfer", {}, stop.signal);
      await entered.promise;
      stop.abort(new Error("cancel request"));
      await assert.rejects(result, /cancel/i);
      assert.equal(releases, 1);
      assert.equal(jobPolls(messages.requests).length, 1);
    },
  );
});

test.for([false, true])(
  "ledger no-op waits for publication and never substitutes a failed write (failure: %s)",
  async (fail) => {
    const facts = await temporaryFacts();
    const messages = observeRequests(facts.cwd);
    await withRpcServer(
      facts.cwd,
      async () => true,
      async ({ createConnection, server }) => {
        await createConnection(facts, { callback: async () => false }).attach();
        const ledger = path.join(server.paths.directory, "clients.json");
        const original = fs.rename.bind(fs);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let writes = 0;
        const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (to === ledger && ++writes === 1) {
            entered.resolve();
            await release.promise;
            if (fail) throw new Error("fixture ledger write failed");
          }
          await original(from, to);
        });
        const changed = { ...facts, sessionFile: path.join(facts.cwd, "new.jsonl") };
        const update = (value: ClientFacts) => requestDaemon(server.paths, server.identity, "update", { facts: value });
        const first = update(changed);
        void first.catch(() => {});
        const outcomes: Promise<unknown>[] = [first];
        try {
          await entered.promise;
          let repeated = false;
          outcomes.push(
            update(changed).then(() => {
              repeated = true;
            }),
          );
          await messages.until((requests) => requests.filter(({ method }) => method === "update").length === 2);
          assert.equal(repeated, false);
          assert.equal(JSON.parse(await fs.readFile(ledger, "utf8")).clients[0].sessionFile, undefined);
          release.resolve();
          const results = await Promise.allSettled(outcomes);
          assert.equal(results[0]?.status, fail ? "rejected" : "fulfilled");
          assert.equal(results[1]?.status, "fulfilled");
          assert.equal(JSON.parse(await fs.readFile(ledger, "utf8")).clients[0].sessionFile, changed.sessionFile);
          assert.equal(writes, fail ? 2 : 1);
          if (!fail) {
            await update(changed);
            assert.equal(writes, 1);
          }
        } finally {
          release.resolve();
          await Promise.allSettled(outcomes);
          spy.mockRestore();
        }
      },
    );
  },
);
