import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { DaemonConnection, DaemonError, findDaemon, requestDaemon } from "../src/client.js";
import { readIdentity, runtimePaths } from "../src/identity.js";
import { IDLE_EXIT_GRACE_MS } from "../src/idle-exit.js";
import { ParticipantAdmission } from "../src/participant-admission.js";
import { type ClientFacts, type Execute, operationPrefix } from "../src/protocol.js";
import { type ServerHooks, startServer } from "../src/server.js";

interface Fixture {
  root: string;
  server: Awaited<ReturnType<typeof startServer>>;
  advance(ms?: number): void;
  stopped: Promise<void>;
  gate(): ReturnType<typeof Promise.withResolvers<void>>;
  child(): Promise<{ pid: number; stop(): Promise<void> }>;
}
async function fixture(
  run: (value: Fixture) => Promise<void>,
  hooks: ServerHooks = {},
  execute: Execute = async () => null,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-idle-server-")));
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
  const done = Promise.withResolvers<void>();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const server = await startServer(root, execute, {
    lifetime: async () => "exit",
    ...hooks,
    stopped: () => {
      hooks.stopped?.();
      done.resolve();
    },
  });
  try {
    await server.checkLifetime();
    await run({
      root,
      server,
      stopped: done.promise,
      advance(ms = IDLE_EXIT_GRACE_MS) {
        now += ms;
      },
      gate() {
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        return gate;
      },
      async child() {
        const child = spawn(process.execPath, ["-e", 'process.send({type:"ready"});setInterval(()=>{},1000);'], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const exited = once(child, "close");
        children.push({ child, exited });
        await once(child, "message");
        assert.ok(child.pid);
        return {
          pid: child.pid,
          async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await exited;
          },
        };
      },
    });
  } finally {
    for (const gate of gates) gate.resolve();
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
    await server.close();
    clock.mockRestore();
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}
function facts(root: string, pid = process.pid, mode: ClientFacts["mode"] = "rpc"): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid,
    cwd: root,
    mode,
    hasUI: mode === "rpc" || mode === "tui",
    idle: true,
  };
}

test("a ready service with no clients closes only after the full grace and preserves recovery bytes", () =>
  fixture(async ({ root, server, advance, stopped }) => {
    const retained = path.join(root, "journal-evidence");
    await fs.writeFile(retained, "retained bytes");
    advance(IDLE_EXIT_GRACE_MS - 1);
    await server.checkLifetime();
    assert.equal(server.closed, false);
    advance(1);
    await server.checkLifetime();
    await stopped;
    assert.equal(server.closed, true);
    assert.equal(await readIdentity(server.paths), undefined);
    assert.equal(await fs.readFile(retained, "utf8"), "retained bytes");
  }));

for (const mode of ["tui", "rpc", "print", "json"] as const)
  for (const state of ["connected", "exit", "replace", "pause"] as const)
    test(`${mode} with a live PID prevents exit while ${state}`, () =>
      fixture(async ({ root, server, advance }) => {
        const peer = facts(root, process.pid, mode);
        await requestDaemon(server.paths, server.identity, "attach", peer);
        if (state === "pause") await requestDaemon(server.paths, server.identity, "pause", { client: peer.id });
        else if (state !== "connected")
          await requestDaemon(server.paths, server.identity, "handoff", {
            client: peer.id,
            handoff: { kind: state, cwd: root },
          });
        advance(IDLE_EXIT_GRACE_MS * 2);
        await server.expireClients();
        await server.checkLifetime();
        assert.equal(server.closed, false);
        assert.equal(server.liveClients().length, 1);
      }));

test("uncertain process probes retain lifetime", () =>
  fixture(async ({ root, server, advance }) => {
    await requestDaemon(server.paths, server.identity, "attach", facts(root));
    const kill = process.kill;
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) throw Object.assign(new Error("uncertain"), { code: "EPERM" });
      return kill.call(process, pid, signal);
    });
    try {
      advance(IDLE_EXIT_GRACE_MS * 2);
      await server.expireClients();
      await server.checkLifetime();
      assert.equal(server.closed, false);
      assert.equal(server.liveClients().length, 1);
    } finally {
      probe.mockRestore();
    }
  }));

test("a restored retired live client keeps a replacement owner alive", () =>
  fixture(async ({ root, server, advance }) => {
    const peer = facts(root);
    await requestDaemon(server.paths, server.identity, "attach", peer);
    await requestDaemon(server.paths, server.identity, "detach", { client: peer.id });
    await server.close();
    const next = await startServer(root, async () => null, { lifetime: async () => "exit" });
    try {
      await next.checkLifetime();
      advance(IDLE_EXIT_GRACE_MS * 2);
      await next.expireClients();
      await next.checkLifetime();
      assert.equal(next.closed, false);
      assert.equal(next.liveClients()[0]?.id, peer.id);
      assert.equal(next.participants().length, 0);
    } finally {
      await next.close();
    }
  }));

test("live clients in one canonical root do not keep a separate root alive", () =>
  fixture(async ({ root, server, advance }) => {
    await requestDaemon(server.paths, server.identity, "attach", facts(root));
    const otherRoot = path.join(root, "other-root");
    await fs.mkdir(otherRoot);
    const done = Promise.withResolvers<void>();
    const other = await startServer(otherRoot, async () => null, {
      lifetime: async () => "exit",
      stopped: done.resolve,
    });
    try {
      await other.checkLifetime();
      advance();
      await Promise.all([server.checkLifetime(), other.checkLifetime()]);
      await done.promise;
      assert.equal(server.closed, false);
      assert.equal(other.closed, true);
    } finally {
      await other.close();
      await fs.rm(other.paths.directory, { recursive: true, force: true });
    }
  }));

test("the last confirmed process exit starts a fresh grace after other clients exit", () =>
  fixture(async ({ root, server, advance, child, stopped }) => {
    const first = await child();
    const second = await child();
    await requestDaemon(server.paths, server.identity, "attach", facts(root, first.pid));
    await requestDaemon(server.paths, server.identity, "attach", facts(root, second.pid));
    await server.checkLifetime();
    await first.stop();
    advance();
    await server.expireClients();
    await server.checkLifetime();
    assert.equal(server.closed, false);
    await second.stop();
    await server.expireClients();
    await server.checkLifetime();
    advance(IDLE_EXIT_GRACE_MS - 1);
    await server.checkLifetime();
    assert.equal(server.closed, false);
    advance(1);
    await server.checkLifetime();
    await stopped;
  }));

test("an attachment during an asynchronous lifetime read prevents quiesce", () => {
  let hold: ReturnType<Fixture["gate"]> | undefined;
  const entered = Promise.withResolvers<void>();
  const quiesce = vi.fn(async () => {});
  return fixture(
    async ({ root, server, advance, gate }) => {
      hold = gate();
      advance();
      const checking = server.checkLifetime();
      await entered.promise;
      await requestDaemon(server.paths, server.identity, "attach", facts(root));
      hold.resolve();
      await checking;
      assert.equal(server.closed, false);
      assert.equal(quiesce.mock.calls.length, 0);
    },
    {
      lifetime: async () => {
        if (hold) {
          entered.resolve();
          await hold.promise;
        }
        return "exit";
      },
      quiesce,
    },
  );
});

test("admission remains available while idle shutdown is quiescing", () => {
  const entered = Promise.withResolvers<void>();
  let hold: ReturnType<Fixture["gate"]>;
  const resumed = vi.fn();
  return fixture(
    async ({ root, server, advance, gate }) => {
      hold = gate();
      advance();
      const checking = server.checkLifetime();
      await entered.promise;
      await requestDaemon(server.paths, server.identity, "attach", facts(root));
      hold.resolve();
      await checking;
      assert.equal(server.closed, false);
      assert.equal(resumed.mock.calls.length, 1);
    },
    {
      quiesce: async () => {
        entered.resolve();
        await hold.promise;
      },
      idle: resumed,
    },
  );
});

test("an attach queued during the final admission check cancels automatic exit", () => {
  let quiesced = false;
  let reads = 0;
  let hold: ReturnType<Fixture["gate"]>;
  const entered = Promise.withResolvers<void>();
  return fixture(
    async ({ root, server, advance, gate }) => {
      hold = gate();
      advance();
      const checking = server.checkLifetime();
      await entered.promise;
      const queued = Promise.withResolvers<void>();
      const original = ParticipantAdmission.prototype.run;
      const observer = vi.spyOn(ParticipantAdmission.prototype, "run").mockImplementation(function <T>(
        this: ParticipantAdmission,
        action: () => Promise<T>,
        signal?: AbortSignal,
      ) {
        queued.resolve();
        return original.call(this, action, signal) as Promise<T>;
      });
      try {
        const attached = requestDaemon(server.paths, server.identity, "attach", facts(root));
        await queued.promise;
        hold.resolve();
        await Promise.all([checking, attached]);
        assert.equal(server.closed, false);
        assert.equal(server.liveClients().length, 1);
      } finally {
        observer.mockRestore();
      }
    },
    {
      quiesce: async () => {
        quiesced = true;
      },
      lifetime: async () => {
        if (quiesced && ++reads === 2) {
          entered.resolve();
          await hold.promise;
        }
        return "exit";
      },
    },
  );
});

test("a client arriving after the final fence sees an authenticated closing error", () => {
  let hold: ReturnType<Fixture["gate"]>;
  const entered = Promise.withResolvers<void>();
  return fixture(
    async ({ root, server, advance, gate, stopped }) => {
      hold = gate();
      advance();
      await server.checkLifetime();
      await entered.promise;
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "attach", facts(root)),
        (error: unknown) => error instanceof DaemonError && error.remote.name === "DaemonStoppingError",
      );
      assert.equal(await findDaemon(root), undefined);
      const connection = new DaemonConnection(server.paths, server.identity, facts(root), {
        callback: async () => true,
      });
      await assert.rejects(
        connection.attach(),
        (error: unknown) => error instanceof DaemonError && error.remote.name === "DaemonStoppingError",
      );
      hold.resolve();
      await stopped;
    },
    {
      close: async () => {
        entered.resolve();
        await hold.promise;
      },
    },
  );
});

test("a failed peer publication pauses automatic exit", () =>
  fixture(async ({ root, server, advance }) => {
    const rename = fs.rename;
    const observer = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === path.join(server.paths.directory, "clients.json")) throw new Error("peer publication failed");
      return rename(source, target);
    });
    try {
      await assert.rejects(
        requestDaemon(server.paths, server.identity, "attach", facts(root)),
        /peer publication failed/u,
      );
    } finally {
      observer.mockRestore();
    }
    advance(IDLE_EXIT_GRACE_MS * 2);
    await server.checkLifetime();
    assert.equal(server.closed, false);
    assert.equal((await readIdentity(server.paths))?.instance, server.identity.instance);
  }));

test("a failed automatic engine close retains ownership and reports no successful stop", () => {
  let broken = true;
  const failed = Promise.withResolvers<void>();
  const stopped = vi.fn();
  return fixture(
    async ({ root, server, advance }) => {
      try {
        advance();
        await server.checkLifetime();
        await failed.promise;
        assert.equal(stopped.mock.calls.length, 0);
        assert.equal((await readIdentity(server.paths))?.instance, server.identity.instance);
        await assert.rejects(
          startServer(root, async () => null),
          /owner is still alive/u,
        );
      } finally {
        broken = false;
      }
      await server.close();
      assert.equal(stopped.mock.calls.length, 1);
    },
    {
      close: async () => {
        if (broken) throw new Error("engine cleanup failed");
      },
      failure: failed.resolve,
      stopped,
    },
  );
});

test("peer persistence drains before automatic shutdown releases the owner", () => {
  const quiesced = Promise.withResolvers<void>();
  return fixture(
    async ({ root, server, advance, child, gate, stopped }) => {
      const owner = await child();
      await requestDaemon(server.paths, server.identity, "attach", facts(root, owner.pid));
      await server.checkLifetime();
      await owner.stop();
      const hold = gate();
      const entered = Promise.withResolvers<void>();
      const rename = fs.rename;
      const observer = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        if (target === path.join(server.paths.directory, "clients.json")) {
          entered.resolve();
          await hold.promise;
        }
        return rename(source, target);
      });
      try {
        const expiring = server.expireClients();
        await entered.promise;
        await server.checkLifetime();
        advance();
        const checking = server.checkLifetime();
        await quiesced.promise;
        assert.equal(server.closed, false);
        assert.ok(await readIdentity(server.paths));
        hold.resolve();
        await Promise.all([expiring, checking]);
        await stopped;
        assert.deepEqual(
          JSON.parse(await fs.readFile(path.join(server.paths.directory, "clients.json"), "utf8")).clients,
          [],
        );
      } finally {
        observer.mockRestore();
      }
    },
    {
      quiesce: async () => {
        quiesced.resolve();
      },
    },
  );
});

test("committed work finishes before automatic shutdown releases the owner", () => {
  let hold: ReturnType<Fixture["gate"]>;
  const entered = Promise.withResolvers<void>();
  return fixture(
    async ({ root, server, advance, gate, child, stopped }) => {
      hold = gate();
      const owner = await child();
      const peer = facts(root, owner.pid);
      await requestDaemon(server.paths, server.identity, "attach", peer);
      await server.checkLifetime();
      await requestDaemon(server.paths, server.identity, "submit", {
        id: `${operationPrefix(server.identity)}${randomUUID()}`,
        client: peer.id,
        operation: "commit",
      });
      await entered.promise;
      await owner.stop();
      await server.expireClients();
      await server.checkLifetime();
      advance();
      const checking = server.checkLifetime();
      assert.equal(server.closed, false);
      assert.ok(await readIdentity(server.paths));
      hold.resolve();
      await checking;
      await stopped;
      assert.equal(await fs.readFile(path.join(root, "committed"), "utf8"), "complete");
    },
    {},
    async (_operation, _payload, execution) => {
      execution.committed();
      entered.resolve();
      await hold.promise;
      execution.validate();
      await fs.writeFile(path.join(execution.root, "committed"), "complete");
    },
  );
});
