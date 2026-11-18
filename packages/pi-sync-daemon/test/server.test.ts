import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, vi } from "vitest";
import { DAEMON_BUILD_VERSION } from "../src/build-version.js";
import { DaemonConnection, DaemonError, requestDaemon } from "../src/client.js";
import { daemonPaths, privateDirectory, readIdentity, runtimePaths } from "../src/identity.js";
import { type ClientFacts, type Execute, type JobView, operationPrefix, type PollReply } from "../src/protocol.js";
import { startServer } from "../src/server.js";

function facts(root: string): ClientFacts {
  return {
    id: randomUUID(),
    pid: process.pid,
    generation: randomUUID(),
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: true,
    sessionId: randomUUID(),
    sessionFile: path.join(root, "sessions", "active.jsonl"),
  };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-api-"));
  try {
    await run(await fs.realpath(root));
  } finally {
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function terminal(server: Awaited<ReturnType<typeof startServer>>, client: string, id: string) {
  for (;;) {
    const value = (await requestDaemon(server.paths, server.identity, "poll", { client, job: id })) as { job: JobView };
    if (value.job.phase === "done" || value.job.phase === "failed") return value.job;
    await setImmediate();
  }
}

type Server = Awaited<ReturnType<typeof startServer>>;

async function expireContact(server: Server) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
  try {
    await server.expireClients();
  } finally {
    clock.mockRestore();
  }
}

function poll(server: Server, client: string, job?: string) {
  return requestDaemon(server.paths, server.identity, "poll", { client, job }) as Promise<PollReply>;
}

function expiredError(error: unknown) {
  return error instanceof DaemonError && error.remote.name === "ClientContactExpiredError";
}

test("root-bound local handshake rejects a second live daemon and authenticates calls", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => "ok");
    try {
      assert.deepEqual(await requestDaemon(server.paths, server.identity, "hello", {}), {
        version: 1,
        buildVersion: DAEMON_BUILD_VERSION,
        root,
        instance: server.identity.instance,
        pid: process.pid,
      });
      await assert.rejects(
        startServer(root, async () => null),
        /owner is still alive/u,
      );
      await assert.rejects(
        requestDaemon(server.paths, { ...server.identity, token: "0".repeat(64) }, "hello", {}),
        /identity or protocol/u,
      );
      await assert.rejects(requestDaemon(server.paths, { ...server.identity, instance: randomUUID() }, "hello", {}), {
        code: "ENOENT",
      });
      assert.equal((await readIdentity(server.paths))?.instance, server.identity.instance);
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(server.paths.directory)).mode & 0o077, 0);
        assert.equal((await fs.stat(server.paths.identity)).mode & 0o077, 0);
        assert.equal((await fs.stat(path.dirname(server.paths.endpoint))).mode & 0o077, 0);
      }
    } finally {
      await server.close();
    }
  }));

test("jobs serialize, duplicate IDs do not execute twice, and changed inputs are rejected", () =>
  fixture(async (root) => {
    let calls = 0;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startServer(root, async (_operation, payload) => {
      calls++;
      entered();
      await hold;
      return payload;
    });
    const peer = facts(root);
    const id = `${operationPrefix(server.identity)}${randomUUID()}`;
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      await requestDaemon(server.paths, server.identity, "submit", {
        id,
        client: peer.id,
        operation: "check",
        payload: "first",
      });
      await ready;
      await requestDaemon(server.paths, server.identity, "submit", {
        id,
        client: peer.id,
        operation: "check",
        payload: "first",
      });
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "submit", {
          id,
          client: peer.id,
          operation: "check",
          payload: "changed",
        }),
        /reused/u,
      );
      assert.equal(calls, 1);
      release();
      assert.equal((await terminal(server, peer.id, id)).result, "first");
    } finally {
      release();
      await server.close();
    }
  }));

test("a cancellation that arrives before dispatch prevents execution", () =>
  fixture(async (root) => {
    let calls = 0;
    const server = await startServer(root, async () => {
      calls++;
    });
    const peer = facts(root);
    const id = `${operationPrefix(server.identity)}${randomUUID()}`;
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      await requestDaemon(server.paths, server.identity, "cancel", { client: peer.id, id });
      await requestDaemon(server.paths, server.identity, "submit", { client: peer.id, id, operation: "push" });
      assert.equal((await terminal(server, peer.id, id)).phase, "failed");
      assert.equal(calls, 0);
    } finally {
      await server.close();
    }
  }));

test("client callbacks preserve request identity and their results", () =>
  fixture(async (root) => {
    const execute: Execute = async (_operation, _payload, context) => context.request("confirm", { title: "Review" });
    const server = await startServer(root, execute);
    const peer = facts(root);
    const seen: string[] = [];
    const connection = await new DaemonConnection(server.paths, server.identity, peer, {
      callback: async (callback) => {
        seen.push(callback.id);
        assert.deepEqual(callback.payload, { title: "Review" });
        return true;
      },
    }).attach();
    try {
      assert.equal(await connection.run("review", {}), true);
      assert.equal(new Set(seen).size, 1);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }));

test("session-generation changes are not accepted as an ordinary update", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => null);
    const peer = facts(root);
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "update", { facts: { ...peer, generation: randomUUID() } }),
        /generation/u,
      );
      assert.equal(server.participants()[0]?.sessionFile, peer.sessionFile);
      await requestDaemon(server.paths, server.identity, "detach", { client: peer.id });
      assert.deepEqual(server.participants(), []);
    } finally {
      await server.close();
    }
  }));

test("restarted service protects an ambiguously disconnected live client", () =>
  fixture(async (root) => {
    const peer = facts(root);
    const first = await startServer(root, async () => null);
    try {
      await requestDaemon(first.paths, first.identity, "attach", peer);
      await expireContact(first);
      assert.equal((await poll(first, peer.id)).contact, "expired");
    } finally {
      await first.close();
    }
    const second = await startServer(root, async () => null);
    try {
      assert.equal(second.participants()[0]?.sessionFile, peer.sessionFile);
      assert.equal(second.participants()[0]?.idle, false);
      assert.equal((await poll(second, peer.id)).contact, "inactive");
      await assert.rejects(requestDaemon(second.paths, second.identity, "resume-contact", peer), /not eligible/u);
      await requestDaemon(second.paths, second.identity, "attach", peer);
      assert.equal(second.participants()[0]?.idle, true);
      await requestDaemon(second.paths, second.identity, "detach", { client: peer.id });
    } finally {
      await second.close();
    }
  }));

test(
  "foreign endpoints from another instance are preserved, never adopted or unlinked",
  { skip: process.platform === "win32" },
  () =>
    fixture(async (root) => {
      const paths = await runtimePaths(root);
      await privateDirectory(paths.directory);
      const old = daemonPaths(paths, randomUUID());
      assert.ok(old.endpointDirectory);
      await fs.mkdir(old.endpointDirectory, { mode: 0o700 });
      await fs.writeFile(old.endpoint, "foreign", { mode: 0o600 });
      const server = await startServer(root, async () => null);
      try {
        assert.notEqual(server.paths.endpoint, old.endpoint);
        assert.equal(await fs.readFile(old.endpoint, "utf8"), "foreign");
      } finally {
        await server.close();
        assert.equal(await fs.readFile(old.endpoint, "utf8"), "foreign");
        await fs.rm(old.endpointDirectory, { recursive: true });
      }
    }),
);

test(
  "closing never lets Node unlink a replacement file or follow a replacement ancestor",
  { skip: process.platform === "win32" },
  () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => null);
      assert.ok(server.paths.endpointDirectory);
      const outside = path.join(root, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "api.sock"), "outside evidence");
      await fs.rm(server.paths.endpointDirectory, { recursive: true });
      await fs.symlink(outside, server.paths.endpointDirectory, "dir");
      try {
        await server.close();
        assert.equal(await fs.readFile(path.join(outside, "api.sock"), "utf8"), "outside evidence");
        const retained = server.retainedEndpoint;
        assert.ok(retained);
        assert.equal((await fs.lstat(path.join(retained, "entry"))).isSymbolicLink(), true);
      } finally {
        await server.close();
        if (server.retainedEndpoint) await fs.rm(server.retainedEndpoint, { recursive: true });
      }
    }),
);

test("a replaced socket file is retained through normal shutdown", { skip: process.platform === "win32" }, () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => null);
    await fs.unlink(server.paths.endpoint);
    await fs.writeFile(server.paths.endpoint, "foreign evidence", { mode: 0o600 });
    try {
      await server.close();
      const retained = server.retainedEndpoint;
      assert.ok(retained);
      assert.equal(await fs.readFile(path.join(retained, "entry", "api.sock"), "utf8"), "foreign evidence");
    } finally {
      await server.close();
      if (server.retainedEndpoint) await fs.rm(server.retainedEndpoint, { recursive: true });
    }
  }),
);

test("different canonical roots have independent identities", () =>
  fixture(async (firstRoot) =>
    fixture(async (secondRoot) => {
      const first = await startServer(firstRoot, async () => 1);
      const second = await startServer(secondRoot, async () => 2);
      try {
        assert.notEqual(first.paths.endpoint, second.paths.endpoint);
        assert.notEqual(first.identity.instance, second.identity.instance);
      } finally {
        await first.close();
        await second.close();
      }
    }),
  ));

test("expired contact cancels work but never treats a live client session as safe", () =>
  fixture(async (root) => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = await startServer(root, async (_operation, _payload, execution) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }),
      );
    });
    const peer = facts(root);
    const id = `${operationPrefix(server.identity)}${randomUUID()}`;
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      await requestDaemon(server.paths, server.identity, "submit", { id, client: peer.id, operation: "wait" });
      await ready;
      await expireContact(server);
      const interrupted = await terminal(server, peer.id, id);
      assert.equal(interrupted.phase, "failed");
      assert.equal((await poll(server, peer.id)).contact, "expired");
      assert.equal(server.participants()[0]?.sessionFile, peer.sessionFile);
      assert.equal(server.participants()[0]?.idle, false);
      await assert.rejects(requestDaemon(server.paths, server.identity, "update", { facts: peer }), expiredError);
      for (const mismatch of [
        { id: randomUUID() },
        { generation: randomUUID() },
        { pid: peer.pid + 1 },
        { cwd: path.dirname(root) },
        { sessionId: randomUUID() },
        { sessionFile: path.join(root, "other.jsonl") },
        { sessionDir: path.join(root, "other") },
      ]) {
        await assert.rejects(requestDaemon(server.paths, server.identity, "resume-contact", { ...peer, ...mismatch }));
        assert.equal((await poll(server, peer.id)).contact, "expired");
      }
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "update", { facts: { ...peer, generation: randomUUID() } }),
        /generation mismatch/u,
      );
      const resumed = (await requestDaemon(server.paths, server.identity, "resume-contact", {
        ...peer,
        ready: true,
      })) as PollReply;
      assert.equal(resumed.contact, "active");
      assert.deepEqual(server.participants(), [{ ...peer, ready: true }]);
      assert.deepEqual((await poll(server, peer.id, id)).job, interrupted);
      await assert.rejects(requestDaemon(server.paths, server.identity, "resume-contact", peer), /not eligible/u);
      await requestDaemon(server.paths, server.identity, "update", { facts: { ...peer, idle: false } });
      assert.equal(server.participants()[0]?.idle, false);
    } finally {
      await server.close();
    }
  }));

test("a poll that beats the heartbeat sweep renews active contact without a resume", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => null);
    const peer = facts(root);
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
      try {
        assert.equal((await poll(server, peer.id)).contact, "active");
        await server.expireClients();
        assert.equal((await poll(server, peer.id)).contact, "active");
      } finally {
        clock.mockRestore();
      }
    } finally {
      await server.close();
    }
  }));

for (const method of ["pause", "handoff", "detach"] as const)
  test(`${method} ends expiry eligibility without removing live session protection`, () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => null);
      const peer = facts(root);
      try {
        await requestDaemon(server.paths, server.identity, "attach", peer);
        await expireContact(server);
        const cleanup = (await requestDaemon(server.paths, server.identity, method, {
          client: peer.id,
          generation: peer.generation,
          pid: peer.pid,
          handoff: { kind: "replace", file: peer.sessionFile },
        })) as PollReply;
        assert.equal(cleanup.contact, "inactive");
        assert.equal((await poll(server, peer.id)).contact, "inactive");
        await assert.rejects(requestDaemon(server.paths, server.identity, "resume-contact", peer), /not eligible/u);
        await assert.rejects(requestDaemon(server.paths, server.identity, "update", { facts: peer }), /not attached/u);
        assert.equal(server.liveClients()[0]?.sessionFile, peer.sessionFile);
      } finally {
        await server.close();
      }
    }));

for (const failCommit of [false, true])
  test(`expiry cancels queued work and fences ${failCommit ? "uncertain" : "settled"} committed work`, () =>
    fixture(async (root) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const observedResume = Promise.withResolvers<void>();
      let watching = false;
      const executions: string[] = [];
      const server = await startServer(
        root,
        async (operation, _payload, execution) => {
          executions.push(operation);
          if (operation !== "first") return "new result";
          execution.committed();
          entered.resolve();
          await finish.promise;
          assert.equal(execution.signal.aborted, false);
          if (failCommit) throw new Error("Retained journal after commit failure");
          return "existing result";
        },
        {
          factsChanged: async () => {
            if (watching) observedResume.resolve();
          },
        },
      );
      const peer = { ...facts(root), ready: true };
      const request = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
      const first = `${operationPrefix(server.identity)}${randomUUID()}`;
      const queued = `${operationPrefix(server.identity)}${randomUUID()}`;
      let resuming: Promise<unknown> | undefined;
      try {
        await request("attach", peer);
        await request("submit", { client: peer.id, id: first, operation: "first" });
        await entered.promise;
        await request("submit", { client: peer.id, id: queued, operation: "queued" });
        await expireContact(server);
        watching = true;
        resuming = request("resume-contact", peer);
        void resuming.catch(() => {});
        await observedResume.promise;
        const interrupted = await poll(server, peer.id, first);
        assert.equal(interrupted.contact, "expired");
        assert.equal(interrupted.job?.phase, "running");
        assert.equal(interrupted.events.filter(({ kind }) => kind === "commit").length, 1);
        assert.equal(server.participants()[0]?.idle, false);
        assert.equal(server.participants()[0]?.ready, false);
        assert.equal((await poll(server, peer.id, queued)).job?.phase, "queued");
        finish.resolve();
        if (failCommit) {
          await assert.rejects(resuming, /cleanup is uncertain/u);
          assert.equal((await poll(server, peer.id)).contact, "expired");
          assert.equal((await terminal(server, peer.id, first)).phase, "failed");
        } else {
          assert.equal(((await resuming) as PollReply).contact, "active");
          assert.equal((await terminal(server, peer.id, first)).result, "existing result");
          const next = `${operationPrefix(server.identity)}${randomUUID()}`;
          await request("submit", { client: peer.id, id: next, operation: "next" });
          assert.equal((await terminal(server, peer.id, next)).result, "new result");
        }
        assert.equal((await terminal(server, peer.id, queued)).error?.message, "Client contact expired");
        assert.deepEqual(executions, failCommit ? ["first"] : ["first", "next"]);
      } finally {
        finish.resolve();
        await Promise.allSettled([resuming]);
        await server.close();
      }
    }));

for (const interrupted of ["expiry", "pause"] as const)
  test(`an update interrupted by ${interrupted} cannot report active contact after waiting for monitoring`, () =>
    fixture(async (root) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let block = false;
      const server = await startServer(root, async () => undefined, {
        factsChanged: async () => {
          if (!block) return;
          block = false;
          entered.resolve();
          await release.promise;
        },
      });
      const peer = facts(root);
      const request = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
      let updating: Promise<unknown> | undefined;
      try {
        await request("attach", peer);
        block = true;
        updating = request("update", { facts: peer });
        void updating.catch(() => {});
        await entered.promise;
        if (interrupted === "expiry") await expireContact(server);
        else await request("pause", { client: peer.id });
        release.resolve();
        if (interrupted === "expiry") await assert.rejects(updating, expiredError);
        else await assert.rejects(updating, /not attached/u);
      } finally {
        release.resolve();
        await Promise.allSettled([updating]);
        await server.close();
      }
    }));

test("contact resume checks changed consent binding before publishing and does not activate on monitor failure", () =>
  fixture(async (root) => {
    const peer = { ...facts(root), ready: true };
    const current: ClientFacts = {
      ...peer,
      model: { provider: "fixture", id: "current", signature: "0".repeat(64), authSource: "stored" },
    };
    let check = false;
    let fail = true;
    const server = await startServer(root, async () => undefined, {
      factsChanged: async () => {
        if (!check) return;
        assert.deepEqual(server.participants(), [{ ...current, ready: false, idle: false }]);
        assert.deepEqual(server.liveClients(), [peer]);
        if (fail) throw new Error("Consent persistence failed");
      },
    });
    const request = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
    try {
      await request("attach", peer);
      await expireContact(server);
      check = true;
      await assert.rejects(request("resume-contact", current), /Consent persistence failed/u);
      assert.equal((await poll(server, peer.id)).contact, "expired");
      assert.deepEqual(server.participants(), [{ ...peer, idle: false }]);
      fail = false;
      assert.equal(((await request("resume-contact", current)) as PollReply).contact, "active");
      assert.deepEqual(server.participants(), [current]);
    } finally {
      await server.close();
    }
  }));

for (const failure of ["persistence", "owner-root-change"] as const)
  test(`contact resume does not publish after ${failure} at the peer ledger fence`, () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => undefined);
      const peer = { ...facts(root), ready: false };
      const candidate = { ...peer, ready: true };
      const request = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
      const ledger = path.join(server.paths.directory, "clients.json");
      const movedRoot = `${root}-moved`;
      const rename = fs.rename;
      let failed = false;
      let moved = false;
      let restoreRename: (() => void) | undefined;
      try {
        await request("attach", peer);
        await expireContact(server);
        const previous = await fs.readFile(ledger, "utf8");
        const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (to === ledger && !failed) {
            failed = true;
            if (failure === "persistence") throw new Error("Peer persistence failed");
            await rename(root, movedRoot);
            moved = true;
            await fs.mkdir(root);
          }
          await rename(from, to);
        });
        restoreRename = () => spy.mockRestore();
        await assert.rejects(
          request("resume-contact", candidate),
          failure === "persistence" ? /Peer persistence failed/u : /Canonical agent root changed/u,
        );
        assert.equal(failed, true);
        assert.equal((await poll(server, peer.id)).contact, "expired");
        assert.deepEqual(server.liveClients(), [peer]);
        if (failure === "persistence") {
          assert.equal(await fs.readFile(ledger, "utf8"), previous);
          await assert.rejects(request("resume-contact", candidate), /ledger persistence is uncertain/u);
          assert.equal((await poll(server, peer.id)).contact, "expired");
        }
      } finally {
        restoreRename?.();
        if (moved) {
          await fs.rmdir(root);
          await rename(movedRoot, root);
        }
        await server.close();
      }
    }));

test("evicted results and old-instance operation IDs cannot dispatch another commit", () =>
  fixture(async (root) => {
    let calls = 0;
    const peer = facts(root);
    const server = await startServer(root, async () => ++calls);
    const first = `${operationPrefix(server.identity)}${randomUUID()}`;
    try {
      await requestDaemon(server.paths, server.identity, "attach", peer);
      for (let index = 0; index < 65; index++) {
        const id = index ? `${operationPrefix(server.identity)}${randomUUID()}` : first;
        await requestDaemon(server.paths, server.identity, "submit", { id, client: peer.id, operation: "commit" });
        assert.equal((await terminal(server, peer.id, id)).phase, "done");
      }
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "submit", { id: first, client: peer.id, operation: "commit" }),
        /expired/u,
      );
      assert.equal(calls, 65);
      await requestDaemon(server.paths, server.identity, "detach", { client: peer.id });
    } finally {
      await server.close();
    }
    const next = await startServer(root, async () => ++calls);
    const replacement = { ...peer, id: randomUUID(), generation: randomUUID() };
    try {
      await requestDaemon(next.paths, next.identity, "attach", replacement);
      await assert.rejects(
        requestDaemon(next.paths, next.identity, "submit", { id: first, client: replacement.id, operation: "commit" }),
        /another daemon instance/u,
      );
      assert.equal(calls, 65);
    } finally {
      await next.close();
    }
  }));

test("disposing a client cancels an open review and drains acknowledged queue release", () =>
  fixture(async (root) => {
    let granted!: () => void;
    const ready = new Promise<void>((resolve) => {
      granted = resolve;
    });
    let released = false;
    const server = await startServer(root, async (_operation, _payload, execution) => {
      await execution.request("queue-acquire", {});
      try {
        return await execution.request("confirm", {});
      } finally {
        await execution.request("queue-release", {});
      }
    });
    const connection = await new DaemonConnection(server.paths, server.identity, facts(root), {
      callback: async (callback, signal) => {
        if (callback.kind === "queue-acquire") return true;
        if (callback.kind === "queue-release") {
          released = true;
          return true;
        }
        granted();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    }).attach();
    const job = connection.run("review", {}).then(
      () => undefined,
      (error) => error,
    );
    try {
      await ready;
      await connection.dispose();
      assert.equal(released, true);
      assert.ok((await job) instanceof Error);
      assert.deepEqual(server.participants(), []);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }));
