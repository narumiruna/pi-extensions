import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ClientFacts, type ContactState, type DaemonConnection, DaemonError } from "@narumitw/pi-sync-daemon";
import { type TestContext, test, vi } from "vitest";

const transport = vi.hoisted(() => ({ connect: vi.fn(), ensure: vi.fn(), request: vi.fn() }));
vi.mock("@narumitw/pi-sync-daemon", async (original) => ({
  ...(await original<typeof import("@narumitw/pi-sync-daemon")>()),
  DaemonConnection: transport.connect,
  ensureDaemon: transport.ensure,
  requestDaemon: transport.request,
}));

type ConnectionOptions = ConstructorParameters<typeof DaemonConnection>[3];
type Participant = Pick<ClientFacts, "id" | "generation">;

async function fixture(testContext: TestContext, disposeError?: Error) {
  vi.resetModules();
  const root = process.env.PI_CODING_AGENT_DIR;
  assert.ok(root, "The isolated Vitest setup must provide an agent directory before import");
  const address = {
    paths: { root },
    identity: { version: 1, root, instance: "fixture", pid: process.pid, token: "fixture" },
  };
  const session = new AbortController();
  const finish: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  let model = "initial";
  const ctx = {
    sessionManager: {},
    cwd: root,
    mode: "rpc",
    hasUI: true,
    isIdle: () => true,
    ui: { setStatus: () => {} },
    get model() {
      return { provider: "test", id: model };
    },
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      getProviderAuthStatus: () => ({ source: "stored" }),
    },
  } as unknown as ExtensionContext;
  const document = {
    path: path.join(root, "pi-sync.json"),
    bytes: Buffer.from("{}"),
    parsed: {},
    identity: { dev: 1, ino: 2 },
  };
  const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
  const client = bindPiDaemonClient(ctx, session.signal);
  testContext.onTestFinished(async () => {
    session.abort();
    for (const release of finish) release();
    await Promise.allSettled(pending);
    await client.dispose().catch((error: unknown) => {
      if (error !== disposeError) throw error;
    });
  });

  const peers = new Map<string, ClientFacts>();
  const wire: Array<{ method: string; facts?: ClientFacts; participant?: Participant }> = [];
  const onBootstrap = vi.fn(async () => true);
  const onBootstrapReply = vi.fn(async () => {});
  const onUpdate = vi.fn(async () => {});
  const onResume = vi.fn(async () => {});
  const onRun = vi.fn(async () => {});
  function makeConnection(facts: ClientFacts, callbacks: ConnectionOptions) {
    const { id, generation } = facts;
    const participant = { id, generation };
    let disposing: Promise<void> | undefined;
    return {
      ...address,
      facts: { ...facts },
      callbacks,
      contactState: "active" as ContactState | undefined,
      contactResumeState: "idle",
      hasPendingWork: false,
      async attach() {
        wire.push({ method: "attach", participant });
        peers.set(id, { ...this.facts });
      },
      async update(facts: ClientFacts) {
        wire.push({ method: "update", facts });
        await onUpdate();
        if (this.contactState === "expired") {
          // Also report expiry from the observer before the update's caller handles the failure.
          callbacks.contact?.("expired");
          throw new DaemonError({ name: "ClientContactExpiredError", message: "Contact expired." });
        }
        peers.set(id, { ...facts });
        Object.assign(this.facts, facts);
      },
      async resumeContact(facts: ClientFacts) {
        wire.push({ method: "resume", facts });
        await onResume();
        this.contactState = "active";
        peers.set(id, { ...facts });
        Object.assign(this.facts, facts);
      },
      async run() {
        wire.push({ method: "run" });
        await onRun();
      },
      pause: async () => {},
      dispose() {
        disposing ??= (async () => {
          const { id, generation } = this.facts;
          wire.push({ method: "dispose", participant: { id, generation } });
          if (disposeError) throw disposeError;
          if (peers.get(id)?.generation === generation) peers.delete(id);
        })();
        return disposing;
      },
    };
  }
  const connections: ReturnType<typeof makeConnection>[] = [];
  // biome-ignore lint/complexity/useArrowFunction: Vitest constructor mocks must be constructable.
  transport.connect.mockImplementation(function (_paths, _identity, facts: ClientFacts, callbacks: ConnectionOptions) {
    const connection = makeConnection(facts, callbacks);
    connections.push(connection);
    return connection;
  });
  transport.ensure.mockResolvedValue(address);
  transport.request.mockImplementation(async (_paths, _identity, method, params) => {
    assert.equal(method, "startup.bootstrap");
    const stored = peers.get(params.client);
    assert.ok(stored);
    assert.equal(params.generation, stored.generation);
    wire.push({ method: "bootstrap" });
    const accepted = await onBootstrap();
    if (accepted) peers.set(stored.id, { ...stored, ready: true, startupDebug: params.debug });
    await onBootstrapReply();
    return accepted;
  });
  await client.connect();
  const [connection] = connections;
  assert.ok(connection);
  const { id, generation } = connection.facts;
  const participant = { id, generation };
  wire.length = 0;
  function track<T>(operation: Promise<T>) {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }
  return {
    client,
    connection,
    onBootstrap,
    onBootstrapReply,
    onUpdate,
    onResume,
    onRun,
    peers,
    participant,
    wire,
    track,
    cancelSession() {
      session.abort();
    },
    get stored() {
      const stored = peers.get(id);
      assert.ok(stored);
      return stored;
    },
    selectModel(id: string) {
      model = id;
    },
    async replace() {
      const next = bindPiDaemonClient(ctx, session.signal);
      testContext.onTestFinished(() => next.dispose());
      await next.connect();
      const replacement = connections.at(-1);
      assert.ok(replacement && replacement !== connection);
      return replacement;
    },
    hold<T>(next: { mockImplementationOnce(action: () => Promise<T>): unknown }, result: T) {
      const entered = Promise.withResolvers<void>();
      const done = Promise.withResolvers<T>();
      const release = () => done.resolve(result);
      finish.push(release);
      next.mockImplementationOnce(() => {
        entered.resolve();
        return done.promise;
      });
      return { entered: entered.promise, release, reject: done.reject };
    },
    bootstrap(signal = session.signal) {
      return track(client.tryStartupBootstrap(document, true, signal));
    },
    binding(background: boolean, signal = session.signal) {
      return track(
        connection.callbacks.callback(
          { id: "binding", job: "job", kind: "model-binding", payload: { background } },
          signal,
        ),
      );
    },
  };
}

test.for([
  { contact: "expired", resume: "idle" },
  { contact: "inactive", resume: "idle" },
  { contact: undefined, resume: "idle" },
  { contact: "active", resume: "running" },
  { contact: "active", resume: "uncertain" },
] as const)(
  "bootstrap declines contact=$contact resume=$resume without publishing",
  async ({ contact, resume }, context) => {
    const f = await fixture(context);
    f.connection.contactState = contact;
    f.connection.contactResumeState = resume;
    assert.equal(await f.bootstrap(), false);
    assert.deepEqual(f.wire, []);
    assert.equal(f.stored.ready, false);
    assert.equal(f.connection.facts.ready, false);
  },
);

test("an accepted bootstrap preserves readiness when contact expires before the reply arrives", async (context) => {
  const f = await fixture(context);
  const reply = f.hold(f.onBootstrapReply, undefined);
  const startup = f.bootstrap();
  await reply.entered;
  f.connection.contactState = "expired";
  reply.release();
  assert.equal(await startup, true);
  assert.equal(f.connection.contactState, "expired");
  assert.equal(f.connection.facts.ready, true);
  assert.equal(f.stored.ready, true);
});

test("bootstrap waits for a pre-bootstrap busy publication to settle", async (context) => {
  const f = await fixture(context);
  const update = f.hold(f.onUpdate, undefined);
  const busy = f.track(f.client.setBusy("agent", true));
  await update.entered;
  const startup = f.bootstrap();
  await setImmediate();
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["update"],
  );
  assert.equal(f.wire[0]?.facts?.ready, false);
  update.release();
  await busy;
  assert.equal(await startup, true);
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["update", "bootstrap"],
  );
  assert.equal(f.stored.ready, true);
  assert.equal(f.stored.startupDebug, true);
  assert.equal(f.stored.idle, false);
  assert.deepEqual(f.connection.facts, f.stored);
});

test("model-binding and busy publications competing with bootstrap sample accepted readiness", async (context) => {
  const f = await fixture(context);
  const reply = f.hold(f.onBootstrapReply, undefined);
  const startup = f.bootstrap();
  await reply.entered;
  f.selectModel("changed");
  const binding = f.binding(false);
  const busy = f.track(f.client.setBusy("agent", true));
  await setImmediate();
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["bootstrap"],
  );
  reply.release();
  assert.equal(await startup, true);
  assert.equal(((await binding) as ClientFacts["model"])?.id, "changed");
  await busy;
  assert.deepEqual(
    f.wire.map(({ method, facts }) => [method, facts?.ready, facts?.startupDebug, facts?.idle]),
    [
      ["bootstrap", undefined, undefined, undefined],
      ["update", true, true, false],
      ["update", true, true, false],
    ],
  );
  assert.deepEqual(f.connection.facts, f.stored);
});

test("failed reattachment can drain a model binding waiting behind its own facts turn", async (context) => {
  const f = await fixture(context);
  const failed = new Error("Reattachment failed.");
  const cancelled = new DOMException("Callback cancelled during detach.", "AbortError");
  const callback = new AbortController();
  const attaching = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const releaseDrain = Promise.withResolvers<void>();
  const dispose = f.connection.dispose.bind(f.connection);
  vi.spyOn(f.connection, "attach").mockImplementationOnce(async () => {
    attaching.resolve();
    try {
      await reply.promise;
    } catch (error) {
      await f.connection.dispose();
      throw error;
    }
  });
  const reattaching = f.track(f.client.finishReattachment());
  try {
    await attaching.promise;
    f.selectModel("changed");
    const binding = f.binding(false, callback.signal);
    const rejected = f.track(assert.rejects(binding, (error: unknown) => error === cancelled));
    vi.spyOn(f.connection, "dispose").mockImplementationOnce(async () => {
      // DaemonConnection aborts non-queue callbacks and waits for their tasks before attach can reject.
      callback.abort(cancelled);
      draining.resolve();
      await Promise.race([binding.catch(() => {}), releaseDrain.promise]);
      await dispose();
    });
    reply.reject(failed);
    await draining.promise;
    const outcome = reattaching.catch((error: unknown) => error);
    assert.equal(
      await Promise.race([outcome, setImmediate("still draining")]),
      failed,
      "disposal must finish without releasing the reattachment's facts turn first",
    );
    await rejected;
    assert.deepEqual(f.wire, [{ method: "dispose", participant: f.participant }]);
  } finally {
    // Let the fixture unwind even if the regression leaves disposal blocked.
    reply.resolve();
    releaseDrain.resolve();
  }
});

test("a model binding cancelled while queued rejects before its facts turn and never publishes", async (context) => {
  const f = await fixture(context);
  const reply = f.hold(f.onBootstrapReply, undefined);
  const startup = f.bootstrap();
  await reply.entered;
  f.selectModel("changed");
  const callback = new AbortController();
  const rejected = f.track(assert.rejects(f.binding(false, callback.signal), { name: "AbortError" }));
  callback.abort();
  assert.equal(await Promise.race([rejected, setImmediate("still queued")]), undefined);
  assert.deepEqual(f.wire, [{ method: "bootstrap" }]);

  reply.release();
  assert.equal(await startup, true);
  await setImmediate();
  assert.deepEqual(f.wire, [{ method: "bootstrap" }]);
  assert.equal(f.stored.model?.id, "initial");
  assert.equal(((await f.binding(false)) as ClientFacts["model"])?.id, "changed");
  assert.equal(f.stored.ready, true);
  assert.equal(f.stored.model?.id, "changed");
});

test("a model binding cancelled during its facts turn waits for publication to drain", async (context) => {
  const f = await fixture(context);
  assert.equal(await f.bootstrap(), true);
  const update = f.hold(f.onUpdate, undefined);
  f.selectModel("changed");
  const callback = new AbortController();
  const rejected = f.track(assert.rejects(f.binding(false, callback.signal), { name: "AbortError" }));
  await update.entered;
  const busy = f.track(f.client.setBusy("agent", true));
  callback.abort();
  assert.equal(await Promise.race([rejected, setImmediate("still publishing")]), "still publishing");
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["bootstrap", "update"],
  );

  update.release();
  await Promise.all([rejected, busy]);
  assert.deepEqual(
    f.wire.map(({ method, facts }) => [method, facts?.ready, facts?.idle]),
    [
      ["bootstrap", undefined, undefined],
      ["update", true, true],
      ["update", true, false],
    ],
  );
  assert.deepEqual(f.connection.facts, f.stored);
});

test("a busy update and a model callback do not wait for the active Pi job", async (context) => {
  const f = await fixture(context);
  assert.equal(await f.bootstrap(), true);
  const job = f.hold(f.onRun, undefined);
  const running = f.track(f.client.run("sync", {}));
  await job.entered;
  f.selectModel("changed");
  const modelUpdate = f.hold(f.onUpdate, undefined);
  const binding = f.binding(true);
  await modelUpdate.entered;
  const busy = f.track(f.client.setBusy("agent", true));
  modelUpdate.release();
  assert.equal(await binding, null, "the background callback must not use the pre-await idle snapshot");
  await busy;
  assert.equal(f.stored.idle, false);
  assert.equal(f.stored.model?.id, "changed");
  job.release();
  await running;
});

test("contact repair completes its non-ready admission and fresh publication before bootstrap", async (context) => {
  const f = await fixture(context);
  f.connection.contactState = "expired";
  const resume = f.hold(f.onResume, undefined);
  const update = f.track(f.client.update());
  await resume.entered;
  const startup = f.bootstrap();
  const busy = f.track(f.client.setBusy("agent", true));
  await setImmediate();
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["update", "resume"],
  );
  assert.equal(f.wire[1]?.facts?.ready, false);
  assert.equal(f.wire[1]?.facts?.idle, false);
  resume.release();
  assert.equal(await startup, true);
  await Promise.all([update, busy]);
  assert.deepEqual(
    f.wire.map(({ method, facts }) => [method, facts?.ready, facts?.idle]),
    [
      ["update", false, true],
      ["resume", false, false],
      ["update", false, false],
      ["bootstrap", undefined, undefined],
      ["update", true, false],
      ["update", true, false],
    ],
  );
  assert.deepEqual(f.stored, f.connection.facts);
});

for (const outcome of ["refused", "unsupported"] as const)
  test(`${outcome} bootstrap releases the facts queue without setting readiness`, async (context) => {
    const f = await fixture(context);
    const refusal = f.hold(f.onBootstrap, false);
    const startup = f.bootstrap();
    await refusal.entered;
    const publish = f.track(f.client.update());
    if (outcome === "refused") refusal.release();
    else refusal.reject(new DaemonError({ name: "Error", message: "Unknown daemon method." }));
    assert.equal(await startup, false);
    await publish;
    assert.equal(f.stored.ready, false);
    await f.client.markReady(true);
    assert.equal(f.stored.ready, true);
    assert.equal(f.stored.startupDebug, true);
    assert.deepEqual(
      f.wire.map(({ method }) => method),
      ["bootstrap", "update", "update"],
    );
  });

for (const loss of ["transport failure", "request abort"] as const)
  test(`${loss} after bootstrap acceptance retires the original participant and blocks queued or future work`, async (context) => {
    const f = await fixture(context);
    const request = new AbortController();
    const lost =
      loss === "request abort"
        ? new DOMException("Startup cancelled.", "AbortError")
        : new Error("Bootstrap reply lost.");
    const reply = f.hold(f.onBootstrapReply, undefined);
    const startup = assert.rejects(f.bootstrap(request.signal), (error: unknown) => error === lost);
    await reply.entered;
    assert.equal(f.stored.ready, true);
    assert.equal(f.connection.facts.ready, false);
    const queued = [
      assert.rejects(f.track(f.client.setBusy("agent", true))),
      assert.rejects(f.track(f.client.run("sync", {}))),
    ];
    if (loss === "request abort") request.abort(lost);
    reply.reject(lost);
    await Promise.all([startup, ...queued]);
    await assert.rejects(f.bootstrap());
    await assert.rejects(f.client.markReady(true));
    await assert.rejects(f.client.run("sync", {}));

    assert.deepEqual(f.wire, [{ method: "bootstrap" }, { method: "dispose", participant: f.participant }]);
    assert.equal(f.peers.has(f.participant.id), false);
    assert.equal(f.connection.facts.ready, false);
  });

test("a failed retirement after a lost accepted reply surfaces uncertain readiness", async (context) => {
  const lost = new Error("Bootstrap reply lost.");
  const disposeError = new Error("Detach failed.");
  const f = await fixture(context, disposeError);
  f.onBootstrapReply.mockRejectedValueOnce(lost);
  await assert.rejects(f.bootstrap(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /readiness is uncertain/u);
    assert.deepEqual(error.errors, [lost, disposeError]);
    return true;
  });
  await assert.rejects(f.bootstrap());
  await assert.rejects(f.client.run("sync", {}));

  assert.deepEqual(f.wire, [{ method: "bootstrap" }, { method: "dispose", participant: f.participant }]);
  assert.equal(f.stored.ready, true, "the owner committed readiness and did not acknowledge retirement");
  assert.equal(f.connection.facts.ready, false);
});

test("a cancelled bootstrap cannot send an RPC after waiting behind a facts publication", async (context) => {
  const f = await fixture(context);
  const update = f.hold(f.onUpdate, undefined);
  const busy = f.track(f.client.setBusy("agent", true));
  await update.entered;
  const request = new AbortController();
  const startup = assert.rejects(f.bootstrap(request.signal), { name: "AbortError" });
  await setImmediate();
  request.abort();
  update.release();
  await busy;
  await startup;
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["update"],
  );
  assert.equal(f.stored.ready, false);
  assert.equal(await f.bootstrap(), true, "cancellation before dispatch does not retire this participant");
});

for (const change of ["cancel request", "cancel session", "pause", "replace", "dispose"] as const)
  test(`${change} before an accepted reply arrives retires only the original participant`, async (context) => {
    const f = await fixture(context);
    const request = new AbortController();
    const reply = f.hold(f.onBootstrapReply, undefined);
    const startup = assert.rejects(
      f.bootstrap(request.signal),
      change.startsWith("cancel") ? { name: "AbortError" } : /paused|replaced/u,
    );
    await reply.entered;
    assert.equal(f.stored.ready, true);
    const publish = assert.rejects(f.track(f.client.setBusy("agent", true)));
    let disposal: Promise<void> | undefined;
    const replacement = change === "replace" ? await f.replace() : undefined;
    const replacementFacts = replacement && { ...replacement.facts };
    if (change === "cancel request") request.abort();
    else if (change === "cancel session") f.cancelSession();
    else if (change === "pause") await f.client.pauseForSessionChange();
    else if (change === "dispose") disposal = f.client.dispose();
    reply.release();
    await Promise.all([startup, publish, disposal]);
    await assert.rejects(f.client.run("sync", {}));

    const replacementParticipant = replacementFacts && {
      id: replacementFacts.id,
      generation: replacementFacts.generation,
    };
    assert.deepEqual(f.wire, [
      { method: "bootstrap" },
      ...(replacementFacts ? [{ method: "attach", participant: replacementParticipant }] : []),
      { method: "dispose", participant: f.participant },
    ]);
    assert.equal(f.peers.has(f.participant.id), false);
    assert.equal(f.connection.facts.ready, false);
    if (replacementFacts) {
      assert.equal(replacementFacts.ready, false);
      assert.deepEqual(replacement?.facts, replacementFacts);
      assert.deepEqual(f.peers.get(replacementFacts.id), replacementFacts);
    }
  });
