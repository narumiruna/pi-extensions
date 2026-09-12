import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineInterface, sessionBus } from "dbus-native";
import caffeinate from "/smoke/build/caffeinate.js";
import { defaultDbusScreenSaverFactory } from "/smoke/build/dbus-inhibit.js";

const BUS_NAME = "org.freedesktop.ScreenSaver";
const INTERFACE = "org.freedesktop.ScreenSaver";
const STANDARD_PATH = "/org/freedesktop/ScreenSaver";
const NIRI_PATH = "/ScreenSaver";
const scenarios = [];

await runScenario("missing ScreenSaver service rejects without leaking the client", async () => {
  const client = await defaultDbusScreenSaverFactory();
  await assert.rejects(client.inhibit("missing service"), /D-Bus idle inhibit failed/u);
  await client.close();
});

const service = await createScreenSaverService();
try {
  await runScenario("standard ScreenSaver path acquires and releases its cookie", async () => {
    service.expose(STANDARD_PATH);
    const client = await defaultDbusScreenSaverFactory();
    await client.inhibit("standard path");
    await client.uninhibit();
    await client.close();
    assert.deepEqual(service.takeCalls(), [
      { member: "Inhibit", path: STANDARD_PATH, application: "pi-caffeinate" },
      { member: "UnInhibit", path: STANDARD_PATH, cookie: 1 },
    ]);
  });

  await runScenario("niri ScreenSaver path is used after the standard path is absent", async () => {
    service.expose(NIRI_PATH);
    const client = await defaultDbusScreenSaverFactory();
    await client.inhibit("niri path");
    await client.uninhibit();
    await client.close();
    assert.deepEqual(service.takeCalls(), [
      { member: "Inhibit", path: NIRI_PATH, application: "pi-caffeinate" },
      { member: "UnInhibit", path: NIRI_PATH, cookie: 2 },
    ]);
  });

  await runScenario("D-Bus-only activation is partial and agent_end cancels pending acquisition", async () => {
    service.expose(NIRI_PATH);
    service.mode = "success";
    const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-caffeinate-docker-agent-"));
    const emptyPath = path.join(agentDir, "empty-path");
    mkdirSync(emptyPath);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = emptyPath;
    try {
      const runtime = createExtensionRuntime();
      await runtime.emit("session_start", { reason: "startup" });
      await runtime.emit("agent_start", {});
      assert.equal(runtime.statuses.get("caffeinate"), "display-awake");
      assert.equal(runtime.notifications[0]?.level, "warning");
      assert.match(runtime.notifications[0]?.message ?? "", /partially active/u);
      assert.match(runtime.notifications[0]?.message ?? "", /system sleep inhibitor/iu);
      await runtime.emit("agent_end", {});
      assert.equal(runtime.statuses.get("caffeinate"), undefined);
      assert.equal(
        service.takeCalls().some(({ member }) => member === "UnInhibit"),
        true,
      );

      service.mode = "hang";
      const observedInhibit = service.nextInhibit();
      const start = runtime.emit("agent_start", {});
      await withDeadline(observedInhibit, 1_000, "in-flight Inhibit was not observed");
      await withDeadline(runtime.emit("agent_end", {}), 1_000, "agent_end did not cancel Inhibit");
      await withDeadline(start, 1_000, "cancelled agent_start did not settle");
      service.mode = "success";
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
} finally {
  await service.close();
}

await runScenario("unreachable session-bus socket rejects without crashing Node", async () => {
  const result = spawnSync(process.execPath, ["/smoke/pi-caffeinate/test/docker/stale-socket-probe.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/pi-caffeinate-missing-session-bus.sock",
    },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /caught: D-Bus idle inhibit failed/u);
});

process.stdout.write(`${JSON.stringify({ passed: true, scenarios })}\n`);

async function runScenario(name, operation) {
  await operation();
  scenarios.push(name);
  process.stdout.write(`ok - ${name}\n`);
}

async function createScreenSaverService() {
  const bus = sessionBus();
  let closing = false;
  bus.connection.on("error", (error) => {
    if (!closing) throw error;
  });
  const requestResult = await bus.requestName(BUS_NAME, 0);
  assert.ok(requestResult === 1 || requestResult === 4);

  let mode = "success";
  let activePath;
  let nextCookie = 1;
  let calls = [];
  const inhibitWaiters = [];
  const definition = defineInterface({
    name: INTERFACE,
    methods: {
      Inhibit: {
        in: { application: "s", reason: "s" },
        out: { cookie: "u" },
        handler: ({ application }, context) => {
          const call = { member: "Inhibit", path: context.path, application };
          calls.push(call);
          inhibitWaiters.shift()?.(call);
          if (mode === "hang") return new Promise(() => undefined);
          return nextCookie++;
        },
      },
      UnInhibit: {
        in: { cookie: "u" },
        handler: ({ cookie }, context) => {
          calls.push({ member: "UnInhibit", path: context.path, cookie });
        },
      },
    },
  });

  return {
    get mode() {
      return mode;
    },
    set mode(value) {
      mode = value;
    },
    expose(objectPath) {
      if (activePath) bus.unexportInterface(activePath, INTERFACE);
      activePath = objectPath;
      bus.exportInterface(definition.impl, objectPath, definition.descriptor);
    },
    nextInhibit() {
      return new Promise((resolve) => inhibitWaiters.push(resolve));
    },
    takeCalls() {
      const result = calls;
      calls = [];
      return result;
    },
    async close() {
      closing = true;
      await bus.close();
    },
  };
}

function createExtensionRuntime() {
  const events = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  const pi = {
    on(type, handler) {
      const handlers = events.get(type) ?? [];
      handlers.push(handler);
      events.set(type, handlers);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message, level = "info") {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };
  caffeinate(pi);
  return {
    notifications,
    statuses,
    async emit(type, event) {
      for (const handler of events.get(type) ?? []) await handler(event, ctx);
    },
  };
}

async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
