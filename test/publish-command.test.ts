import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, type TestContext, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const script = "../scripts/publish-command.mjs";
const { runPublishCommand } = await import(script);
const spawnMock = vi.mocked(spawn);
const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;
const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockClear();
});

// Every command is a local Node child. Control sockets provide readiness and signal handshakes.
const actor = String.raw`
import { spawn } from "node:child_process";
import { connect } from "node:net";
const [port, role, descendantStdio, source] = process.argv.slice(1);
const socket = connect(Number(port), "127.0.0.1");
socket.setEncoding("utf8");
socket.on("error", () => process.exit(91));
const report = (event) => socket.write(role + ":" + process.pid + ":" + event + "\n");
if (!descendantStdio) process.on("SIGTERM", () => report("term"));
if (descendantStdio) {
  const descendant = spawn(process.execPath, ["--input-type=module", "-e", source, port, "descendant", ""], {
    stdio: descendantStdio === "pipe" ? ["ignore", "inherit", "inherit"] : "ignore",
  });
  descendant.unref();
}
socket.once("connect", () => report("ready"));
let input = "";
socket.on("data", (data) => {
  input += data;
  if (input.includes("finish\n")) socket.end(() => process.exit(0));
});
`;

type Peer = { socket: Socket; pid: number; closed: Promise<void> };

async function controlledChild(
  t: TestContext,
  {
    signal,
    capture = true,
    descendant,
  }: { signal?: AbortSignal; capture?: boolean; descendant?: "pipe" | "ignore" } = {},
) {
  const events = new Map<string, ReturnType<typeof Promise.withResolvers<Peer>>>();
  const event = (key: string) => {
    let pending = events.get(key);
    if (!pending) {
      pending = Promise.withResolvers<Peer>();
      events.set(key, pending);
    }
    return pending;
  };
  const peers: Peer[] = [];
  const server = createServer((socket) => {
    const peer = { socket, pid: 0, closed: new Promise<void>((resolve) => socket.once("close", resolve)) };
    peers.push(peer);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let input = "";
    socket.on("data", (data) => {
      input += data;
      let newline = input.indexOf("\n");
      while (newline !== -1) {
        const [role, pid, name] = input.slice(0, newline).split(":");
        input = input.slice(newline + 1);
        peer.pid = Number(pid);
        event(`${role}:${name}`).resolve(peer);
        newline = input.indexOf("\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const running = runPublishCommand(
    process.execPath,
    ["--input-type=module", "-e", actor, String(address.port), "child", descendant ?? "", actor],
    { signal, capture },
  );
  // Observe rejection immediately; individual assertions can attach after readiness.
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const child = spawnMock.mock.results.at(-1)?.value as ChildProcess;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const terminate = () => {
    const kill = (pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    if (signal && process.platform !== "win32" && child.pid) kill(-child.pid);
    if (child.pid && child.exitCode === null && child.signalCode === null) kill(child.pid);
    for (const peer of peers) if (peer.pid && !peer.socket.destroyed) kill(peer.pid);
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  t.onTestFinished(async () => {
    nativeClearTimeout(deadline);
    terminate();
    for (const peer of peers) peer.socket.destroy();
    await closed;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const leader = await event("child:ready").promise;
  const follower = descendant ? await event("descendant:ready").promise : undefined;
  const safety = Promise.withResolvers<never>();
  // Startup is outside the assertion deadline. Never use a sleep to synchronize children.
  deadline = nativeSetTimeout(() => {
    terminate();
    safety.reject(new Error("Publish command did not complete after readiness"));
  }, 3_000);
  void safety.promise.catch(() => {});
  return {
    child,
    leader,
    follower,
    running,
    settled: () => settled,
    waitFor: (key: string) => Promise.race([event(key).promise, safety.promise]),
    until: <T>(work: Promise<T>) => Promise.race([work, safety.promise]),
    finish: () => leader.socket.write("finish\n"),
  };
}

function assertReleased(child: ChildProcess, signal: AbortSignal) {
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout?.listenerCount("data") ?? 0, 0);
  assert.equal(child.stderr?.listenerCount("data") ?? 0, 0);
  assert.equal(vi.getTimerCount(), 0);
}

for (const code of [0, 7]) {
  test(`captures stdout/stderr and returns exit code ${code}`, async (t) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "publish-command-")));
    t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const controller = new AbortController();
    const result = await runPublishCommand(
      process.execPath,
      [
        "-e",
        `process.stdout.write(process.cwd()); process.stderr.write("metadata error"); process.exitCode = ${code};`,
      ],
      { cwd, capture: true, signal: controller.signal },
    );
    assert.deepEqual(result, { code, stdout: cwd, stderr: "metadata error" });
    const child = spawnMock.mock.results.at(-1)?.value as ChildProcess;
    assertReleased(child, controller.signal);
    assert.equal(spawnMock.mock.calls[0]?.[2]?.detached, process.platform !== "win32");
    assert.equal(spawnMock.mock.calls[0]?.[2]?.signal, undefined);
  });
}

test("native commands inherit stdio and have no deadline or process group", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await controlledChild(t, { capture: false });
  const options = spawnMock.mock.calls[0]?.[2];
  assert.equal(options?.stdio, "inherit");
  assert.equal(options?.detached, false);
  assert.equal(options?.signal, undefined);
  assert.equal(f.child.stdout, null);
  assert.equal(f.child.stderr, null);
  assert.equal(vi.getTimerCount(), 0);
  vi.advanceTimersByTime(31_000);
  assert.equal(f.settled(), false);
  f.finish();
  assert.deepEqual(await f.until(f.running), { code: 0, stdout: "", stderr: "" });
  assert.equal(vi.getTimerCount(), 0);
});

test("spawn errors reject only after close and release signal listeners", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const running = runPublishCommand(process.execPath, ["-e", ""], {
    cwd: path.join(tmpdir(), `publish-command-missing-${crypto.randomUUID()}`),
    capture: true,
    signal: controller.signal,
  });
  const child = spawnMock.mock.results.at(-1)?.value as ChildProcess;
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  await assert.rejects(running, { code: "ENOENT" });
  assert.equal(closed, true);
  assertReleased(child, controller.signal);
});

test("synchronous spawn validation errors leave no listeners or timers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  await assert.rejects(runPublishCommand(process.execPath, ["\0"], { signal: controller.signal }), TypeError);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("pre-aborted input rejects with its reason without spawning", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const reason = new Error("Registry deadline");
  controller.abort(reason);
  await assert.rejects(runPublishCommand(process.execPath, ["-e", ""], { signal: controller.signal }), (error) => {
    assert.equal(error, reason);
    return true;
  });
  assert.equal(spawnMock.mock.calls.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

posixTest("abort sends group SIGTERM and waits for close, not an early abort error", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const kill = vi.spyOn(process, "kill");
  const controller = new AbortController();
  const reason = new Error("Registry deadline");
  const f = await controlledChild(t, { signal: controller.signal });
  controller.abort(reason);
  await f.waitFor("child:term");
  assert.equal(f.settled(), false);
  assert.ok(kill.mock.calls.some(([pid, signal]) => pid === -(f.child.pid ?? 0) && signal === "SIGTERM"));
  assert.equal(vi.getTimerCount(), 1);
  f.finish();
  await f.until(assert.rejects(f.running, (error) => error === reason));
  assert.equal(f.child.exitCode, 0);
  assertReleased(f.child, controller.signal);
});

posixTest("a child ignoring SIGTERM is killed only after the fixed 1000ms grace", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const f = await controlledChild(t, { signal: controller.signal });
  controller.abort();
  await f.waitFor("child:term");
  vi.advanceTimersByTime(999);
  assert.equal(f.settled(), false);
  assert.equal(f.child.signalCode, null);
  assert.equal(vi.getTimerCount(), 1);
  vi.advanceTimersByTime(1);
  await f.until(assert.rejects(f.running, (error) => error === controller.signal.reason));
  assert.equal(f.child.signalCode, "SIGKILL");
  assertReleased(f.child, controller.signal);
});

posixTest("abort kills a descendant holding stdio after its leader has already exited", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const f = await controlledChild(t, { signal: controller.signal, descendant: "pipe" });
  const exited = once(f.child, "exit");
  f.finish();
  assert.deepEqual(await f.until(exited), [0, null]);
  assert.equal(f.settled(), false);
  controller.abort();
  await f.waitFor("descendant:term");
  assert.equal(f.settled(), false);
  vi.advanceTimersByTime(1_000);
  await f.until(assert.rejects(f.running, (error) => error === controller.signal.reason));
  await f.until(f.follower?.closed ?? Promise.reject(new Error("Missing descendant")));
  assertReleased(f.child, controller.signal);
});

posixTest("leader close cannot cancel escalation for a descendant without captured pipes", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const f = await controlledChild(t, { signal: controller.signal, descendant: "ignore" });
  const closed = once(f.child, "close");
  controller.abort();
  await f.waitFor("descendant:term");
  await f.until(closed);
  assert.equal(f.settled(), false);
  assert.equal(vi.getTimerCount(), 1);
  vi.advanceTimersByTime(1_000);
  await f.until(assert.rejects(f.running, (error) => error === controller.signal.reason));
  await f.until(f.follower?.closed ?? Promise.reject(new Error("Missing descendant")));
  assertReleased(f.child, controller.signal);
});

posixTest("normal registry completion also releases descendants without captured pipes", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const f = await controlledChild(t, { signal: controller.signal, descendant: "ignore" });
  const closed = once(f.child, "close");
  f.finish();
  await f.waitFor("descendant:term");
  await f.until(closed);
  assert.equal(f.settled(), false);
  vi.advanceTimersByTime(1_000);
  assert.deepEqual(await f.until(f.running), { code: 0, stdout: "", stderr: "" });
  await f.until(f.follower?.closed ?? Promise.reject(new Error("Missing descendant")));
  assertReleased(f.child, controller.signal);
});

posixTest("repeated aborts do not add timers or retain listeners across commands", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController();
    const f = await controlledChild(t, { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort();
    await f.waitFor("child:term");
    controller.abort();
    controller.signal.dispatchEvent(new Event("abort"));
    assert.equal(vi.getTimerCount(), 1);
    f.finish();
    await f.until(assert.rejects(f.running, (error) => error === controller.signal.reason));
    assertReleased(f.child, controller.signal);
    controller.signal.dispatchEvent(new Event("abort"));
    assert.equal(vi.getTimerCount(), 0);
  }
});
