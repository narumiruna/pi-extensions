import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { FleetControllerDependencies } from "../src/fleet-controller.js";
import { createPiFleetExtension } from "../src/pi-fleet.js";
import { createGroup, formatInvite } from "../src/protocol.js";
import { DEFAULT_FLEET_SETTINGS, type FleetSettingsRuntime, type FleetSettingsState } from "../src/settings.js";

function dependencies(): FleetControllerDependencies {
  return {
    createTransport: (options) => ({
      start: async () => undefined,
      stop: async () => undefined,
      listPeers: async () => [],
      send: async () => ({ accepted: true, duplicate: false }),
      setAcceptsRequests: (value) => {
        options.peer.acceptsRequests = value;
      },
      get peerDescription() {
        return { ...options.peer, endpointId: "a".repeat(24) };
      },
      endpointManifest: {
        directory: "/tmp/pi-fleet-test",
        socketPath: "/tmp/pi-fleet-test/endpoint.sock",
        manifestPath: "/tmp/pi-fleet-test/endpoint.json",
      },
    }),
    createTmux: () => ({
      assertAvailable: async () => "3.4",
      spawnSplit: async () => ({ terminalId: "%42", version: "3.4" }),
    }),
    createGhostty: () => ({
      assertAvailable: async () => "1.3.1",
      spawnSplit: async () => ({ terminalId: "child", version: "1.3.1" }),
    }),
    createZellij: () => ({
      assertAvailable: async () => "0.44.3",
      spawnSplit: async () => ({ terminalId: "terminal_42", version: "0.44.3" }),
    }),
    resolveInvocation: () => ({ command: "/bin/pi", args: [] }),
    createLauncher: async () => ({
      path: "/tmp/launch.sh",
      command: "/tmp/launch.sh",
      cleanup: async () => undefined,
    }),
    realpath: async (value) => value,
    isDirectory: async () => true,
    now: Date.now,
    randomId: (prefix) => `${prefix}_1234567890abcdef`,
    sleep: async () => undefined,
    launchTimeoutMs: 1,
    environment: {},
  };
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

test("extension registers its command, tools, renderer, and lifecycle without factory resources", async () => {
  const mock = createMockPi();
  const settings = memorySettingsRuntime();
  let menuLoads = 0;
  createPiFleetExtension({
    controllerDependencies: dependencies(),
    settingsRuntime: settings,
    loadMenu: async () => {
      menuLoads += 1;
      return { showFleetMenu: async () => undefined };
    },
  })(mock.pi);
  assert.ok(mock.commands.get("fleet"));
  assert.deepEqual(
    mock.tools.map(({ name }) => name),
    ["session_spawn", "session_bus"],
  );
  assert.ok(mock.messageRenderers.get("pi-fleet-message"));
  assert.equal(menuLoads, 0);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await emit(mock, "session_start", { reason: "startup" }, context.ctx);
  assert.equal(menuLoads, 0);
  assert.equal(settings.calls.reload, 1);
  await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
  assert.equal(settings.calls.flush, 1);
});

test("fleet menu loads on demand, caches success, retries failure, and suppresses stale loads", async () => {
  const mock = createMockPi();
  let loads = 0;
  let shows = 0;
  let release: (() => void) | undefined;
  createPiFleetExtension({
    controllerDependencies: dependencies(),
    settingsRuntime: memorySettingsRuntime(),
    loadMenu: async () => {
      loads += 1;
      if (loads === 1) throw new Error("temporary menu failure");
      if (loads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        showFleetMenu: async () => {
          shows += 1;
        },
      };
    },
  })(mock.pi);
  const first = createMockContext({ mode: "tui", hasUI: true });
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  const command = mock.commands.get("fleet");
  assert.ok(command);
  await assert.rejects(Promise.resolve(command.handler("", first.ctx)), /temporary menu failure/u);
  const pending = command.handler("", first.ctx);
  await Promise.resolve();
  await emit(mock, "session_shutdown", { reason: "new" }, first.ctx);
  const second = createMockContext({ mode: "tui", hasUI: true });
  await emit(mock, "session_start", { reason: "new" }, second.ctx);
  release?.();
  await pending;
  assert.equal(shows, 0);
  await command.handler("", second.ctx);
  await command.handler("", second.ctx);
  assert.equal(loads, 2);
  assert.equal(shows, 2);
  await emit(mock, "session_shutdown", { reason: "quit" }, second.ctx);
});

test("direct invite joins in TUI and RPC but rejects unknown, trailing, JSON, and print input", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const mock = createMockPi();
    createPiFleetExtension({
      controllerDependencies: dependencies(),
      settingsRuntime: memorySettingsRuntime(),
    })(mock.pi);
    const context = createMockContext({ mode, hasUI: true, confirm: async () => true });
    await emit(mock, "session_start", { reason: "startup" }, context.ctx);
    const command = mock.commands.get("fleet");
    assert.ok(command);
    const invite = formatInvite(createGroup(Buffer.alloc(32, 12)).secret);
    await command.handler(invite, context.ctx);
    assert.match(context.notifications.at(-1)?.message ?? "", /joined/iu);
    assert.equal(JSON.stringify(context.notifications).includes(invite), false);
    await assert.rejects(Promise.resolve(command.handler(`${invite} trailing`, context.ctx)), /Usage/u);
    await assert.rejects(Promise.resolve(command.handler("unknown", context.ctx)), /Usage/u);
    await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
  }
  for (const mode of ["json", "print"] as const) {
    const mock = createMockPi();
    createPiFleetExtension({
      controllerDependencies: dependencies(),
      settingsRuntime: memorySettingsRuntime(),
    })(mock.pi);
    const context = createMockContext({ mode, hasUI: false });
    await emit(mock, "session_start", { reason: "startup" }, context.ctx);
    const command = mock.commands.get("fleet");
    assert.ok(command);
    await assert.rejects(Promise.resolve(command.handler("", context.ctx)), /unavailable.*mode/iu);
    assert.equal(context.notifications.length, 0);
    await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
  }
});

function memorySettingsRuntime(): FleetSettingsRuntime & {
  calls: { reload: number; flush: number };
} {
  const state: FleetSettingsState = {
    settings: { ...DEFAULT_FLEET_SETTINGS },
    sources: { defaultTerminal: "built-in", confirmSessionLaunch: "built-in" },
    canSave: true,
  };
  const calls = { reload: 0, flush: 0 };
  return {
    calls,
    get: () => state,
    getPath: () => "/tmp/pi-fleet.json",
    reload: async () => {
      calls.reload += 1;
      return state;
    },
    update: async () => state,
    flush: async () => {
      calls.flush += 1;
    },
  };
}
