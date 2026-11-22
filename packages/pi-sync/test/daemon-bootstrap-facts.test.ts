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

async function fixture(testContext: TestContext) {
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
    await client.dispose();
  });

  let stored: ClientFacts;
  let options: ConnectionOptions;
  const wire: Array<{ method: string; facts?: ClientFacts }> = [];
  const onBootstrap = vi.fn(async () => true);
  const onUpdate = vi.fn(async () => {});
  const onResume = vi.fn(async () => {});
  const onRun = vi.fn(async () => {});
  const connection = {
    ...address,
    facts: {} as ClientFacts,
    contactState: "active" as ContactState | undefined,
    contactResumeState: "idle",
    hasPendingWork: false,
    attach: async () => {
      stored = { ...connection.facts };
    },
    update: async (facts: ClientFacts) => {
      wire.push({ method: "update", facts });
      await onUpdate();
      if (connection.contactState === "expired") {
        // Also report expiry from the observer before the update's caller handles the failure.
        options.contact?.("expired");
        throw new DaemonError({ name: "ClientContactExpiredError", message: "Contact expired." });
      }
      stored = { ...facts };
      Object.assign(connection.facts, facts);
    },
    resumeContact: async (facts: ClientFacts) => {
      wire.push({ method: "resume", facts });
      await onResume();
      connection.contactState = "active";
      stored = { ...facts };
      Object.assign(connection.facts, facts);
    },
    run: async () => {
      wire.push({ method: "run" });
      await onRun();
    },
    pause: async () => {},
    dispose: async () => {},
  };
  // biome-ignore lint/complexity/useArrowFunction: Vitest constructor mocks must be constructable.
  transport.connect.mockImplementation(function (_paths, _identity, facts: ClientFacts, callbacks: ConnectionOptions) {
    options = callbacks;
    Object.assign(connection.facts, facts);
    return connection;
  });
  transport.ensure.mockResolvedValue(address);
  transport.request.mockImplementation(async (_paths, _identity, method, params) => {
    assert.equal(method, "startup.bootstrap");
    assert.equal(params.client, connection.facts.id);
    assert.equal(params.generation, connection.facts.generation);
    wire.push({ method: "bootstrap" });
    const accepted = await onBootstrap();
    if (accepted) stored = { ...stored, ready: true, startupDebug: params.debug };
    return accepted;
  });
  await client.connect();
  function track<T>(operation: Promise<T>) {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }
  return {
    client,
    connection,
    onBootstrap,
    onUpdate,
    onResume,
    onRun,
    wire,
    track,
    get stored() {
      return stored;
    },
    selectModel(id: string) {
      model = id;
    },
    replace() {
      const next = bindPiDaemonClient(ctx, session.signal);
      testContext.onTestFinished(() => next.dispose());
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
      return { entered: entered.promise, release };
    },
    bootstrap(signal = session.signal) {
      return track(client.tryStartupBootstrap(document, true, signal));
    },
    binding(background: boolean, signal = session.signal) {
      return track(
        options.callback({ id: "binding", job: "job", kind: "model-binding", payload: { background } }, signal),
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
  const bootstrap = f.hold(f.onBootstrap, true);
  const startup = f.bootstrap();
  await bootstrap.entered;
  f.connection.contactState = "expired";
  bootstrap.release();
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
  const bootstrap = f.hold(f.onBootstrap, true);
  const startup = f.bootstrap();
  await bootstrap.entered;
  f.selectModel("changed");
  const binding = f.binding(false);
  const busy = f.track(f.client.setBusy("agent", true));
  await setImmediate();
  assert.deepEqual(
    f.wire.map(({ method }) => method),
    ["bootstrap"],
  );
  bootstrap.release();
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

for (const outcome of ["refused", "unsupported", "failed"] as const)
  test(`${outcome} bootstrap releases the facts queue without setting readiness`, async (context) => {
    const f = await fixture(context);
    if (outcome === "refused") f.onBootstrap.mockResolvedValueOnce(false);
    else if (outcome === "unsupported")
      f.onBootstrap.mockRejectedValueOnce(new DaemonError({ name: "Error", message: "Unknown daemon method." }));
    else f.onBootstrap.mockRejectedValueOnce(new Error("Bootstrap failed."));
    const startup = f.bootstrap();
    if (outcome === "failed") await assert.rejects(startup, /Bootstrap failed/u);
    else assert.equal(await startup, false);
    await f.client.update();
    assert.equal(f.stored.ready, false);
    await f.client.markReady(true);
    assert.equal(f.stored.ready, true);
    assert.equal(f.stored.startupDebug, true);
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
});

for (const change of ["pause", "replace", "dispose"] as const)
  test(`${change} during bootstrap prevents a stale readiness latch or queued publication`, async (context) => {
    const f = await fixture(context);
    const bootstrap = f.hold(f.onBootstrap, true);
    const startup = assert.rejects(f.bootstrap(), /paused|replaced/u);
    await bootstrap.entered;
    const publish = assert.rejects(f.track(f.client.setBusy("agent", true)), /paused|replaced/u);
    let disposal: Promise<void> | undefined;
    if (change === "pause") await f.client.pauseForSessionChange();
    else if (change === "replace") f.replace();
    else disposal = f.client.dispose();
    bootstrap.release();
    await Promise.all([startup, publish, disposal]);
    assert.deepEqual(
      f.wire.map(({ method }) => method),
      ["bootstrap"],
    );
    assert.equal(f.connection.facts.ready, false);
  });
