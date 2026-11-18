import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { type ClientFacts, type DaemonConnection, DaemonError, type Identity } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { PiApplyGate } from "../src/daemon/apply-gate.js";
import { withTempHome } from "./helpers.js";

const transport = vi.hoisted(() => ({
  connect: vi.fn(),
  ensure: vi.fn(),
  find: vi.fn(),
  wait: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@narumitw/pi-sync-daemon", async (original) => ({
  ...(await original<typeof import("@narumitw/pi-sync-daemon")>()),
  DaemonConnection: transport.connect,
  ensureDaemon: transport.ensure,
  findDaemon: transport.find,
  waitForDaemonExit: transport.wait,
  stopDaemon: transport.stop,
}));

function stopping() {
  return new DaemonError({ name: "DaemonStoppingError", message: "The old owner is closing." });
}
function waitingSignal() {
  const signal = transport.wait.mock.calls[0]?.[1];
  assert.ok(signal instanceof AbortSignal);
  return signal;
}

async function withClient(action: (owned: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await withTempHome(async (agentDir) => {
    const owned = await fixture(agentDir);
    try {
      await action(owned);
    } finally {
      // Release the handshake even when an assertion fails, so disposal cannot strand work.
      owned.exited.resolve();
      await owned.client.dispose();
      for (const connection of owned.connections) assert.equal(connection.dispose.mock.calls.length, 1);
    }
  });
}

async function fixture(agentDir: string) {
  vi.resetModules();
  for (const mock of Object.values(transport)) mock.mockReset();
  transport.stop.mockResolvedValue(undefined);
  await fs.mkdir(agentDir, { recursive: true });
  const root = await fs.realpath(agentDir);
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const { ctx: context, notifications } = createMockContext({
    cwd: root,
    mode: "rpc",
    hasUI: true,
    sessionManager: manager,
  });
  const ctx = context as ExtensionContext;
  const session = new AbortController();
  const enteredWait = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const events: string[] = [];
  const addresses = ["old", "new", "unexpected-third"].map((instance) => ({
    paths: {
      root,
      directory: path.join(root, "runtime"),
      identity: path.join(root, "runtime", "identity.json"),
      startup: path.join(root, "runtime", "startup.lock"),
      owner: path.join(root, "runtime", "owner.lock"),
    },
    identity: { version: 1, root, instance, pid: process.pid, token: instance } satisfies Identity,
  }));
  const attachErrors: unknown[] = [stopping()];
  let operationError: Error | undefined;
  let onAttach: (() => Promise<void>) | undefined;
  const result = { completed: true };
  const connections: ReturnType<typeof connection>[] = [];
  function connection(
    paths: DaemonConnection["paths"],
    identity: Identity,
    facts: ClientFacts,
    callback: ConstructorParameters<typeof DaemonConnection>[3]["callback"],
  ) {
    const label = identity.instance;
    const attachError = attachErrors[connections.length];
    return {
      paths,
      identity,
      facts,
      callback,
      attach: vi.fn(async (_signal?: AbortSignal) => {
        events.push(`${label}:attach`);
        if (attachError) throw attachError;
        await onAttach?.();
      }),
      update: vi.fn(async (next: ClientFacts) => {
        events.push(`${label}:update`);
        Object.assign(facts, next);
      }),
      run: vi.fn(async (..._args: Parameters<DaemonConnection["run"]>) => {
        events.push(`${label}:run`);
        if (operationError) throw operationError;
        return result;
      }),
      dispose: vi.fn(async () => {
        events.push(`${label}:dispose`);
      }),
    };
  }
  // biome-ignore lint/complexity/useArrowFunction: Vitest constructor mocks must be constructable.
  transport.connect.mockImplementation(function (
    paths: DaemonConnection["paths"],
    identity: Identity,
    facts: ClientFacts,
    options: ConstructorParameters<typeof DaemonConnection>[3],
  ) {
    const created = connection(paths, identity, facts, options.callback);
    connections.push(created);
    return created;
  });
  transport.ensure.mockImplementation(async () => {
    const address = addresses[transport.ensure.mock.calls.length - 1];
    assert.ok(address, "Unexpected additional daemon launch");
    events.push(`${address.identity.instance}:ensure`);
    return address;
  });
  transport.find.mockResolvedValue(addresses[0]);
  // Intentionally complete only on the exit handshake, even if the caller becomes stale.
  // The adapter must revalidate ownership and cancellation after this await.
  transport.wait.mockImplementation(async () => {
    events.push("old:wait");
    enteredWait.resolve();
    await exited.promise;
    events.push("old:exited");
  });
  // Import after withTempHome installs this test's agent-root environment.
  const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
  const client = bindPiDaemonClient(ctx, session.signal);
  return {
    client,
    ctx,
    notifications,
    session,
    bindPiDaemonClient,
    addresses,
    attachErrors,
    connections,
    events,
    enteredWait,
    exited,
    result,
    duringAttach(action: () => Promise<void>) {
      onAttach = action;
    },
    failOperation(error: Error) {
      operationError = error;
    },
  };
}

test("run disposes the rejected unpublished connection and waits for owner exit before reconnecting", () =>
  withClient(async (f) => {
    const payload = { setup: "requested-setup" };
    const request = new AbortController();
    const commit = vi.fn();
    const running = f.client.run("sync", payload, request.signal, f.ctx, commit);
    await f.enteredWait.promise;
    assert.deepEqual(f.events, ["old:ensure", "old:attach", "old:dispose", "old:wait"]);
    assert.equal(transport.ensure.mock.calls.length, 1);
    assert.equal(f.connections[0]?.attach.mock.calls[0]?.[0], waitingSignal());
    assert.equal(transport.wait.mock.calls[0]?.[0], f.addresses[0]?.identity);
    assert.equal(waitingSignal().aborted, false);
    assert.equal(f.connections[0]?.run.mock.calls.length, 0);
    assert.equal(f.connections[0]?.update.mock.calls.length, 0);
    f.exited.resolve();
    assert.equal(await running, f.result);
    assert.deepEqual(f.events, [
      "old:ensure",
      "old:attach",
      "old:dispose",
      "old:wait",
      "old:exited",
      "new:ensure",
      "new:attach",
      "new:update",
      "new:run",
    ]);
    const next = f.connections[1];
    assert.ok(next);
    assert.equal(next.facts.generation, f.connections[0]?.facts.generation);
    assert.equal(next.facts.sessionId, f.ctx.sessionManager.getSessionId());
    assert.equal(next.facts.sessionFile, f.ctx.sessionManager.getSessionFile());
    const [operation, sent, signal, onCommit] = next.run.mock.calls[0] ?? [];
    assert.equal(operation, "sync");
    assert.equal(sent, payload);
    assert.equal(signal?.aborted, false);
    assert.equal(onCommit, commit);
    assert.equal(transport.ensure.mock.calls.length, 2);
  }));

for (const invalidation of ["session cancellation", "disposal", "replacement", "request cancellation"] as const)
  test(`${invalidation} during owner-exit wait prevents a second launch and submission`, () =>
    withClient(async (f) => {
      const request = new AbortController();
      const running = f.client.run("sync", {}, request.signal);
      const rejected = assert.rejects(running, /cancelled|replaced/iu);
      await f.enteredWait.promise;
      let disposal: Promise<void> | undefined;
      let replacement: ReturnType<typeof f.bindPiDaemonClient> | undefined;
      try {
        if (invalidation === "session cancellation") f.session.abort(new Error("Session cancelled"));
        else if (invalidation === "request cancellation") request.abort(new Error("Request cancelled"));
        else if (invalidation === "disposal") disposal = f.client.dispose();
        else replacement = f.bindPiDaemonClient(f.ctx, new AbortController().signal);
        f.exited.resolve();
        await rejected;
        await disposal;
        assert.equal(
          waitingSignal().aborted,
          invalidation === "session cancellation" || invalidation === "request cancellation",
        );
        assert.equal(transport.ensure.mock.calls.length, 1);
        assert.equal(f.connections.length, 1);
        assert.equal(f.connections[0]?.run.mock.calls.length, 0);
      } finally {
        await replacement?.dispose();
      }
    }));

test("a second closing attach exhausts the single retry without submitting the operation", () =>
  withClient(async (f) => {
    const second = stopping();
    f.attachErrors.push(second);
    const running = f.client.run("sync", {});
    const rejected = assert.rejects(running, (error) => error === second);
    await f.enteredWait.promise;
    f.exited.resolve();
    await rejected;
    assert.equal(transport.ensure.mock.calls.length, 2);
    assert.equal(transport.wait.mock.calls.length, 1);
    assert.equal(f.connections.length, 2);
    for (const connection of f.connections) {
      assert.equal(connection.dispose.mock.calls.length, 1);
      assert.equal(connection.run.mock.calls.length, 0);
      assert.equal(connection.update.mock.calls.length, 0);
    }
  }));

test("a closing error from an already submitted operation is not retried or replayed", () =>
  withClient(async (f) => {
    f.attachErrors.length = 0;
    const error = stopping();
    f.failOperation(error);
    await assert.rejects(f.client.run("sync", {}), (caught) => caught === error);
    assert.equal(transport.ensure.mock.calls.length, 1);
    assert.equal(transport.wait.mock.calls.length, 0);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0]?.run.mock.calls.length, 1);
  }));

for (const error of [
  new Error("Attach failed"),
  new DaemonError({ name: "PermissionError", message: "Attach denied" }),
  Object.assign(new Error("Not a recognized remote error"), { name: "DaemonStoppingError" }),
])
  test(`generic attach error (${error.name}: ${error.message}) does not retry and is cleaned up`, () =>
    withClient(async (f) => {
      f.attachErrors[0] = error;
      await assert.rejects(f.client.run("sync", {}), (caught) => caught === error);
      assert.equal(transport.ensure.mock.calls.length, 1);
      assert.equal(transport.wait.mock.calls.length, 0);
      assert.equal(f.connections.length, 1);
      assert.equal(f.connections[0]?.run.mock.calls.length, 0);
      await f.client.dispose();
      assert.equal(f.connections[0]?.dispose.mock.calls.length, 1);
    }));

test("failed unpublished cleanup blocks identity renewal and the next command", () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const old = { id: f.client.id, generation: f.client.generation };
    const failure = new Error("Previous cleanup is uncertain");
    const gate = (f.client as unknown as { gate: PiApplyGate }).gate;
    const release = vi.spyOn(gate, "releaseAfterDrain");
    try {
      f.attachErrors[0] = new DOMException("Startup cancelled", "AbortError");
      await assert.rejects(f.client.run("sync", {}), { name: "AbortError" });
      const partial = f.connections[0];
      assert.ok(partial);
      const target = path.join(f.client.root, "held.md");
      await fs.writeFile(target, "unchanged");
      await gate.acquire("old-attempt", [target]);
      partial.dispose.mockRejectedValue(failure);
      await assert.rejects(f.client.run("sync", {}), (error) => error === failure);
      assert.deepEqual({ id: f.client.id, generation: f.client.generation }, old);
      assert.equal(release.mock.calls.length, 0, "uncertain grants must remain held");
      assert.equal(gate.size, 1);
      assert.equal(transport.ensure.mock.calls.length, 1);
      assert.equal(f.connections.length, 1);
      assert.equal(partial.run.mock.calls.length, 0);
    } finally {
      for (const connection of f.connections) connection.dispose.mockResolvedValue(undefined);
      await f.client.dispose();
      release.mockRestore();
    }
  }));

test("cancellation during prior cleanup cannot publish a new identity or operation", () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const old = { id: f.client.id, generation: f.client.generation };
    const entered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const request = new AbortController();
    const gate = (f.client as unknown as { gate: PiApplyGate }).gate;
    let next: Promise<unknown> | undefined;
    try {
      f.attachErrors[0] = new DOMException("Startup cancelled", "AbortError");
      await assert.rejects(f.client.run("sync", {}), { name: "AbortError" });
      const partial = f.connections[0];
      assert.ok(partial);
      const target = path.join(f.client.root, "held.md");
      await fs.writeFile(target, "unchanged");
      await gate.acquire("old-attempt", [target]);
      partial.dispose.mockImplementation(async () => {
        entered.resolve();
        await drained.promise;
      });
      next = f.client.run("sync", {}, request.signal);
      const rejected = assert.rejects(next, { name: "AbortError" });
      await entered.promise;
      request.abort();
      drained.resolve();
      await rejected;
      assert.equal(gate.size, 0, "acknowledged cleanup must finish even after cancellation");
      assert.deepEqual({ id: f.client.id, generation: f.client.generation }, old);
      assert.equal(transport.ensure.mock.calls.length, 1);
      assert.equal(f.connections.length, 1);
      assert.equal(partial.run.mock.calls.length, 0);
      assert.equal(await f.client.run("sync", {}), f.result);
      assert.notEqual(f.client.id, old.id);
      assert.notEqual(f.client.generation, old.generation);
      assert.equal(f.connections[1]?.facts.id, f.client.id);
      assert.equal(f.connections[1]?.facts.generation, f.client.generation);
    } finally {
      drained.resolve();
      request.abort();
      await next?.catch(() => {});
      await f.client.dispose();
    }
  }));

const reloadCallback = { id: "reload", job: "pull", kind: "reload", payload: {} };

test("a completed reload request fences queued work until its command releases it", () =>
  withClient(async (f) => {
    f.attachErrors.length = 0;
    await f.client.connect();
    const connection = f.connections[0];
    assert.ok(connection);
    const reload = new AbortController();
    const other = new AbortController();
    let closes = 0;
    reload.signal.addEventListener("abort", () => closes++);
    const requested = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    connection.run.mockImplementationOnce(async (_operation, _payload, signal) => {
      assert.ok(signal);
      assert.equal(await connection.callback(reloadCallback, signal), true);
      assert.equal(await connection.callback({ ...reloadCallback, id: "duplicate" }, signal), true);
      requested.resolve();
      await finish.promise;
      return f.result;
    });
    const pull = f.client.run("pull", {}, undefined, f.ctx, undefined, reload);
    try {
      await Promise.race([requested.promise, pull]);
      assert.equal(reload.signal.aborted, false);
      const blocked = assert.rejects(f.client.run("settings.cas", {}), /about to reload/u);
      finish.resolve();
      assert.equal(await pull, f.result);
      await blocked;
      assert.equal(connection.run.mock.calls.length, 1);
      assert.equal(closes, 1);
      f.client.releaseReload(other);
      assert.equal(f.client.canReload(other), false);
      assert.equal(f.client.canReload(reload), true);
      f.client.releaseReload(reload);
      assert.equal(f.client.canReload(reload), false);
      assert.equal(await f.client.run("settings.cas", {}), f.result);
    } finally {
      finish.resolve();
      await pull.catch(() => {});
    }
  }));

for (const outcome of ["failed", "cancelled", "closed", "stale"] as const) {
  test(`a ${outcome} pull cannot hand off its reload`, () =>
    withClient(async (f) => {
      f.attachErrors.length = 0;
      await f.client.connect();
      const connection = f.connections[0];
      assert.ok(connection);
      const reload = new AbortController();
      const request = new AbortController();
      const failure = new Error("Operation failed after the callback");
      connection.run.mockImplementationOnce(async (_operation, _payload, signal) => {
        assert.ok(signal);
        await connection.callback(reloadCallback, signal);
        if (outcome === "failed") throw failure;
        if (outcome === "cancelled") request.abort();
        if (outcome === "closed") reload.abort();
        if (outcome === "stale") f.session.abort();
        return f.result;
      });
      const pull = f.client.run("pull", {}, request.signal, f.ctx, undefined, reload);
      if (outcome === "failed") await assert.rejects(pull, (error) => error === failure);
      else if (outcome === "stale") await assert.rejects(pull, { name: "AbortError" });
      else assert.equal(await pull, f.result);
      assert.equal(reload.signal.aborted, outcome === "closed");
      assert.equal(f.client.canReload(reload), false);
      if (outcome !== "stale") {
        assert.equal(await f.client.run("status", {}), f.result);
        await assert.rejects(
          connection.callback(reloadCallback, new AbortController().signal),
          /No active Pi command/u,
        );
      }
    }));
}

test("passive attach returns false for a closing owner without launching or waiting", () =>
  withClient(async (f) => {
    assert.equal(await f.client.attachExisting(), false);
    assert.deepEqual(transport.find.mock.calls, [[f.client.root]]);
    assert.equal(transport.ensure.mock.calls.length, 0);
    assert.equal(transport.wait.mock.calls.length, 0);
    assert.deepEqual(f.events, ["old:attach", "old:dispose"]);
    assert.equal(f.connections[0]?.run.mock.calls.length, 0);
  }));

test("a protection-only connection cannot publish a model binding during attach", () =>
  withClient(async (f) => {
    const [oldOwner] = f.addresses;
    f.attachErrors.length = 0;
    transport.find.mockResolvedValue({ ...oldOwner, needsUpgrade: true });
    const client = f.bindPiDaemonClient(
      {
        ...f.ctx,
        model: { provider: "fixture", id: "fixture" } as ExtensionContext["model"],
        modelRegistry: {
          getRegisteredProviderIds: () => [],
          getProviderAuthStatus: () => ({ source: "stored" }),
        } as unknown as ExtensionContext["modelRegistry"],
      },
      f.session.signal,
    );
    f.duringAttach(async () => {
      const connection = f.connections[0];
      assert.ok(connection);
      const binding = await connection.callback(
        { id: "callback", job: "job", kind: "model-binding", payload: {} },
        f.session.signal,
      );
      assert.equal(binding, null);
      assert.equal(connection.update.mock.calls.length, 0);
    });
    try {
      assert.equal(await client.attachExisting(), false);
    } finally {
      await client.dispose();
    }
  }));

test("an older compatible owner is protection-only unless an interactive replacement opts into upgrade", () =>
  withClient(async (f) => {
    const [oldOwner, newOwner] = f.addresses;
    assert.ok(oldOwner && newOwner);
    f.attachErrors.length = 0;
    transport.find.mockResolvedValue({ ...oldOwner, needsUpgrade: true });
    transport.ensure.mockResolvedValueOnce({ ...newOwner, needsUpgrade: false });

    const assertProtectionOnly = async (client: typeof f.client, options?: { allowUpgrade: boolean }) => {
      const start = f.events.length;
      try {
        assert.equal(await client.attachExisting(options), false);
        await assert.rejects(client.run("sync", {}), /only protecting/iu);
        assert.deepEqual(f.events.slice(start), ["old:attach"]);
        assert.equal(f.connections.at(-1)?.facts.ready, false);
        assert.equal(transport.ensure.mock.calls.length, 0);
      } finally {
        await client.dispose();
      }
    };

    await assertProtectionOnly(f.client);
    for (const mode of ["print", "json"] as const) {
      const headless = f.bindPiDaemonClient({ ...f.ctx, mode, hasUI: false }, f.session.signal);
      await assertProtectionOnly(headless, { allowUpgrade: true });
    }

    const replacement = f.bindPiDaemonClient(f.ctx, f.session.signal);
    try {
      const start = f.events.length;
      assert.equal(await replacement.attachExisting({ allowUpgrade: true }), true);
      assert.deepEqual(transport.ensure.mock.calls, [[replacement.root, f.session.signal]]);
      assert.deepEqual(f.events.slice(start), ["new:attach"]);
      assert.equal(transport.stop.mock.calls.length, 0);
      assert.equal(transport.wait.mock.calls.length, 0);
    } finally {
      await replacement.dispose();
    }
  }));

test("a failed interactive upgrade reports its error and protects the replacement session on the old owner", () =>
  withClient(async (f) => {
    const [oldOwner] = f.addresses;
    assert.ok(oldOwner);
    transport.find.mockResolvedValue({ ...oldOwner, needsUpgrade: true });
    transport.ensure.mockRejectedValue(new Error("Unattended permission needs review\u001b"));
    f.attachErrors.length = 0;

    assert.equal(await f.client.attachExisting({ allowUpgrade: true }), false);
    assert.deepEqual(f.notifications, [
      { message: "pi-sync daemon upgrade failed: Unattended permission needs review?", level: "error" },
    ]);
    const [fallback] = f.connections;
    assert.ok(fallback);
    assert.equal(fallback.identity, oldOwner.identity);
    assert.equal(fallback.facts.sessionFile, f.ctx.sessionManager.getSessionFile());
    assert.equal(fallback.facts.sessionId, f.ctx.sessionManager.getSessionId());
    assert.deepEqual(f.events, ["old:attach"]);

    // The session handoff can refresh protection and facts, but cannot start active work.
    await f.client.finishReattachment();
    await f.client.markReady(false);
    assert.equal(fallback.facts.hasUI, false);
    assert.equal(fallback.facts.ready, false);
    assert.equal(fallback.facts.idle, false);
    assert.equal(fallback.facts.model, undefined);
    await assert.rejects(f.client.verifyConnection(), /only protecting/iu);
    await assert.rejects(f.client.run("sync", {}), /only protecting/iu);
    assert.deepEqual(f.events, ["old:attach", "old:attach", "old:update"]);
    assert.equal(fallback.dispose.mock.calls.length, 0);
    assert.equal(fallback.run.mock.calls.length, 0);
    assert.equal(transport.ensure.mock.calls.length, 1);
    assert.equal(transport.find.mock.calls.length, 1);
    assert.equal(transport.wait.mock.calls.length, 0);
  }));

for (const attachError of [stopping(), Object.assign(new Error("Owner has exited"), { code: "ECONNREFUSED" })])
  test(`a failed upgrade is reported even when fallback cannot attach: ${attachError.message}`, () =>
    withClient(async (f) => {
      transport.find.mockResolvedValue({ ...f.addresses[0], needsUpgrade: true });
      transport.ensure.mockRejectedValue(new Error("Upgrade refused"));
      f.attachErrors[0] = attachError;

      const attaching = f.client.attachExisting({ allowUpgrade: true });
      if (attachError instanceof DaemonError) assert.equal(await attaching, false);
      else await assert.rejects(attaching, (error) => error === attachError);
      assert.deepEqual(f.notifications, [
        { message: "pi-sync daemon upgrade failed: Upgrade refused", level: "error" },
      ]);
      assert.equal(transport.find.mock.calls.length, 1);
      assert.equal(transport.ensure.mock.calls.length, 1);
      assert.equal(f.connections.length, 1);
      assert.equal(f.connections[0]?.run.mock.calls.length, 0);
    }));

for (const [phase, invalidate] of [
  ["upgrade", "cancellation"],
  ["upgrade", "replacement"],
  ["upgrade", "disposal"],
  ["fallback", "cancellation"],
  ["fallback", "replacement"],
] as const)
  test(`${invalidate} during ${phase} cannot publish stale protection or report the old error`, () =>
    withClient(async (f) => {
      transport.find.mockResolvedValue({ ...f.addresses[0], needsUpgrade: true });
      f.attachErrors.length = 0;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failUpgrade = async () => {
        if (phase === "upgrade") {
          entered.resolve();
          await release.promise;
        }
        throw new Error("Upgrade refused");
      };
      transport.ensure.mockImplementation(failUpgrade);
      if (phase === "fallback") {
        f.duringAttach(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      const attaching = f.client.attachExisting({ allowUpgrade: true });
      let replacement: ReturnType<typeof f.bindPiDaemonClient> | undefined;
      let disposal: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, attaching]);
        assert.equal(f.connections.length, phase === "upgrade" ? 0 : 1);
        if (invalidate === "cancellation") f.session.abort(new Error("Session cancelled"));
        else if (invalidate === "replacement") replacement = f.bindPiDaemonClient(f.ctx, new AbortController().signal);
        else disposal = f.client.dispose();
        release.resolve();
        await assert.rejects(attaching, /session was replaced|session cancelled/iu);
        await disposal;
        assert.equal(transport.ensure.mock.calls.length, 1);
        assert.equal(f.connections.length, phase === "upgrade" ? 0 : 1);
        assert.deepEqual(f.notifications, []);
        for (const connection of f.connections) {
          assert.equal(connection.run.mock.calls.length, 0);
          assert.equal(connection.update.mock.calls.length, 0);
        }
      } finally {
        release.resolve();
        await attaching.catch(() => {});
        await replacement?.dispose();
      }
    }));
