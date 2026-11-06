import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const compiledRoot = resolve("node_modules/.cache/pi-extensions-test");

// Use emitted modules in a plain Node child: the test worker's own handles would hide exit blockers.
const probe = String.raw`
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const [kind, root] = process.argv.slice(1);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const load = (path) => import(pathToFileURL(join(root, path)).href);
const timers = [];
for (const name of ["setTimeout", "setInterval"]) {
  const original = globalThis[name];
  globalThis[name] = (callback, delay, ...args) => {
    const timer = original(callback, delay, ...args);
    timers.push({ timer, delay });
    return timer;
  };
}
const { createMockContext, createMockPi } = await load("test/support.js");
const context = createMockContext({ mode: "tui", cwd: agentDir });

if (kind === "starship") {
  await writeFile(join(agentDir, "pi-starship.toml"), "format = 'status'\n");
  const { default: starship } = await load("packages/pi-starship/src/pi-starship.js");
  const mock = createMockPi();
  starship(mock.pi);
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  assert.equal(typeof context.footer, "function");
  context.footer({ requestRender() {} }, {}, {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  });
} else if (kind === "tool") {
  const { createActiveToolStatusController } = await load("packages/pi-tool/src/active-tool-status.js");
  const mock = createMockPi({ activeTools: ["read"] });
  createActiveToolStatusController(mock.pi).start(context.ctx, true);
} else if (kind === "sync") {
  const { v3S3Settings } = await load("packages/pi-sync/test/helpers.js");
  const { localConfigPath } = await load("packages/pi-sync/src/settings/config-file.js");
  await writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
  const { createStartupCheck } = await load("packages/pi-sync/src/sync/startup-check.js");
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const check = createStartupCheck({
    inspection: () => {
      entered();
      return new Promise(() => {});
    },
  }, {});
  check.start(context.ctx, new AbortController().signal);
  await waiting;
} else if (kind === "fleet") {
  const { createGroup, FLEET_PROTOCOL_VERSION } = await load("packages/pi-fleet/src/protocol.js");
  const { FleetTransport } = await load("packages/pi-fleet/src/transport.js");
  const transport = new FleetTransport({
    group: createGroup(Buffer.alloc(32, 24)),
    baseDirectory: agentDir,
    peer: {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      sessionId: "passive-exit", name: "passive-exit", cwd: agentDir,
      pid: process.pid, acceptsRequests: false,
    },
    onMessage() {},
  });
  await transport.start();
  assert.ok(transport.endpointManifest);
} else if (kind === "herdr") {
  const { openHerdrSubscription } = await load("packages/pi-herdr/src/herdr-client.js");
  const endpoint = join(agentDir, "herdr.sock");
  const server = createServer((socket) => {
    // This fake external peer must not itself keep the probe alive.
    socket.unref();
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]);
      socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  server.unref();
  await openHerdrSubscription(endpoint, { id: "idle", method: "events.subscribe", params: {} },
    new AbortController().signal, () => {});
} else if (kind === "goal-wakeup") {
  const { GoalWaitTimer } = await load("packages/pi-goal/src/wait.js");
  new GoalWaitTimer().schedule(Date.now() + 50, () => process.stdout.write("woke\n"));
} else {
  throw new Error("Unknown probe: " + kind);
}

if (kind !== "fleet" && kind !== "herdr") {
  const delay = { starship: 30000, tool: 500, sync: 30000 }[kind];
  const owned = kind === "goal-wakeup" ? timers.at(-1) : timers.find((record) => record.delay === delay);
  assert.ok(owned, "Expected an armed timer");
  assert.equal(owned.timer.hasRef(), kind === "goal-wakeup");
}
process.send("ready");
process.disconnect();
// Do not call session_shutdown, dispose(), process.exit(), or clear the owned timer.
`;

for (const kind of ["starship", "tool", "sync", "fleet", "herdr", "goal-wakeup"]) {
  const run = process.platform === "win32" && (kind === "fleet" || kind === "herdr") ? test.skip : test;
  run(`${kind}: background work permits natural exit; accepted wakeups still finish`, async (t) => {
    // These probes test handle ownership, not the Unix socket path limit.
    const shortPath = process.platform !== "win32" && (kind === "fleet" || kind === "herdr");
    const directory = await mkdtemp(
      join(shortPath ? await realpath("/tmp") : tmpdir(), shortPath ? "pi-bg-" : "pi-background-timer-exit-"),
    );
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe, kind, compiledRoot], {
      cwd: directory,
      env: { ...process.env, PI_CODING_AGENT_DIR: directory },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
    let output = "";
    t.onTestFinished(async () => {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true, force: true });
    });
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });

    await new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.on("message", (message) => {
        if (message !== "ready" || ready) return;
        ready = true;
        // Import/startup cost is outside this exit deadline.
        deadline = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${kind} retained the process after readiness.\n${output}`));
        }, 1_000);
      });
      child.once("close", (code, signal) => {
        clearTimeout(deadline);
        if (ready && code === 0 && (kind !== "goal-wakeup" || output.includes("woke\n"))) resolveExit();
        else reject(new Error(`${kind} failed (ready=${ready}, code=${code}, signal=${signal}).\n${output}`));
      });
    });
    assert.equal(ready, true);
  });
}
