import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, type TestContext, test, vi } from "vitest";
import { createRpcFixture } from "./daemon-rpc-fixture.js";

const daemon = vi.hoisted(() => ({
  ensure: vi.fn<() => Promise<void>>(),
  find: vi.fn<() => Promise<undefined>>(),
  stop: vi.fn<() => Promise<boolean>>(),
  construct: vi.fn(),
  dispose: vi.fn<() => Promise<void>>(),
}));
vi.mock("@narumitw/pi-sync-daemon", () => ({
  ensureDaemon: daemon.ensure,
  findDaemon: daemon.find,
  stopDaemon: daemon.stop,
}));
vi.mock("./daemon-rpc-helpers.js", () => ({
  SyncRpc: class {
    dispose = daemon.dispose;
    constructor(...args: unknown[]) {
      daemon.construct(...args);
    }
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  daemon.ensure.mockResolvedValue();
  daemon.find.mockResolvedValue(undefined);
  daemon.stop.mockResolvedValue(true);
  daemon.dispose.mockResolvedValue();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function owner(testContext: TestContext) {
  const controller = new AbortController();
  let finish: Parameters<TestContext["onTestFinished"]>[0] | undefined;
  const context: Pick<TestContext, "signal" | "onTestFinished"> = {
    signal: controller.signal,
    onTestFinished(callback) {
      finish = callback;
    },
  };
  const dispose = async () => finish?.(testContext);
  testContext.onTestFinished(async () => {
    controller.abort();
    await dispose();
  });
  return { context, controller, dispose };
}

test("cleanup joins late daemon startup and refuses a cancelled client publication", async (testContext) => {
  const scope = owner(testContext);
  const started = deferred();
  const publish = deferred();
  daemon.ensure.mockImplementation(async () => {
    started.resolve();
    await publish.promise;
  });
  const fixture = await createRpcFixture(scope.context);
  const root = path.dirname(fixture.agent);
  const rejected = assert.rejects(fixture.connect(), /fixture is closing/u);
  await started.promise;
  scope.controller.abort();
  const disposed = scope.dispose();
  try {
    await fs.stat(root);
    assert.equal(daemon.stop.mock.calls.length, 0);
    assert.equal(daemon.construct.mock.calls.length, 0);
    await assert.rejects(
      fixture.prepare(async () => {}),
      /fixture is closing/u,
    );
  } finally {
    publish.resolve();
  }
  await rejected;
  await disposed;
  assert.equal(daemon.stop.mock.calls.length, 1);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  await scope.dispose();
  assert.equal(daemon.stop.mock.calls.length, 1);
});

test("cleanup drains an owned preparation before removing its root", async (testContext) => {
  const scope = owner(testContext);
  const fixture = await createRpcFixture(scope.context);
  const root = path.dirname(fixture.agent);
  const started = deferred();
  const release = deferred();
  const prepared = fixture.prepare(async () => {
    started.resolve();
    await release.promise;
    await fs.writeFile(path.join(root, "late-write"), "owned");
  });
  await started.promise;
  const disposed = scope.dispose();
  try {
    await fs.stat(root);
    await assert.rejects(fixture.connect(), /fixture is closing/u);
  } finally {
    release.resolve();
  }
  await prepared;
  await disposed;
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  assert.equal(daemon.ensure.mock.calls.length, 0);
});

test("normal fixture cleanup disposes clients before the daemon and removes its abort listener", async (testContext) => {
  const scope = owner(testContext);
  const fixture = await createRpcFixture(scope.context);
  await fixture.connect();
  const removed = vi.spyOn(scope.context.signal, "removeEventListener");
  daemon.stop.mockImplementation(async () => {
    assert.ok(daemon.dispose.mock.calls.length > 0);
    return true;
  });
  await scope.dispose();
  assert.equal(daemon.stop.mock.calls.length, 1);
  assert.ok(removed.mock.calls.some(([type]) => type === "abort"));
  const before = daemon.dispose.mock.calls.length;
  scope.controller.abort();
  assert.equal(daemon.dispose.mock.calls.length, before);
});

test("cleanup waits for adoption after owned startup before stopping the daemon", async (testContext) => {
  const scope = owner(testContext);
  const fixture = await createRpcFixture(scope.context);
  const root = path.dirname(fixture.agent);
  await fixture.startDaemon();
  const started = deferred();
  const reviewed = deferred();
  const adopting = fixture.prepare(async () => {
    started.resolve();
    await reviewed.promise;
    assert.equal(daemon.stop.mock.calls.length, 0);
  });
  await started.promise;
  scope.controller.abort();
  const disposed = scope.dispose();
  try {
    await fs.stat(root);
    assert.equal(daemon.stop.mock.calls.length, 0);
  } finally {
    reviewed.resolve();
  }
  await adopting;
  await disposed;
  assert.equal(daemon.stop.mock.calls.length, 1);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});

test("uncertain startup retains the root and reports the cleanup failure", async (testContext) => {
  const controller = new AbortController();
  let finish: Parameters<TestContext["onTestFinished"]>[0] | undefined;
  const fixture = await createRpcFixture({
    signal: controller.signal,
    onTestFinished(callback) {
      finish = callback;
    },
  });
  const root = path.dirname(fixture.agent);
  testContext.onTestFinished(async () => {
    controller.abort();
    await Promise.resolve(finish?.(testContext)).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  daemon.ensure.mockRejectedValue(new Error("Synthetic startup failure"));
  await assert.rejects(fixture.startDaemon(), /Synthetic startup failure/u);
  const cleanup = finish;
  assert.ok(cleanup);
  await assert.rejects(async () => cleanup(testContext), /startup was uncertain/u);
  await fs.stat(root);
  assert.equal(daemon.stop.mock.calls.length, 0);
});
