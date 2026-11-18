import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { ClientRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, vi } from "vitest";
import { DaemonConnection, requestDaemon } from "../src/client.js";
import { engineHost } from "../src/engine/host.js";
import { runtimePaths } from "../src/identity.js";
import { withCleanup } from "../src/lifecycle.js";
import { ParticipantAdmission } from "../src/participant-admission.js";
import type { ClientFacts, PollReply } from "../src/protocol.js";
import { startServer } from "../src/server.js";
import { installServiceHost } from "../src/service-host.js";

function facts(root: string, mode: ClientFacts["mode"] = "rpc"): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode,
    hasUI: mode === "rpc",
    idle: true,
  };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-admission-")));
  try {
    await run(root);
  } finally {
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}
/** Observe the server enqueuing admission, not a client-side timer or a network sleep. */
function observeAdmission() {
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const original = ParticipantAdmission.prototype.run;
  const spy = vi.spyOn(ParticipantAdmission.prototype, "run").mockImplementation(function <T>(
    this: ParticipantAdmission,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    entered.resolve(signal);
    return original.call(this, action, signal) as Promise<T>;
  });
  return { entered: entered.promise, restore: () => spy.mockRestore() };
}

async function expireContact(server: Awaited<ReturnType<typeof startServer>>) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
  try {
    await server.expireClients();
  } finally {
    clock.mockRestore();
  }
}

for (const releaseFails of [false, true])
  test(`expired contact waits for ${releaseFails ? "failed" : "acknowledged"} reservation cleanup`, () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => undefined);
      const owner = new AbortController();
      const granted = Promise.withResolvers<void>();
      const releaseQueued = Promise.withResolvers<void>();
      const reservation = randomUUID();
      const peer = { ...facts(root), ready: true };
      const call = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
      const poll = () => call("poll", { client: peer.id }) as Promise<PollReply>;
      let reservationWork: Promise<void> | undefined;
      let resuming: Promise<unknown> | undefined;
      let observer: ReturnType<typeof observeAdmission> | undefined;
      try {
        await call("attach", peer);
        const execution = server.backgroundExecution(owner.signal);
        reservationWork = execution.withParticipants(async () => {
          try {
            await execution.request("queue-acquire", { reservation }, peer.id);
            granted.resolve();
            await once(execution.signal, "abort");
          } finally {
            const release = execution.request("queue-release", { reservation }, peer.id);
            releaseQueued.resolve();
            await release;
          }
        });
        void reservationWork.catch(() => {});
        let acquire: PollReply["callbacks"][number] | undefined;
        while (!acquire) acquire = (await poll()).callbacks.find(({ kind }) => kind === "queue-acquire");
        await call("answer", { client: peer.id, id: acquire.id, value: true });
        await granted.promise;
        await expireContact(server);
        await releaseQueued.promise;
        observer = observeAdmission();
        resuming = call("resume-contact", peer);
        void resuming.catch(() => {});
        await observer.entered;
        observer.restore();
        const pendingRelease = await poll();
        assert.equal(pendingRelease.contact, "expired");
        assert.equal(server.participants()[0]?.ready, false);
        const release = pendingRelease.callbacks.find(({ kind }) => kind === "queue-release");
        assert.ok(release);
        assert.equal(release.job, acquire.job);
        assert.deepEqual(release.payload, { reservation });
        assert.equal((await poll()).callbacks[0]?.id, release.id);
        await call("answer", {
          client: peer.id,
          id: release.id,
          ...(releaseFails ? { error: "Pi could not confirm release" } : { value: true }),
        });
        if (releaseFails) {
          await assert.rejects(reservationWork, /could not confirm/u);
          await assert.rejects(resuming, /cleanup is uncertain/u);
          assert.equal((await poll()).contact, "expired");
          assert.equal(server.participants()[0]?.idle, false);
        } else {
          await reservationWork;
          assert.equal(((await resuming) as PollReply).contact, "active");
          assert.deepEqual((await poll()).callbacks, []);
          assert.equal(server.participants()[0]?.ready, true);
        }
      } finally {
        observer?.restore();
        owner.abort();
        for (const callback of (await poll()).callbacks)
          if (callback.kind === "queue-release")
            await call("answer", { client: peer.id, id: callback.id, value: true });
        await Promise.allSettled([reservationWork, resuming]);
        await server.close();
      }
    }));

for (const cancellation of ["disconnect", "pause", "handoff", "stop"] as const)
  test(`a queued contact resume cancelled by ${cancellation} cannot publish after the fence`, () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => undefined);
      const peer = { ...facts(root), ready: true };
      const call = (method: string, params: unknown, signal?: AbortSignal) =>
        requestDaemon(server.paths, server.identity, method, params, signal);
      const owner = new AbortController();
      const request = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let observer: ReturnType<typeof observeAdmission> | undefined;
      let held: Promise<void> | undefined;
      let resuming: Promise<unknown> | undefined;
      try {
        await call("attach", peer);
        await expireContact(server);
        held = server.backgroundExecution(owner.signal).withParticipants(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        observer = observeAdmission();
        resuming = call("resume-contact", peer, request.signal);
        void resuming.catch(() => {});
        const signal = await observer.entered;
        assert.ok(signal);
        observer.restore();
        const aborted = once(signal, "abort");
        if (cancellation === "disconnect") request.abort();
        else await call(cancellation, { client: peer.id, handoff: { kind: "replace", cwd: root } });
        await assert.rejects(resuming);
        await aborted;
        assert.equal(server.participants()[0]?.idle, false);
        release.resolve();
        await held;
        if (cancellation === "disconnect") {
          assert.equal(((await call("poll", { client: peer.id })) as PollReply).contact, "expired");
          assert.equal(((await call("resume-contact", peer)) as PollReply).contact, "active");
        } else if (cancellation !== "stop") {
          assert.equal(((await call("poll", { client: peer.id })) as PollReply).contact, "inactive");
          await assert.rejects(call("resume-contact", peer), /not eligible/u);
        } else {
          await server.close();
          assert.equal(server.participants()[0]?.idle, false);
        }
      } finally {
        observer?.restore();
        request.abort();
        owner.abort();
        release.resolve();
        await Promise.allSettled([held, resuming]);
        await server.close();
      }
    }));

for (const mode of ["print", "json", "rpc"] as const)
  for (const phase of ["grant", "apply", "release"] as const)
    test(`${mode} admission waits through ${phase}, nested writes, and acknowledged queue release`, () =>
      fixture(async (root) => {
        const blocked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const events: string[] = [];
        const target = path.join(root, "AGENTS.md");
        const nested = path.join(root, "nested.md");
        const host = installServiceHost(root);
        let held = false;
        async function hold(at: typeof phase) {
          if (phase === at && !held) {
            held = true;
            blocked.resolve();
            await release.promise;
          }
        }
        const server = await startServer(root, async (_operation, _payload, execution) => {
          const reserveTargets = engineHost().reserveTargets;
          assert.ok(reserveTargets);
          await host.run(execution, () =>
            reserveTargets([target], async () => {
              await hold("apply");
              await engineHost().mutate(target, () => fs.writeFile(target, "applied"));
              // A new target inside the batch must share admission, not deadlock on a second lock.
              await engineHost().mutate(nested, () => fs.writeFile(nested, "nested"));
            }),
          );
          return true;
        });
        const first = new DaemonConnection(server.paths, server.identity, facts(root), {
          callback: async (callback) => {
            if (callback.kind === "queue-acquire") {
              await hold("grant");
              events.push("first-grant");
            } else if (callback.kind === "queue-release") {
              await hold("release");
              events.push("first-release");
            } else throw new Error("Unexpected callback");
            return true;
          },
        });
        const joined = new DaemonConnection(server.paths, server.identity, facts(root, mode), {
          callback: async (callback) => {
            events.push(`joined-${callback.kind}`);
            return true;
          },
        });
        let observer: ReturnType<typeof observeAdmission> | undefined;
        let work: Promise<unknown> | undefined;
        let attaching: Promise<unknown> | undefined;
        try {
          await first.attach();
          work = first.run("write", {});
          void work.catch(() => {});
          await blocked.promise;
          observer = observeAdmission();
          attaching = joined.attach().then(() => events.push("attached"));
          void attaching.catch(() => {});
          await observer.entered;
          observer.restore();
          assert.ok(!server.participants().some((peer) => peer.id === joined.facts.id));
          assert.ok(!events.includes("attached"));
          release.resolve();
          await work;
          await attaching;
          assert.ok(events.lastIndexOf("first-release") < events.indexOf("attached"));
          assert.ok(!events.some((event) => event.startsWith("joined-")));
          assert.equal(await fs.readFile(target, "utf8"), "applied");
          assert.equal(await fs.readFile(nested, "utf8"), "nested");
          // The next transaction must reserve both the original and newly admitted Pi queues.
          assert.equal(await first.run("write", {}), true);
          assert.ok(events.includes("joined-queue-acquire"));
          assert.ok(events.includes("joined-queue-release"));
        } finally {
          observer?.restore();
          release.resolve();
          await Promise.allSettled([work, attaching]);
          await withCleanup(
            async () => {
              const results = await Promise.allSettled([first.dispose(), joined.dispose()]);
              for (const result of results) if (result.status === "rejected") throw result.reason;
            },
            () => server.close(),
          );
        }
      }));

test("attach has a cancellable admission wait rather than an idle timeout; other requests stay bounded", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => undefined);
    const timeouts: number[] = [];
    const original = ClientRequest.prototype.setTimeout;
    const spy = vi.spyOn(ClientRequest.prototype, "setTimeout").mockImplementation(function (
      this: ClientRequest,
      milliseconds: number,
      callback?: () => void,
    ) {
      timeouts.push(milliseconds);
      return original.call(this, milliseconds, callback);
    });
    try {
      await requestDaemon(server.paths, server.identity, "attach", facts(root));
      await requestDaemon(server.paths, server.identity, "hello", {});
      assert.deepEqual(timeouts, [0, 30_000]);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  }));

test("a disconnected attach is removed from admission even without a detach request", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => undefined);
    const owner = new AbortController();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = server.backgroundExecution(owner.signal).withParticipants(async () => {
      ready.resolve();
      await release.promise;
    });
    const request = new AbortController();
    let observer: ReturnType<typeof observeAdmission> | undefined;
    let attaching: Promise<unknown> | undefined;
    try {
      await ready.promise;
      observer = observeAdmission();
      attaching = requestDaemon(server.paths, server.identity, "attach", facts(root), request.signal).then(
        () => undefined,
        (error) => error,
      );
      const signal = await observer.entered;
      observer.restore();
      assert.ok(signal);
      const disconnected = once(signal, "abort");
      request.abort();
      assert.ok((await attaching) instanceof Error);
      await disconnected;
      release.resolve();
      await held;
      await server.backgroundExecution(owner.signal).withParticipants(async (peers) => assert.deepEqual(peers, []));
      assert.deepEqual(server.liveClients(), []);
    } finally {
      observer?.restore();
      request.abort();
      release.resolve();
      owner.abort();
      await Promise.allSettled([held, attaching]);
      await server.close();
    }
  }));

test("cancelled waiters settle without releasing an active scope or poisoning later admission", async () => {
  const admission = new ParticipantAdmission();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const active = admission.run(async () => {
    ready.resolve();
    await release.promise;
  });
  await ready.promise;
  const controller = new AbortController();
  let stale = false;
  const cancelled = admission.run(async () => {
    stale = true;
  }, controller.signal);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  try {
    await rejected;
    assert.equal(stale, false);
    let entered = false;
    const next = admission.run(async () => {
      entered = true;
      return "next";
    });
    await setImmediate();
    assert.equal(entered, false, "a cancelled waiter must not release the active scope");
    release.resolve();
    await active;
    assert.equal(await next, "next");
    await assert.rejects(
      admission.run(async () => {
        throw new Error("failed scope");
      }),
      /failed scope/u,
    );
    assert.equal(await admission.run(async () => "recovered"), "recovered");
  } finally {
    release.resolve();
    await active;
  }
});

for (const cancellation of ["dispose", "signal"] as const)
  test(`a queued attach cancelled by ${cancellation} cannot publish after the reservation ends`, () =>
    fixture(async (root) => {
      const server = await startServer(root, async () => undefined);
      const controller = new AbortController();
      const request = new AbortController();
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = server.backgroundExecution(controller.signal).withParticipants(async () => {
        ready.resolve();
        await release.promise;
      });
      const joined = new DaemonConnection(server.paths, server.identity, facts(root), { callback: async () => true });
      let observer: ReturnType<typeof observeAdmission> | undefined;
      let attaching: Promise<unknown> | undefined;
      try {
        await ready.promise;
        observer = observeAdmission();
        attaching = joined.attach(request.signal).then(
          () => undefined,
          (error) => error,
        );
        await observer.entered;
        observer.restore();
        if (cancellation === "dispose") await joined.dispose();
        else request.abort(new DOMException("Startup cancelled", "AbortError"));
        assert.ok((await attaching) instanceof Error);
        release.resolve();
        await held;
        // This second scope starts after the cancelled attach has drained from admission.
        await server.backgroundExecution(controller.signal).withParticipants(async (peers) => {
          assert.deepEqual(peers, []);
        });
        assert.deepEqual(server.liveClients(), []);
      } finally {
        observer?.restore();
        release.resolve();
        controller.abort();
        await Promise.allSettled([held, attaching]);
        await withCleanup(
          () => joined.dispose(),
          () => server.close(),
        );
      }
    }));

test("an attach signal does not cancel the established session connection", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => "ok");
    const client = new DaemonConnection(server.paths, server.identity, facts(root), { callback: async () => true });
    const request = new AbortController();
    try {
      await client.attach(request.signal);
      request.abort();
      await client.update(client.facts);
      assert.equal(await client.run("check", {}), "ok");
    } finally {
      await withCleanup(
        () => client.dispose(),
        () => server.close(),
      );
    }
  }));

test("factsChanged can await another reservation because attach releases admission before hooks", () =>
  fixture(async (root) => {
    const controller = new AbortController();
    let observed = false;
    const server = await startServer(root, async () => undefined, {
      factsChanged: async () => {
        await server.backgroundExecution(controller.signal).withParticipants(async (peers) => {
          observed = peers.length === 1;
        });
      },
    });
    const client = new DaemonConnection(server.paths, server.identity, facts(root), { callback: async () => true });
    try {
      await client.attach();
      assert.equal(observed, true);
    } finally {
      await withCleanup(
        () => client.dispose(),
        async () => {
          controller.abort();
          await server.close();
        },
      );
    }
  }));

test("shutdown aborts a queued reservation and refuses a queued attach before closing the endpoint", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => undefined);
    const controller = new AbortController();
    const execution = server.backgroundExecution(controller.signal);
    const ready = Promise.withResolvers<void>();
    const held = execution.withParticipants(async () => {
      ready.resolve();
      await new Promise<void>((resolve) => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const client = new DaemonConnection(server.paths, server.identity, facts(root), { callback: async () => true });
    let observer: ReturnType<typeof observeAdmission> | undefined;
    let attaching: Promise<unknown> | undefined;
    try {
      await ready.promise;
      observer = observeAdmission();
      attaching = client.attach().then(
        () => undefined,
        (error) => error,
      );
      await observer.entered;
      observer.restore();
      const queued = server.backgroundExecution(controller.signal).withParticipants(async () => {
        throw new Error("Stale reservation ran");
      });
      const rejected = assert.rejects(queued, { name: "AbortError" });
      await server.close();
      await rejected;
      await held;
      assert.ok((await attaching) instanceof Error);
      assert.ok(!server.participants().some((peer) => peer.id === client.facts.id));
    } finally {
      observer?.restore();
      controller.abort();
      await Promise.allSettled([held, attaching, client.dispose()]);
      await server.close();
    }
  }));
