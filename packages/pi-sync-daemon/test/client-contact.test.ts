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
