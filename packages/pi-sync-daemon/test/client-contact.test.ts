import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { daemonPaths, privateDirectory, readJsonBody, runtimePaths } from "../src/identity.js";
import { type ConnectionOptions, type ContactState, DaemonConnection, DaemonError } from "../src/index.js";
import type { Callback, ClientFacts, Identity, PollReply, Request } from "../src/protocol.js";

function poll(contact?: ContactState, extra: Partial<PollReply> = {}) {
  return { result: { cursor: 0, callbacks: [], events: [], contact, ...extra } };
}
function failure(name: string) {
  return { error: { name, message: name } };
}
function releaseCallback(): Callback {
  return { id: randomUUID(), job: randomUUID(), kind: "queue-release", payload: { token: randomUUID() } };
}
type Call = { method: string; params: Record<string, unknown> };
async function fixture(
  respond: (call: Call, response: ServerResponse) => unknown,
  run: (client: DaemonConnection, calls: Call[]) => Promise<void>,
  options: Partial<ConnectionOptions> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-contact-client-"));
  const base = await runtimePaths(root);
  const identity: Identity = {
    version: 1,
    root: base.root,
    instance: randomUUID(),
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
  };
  const paths = daemonPaths(base, identity.instance);
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const { root, instance, token, version, method, params } = (await readJsonBody(request)) as Request;
      assert.deepEqual(
        { root, instance, token, version },
        { root: base.root, instance: identity.instance, token: identity.token, version: 1 },
      );
      const call = { method, params: params as Call["params"] };
      calls.push(call);
      const answer = await respond(call, response);
      if (!response.destroyed) {
        const envelope = answer ?? poll();
        response.writeHead("error" in (envelope as object) ? 400 : 200);
        response.end(JSON.stringify(envelope));
      }
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  const facts: ClientFacts = {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: base.root,
    mode: "rpc",
    hasUI: true,
    idle: true,
    ready: true,
    sessionId: randomUUID(),
  };
  const client = new DaemonConnection(paths, identity, facts, { callback: async () => true, ...options });
  try {
    if (paths.endpointDirectory) await privateDirectory(paths.endpointDirectory);
    await new Promise<void>((resolve, reject) => server.listen(paths.endpoint, resolve).once("error", reject));
    try {
      await run(client, calls);
    } finally {
      await client.dispose();
    }
    assert.deepEqual(errors, []);
  } finally {
    if (server.listening) {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await stopped;
    }
    if (paths.endpointDirectory) await fs.rm(paths.endpointDirectory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("a full callback ledger still drains releases once and retires their cleanup records", async () => {
  const release = releaseCallback();
  const later = releaseCallback();
  let phase: "pending" | "retired" | "older" | "next" = "pending";
  let observations = 0;
  const handled: string[] = [];
  const answers: string[] = [];
  let unconfirmed = false;
  await fixture(
    ({ method, params }) => {
      if (method === "poll") {
        if (phase === "retired") return poll("active", { cursor: 2 });
        if (phase === "next") return poll("active", { cursor: 3, callbacks: [later] });
        return poll("active", { cursor: 1, callbacks: [release] });
      }
      if (method === "answer") {
        assert.equal(params.value, true);
        answers.push(String(params.id));
        // Keep the first callback pending to exercise deduplication after the task ends.
        return params.id === release.id ? failure("Cannot acknowledge") : { result: {} };
      }
      return poll("active");
    },
    async (client, calls) => {
      // Seed completed history to reach the production limit without thousands of IPC calls.
      const history = Reflect.get(client, "completedCallbacks") as Set<string>;
      for (let index = 0; index < 4096; index++) history.add(String(index));
      await client.attach();
      await vi.waitFor(() => assert.ok(unconfirmed));
      await assert.rejects(client.run("write", {}), /unavailable/u);
      assert.ok(!calls.some(({ method }) => method === "submit"));
      const observePoll = async () => {
        const previous = observations;
        await vi.waitFor(() => assert.ok(observations > previous));
      };
      await observePoll();
      assert.deepEqual(answers, [release.id]);
      phase = "retired";
      await observePoll();
      phase = "older";
      await observePoll();
      phase = "next";
      await vi.waitFor(() => assert.deepEqual(answers, [release.id, later.id]));
      assert.deepEqual(handled, [release.id, later.id]);
      assert.equal((Reflect.get(client, "completedReleases") as Set<string>).has(release.id), false);
    },
    {
      callback: async ({ id }) => {
        handled.push(id);
        return true;
      },
      queueRelease: ({ state }) => {
        if (state === "unconfirmed") unconfirmed = true;
      },
      contact: () => observations++,
    },
  );
});

test("poll notifies repeated contact states only after admission but serves cleanup during attach", async () => {
  const queueRelease = releaseCallback();
  const admitted = Promise.withResolvers<void>();
  let answered = false;
  let contact: ContactState = "inactive";
  const observations: ContactState[] = [];
  await fixture(
    async ({ method, params }) => {
      if (method === "attach") {
        await admitted.promise;
        return poll("active");
      }
      if (method === "poll") return poll(contact, { callbacks: answered ? [] : [queueRelease] });
      if (method === "answer") {
        assert.equal(params.id, queueRelease.id);
        assert.equal(params.value, true);
        answered = true;
      }
    },
    async (client) => {
      const attaching = client.attach();
      try {
        await vi.waitFor(() => assert.equal(answered, true));
        assert.deepEqual(observations, []);
        assert.equal(client.contactState, undefined);
        await assert.rejects(client.resumeContact(client.facts), /unavailable/u);
        contact = "active";
      } finally {
        admitted.resolve();
        await attaching;
      }
      assert.equal(client.contactState, "active");
      contact = "expired";
      await vi.waitFor(() => assert.ok(observations.filter((value) => value === "expired").length >= 2));
      assert.equal(client.contactState, "expired");
      contact = "inactive";
      await vi.waitFor(() => assert.equal(observations.at(-1), "inactive"));
    },
    { contact: (state) => observations.push(state) },
  );
});

test.each(["request", "response", "response with stale retry"] as const)(
  "a lost queue-release %s does not replay the job or callback",
  async (drop) => {
    let job: string | undefined;
    let released = false;
    let answers = 0;
    let handled = 0;
    let finished = false;
    const callback = { ...releaseCallback(), payload: { reservation: randomUUID() } };
    let signal: AbortSignal | undefined;
    if (drop === "response") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await fixture(
      async ({ method, params }, response) => {
        if (method === "submit") job = String(params.id);
        if (method === "poll") {
          // Force a stale retry in one case by delaying the removal snapshot.
          const visible = released && (drop === "response" || finished);
          return poll("active", {
            cursor: visible ? 2 : 1,
            callbacks: job && !visible ? [{ ...callback, job }] : [],
            ...(params.job === job &&
              job && {
                job: visible ? { id: job, phase: "done", result: "original" } : { id: job, phase: "running" },
              }),
          });
        }
        if (method === "answer") {
          answers++;
          assert.deepEqual(params, { client: params.client, id: callback.id, value: true });
          if (answers === 1) {
            released = drop !== "request";
            if (drop === "response") {
              // Only the newer poll confirms removal. The answer gets no response.
              await new Promise<void>((resolve) => response.once("close", resolve));
            } else response.destroy();
          } else if (released) {
            return failure("Stale or foreign callback response.");
          } else {
            released = true;
            return { result: {} };
          }
        }
        if (method === "cancel") return { result: {} };
        return poll("active");
      },
      async (client, calls) => {
        await client.attach();
        const result = client.run("fixture", {});
        try {
          // Drive polling without reaching the two-second answer attempt timeout.
          // The other cases use real time to exercise the retry path.
          await vi.waitFor(async () => {
            assert.equal(await result, "original");
            assert.ok(released && (drop === "response" || finished));
          });
        } catch (error) {
          await client.dispose();
          throw error;
        }
        assert.equal(handled, 1);
        assert.equal(calls.filter(({ method }) => method === "submit").length, 1);
        if (drop === "response") assert.equal(signal?.aborted, true);
        assert.equal(answers, drop === "response" ? 1 : 2);
      },
      {
        callback: async (_, callbackSignal) => {
          signal = callbackSignal;
          handled++;
          return true;
        },
        queueRelease: ({ state }) => {
          if (state === "finished") finished = true;
        },
      },
    ).finally(() => {
      if (drop === "response") vi.useRealTimers();
    });
  },
);

test.each(["failed", "rejected", "exhausted", "detached"] as const)(
  "queue release delivery handles %s without re-running the callback",
  async (scenario) => {
    const release = releaseCallback();
    const clock = vi.spyOn(performance, "now");
    const states: string[] = [];
    let answers = 0;
    let callbacks = 0;
    const confirmed = Promise.withResolvers<void>();
    try {
      await fixture(
        async ({ method, params }, response) => {
          if (method === "detach" && scenario === "detached") await confirmed.promise;
          if (method === "poll") return poll(undefined, { callbacks: [release] });
          if (method === "answer") {
            answers++;
            assert.equal(params.id, release.id);
            if (scenario === "failed") {
              assert.equal(typeof params.error, "string");
              return { result: {} };
            }
            assert.equal(params.value, true);
            if (scenario === "rejected") return failure("Rejected");
            if (scenario === "exhausted") clock.mockReturnValue(performance.now() + 26_000);
            if (answers === 1) response.destroy();
            else return { result: {} };
          }
          return poll();
        },
        async (client) => {
          if (scenario === "detached") {
            // A detached recovery has no attach or foreground context, but still polls to drain.
            await client.dispose();
            assert.deepEqual(states, ["retrying", "finished"]);
          } else {
            await client.attach();
            await vi.waitFor(() => assert.equal(states.at(-1), "unconfirmed"));
          }
          assert.equal(callbacks, 1);
          assert.equal(answers, scenario === "detached" ? 2 : 1);
          assert.equal(states.includes("finished"), scenario === "detached");
        },
        {
          callback: async () => {
            callbacks++;
            if (scenario === "failed") throw new Error("release failed");
            return true;
          },
          queueRelease: ({ state }) => {
            states.push(state);
            if (state !== "retrying") confirmed.resolve();
          },
        },
      );
    } finally {
      clock.mockRestore();
    }
  },
);

test.each(["submit", "terminal result", "result until drain"] as const)(
  "the foreground client keeps the same daemon job through a lost %s reply",
  async (dropped) => {
    let requested: unknown;
    let executions = 0;
    let results = 0;
    const outcome = { outcome: "applied", message: "One verified apply" };
    const terminal = () => ({ id: requested as string, phase: "done" as const, result: outcome });
    await fixture(
      ({ method, params }, response) => {
        if (method === "attach") return poll("active");
        if (method === "submit") {
          if (requested === undefined) {
            requested = params.id;
            executions++;
            if (dropped === "submit") response.destroy();
          } else assert.equal(params.id, requested);
          return { result: terminal() };
        }
        if (method === "poll" && params.job !== undefined) {
          assert.equal(params.job, requested);
          results++;
          if ((dropped === "terminal result" && results === 1) || dropped === "result until drain") response.destroy();
          return poll("active", { job: terminal() });
        }
        if (method === "cancel") return { result: terminal() };
        return poll("active");
      },
      async (client, calls) => {
        await client.attach();
        assert.deepEqual(await client.run("pull.foreground", {}), outcome);
        assert.equal(executions, 1);
        assert.equal(calls.filter(({ method }) => method === "submit").length, dropped === "submit" ? 2 : 1);
        assert.equal(
          calls.filter(({ method }) => method === "cancel").length,
          dropped === "result until drain" ? 1 : 0,
        );
      },
    );
  },
);

test("a lost foreground job result with no terminal drain evidence stays uncertain", async () => {
  let submitted = false;
  await fixture(
    ({ method, params }) => {
      if (method === "attach") return poll("active");
      if (method === "submit") {
        submitted = true;
        return { result: { id: params.id, phase: "running" } };
      }
      if (method === "poll" && params.job)
        return failure("Operation is unknown or its result expired; reconcile journals instead of replaying.");
      if (method === "cancel") return { result: { cancelled: true } };
      return poll("active");
    },
    async (client, calls) => {
      await client.attach();
      let job: string | undefined;
      await assert.rejects(
        client.run("pull.foreground", {}, undefined, undefined, (value) => {
          job = value;
        }),
        /could not be verified.*Changes may have been made/u,
      );
      assert.equal(submitted, true);
      assert.ok(job);
      await assert.rejects(
        client.recoverForeground(job, AbortSignal.timeout(500)),
        /could not verify a completed transfer/u,
      );
      assert.equal(client.hasPendingWork, true);
      assert.equal(calls.filter(({ method }) => method === "submit").length, 1);
      assert.equal(calls.filter(({ method }) => method === "foreground-stop").length, 0);
    },
  );
});

test("an old background poll cannot cancel a newer queue-release delivery", async () => {
  const release = releaseCallback();
  const oldPoll = Promise.withResolvers<void>();
  const oldPollEntered = Promise.withResolvers<void>();
  const admitPoll = Promise.withResolvers<void>();
  const allowAnswer = Promise.withResolvers<void>();
  let backgroundPolls = 0;
  let consumed = false;
  let answers = 0;
  let handled = 0;
  let signal: AbortSignal | undefined;
  let job: string | undefined;
  await fixture(
    async ({ method, params }, response) => {
      if (method === "submit") job = String(params.id);
      if (method === "poll" && !params.job) {
        backgroundPolls++;
        if (backgroundPolls === 1) {
          await admitPoll.promise;
          return poll("active");
        }
        if (backgroundPolls === 2) {
          oldPollEntered.resolve();
          await oldPoll.promise;
          return poll("expired", { cursor: 1 });
        }
      }
      if (method === "answer") {
        answers++;
        if (answers === 1) response.destroy();
        else return { result: {} };
      }
      if (method === "poll" && job) {
        return poll("active", {
          cursor: answers === 2 ? 3 : 2,
          callbacks: answers === 2 ? [] : [{ ...release, job }],
          job: answers === 2 ? { id: job, phase: "done", result: true } : { id: job, phase: "running" },
        });
      }
      return poll("active", { cursor: 1 });
    },
    async (client) => {
      try {
        await client.attach();
        admitPoll.resolve();
        await oldPollEntered.promise;
        const result = client.run("fixture", {});
        void result.catch(() => {});
        await vi.waitFor(() => assert.ok(consumed));
        assert.equal(signal?.aborted, false);
        allowAnswer.resolve();
        await vi.waitFor(() => assert.equal(answers, 2));
        assert.equal(await result, true);
        assert.equal(handled, 1);
      } finally {
        admitPoll.resolve();
        oldPoll.resolve();
        allowAnswer.resolve();
      }
    },
    {
      callback: async (_, callbackSignal) => {
        signal = callbackSignal;
        handled++;
        oldPoll.resolve();
        await allowAnswer.promise;
        return true;
      },
      contact: (state) => {
        if (state === "expired") consumed = true;
      },
    },
  );
});

test("legacy replies and transport failures do not make contact eligible", async () => {
  let failPoll = false;
  const errors: unknown[] = [];
  const observations: ContactState[] = [];
  await fixture(
    ({ method }, response) => {
      if (method === "poll" && failPoll) response.destroy();
      return poll();
    },
    async (client, calls) => {
      await client.attach();
      await client.update({ ...client.facts, idle: false });
      failPoll = true;
      await vi.waitFor(() => assert.equal(errors.length, 1));
      assert.equal(client.contactState, undefined);
      assert.deepEqual(observations, []);
      await assert.rejects(client.resumeContact(client.facts), /No confirmed contact expiry/u);
      assert.equal(
        calls.some(({ method }) => method === "resume-contact"),
        false,
      );
    },
    { error: (error) => errors.push(error), contact: (state) => observations.push(state) },
  );
});

test("update expiry and resume publication fence older polls; repair serializes fresh facts with updates", async () => {
  const oldActive = Promise.withResolvers<void>();
  const oldExpired = Promise.withResolvers<void>();
  const resumeReply = Promise.withResolvers<void>();
  const queueRelease = releaseCallback();
  let contact: ContactState = "active";
  let held: "active" | "expired" | undefined;
  let holding: ContactState | undefined;
  let answered = false;
  const observations: ContactState[] = [];
  await fixture(
    async ({ method, params }) => {
      if (method === "attach") return poll("active");
      if (method === "update") return contact === "expired" ? failure("ClientContactExpiredError") : poll(contact);
      if (method === "resume-contact") {
        await resumeReply.promise;
        contact = "active";
        return poll(contact);
      }
      if (method === "poll") {
        if (held) {
          const snapshot = held;
          held = undefined;
          holding = snapshot;
          await (snapshot === "active" ? oldActive.promise : oldExpired.promise);
          return poll(snapshot);
        }
        return poll(contact, { callbacks: contact === "expired" && !answered ? [queueRelease] : [] });
      }
      if (method === "answer") {
        assert.equal(params.id, queueRelease.id);
        assert.equal(params.value, true);
        answered = true;
      }
    },
    async (client, calls) => {
      await client.attach();
      held = "active";
      await vi.waitFor(() => assert.equal(holding, "active"));
      contact = "expired";
      await assert.rejects(
        client.update({ ...client.facts, ready: false }),
        (error) => error instanceof DaemonError && error.remote.name === "ClientContactExpiredError",
      );
      assert.equal(client.contactState, "expired");
      assert.equal(client.facts.ready, true);
      const afterExpiry = observations.length;
      oldActive.resolve();
      await vi.waitFor(() => {
        assert.equal(answered, true);
        assert.ok(observations.length > afterExpiry);
      });
      assert.ok(observations.slice(afterExpiry).every((state) => state === "expired"));
      held = "expired";
      await vi.waitFor(() => assert.equal(holding, "expired"));
      const fresh = { ...client.facts, idle: false, ready: false };
      await assert.rejects(
        client.resumeContact({ ...fresh, generation: randomUUID() }),
        /No confirmed contact expiry/u,
      );
      const repair = client.resumeContact(fresh);
      const update = client.update({ ...fresh, ready: true });
      await vi.waitFor(() => assert.equal(calls.filter(({ method }) => method === "resume-contact").length, 1));
      assert.equal(client.contactResumeState, "running");
      assert.equal(calls.filter(({ method }) => method === "update").length, 1);
      await assert.rejects(client.resumeContact(fresh), /running or uncertain/u);
      resumeReply.resolve();
      await repair;
      await update;
      assert.deepEqual(calls.find(({ method }) => method === "resume-contact")?.params, fresh);
      assert.equal(calls.filter(({ method }) => method === "attach").length, 1);
      assert.equal(client.contactResumeState, "idle");
      assert.equal(client.contactState, "active");
      assert.equal(client.facts.ready, true);
      const afterResume = observations.length;
      oldExpired.resolve();
      await vi.waitFor(() => assert.ok(observations.length > afterResume));
      assert.ok(observations.slice(afterResume).every((state) => state === "active"));
    },
    { contact: (state) => observations.push(state) },
  );
});

test("a newer expired poll fences an active update reply without blocking its queued repair", async () => {
  const enteredUpdate = Promise.withResolvers<void>();
  const releaseUpdate = Promise.withResolvers<void>();
  let contact: ContactState = "active";
  const observations: ContactState[] = [];
  await fixture(
    async ({ method }) => {
      if (method === "update") {
        enteredUpdate.resolve();
        await releaseUpdate.promise;
        return poll("active");
      }
      if (method === "resume-contact") contact = "active";
      return poll(contact);
    },
    async (client, calls) => {
      await client.attach();
      const updating = client.update({ ...client.facts, ready: false });
      try {
        await enteredUpdate.promise;
        contact = "expired";
        await vi.waitFor(() => assert.ok(observations.filter((state) => state === "expired").length >= 2));
        const repairing = client.resumeContact({ ...client.facts, idle: false });
        releaseUpdate.resolve();
        const [update, repair] = await Promise.allSettled([updating, repairing]);
        assert.equal(update.status, "rejected");
        if (update.status === "rejected") assert.match(String(update.reason), /changed during update/u);
        assert.equal(repair.status, "fulfilled");
        assert.equal(client.contactState, "active");
        assert.equal(client.contactResumeState, "idle");
        assert.equal(client.facts.ready, true);
        assert.equal(calls.filter(({ method }) => method === "resume-contact").length, 1);
      } finally {
        releaseUpdate.resolve();
        await Promise.allSettled([updating]);
      }
    },
    { contact: (state) => observations.push(state) },
  );
});

test.each(["active", "expired", "inactive", undefined] as const)(
  "repeated %s polls do not invalidate an in-flight facts update",
  async (contact) => {
    const enteredUpdate = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    let polls = 0;
    await fixture(
      async ({ method }) => {
        if (method === "update") {
          enteredUpdate.resolve();
          await releaseUpdate.promise;
        }
        if (method === "poll") polls++;
        return poll(contact);
      },
      async (client) => {
        await client.attach();
        const updating = client.update({ ...client.facts, ready: false });
        try {
          await enteredUpdate.promise;
          const before = polls;
          // Later requests prove that earlier repeated observations were consumed.
          await vi.waitFor(() => assert.ok(polls >= before + 3));
        } finally {
          releaseUpdate.resolve();
          await updating;
        }
        assert.equal(client.contactState, contact);
        assert.equal(client.facts.ready, false);
      },
    );
  },
);

test("an expired client keeps polling the original job and waits for its terminal result before repair", async () => {
  let contact: ContactState = "active";
  let job: string | undefined;
  let terminal = false;
  let publishedCommit = false;
  let releasing = false;
  const queueRelease = releaseCallback();
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const events = (): PollReply["events"] => (job ? [{ id: 1, kind: "commit", payload: { job } }] : []);
  await fixture(
    async ({ method, params }) => {
      if (method === "submit") {
        assert.equal(job, undefined);
        job = String(params.id);
        return { result: { id: job, phase: "queued" } };
      }
      if (method === "poll" && params.job !== undefined) {
        assert.equal(params.job, job);
        assert.ok(job);
        arrived.resolve();
        return poll(contact, {
          cursor: 1,
          events: events(),
          job: terminal ? { id: job, phase: "done", result: "original" } : { id: job, phase: "running" },
        });
      }
      if (method === "resume-contact") {
        releasing = true;
        await released.promise;
        releasing = false;
        contact = "active";
      }
      if (method === "answer") {
        assert.equal(params.id, queueRelease.id);
        assert.equal(params.value, true);
        released.resolve();
      }
      return poll(contact, {
        cursor: job ? 1 : 0,
        events: events(),
        callbacks: method === "poll" && releasing ? [queueRelease] : [],
      });
    },
    async (client, calls) => {
      await client.attach();
      const work = client.run("transfer", { original: true }, undefined, () => {
        publishedCommit = true;
      });
      try {
        await arrived.promise;
        contact = "expired";
        await vi.waitFor(() => assert.equal(client.contactState, "expired"));
        assert.equal(publishedCommit, true);
        assert.equal(client.hasPendingWork, true);
        await assert.rejects(client.resumeContact(client.facts), /draining work/u);
        await assert.rejects(client.attach(), /draining work/u);
        await assert.rejects(client.run("transfer", { original: true }), /confirm contact/u);
      } finally {
        terminal = true;
        assert.equal(await work, "original");
      }
      assert.equal(client.hasPendingWork, false);
      await client.resumeContact(client.facts);
      assert.equal(client.contactState, "active");
      assert.equal(calls.filter(({ method }) => method === "submit").length, 1);
      assert.equal(calls.filter(({ method }) => method === "resume-contact").length, 1);
    },
  );
});

test.each([1, 3])("%s failed state observations do not cancel an accepted foreground job", async (failed) => {
  let id: string | undefined;
  let attempts = 0;
  let jobPolls = 0;
  await fixture(
    ({ method, params }, response) => {
      if (method === "attach") return poll("active", { stateWait: 1 });
      if (method === "submit") {
        assert.equal(id, undefined);
        id = String(params.id);
        return { result: { id, phase: "queued" } };
      }
      if (method === "state-wait") {
        if (id && Array.isArray(params.jobs) && params.jobs.includes(id) && ++attempts <= failed) {
          response.destroy();
          return;
        }
        return {
          result: {
            ...poll("active").result,
            stateRevision: "1",
            finished: attempts > failed && id ? [id] : [],
            missing: [],
          },
        };
      }
      if (method === "poll" && params.job) {
        assert.ok(id);
        assert.equal(params.job, id);
        jobPolls++;
        if (failed === 3 && jobPolls === 1) return poll("active", { job: { id, phase: "running" } });
        return poll("active", { job: { id, phase: "done", result: "original" } });
      }
      return poll("active");
    },
    async (client, calls) => {
      await client.attach();
      assert.equal(await client.run("transfer", {}), "original");
      assert.equal(jobPolls, failed === 1 ? 1 : 2);
      assert.equal(calls.filter(({ method }) => method === "submit").length, 1);
      assert.equal(calls.filter(({ method }) => method === "cancel").length, 0);
    },
  );
});

test.each(["state wait", "job poll", "terminal poll"] as const)(
  "a missing result from %s blocks new writes even when cancellation is acknowledged",
  async (source) => {
    const cancelling = Promise.withResolvers<void>();
    const finishCancel = Promise.withResolvers<void>();
    let id: string | undefined;
    await fixture(
      async ({ method, params }) => {
        if (method === "attach") return poll("active", source === "job poll" ? {} : { stateWait: 1 });
        if (method === "submit") {
          assert.equal(id, undefined);
          id = String(params.id);
          return { result: { id, phase: "queued" } };
        }
        if (method === "state-wait") {
          const watching = id && Array.isArray(params.jobs) && params.jobs.includes(id) ? [id] : [];
          return {
            result: {
              ...poll("active").result,
              stateRevision: "1",
              finished: source === "terminal poll" ? watching : [],
              missing: source === "state wait" ? watching : [],
            },
          };
        }
        if (method === "poll" && params.job && source === "job poll")
          return {
            error: {
              name: "Error",
              message: "Operation is unknown or its result expired; reconcile journals instead of replaying.",
            },
          };
        if (method === "cancel") {
          assert.equal(params.id, id);
          cancelling.resolve();
          await finishCancel.promise;
          return { result: { cancelled: true } };
        }
        return poll("active");
      },
      async (client, calls) => {
        await client.attach();
        const result = assert.rejects(client.run("transfer", {}), /reconcile journals/u);
        void result.catch(() => {});
        await cancelling.promise;
        try {
          await assert.rejects(client.update(client.facts), /unavailable/u);
          await assert.rejects(client.run("transfer", {}), /unavailable/u);
        } finally {
          finishCancel.resolve();
          await result;
        }
        assert.equal(client.hasPendingWork, true);
        await assert.rejects(client.run("transfer", {}), /unavailable/u);
        await assert.rejects(client.resumeContact(client.facts), /unavailable/u);
        await assert.rejects(client.attach(), /unavailable/u);
        assert.deepEqual(
          calls
            .filter(({ method }) => ["submit", "cancel", "resume-contact", "update", "attach"].includes(method))
            .map(({ method }) => method),
          ["attach", "submit", "cancel"],
        );
      },
    );
  },
);

test("disposing with a state wait settles the original foreground job", async () => {
  let id: string | undefined;
  const waiting = Promise.withResolvers<void>();
  await fixture(
    async ({ method, params }, response) => {
      if (method === "attach") return poll("active", { stateWait: 1 });
      if (method === "submit") {
        id = String(params.id);
        return { result: { id, phase: "queued" } };
      }
      if (method === "state-wait") {
        const watching = id && Array.isArray(params.jobs) && params.jobs.includes(id) ? id : undefined;
        if (watching) waiting.resolve();
        if (watching) await new Promise<void>((resolve) => response.once("close", resolve));
        return { result: { ...poll("active").result, stateRevision: "1", finished: [], missing: [] } };
      }
      return poll("active");
    },
    async (client, calls) => {
      await client.attach();
      const result = assert.rejects(client.run("transfer", {}), /disposed|closed/u);
      await waiting.promise;
      await client.dispose();
      await result;
      assert.equal(client.hasPendingWork, false);
      assert.equal(calls.filter(({ method }) => method === "submit").length, 1);
    },
  );
});

test("caller cancellation rejects a repair queued behind update without sending it", async () => {
  const releaseUpdate = Promise.withResolvers<void>();
  const enteredUpdate = Promise.withResolvers<void>();
  await fixture(
    async ({ method }) => {
      if (method === "update") {
        enteredUpdate.resolve();
        await releaseUpdate.promise;
        return failure("ClientContactExpiredError");
      }
      return poll(method === "resume-contact" ? "active" : "expired");
    },
    async (client, calls) => {
      await client.attach();
      const update = assert.rejects(client.update(client.facts), { name: "ClientContactExpiredError" });
      await enteredUpdate.promise;
      const controller = new AbortController();
      const repair = client.resumeContact({ ...client.facts, idle: false }, controller.signal);
      try {
        assert.equal(client.contactResumeState, "running");
        controller.abort(new Error("repair cancelled"));
        await assert.rejects(repair, /repair cancelled/u);
        assert.equal(client.contactResumeState, "idle");
      } finally {
        releaseUpdate.resolve();
        await update;
      }
      assert.equal(client.facts.idle, true);
      assert.equal(
        calls.some(({ method }) => method === "resume-contact"),
        false,
      );
      await client.resumeContact(client.facts);
    },
  );
});

test.each(["remote error", "lost response"])(
  "a %s after dispatch blocks reattach without disposing",
  async (outcome) => {
    const observations: ContactState[] = [];
    await fixture(
      ({ method }, response) => {
        if (method === "resume-contact") {
          if (outcome === "remote error") return failure("Error");
          response.destroy();
        }
        return poll("expired");
      },
      async (client, calls) => {
        await client.attach();
        await assert.rejects(client.resumeContact({ ...client.facts, ready: false }));
        assert.equal(client.facts.ready, true);
        const afterFailure = observations.length;
        await vi.waitFor(() => assert.ok(observations.length > afterFailure));
        assert.equal(client.contactState, "expired");
        assert.equal(client.contactResumeState, "uncertain");
        await assert.rejects(client.resumeContact(client.facts), /running or uncertain/u);
        await assert.rejects(client.attach(), /draining work/u);
        assert.deepEqual(
          calls.filter(({ method }) => method !== "poll").map(({ method }) => method),
          ["attach", "resume-contact"],
        );
      },
      { contact: (state) => observations.push(state) },
    );
  },
);

test.each(["pause", "dispose"] as const)(
  "%s aborts dispatched repair and still acknowledges cleanup polls",
  async (action) => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    const queueRelease = releaseCallback();
    let draining = false;
    let released = false;
    const observations: ContactState[] = [];
    await fixture(
      async ({ method, params }, response) => {
        if (method === "resume-contact") {
          response.once("close", disconnected.resolve);
          entered.resolve();
          await disconnected.promise;
          return poll("active");
        }
        if (method === "pause" || (action === "dispose" && method === "detach")) {
          draining = true;
          await answered.promise;
          return poll("inactive");
        }
        if (method === "answer") {
          assert.equal(params.id, queueRelease.id);
          assert.equal(params.value, true);
          released = true;
          answered.resolve();
        }
        return poll("expired", { callbacks: draining && !released ? [queueRelease] : [] });
      },
      async (client, calls) => {
        await client.attach();
        const repair = assert.rejects(client.resumeContact({ ...client.facts, ready: false }), { name: "AbortError" });
        await entered.promise;
        const seenBefore = observations.length;
        await Promise.all([client[action](), repair, disconnected.promise]);
        assert.equal(observations.length, seenBefore);
        assert.equal(released, true);
        assert.equal(client.facts.ready, true);
        assert.equal(client.contactResumeState, "uncertain");
        await assert.rejects(client.attach(), /draining work/u);
        await assert.rejects(client.resumeContact(client.facts), /running or uncertain/u);
        assert.equal(calls.filter(({ method }) => method === "attach").length, 1);
        assert.equal(calls.filter(({ method }) => method === "resume-contact").length, 1);
      },
      { contact: (state) => observations.push(state) },
    );
  },
);
