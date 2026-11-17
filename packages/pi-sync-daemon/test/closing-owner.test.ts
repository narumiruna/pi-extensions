import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
  DaemonConnection,
  DaemonError,
  ensureDaemon,
  findDaemon,
  requestDaemon,
  waitForDaemonExit,
} from "../dist/client.js";
import {
  daemonPaths,
  privateDirectory,
  processExists,
  publishIdentity,
  readIdentity,
  runtimePaths,
} from "../src/identity.js";
import type { Identity } from "../src/protocol.js";

// The child owns the socket and stays alive after transport closure until explicitly released.
// IPC, not a wall-clock delay, controls each closing-owner race.
const ownerProgram = `
import { createServer } from "node:http";
const { endpoint, identity, mode } = JSON.parse(process.argv[1]);
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
process.on("message", (message) => {
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
  | "callbacks";

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

async function fixture(run: (owner: Awaited<ReturnType<typeof createOwner>>) => Promise<void>, mode: Mode = "closing") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-closing-")));
  const paths = await runtimePaths(root);
  let owner: Awaited<ReturnType<typeof createOwner>> | undefined;
  try {
    owner = await createOwner(root, mode);
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

async function createOwner(root: string, mode: Mode) {
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
        mode,
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
    const command = async (type: "probe" | "close" | "reject") => {
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
