import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { test, vi } from "vitest";
import { main as daemonCli } from "../dist/cli.js";
import {
  DaemonConnection,
  DaemonError,
  ensureDaemon,
  findDaemon,
  requestDaemon,
  waitForDaemonExit,
} from "../dist/client.js";
import { DAEMON_BUILD_VERSION } from "../src/build-version.js";
import {
  daemonPaths,
  privateDirectory,
  processExists,
  publishIdentity,
  readIdentity,
  readUpgradeOwner,
  runtimePaths,
} from "../src/identity.js";
import type { Identity } from "../src/protocol.js";
import { startServer } from "../src/server.js";

const launches = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realSpawn: typeof spawn = actual.spawn;
  return {
    ...actual,
    spawn: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      if (args[1] === "serve") launches();
      return realSpawn(file, args, options);
    }) as typeof spawn,
  };
});

// The child owns the socket and stays alive after transport closure until explicitly released.
// IPC, not a wall-clock delay, controls each closing-owner race.
const ownerProgram = `
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
const { endpoint, identity, identityFile, mode, buildVersion } = JSON.parse(process.argv[1]);
identity.pid = process.pid;
let attached = false;
const pendingAttach = [];
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const authenticated = body.version === 1 && body.root === identity.root &&
    body.instance === identity.instance && body.token === identity.token;
  if (authenticated && mode === "silent") {
    process.send({ type: "hello", authenticated });
    return;
  }
  if (authenticated && mode === "drop-detach" && body.method === "detach") {
    request.socket.destroy();
    return;
  }
  if (authenticated && mode === "callbacks" && body.method === "attach") {
    pendingAttach.push(response);
    return;
  }
  let value;
  if (!authenticated || mode === "unauthorized") {
    response.statusCode = 403;
    value = { error: { name: "Error", message: "Invalid daemon identity or protocol." } };
  } else if (mode === "callbacks" && body.method === "poll") {
    value = { result: { cursor: 0, events: [], callbacks: [{ id: "queue", job: "unpublished", kind: "queue-acquire", payload: {} }] } };
  } else if (mode === "admitted-event" && body.method !== "detach") {
    value = { result: { cursor: 1, callbacks: [], events: [{ id: 1, kind: "notify", payload: {} }] } };
  } else if (mode === "attached" && (!attached || body.method === "poll")) {
    if (body.method === "attach") attached = true;
    value = { result: { cursor: 0, callbacks: [], events: [] } };
  } else if (mode === "upgrade" && body.method === "hello") {
    const { version, root, instance, pid } = identity;
    value = { result: { version, root, instance, pid, buildVersion } };
  } else if (mode === "upgrade" && body.method === "stop") {
    response.once("finish", () => process.send({ type: "stop", authenticated }));
    value = { result: { stopping: true } };
  } else if (mode === "incompatible") {
    value = { result: { ...identity, version: 2 } };
  } else if (mode === "malformed") {
    value = { error: { name: "DaemonStoppingError" } };
  } else {
    value = { error: {
      name: ["closing", "drop-detach", "attached", "generic-attach", "admitted-event", "callbacks"].includes(mode) &&
        !(mode === "generic-attach" && body.method === "attach") ? "DaemonStoppingError" : "Error",
      message: "Daemon is closing after its idle grace period; wait for owner exit before reconnecting."
    } };
  }
  response.once("finish", () => process.send({ type: "hello", authenticated }));
  response.end(JSON.stringify(value));
});
process.on("message", async (message) => {
  if (message === "release") {
    await rm(identityFile);
    server.close(() => process.send({ type: "release" }));
  }
  if (message === "exit") process.exit(0);
  if (message === "probe") process.send({ type: "probe" });
  if (message === "close") server.close(() => process.send({ type: "closed" }));
  if (message === "reject") {
    for (const response of pendingAttach) response.end(JSON.stringify({ error: { name: "DaemonStoppingError", message: "closing" } }));
    process.send({ type: "reject" });
  }
});
server.listen(endpoint, () => process.send({ type: "ready" }));
`;

type Mode =
  | "closing"
  | "generic"
  | "incompatible"
  | "malformed"
  | "unauthorized"
  | "silent"
  | "drop-detach"
  | "attached"
  | "generic-attach"
  | "admitted-event"
  | "callbacks"
  | "upgrade";

function message(child: ChildProcess, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => {
      child.off("message", received);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const received = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== type) return;
      cleanup();
      resolve(value as Record<string, unknown>);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = () => failed(new Error(`Fake owner exited before ${type}.`));
    child.on("message", received);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function fixture(
  run: (owner: Awaited<ReturnType<typeof createOwner>>) => Promise<void>,
  mode: Mode = "closing",
  buildVersion?: string,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-closing-")));
  const paths = await runtimePaths(root);
  let owner: Awaited<ReturnType<typeof createOwner>> | undefined;
  try {
    owner = await createOwner(root, mode, buildVersion);
    await run(owner);
  } finally {
    // Discover a replacement even when the assertion immediately after startup failed.
    const replacement = await readIdentity(paths).catch(() => undefined);
    try {
      if (replacement && replacement.pid !== owner?.identity.pid && replacement.pid !== process.pid) {
        try {
          await requestDaemon(paths, replacement, "stop", {}, AbortSignal.timeout(1_000));
          await waitForDaemonExit(replacement, AbortSignal.timeout(1_000));
        } catch {
          if (processExists(replacement.pid)) process.kill(replacement.pid, "SIGKILL");
          await waitForDaemonExit(replacement, AbortSignal.timeout(1_000));
        }
      }
    } finally {
      if (owner) await terminate(owner.child);
      for (const identity of [owner?.identity, replacement]) {
        if (!identity) continue;
        const endpoint = daemonPaths(paths, identity.instance).endpointDirectory;
        if (endpoint) await fs.rm(endpoint, { recursive: true, force: true });
      }
      await fs.rm(paths.directory, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

async function createOwner(root: string, mode: Mode, buildVersion?: string) {
  const paths = await runtimePaths(root);
  await privateDirectory(paths.directory);
  const identity: Identity = {
    version: 1,
    root,
    instance: randomUUID(),
    pid: 1,
    token: randomBytes(32).toString("hex"),
  };
  const endpoint = daemonPaths(paths, identity.instance);
  if (endpoint.endpointDirectory) await privateDirectory(endpoint.endpointDirectory);
  // Seed opaque evidence; a connection must not interpret or rewrite these bytes.
  const evidence = new Map([
    ["settings.json", '{ "unknownClosingOwnerField": { "keep": true } }\n'],
    ["sync-daemon/journals/pending.json", '{ "phase": "committed", "unknown": [1, 2] }\n'],
    ["sync-daemon/backups/preimage", "exact preimage\r\n\u0000"],
    ["sync-daemon/request-accounting.json", '{ "requests": 7, "unknown": true }\n'],
  ]);
  for (const [name, bytes] of evidence) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
  }
  // Pass the child's actual PID through the request handshake, not the fixture runner PID.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      ownerProgram,
      JSON.stringify({
        endpoint: endpoint.endpoint,
        identity,
        identityFile: paths.identity,
        mode,
        buildVersion,
      }),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  child.stderr?.resume();
  try {
    assert.ok(child.pid);
    identity.pid = child.pid;
    await message(child, "ready");
    await publishIdentity(paths, identity);
    const identityBytes = await fs.readFile(paths.identity);
    const rootEntries = (await fs.readdir(root, { recursive: true })).sort();
    const command = async (type: "probe" | "close" | "reject" | "release") => {
      const reply = message(child, type === "close" ? "closed" : type);
      child.send(type);
      await reply;
    };
    const preserved = async () => {
      assert.deepEqual((await fs.readdir(root, { recursive: true })).sort(), rootEntries);
      for (const [name, bytes] of evidence)
        assert.deepEqual(await fs.readFile(path.join(root, name)), Buffer.from(bytes));
    };
    const unchanged = async () => {
      assert.deepEqual(await fs.readFile(paths.identity), identityBytes);
      assert.deepEqual(await fs.readdir(paths.directory), ["identity.json"]);
      assert.equal(processExists(identity.pid), true);
      await preserved();
    };
    return { root, paths, identity, identityBytes, child, command, preserved, unchanged };
  } catch (error) {
    await terminate(child);
    if (endpoint.endpointDirectory) await fs.rm(endpoint.endpointDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function cliResult(command: string, root: string) {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await daemonCli([command, "--root", root]);
    assert.equal(stdout.mock.calls.length, 1);
    return JSON.parse(stdout.mock.calls[0]?.[0] ?? "");
  } finally {
    stdout.mockRestore();
  }
}

function beforeStartupSettles<T>(step: Promise<T>, label: string, ...startups: Promise<unknown>[]) {
  return Promise.race([
    step,
    ...startups.map((startup) => startup.then(() => assert.fail(`Startup completed before ${label}.`))),
  ]);
}

function observeExitPoll(owner: Awaited<ReturnType<typeof createOwner>>) {
  const polled = Promise.withResolvers<void>();
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === owner.identity.pid && signal === 0) polled.resolve();
    return kill(pid, signal);
  });
  const launched = Promise.withResolvers<"launch">();
  launches.mockImplementation(() => launched.resolve("launch"));
  return {
    first: Promise.race([polled.promise.then(() => "poll" as const), launched.promise]),
    restore: () => {
      spy.mockRestore();
      launches.mockImplementation(() => {});
    },
  };
}

for (const buildVersion of [undefined, "0.0.0"]) {
  test(`concurrent startup replaces ${buildVersion ?? "an unversioned"} owner only after drain and exit`, () =>
    fixture(
      async (owner) => {
        assert.equal((await findDaemon(owner.root))?.needsUpgrade, true);
        await owner.unchanged(); // Discovery alone does not stop the service.
        launches.mockClear();
        const stopped = message(owner.child, "stop");
        const controller = new AbortController();
        const first = ensureDaemon(owner.root, controller.signal);
        const second = ensureDaemon(owner.root, controller.signal);
        const both = Promise.all([first, second]);
        void both.catch(() => {});
        try {
          assert.equal(
            (await beforeStartupSettles(stopped, "stop acknowledgement", first, second)).authenticated,
            true,
          );
          assert.equal((await readIdentity(owner.paths))?.instance, owner.identity.instance);
          await owner.command("release");
          const observer = observeExitPoll(owner);
          try {
            assert.equal(await beforeStartupSettles(observer.first, "the exit probe", first, second), "poll");
            assert.equal(await readIdentity(owner.paths), undefined);
            assert.equal(launches.mock.calls.length, 0);
          } finally {
            observer.restore();
          }
          const exited = once(owner.child, "exit");
          owner.child.send("exit");
          await exited;
          const [next, other] = await both;
          assert.notEqual(next.identity.instance, owner.identity.instance);
          assert.equal(next.identity.instance, other.identity.instance);
          assert.equal(next.needsUpgrade, false);
          assert.equal(launches.mock.calls.length, 1);
          await owner.preserved();
        } finally {
          controller.abort();
          await Promise.allSettled([first, second]);
        }
      },
      "upgrade",
      buildVersion,
    ));
}

for (const buildVersion of [DAEMON_BUILD_VERSION, "999.0.0"]) {
  test(`startup reuses an owner on build ${buildVersion} without a downgrade`, () =>
    fixture(
      async (owner) => {
        assert.equal((await ensureDaemon(owner.root)).identity.instance, owner.identity.instance);
        await owner.unchanged();
      },
      "upgrade",
      buildVersion,
    ));
}

test("a new caller waits for the old PID after cancellation and identity release", () =>
  fixture(async (owner) => {
    launches.mockClear();
    const controller = new AbortController();
    const stopped = message(owner.child, "stop");
    const startup = ensureDaemon(owner.root, controller.signal);
    const first = assert.rejects(startup, { name: "AbortError" });
    void first.catch(() => {});
    try {
      await beforeStartupSettles(stopped, "stop acknowledgement", startup);
      await owner.command("release");
    } finally {
      controller.abort();
    }
    await first;
    assert.equal(await readIdentity(owner.paths), undefined);
    const pending = await readUpgradeOwner(owner.paths);
    assert.equal(pending?.pid, owner.identity.pid);
    assert.equal(Object.hasOwn(pending ?? {}, "token"), false);
    assert.deepEqual(await cliResult("status", owner.root), {
      running: false,
      root: owner.root,
      pendingUpgradePid: owner.identity.pid,
    });
    await assert.rejects(daemonCli(["repair-upgrade", "--root", owner.root]), /cannot verify.*exit/iu);
    assert.deepEqual(await readUpgradeOwner(owner.paths), pending);
    await assert.rejects(
      startServer(owner.root, async () => undefined),
      /daemon upgrade is pending/u,
    );

    const waiting = new AbortController();
    const observer = observeExitPoll(owner);
    const next = ensureDaemon(owner.root, waiting.signal);
    void next.catch(() => {});
    try {
      assert.equal(await beforeStartupSettles(observer.first, "the exit probe", next), "poll");
      assert.equal(launches.mock.calls.length, 0);
      const exited = once(owner.child, "exit");
      owner.child.send("exit");
      await exited;
      assert.notEqual((await next).identity.pid, owner.identity.pid);
      assert.equal(launches.mock.calls.length, 1);
      assert.equal(await readUpgradeOwner(owner.paths), undefined);
    } finally {
      waiting.abort();
      observer.restore();
      await next.catch(() => {});
    }
  }, "upgrade"));

test("another startup keeps waiting beyond the former five-second lock budget and can cancel", () =>
  fixture(async (owner) => {
    const release = await lockfile.lock(owner.paths.directory, {
      realpath: false,
      lockfilePath: owner.paths.startup,
    });
    const controller = new AbortController();
    const start = performance.now();
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(start)
      .mockReturnValue(start + 6_000);
    const lock = lockfile.lock.bind(lockfile);
    const secondAttempt = Promise.withResolvers<void>();
    let attempts = 0;
    const acquire = vi.spyOn(lockfile, "lock").mockImplementation((...args) => {
      if (++attempts === 2) secondAttempt.resolve();
      return lock(...args);
    });
    const next = assert.rejects(ensureDaemon(owner.root, controller.signal), { name: "AbortError" });
    void next.catch(() => {});
    try {
      await beforeStartupSettles(secondAttempt.promise, "the second startup lock attempt", next);
      controller.abort();
      await next;
    } finally {
      controller.abort();
      acquire.mockRestore();
      clock.mockRestore();
      await next.catch(() => {});
      await release();
    }
    await owner.unchanged();
  }, "upgrade"));

test("only explicit repair clears a pending owner that exited without releasing its identity", () =>
  fixture(async (owner) => {
    launches.mockClear();
    const stopped = message(owner.child, "stop");
    const startup = ensureDaemon(owner.root);
    const result = assert.rejects(startup, /without releasing its identity/u);
    void result.catch(() => {});
    await beforeStartupSettles(stopped, "stop acknowledgement", startup);
    const active = await cliResult("status", owner.root);
    assert.equal(active.running, true);
    assert.equal(active.pid, owner.identity.pid);
    assert.equal(active.pendingUpgradePid, owner.identity.pid);
    assert.equal(Object.hasOwn(active, "token"), false);
    const exited = once(owner.child, "exit");
    owner.child.send("exit");
    await exited;
    await result;
    await assert.rejects(ensureDaemon(owner.root), /without releasing its identity/u);
    assert.deepEqual(await fs.readFile(owner.paths.identity), owner.identityBytes);
    const upgradeBytes = await fs.readFile(path.join(owner.paths.directory, "upgrade-owner.json"));
    const repair = await cliResult("repair-upgrade", owner.root);
    assert.equal(repair.repaired, true);
    assert.equal(repair.revokedGrants, 0);
    assert.deepEqual(await fs.readFile(path.join(repair.archive, "identity.json")), owner.identityBytes);
    assert.deepEqual(await fs.readFile(path.join(repair.archive, "upgrade-owner.json")), upgradeBytes);
    assert.equal(await readIdentity(owner.paths), undefined);
    assert.equal(await readUpgradeOwner(owner.paths), undefined);
    assert.equal(launches.mock.calls.length, 0);
    await owner.preserved();
    assert.equal((await ensureDaemon(owner.root)).needsUpgrade, false);
    assert.equal(launches.mock.calls.length, 1);
  }, "upgrade"));

test("offline upgrade repair revokes grants written during drain without launching the daemon", () =>
  fixture(async (owner) => {
    launches.mockClear();
    const stopped = message(owner.child, "stop");
    const startup = ensureDaemon(owner.root);
    const result = assert.rejects(startup, /review or revoke unattended/iu);
    void result.catch(() => {});
    await beforeStartupSettles(stopped, "stop acknowledgement", startup);
    const state = path.join(owner.root, ".pisync");
    const file = path.join(state, "daemon.json");
    const consent = {
      version: 1,
      root: owner.root,
      handover: true,
      nonce: "a".repeat(64),
      setups: {
        home: { fingerprint: "b".repeat(64), afterExit: true, other: [1, 2] },
        work: { fingerprint: "c".repeat(64), afterExit: true },
      },
      future: "keep",
    };
    await fs.mkdir(state);
    await fs.writeFile(file, JSON.stringify(consent), { mode: 0o600 });
    await owner.command("release");
    const exited = once(owner.child, "exit");
    owner.child.send("exit");
    await exited;
    await result;
    await assert.rejects(ensureDaemon(owner.root), /review or revoke unattended/iu);
    const repair = await cliResult("repair-upgrade", owner.root);
    assert.equal(repair.repaired, true);
    assert.equal(repair.revokedGrants, 2);
    consent.setups.home.afterExit = false;
    consent.setups.work.afterExit = false;
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), consent);
    assert.equal(await readUpgradeOwner(owner.paths), undefined);
    assert.equal(launches.mock.calls.length, 0);
    assert.deepEqual(await cliResult("repair-upgrade", owner.root), { repaired: false });
    assert.equal((await ensureDaemon(owner.root)).needsUpgrade, false);
    assert.equal(launches.mock.calls.length, 1);
  }, "upgrade"));

for (const stateDirectory of ["pi-sync", ".pisync"]) {
  test(`an unattended grant in ${stateDirectory} blocks implicit upgrade`, () =>
    fixture(async (owner) => {
      const dir = path.join(owner.root, stateDirectory);
      const target = path.join(dir, "daemon.json");
      const consent = JSON.stringify({
        version: 1,
        root: owner.root,
        handover: true,
        nonce: "0".repeat(64),
        setups: { active: { fingerprint: "1".repeat(64), afterExit: true } },
      });
      await fs.mkdir(dir);
      await fs.writeFile(target, consent, { mode: 0o600 });
      const messages: unknown[] = [];
      owner.child.on("message", (value) => messages.push(value));
      await assert.rejects(ensureDaemon(owner.root), /revoke unattended Pi Sync permission/iu);
      await owner.command("probe");
      assert.ok(!messages.some((value) => (value as { type?: string }).type === "stop"));
      assert.deepEqual(await fs.readFile(owner.paths.identity), owner.identityBytes);
      assert.equal(await fs.readFile(target, "utf8"), consent);
    }, "upgrade"));
}

test("the upgrade waits for the migration guard before selecting and reading consent", () =>
  fixture(async (owner) => {
    const legacy = path.join(owner.root, ".pisync");
    await fs.mkdir(legacy);
    const consent = JSON.stringify({
      version: 1,
      root: owner.root,
      handover: true,
      nonce: "0".repeat(64),
      setups: { active: { fingerprint: "1".repeat(64), afterExit: true } },
    });
    await fs.writeFile(path.join(legacy, "daemon.json"), consent, { mode: 0o600 });
    const migration = path.join(owner.root, ".pi-sync-state-migration.lock");
    const release = await lockfile.lock(owner.root, { realpath: false, lockfilePath: migration });
    const lock = lockfile.lock.bind(lockfile);
    const tried = Promise.withResolvers<void>();
    const acquire = vi.spyOn(lockfile, "lock").mockImplementation((...args) => {
      if (args[1]?.lockfilePath === migration) tried.resolve();
      return lock(...args);
    });
    const controller = new AbortController();
    const canonical = path.join(owner.root, "pi-sync");
    const result = assert.rejects(
      ensureDaemon(owner.root, controller.signal),
      /revoke unattended Pi Sync permission/iu,
    );
    void result.catch(() => {});
    try {
      await beforeStartupSettles(tried.promise, "the migration guard attempt", result);
      await fs.rename(legacy, canonical);
    } finally {
      await release();
      acquire.mockRestore();
    }
    try {
      await result;
      assert.equal(await readUpgradeOwner(owner.paths), undefined);
      assert.equal(await fs.readFile(path.join(canonical, "daemon.json"), "utf8"), consent);
      assert.equal((await readIdentity(owner.paths))?.pid, owner.identity.pid);
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
  }, "upgrade"));

function connection(owner: Awaited<ReturnType<typeof createOwner>>, event?: () => void) {
  return new DaemonConnection(
    owner.paths,
    owner.identity,
    {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd: owner.root,
      mode: "rpc",
      hasUI: true,
      idle: true,
    },
    { callback: async () => true, event },
  );
}

for (const mode of ["closing", "drop-detach"] as const)
  test(`a real unpublished attach preserves its stopping marker after ${mode} cleanup`, () =>
    fixture(async (owner) => {
      const client = connection(owner);
      await assert.rejects(client.attach(), (error: unknown) => {
        assert.ok(error instanceof DaemonError);
        assert.equal(error.remote.name, "DaemonStoppingError");
        if (mode === "closing") assert.ok(error.cause instanceof DaemonError);
        else assert.equal((error.cause as NodeJS.ErrnoException).code, "ECONNRESET");
        return true;
      });
      await client.dispose().catch(() => {});
      await owner.unchanged();
    }, mode));

for (const mode of ["attached", "generic-attach", "admitted-event"] as const)
  test(`failed attach cleanup remains an AggregateError for ${mode} ownership`, () =>
    fixture(async (owner) => {
      const client = connection(
        owner,
        mode === "admitted-event"
          ? () => {
              throw new DaemonError({ name: "DaemonStoppingError", message: "application event failed" });
            }
          : undefined,
      );
      if (mode === "attached") await client.attach();
      await assert.rejects(
        client.attach(),
        (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
      );
      await client.dispose().catch(() => {});
      await owner.unchanged();
    }, mode));

test("observed queue callbacks prevent treating a rejected first attach as grant-free", () =>
  fixture(async (owner) => {
    const entered = Promise.withResolvers<void>();
    const client = new DaemonConnection(
      owner.paths,
      owner.identity,
      {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: owner.root,
        mode: "rpc",
        hasUI: true,
        idle: true,
      },
      {
        callback: async (_callback, signal) => {
          entered.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return true;
        },
      },
    );
    const attached = client.attach();
    const rejected = assert.rejects(attached, (error: unknown) => error instanceof AggregateError);
    await entered.promise;
    await owner.command("reject");
    await rejected;
    await client.dispose().catch(() => {});
    await owner.unchanged();
  }, "callbacks"));

test("startup cancellation interrupts a stalled existing-owner handshake without launching", () =>
  fixture(async (owner) => {
    const controller = new AbortController();
    const hello = message(owner.child, "hello");
    const connecting = ensureDaemon(owner.root, controller.signal);
    const rejected = assert.rejects(connecting, { name: "AbortError" });
    try {
      assert.equal((await hello).authenticated, true);
      controller.abort();
      await rejected;
      await owner.unchanged();
    } finally {
      controller.abort();
      await connecting.catch(() => {});
    }
  }, "silent"));

test("waitForDaemonExit cancels without treating a live recorded PID as exited", () =>
  fixture(async (owner) => {
    const controller = new AbortController();
    const waiting = waitForDaemonExit(owner.identity, controller.signal);
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    try {
      await owner.command("probe");
      controller.abort();
      await rejected;
      await assert.rejects(waitForDaemonExit(owner.identity, controller.signal), { name: "AbortError" });
      await owner.unchanged();
    } finally {
      controller.abort();
      await waiting.catch(() => {});
    }
  }));

test("the 30-second exit-wait deadline never replaces a still-live owner", () =>
  fixture(async (owner) => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000);
    try {
      await assert.rejects(waitForDaemonExit(owner.identity), /Closing daemon is still alive/u);
      await owner.unchanged();
    } finally {
      clock.mockRestore();
    }
  }));

test("waitForDaemonExit completes after the recorded child actually exits", () =>
  fixture(async (owner) => {
    const controller = new AbortController();
    const waiting = waitForDaemonExit(owner.identity, controller.signal);
    try {
      await terminate(owner.child);
      await waiting;
      assert.equal(processExists(owner.identity.pid), false);
      assert.deepEqual(await fs.readFile(owner.paths.identity), owner.identityBytes);
      await owner.preserved();
    } finally {
      controller.abort();
      await waiting.catch(() => {});
    }
  }));

test("ensureDaemon cancels a closing-owner wait even after the socket closes, without launching", () =>
  fixture(async (owner) => {
    const controller = new AbortController();
    const hello = message(owner.child, "hello");
    const connecting = ensureDaemon(owner.root, controller.signal);
    const rejected = assert.rejects(connecting, { name: "AbortError" });
    try {
      assert.equal((await hello).authenticated, true);
      await owner.command("close");
      await owner.command("probe");
      controller.abort();
      await rejected;
      await owner.unchanged();
    } finally {
      controller.abort();
      await connecting.catch(() => {});
    }
  }));

test("confirmed closing-owner exit permits one replacement for simultaneous public clients", () =>
  fixture(async (owner) => {
    const controller = new AbortController();
    const hello = message(owner.child, "hello");
    const attempts = [ensureDaemon(owner.root, controller.signal), ensureDaemon(owner.root, controller.signal)];
    const connected = Promise.all(attempts);
    void connected.catch(() => {});
    let settled = false;
    void connected.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      assert.equal((await hello).authenticated, true);
      await owner.command("close");
      await owner.command("probe");
      assert.equal(settled, false);
      assert.deepEqual(await fs.readFile(owner.paths.identity), owner.identityBytes);
      assert.equal(processExists(owner.identity.pid), true);
      await owner.preserved();
      await terminate(owner.child);
      assert.equal(processExists(owner.identity.pid), false);
      const [first, second] = await connected;
      assert.deepEqual(first.identity, second.identity);
      assert.notEqual(first.identity.instance, owner.identity.instance);
      assert.notEqual(first.identity.pid, owner.identity.pid);
      assert.equal(processExists(first.identity.pid), true);
      assert.equal((await findDaemon(owner.root))?.identity.instance, first.identity.instance);
      assert.equal(
        ((await requestDaemon(first.paths, first.identity, "hello", {})) as { pid: number }).pid,
        first.identity.pid,
      );
      await owner.preserved();
    } finally {
      controller.abort();
      await Promise.allSettled(attempts);
    }
  }));

for (const mode of ["generic", "incompatible", "malformed", "unauthorized"] as const) {
  test(`a live ${mode} owner fails closed without a launch or state changes`, () =>
    fixture(async (owner) => {
      await assert.rejects(ensureDaemon(owner.root), /owner is alive but unavailable/u);
      await assert.rejects(findDaemon(owner.root));
      await owner.unchanged();
    }, mode));
}

test("an incompatible identity file fails closed and retains its exact bytes", () =>
  fixture(async (owner) => {
    const bytes = Buffer.from(`${JSON.stringify({ ...owner.identity, version: 2 })}\n`);
    await fs.writeFile(owner.paths.identity, bytes, { mode: 0o600 });
    await assert.rejects(ensureDaemon(owner.root), /incompatible daemon identity/u);
    await assert.rejects(findDaemon(owner.root), /incompatible daemon identity/u);
    assert.deepEqual(await fs.readFile(owner.paths.identity), bytes);
    assert.deepEqual(await fs.readdir(owner.paths.directory), ["identity.json"]);
    assert.equal(processExists(owner.identity.pid), true);
    await owner.preserved();
  }));

test("an unreachable live owner fails closed without a launch or state changes", () =>
  fixture(async (owner) => {
    await owner.command("close");
    await assert.rejects(ensureDaemon(owner.root), /owner is alive but unavailable/u);
    await assert.rejects(findDaemon(owner.root));
    await owner.unchanged();
  }));

test("passive findDaemon reports a recognized closing owner as absent and never launches", () =>
  fixture(async (owner) => {
    const hello = message(owner.child, "hello");
    assert.equal(await findDaemon(owner.root), undefined);
    assert.equal((await hello).authenticated, true);
    await owner.unchanged();
    await terminate(owner.child);
    assert.equal(await findDaemon(owner.root), undefined);
    assert.deepEqual(await fs.readFile(owner.paths.identity), owner.identityBytes);
    await owner.preserved();
  }));
