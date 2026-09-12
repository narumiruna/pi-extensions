import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  FleetController,
  type FleetControllerDependencies,
  type FleetTerminalPort,
  type FleetTransportPort,
  type SpawnSessionInput,
} from "../src/fleet-controller.js";
import type { FleetMessage, FleetPeerDescription } from "../src/protocol.js";
import {
  DEFAULT_FLEET_SETTINGS,
  type FleetSettings,
  type FleetSettingsPatch,
  type FleetSettingsRuntime,
  type FleetSettingsState,
} from "../src/settings.js";
import { TmuxLaunchError } from "../src/tmux.js";
import type { FleetDeliveryAck, FleetSendAuthorization, FleetTransportOptions } from "../src/transport.js";
import { ZellijLaunchError } from "../src/zellij.js";

class SpawnTransport implements FleetTransportPort {
  peers: FleetPeerDescription[] = [];
  messages: FleetMessage[] = [];
  authorizations: Array<FleetSendAuthorization | undefined> = [];
  stopped = 0;
  beforeList?: () => void;
  readonly endpointManifest = {
    directory: "/tmp/pi-fleet-spawn-test",
    socketPath: "/tmp/pi-fleet-spawn-test/endpoint.sock",
    manifestPath: "/tmp/pi-fleet-spawn-test/endpoint.json",
  };
  constructor(readonly options: FleetTransportOptions) {}
  async start() {}
  async stop() {
    this.stopped += 1;
  }
  async listPeers() {
    this.beforeList?.();
    return [...this.peers];
  }
  async send(
    _targetSessionId: string,
    message: FleetMessage,
    _signal?: AbortSignal,
    authorization?: FleetSendAuthorization,
  ): Promise<FleetDeliveryAck> {
    this.messages.push(message);
    this.authorizations.push(authorization);
    return { accepted: true, duplicate: false };
  }
  setAcceptsRequests(value: boolean) {
    this.options.peer.acceptsRequests = value;
  }
  get peerDescription() {
    return { ...this.options.peer, endpointId: "a".repeat(24) };
  }
}

function harness(options: { ready?: boolean; launchError?: Error } = {}) {
  const mock = createMockPi();
  const transports: SpawnTransport[] = [];
  const tmuxSplitCalls: Parameters<FleetTerminalPort["spawnSplit"]>[0][] = [];
  const ghosttySplitCalls: Parameters<FleetTerminalPort["spawnSplit"]>[0][] = [];
  const zellijSplitCalls: Parameters<FleetTerminalPort["spawnSplit"]>[0][] = [];
  let now = 1_800_000_000_000;
  let tmuxCreated = 0;
  let ghosttyCreated = 0;
  let zellijCreated = 0;
  let launcherCleaned = false;
  const launcherEnvironments: Array<Readonly<Record<string, string>> | undefined> = [];
  let cleanupStateAtFirstPoll: boolean | undefined;
  let pendingPeer: FleetPeerDescription | undefined;
  const spawnSplit = async (
    terminal: "tmux" | "ghostty" | "zellij",
    spawnOptions: Parameters<FleetTerminalPort["spawnSplit"]>[0],
  ) => {
    const calls = terminal === "tmux" ? tmuxSplitCalls : terminal === "ghostty" ? ghosttySplitCalls : zellijSplitCalls;
    calls.push(spawnOptions);
    if (options.launchError) throw options.launchError;
    if (options.ready !== false) {
      const childEnvironment =
        Object.keys(spawnOptions.environment).length > 0
          ? spawnOptions.environment
          : (launcherEnvironments.at(-1) ?? {});
      pendingPeer = {
        protocolVersion: 2,
        sessionId: "child-session",
        endpointId: "b".repeat(24),
        name: childEnvironment.PI_FLEET_CHILD_NAME,
        cwd: spawnOptions.cwd,
        pid: 456,
        launchId: childEnvironment.PI_FLEET_LAUNCH_ID,
        acceptsRequests: false,
      };
    }
    return {
      terminalId: `${terminal}-child`,
      version: terminal === "tmux" ? "3.4" : terminal === "ghostty" ? "1.3.1" : "0.44.3",
    };
  };
  const deps: FleetControllerDependencies = {
    createTransport: (transportOptions) => {
      const transport = new SpawnTransport(transportOptions);
      transport.beforeList = () => {
        if (
          (tmuxSplitCalls.length > 0 || ghosttySplitCalls.length > 0 || zellijSplitCalls.length > 0) &&
          cleanupStateAtFirstPoll === undefined
        ) {
          cleanupStateAtFirstPoll = launcherCleaned;
        }
        if (pendingPeer) {
          transport.peers.push(pendingPeer);
          pendingPeer = undefined;
        }
      };
      transports.push(transport);
      return transport;
    },
    createTmux: () => {
      tmuxCreated += 1;
      return {
        assertAvailable: async () => "3.4",
        spawnSplit: (spawnOptions) => spawnSplit("tmux", spawnOptions),
      };
    },
    createGhostty: () => {
      ghosttyCreated += 1;
      return {
        assertAvailable: async () => "1.3.1",
        spawnSplit: (spawnOptions) => spawnSplit("ghostty", spawnOptions),
      };
    },
    createZellij: () => {
      zellijCreated += 1;
      return {
        assertAvailable: async () => "0.44.3",
        spawnSplit: (spawnOptions) => spawnSplit("zellij", spawnOptions),
      };
    },
    resolveInvocation: (args) => ({ command: "/bin/pi", args }),
    createLauncher: async (_invocation, _directory, environment) => {
      launcherEnvironments.push(environment);
      return {
        path: "/tmp/pi-fleet-spawn-test/launch.sh",
        command: "/tmp/pi-fleet-spawn-test/launch.sh",
        cleanup: async () => {
          launcherCleaned = true;
        },
      };
    },
    realpath: async (value) => `/real${value}`,
    isDirectory: async () => true,
    now: () => now,
    randomId: (prefix) => `${prefix}_1234567890abcdef`,
    sleep: async () => {
      now += 101;
    },
    launchTimeoutMs: 200,
    environment: {
      TMUX: "/tmp/tmux-1000/default,1234,0",
      TMUX_PANE: "%7",
    },
  };
  return {
    mock,
    deps,
    transports,
    splitCalls: tmuxSplitCalls,
    ghosttySplitCalls,
    zellijSplitCalls,
    launcherEnvironments,
    get tmuxCreated() {
      return tmuxCreated;
    },
    get ghosttyCreated() {
      return ghosttyCreated;
    },
    get zellijCreated() {
      return zellijCreated;
    },
    get launcherCleaned() {
      return launcherCleaned;
    },
    get cleanupStateAtFirstPoll() {
      return cleanupStateAtFirstPoll;
    },
  };
}

test("spawn auto-creates a group, preserves parent, inherits model, and sends kickoff", async () => {
  const runtime = harness();
  const { mock, deps, transports, splitCalls } = runtime;
  const controller = new FleetController(mock.pi, deps);
  const confirmationMessages: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    confirm: async (_title: string, message: string) => {
      confirmationMessages.push(message);
      return true;
    },
  });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const result = await controller.spawn(context.ctx, {
    direction: "down",
    name: "Child",
    task: "Check tests",
    cwd: "worktree",
  });
  assert.equal(confirmationMessages.length, 1);
  assert.equal(
    confirmationMessages.some((message) => /tmux split: down/u.test(message)),
    true,
  );
  assert.equal(transports.length, 1);
  assert.equal(splitCalls.length, 1);
  assert.equal(runtime.tmuxCreated, 1);
  assert.equal(runtime.ghosttyCreated, 0);
  assert.equal(splitCalls[0]?.direction, "down");
  assert.equal(runtime.cleanupStateAtFirstPoll, false);
  assert.equal(runtime.launcherEnvironments[0], undefined);
  assert.equal(splitCalls[0]?.cwd, "/real/project/worktree");
  assert.equal(splitCalls[0]?.environment.PI_FLEET_MODEL_PROVIDER, "provider");
  assert.equal(splitCalls[0]?.environment.PI_FLEET_MODEL_ID, "model");
  assert.equal(splitCalls[0]?.environment.PI_FLEET_THINKING, "high");
  assert.match(splitCalls[0]?.environment.PI_FLEET_INVITE ?? "", /^pifleet:v1:/u);
  assert.match(splitCalls[0]?.environment.PI_FLEET_KICKOFF_CAPABILITY ?? "", /^kickoff_/u);
  assert.equal(transports[0]?.messages[0]?.mode, "kickoff");
  assert.equal(
    transports[0]?.authorizations[0]?.kickoffCapability,
    splitCalls[0]?.environment.PI_FLEET_KICKOFF_CAPABILITY,
  );
  assert.equal(transports[0]?.messages[0]?.text, "Check tests");
  assert.equal(result.sessionId, "child-session");
  assert.equal(result.terminal, "tmux");
  assert.equal(result.terminalId, "tmux-child");
  assert.equal(result.terminalVersion, "3.4");
  assert.equal(result.ghosttyVersion, undefined);
  assert.equal(result.kickoffAccepted, true);
  assert.equal(runtime.launcherCleaned, true);
  assert.equal(mock.sentMessages.length, 0);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("spawn reuses an existing group and supports all split directions", async () => {
  for (const direction of ["right", "down", "left", "up"] as const) {
    const { mock, deps, transports, splitCalls } = harness();
    const controller = new FleetController(mock.pi, deps);
    const context = createMockContext({ mode: "rpc", hasUI: true, confirm: async () => true });
    await controller.sessionStart({ reason: "startup" }, context.ctx);
    await controller.startNewGroup(context.ctx, false);
    await controller.spawn(context.ctx, { direction });
    assert.equal(transports.length, 1);
    assert.equal(splitCalls[0]?.direction, direction);
    await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  }
});

test("spawn uses the configured terminal when omitted and lets an explicit argument override it", async () => {
  for (const explicitTerminal of [undefined, "tmux"] as const) {
    const runtime = harness();
    runtime.deps.environment = {};
    const settings = memorySettingsRuntime({ defaultTerminal: "ghostty" });
    const controller = new FleetController(runtime.mock.pi, runtime.deps, settings);
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      confirm: async () => true,
    });
    await controller.sessionStart({ reason: "startup" }, context.ctx);
    const result = await controller.spawn(context.ctx, {
      ...(explicitTerminal ? { terminal: explicitTerminal } : {}),
    });
    assert.equal(result.terminal, explicitTerminal ?? "ghostty");
    assert.equal(runtime.tmuxCreated, explicitTerminal === "tmux" ? 1 : 0);
    assert.equal(runtime.ghosttyCreated, explicitTerminal === "tmux" ? 0 : 1);
    await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  }
});

test("spawn rejects an invalid explicit terminal instead of treating it as omitted", async () => {
  const runtime = harness();
  const controller = new FleetController(runtime.mock.pi, runtime.deps);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await assert.rejects(
    controller.spawn(context.ctx, { terminal: "" } as unknown as SpawnSessionInput),
    /must be tmux, ghostty, or zellij/u,
  );
  assert.equal(runtime.tmuxCreated, 0);
  assert.equal(runtime.transports.length, 0);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("spawn resolves the automatic default to one concrete current backend", async () => {
  for (const [environment, terminal] of [
    [{ TMUX: "/tmp/tmux-1000/default,1234,0", TMUX_PANE: "%7" }, "tmux"],
    [{ ZELLIJ: "0", ZELLIJ_PANE_ID: "7", TERM_PROGRAM: "ghostty" }, "zellij"],
    [{ TERM_PROGRAM: "ghostty" }, "ghostty"],
  ] as const) {
    const runtime = harness();
    runtime.deps.environment = environment;
    const controller = new FleetController(runtime.mock.pi, runtime.deps);
    const confirmations: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return true;
      },
    });
    await controller.sessionStart({ reason: "startup" }, context.ctx);
    const result = await controller.spawn(context.ctx, {});
    assert.equal(result.terminal, terminal);
    assert.equal(runtime.tmuxCreated, terminal === "tmux" ? 1 : 0);
    assert.equal(runtime.zellijCreated, terminal === "zellij" ? 1 : 0);
    assert.equal(runtime.ghosttyCreated, terminal === "ghostty" ? 1 : 0);
    assert.equal(
      confirmations.some((message) =>
        new RegExp(`${terminal === "ghostty" ? "Ghostty" : terminal} split`, "iu").test(message),
      ),
      true,
    );
    await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  }
});

test("automatic resolution fails before launch side effects and never falls back after preflight", async () => {
  const missing = harness();
  missing.deps.environment = {};
  const missingController = new FleetController(missing.mock.pi, missing.deps);
  const missingContext = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await missingController.sessionStart({ reason: "startup" }, missingContext.ctx);
  await assert.rejects(missingController.spawn(missingContext.ctx, {}), /detect a supported terminal/u);
  assert.equal(missing.tmuxCreated, 0);
  assert.equal(missing.zellijCreated, 0);
  assert.equal(missing.ghosttyCreated, 0);
  assert.equal(missing.transports.length, 0);
  await missingController.sessionShutdown({ reason: "quit" }, missingContext.ctx);

  const unavailable = harness();
  unavailable.deps.environment = {
    ZELLIJ: "0",
    ZELLIJ_PANE_ID: "7",
    TERM_PROGRAM: "ghostty",
  };
  let zellijChecks = 0;
  unavailable.deps.createZellij = () => {
    zellijChecks += 1;
    return {
      assertAvailable: async () => {
        throw new ZellijLaunchError("Zellij unavailable");
      },
      spawnSplit: async () => assert.fail("split must not start after failed preflight"),
    };
  };
  const unavailableController = new FleetController(unavailable.mock.pi, unavailable.deps);
  const unavailableContext = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async () => true,
  });
  await unavailableController.sessionStart({ reason: "startup" }, unavailableContext.ctx);
  await assert.rejects(unavailableController.spawn(unavailableContext.ctx, {}), /Zellij unavailable/u);
  assert.equal(zellijChecks, 1);
  assert.equal(unavailable.tmuxCreated, 0);
  assert.equal(unavailable.ghosttyCreated, 0);
  assert.equal(unavailable.transports.length, 0);
  await unavailableController.sessionShutdown({ reason: "quit" }, unavailableContext.ctx);
});

test("spawn routes configured and explicit Zellij launches without changing the auto default", async () => {
  for (const configured of [false, true]) {
    const runtime = harness();
    const settings = memorySettingsRuntime(configured ? { defaultTerminal: "zellij" } : {});
    const controller = new FleetController(runtime.mock.pi, runtime.deps, settings);
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      confirm: async () => true,
    });
    await controller.sessionStart({ reason: "startup" }, context.ctx);
    const result = await controller.spawn(context.ctx, configured ? {} : { terminal: "zellij", direction: "up" });
    assert.equal(result.terminal, "zellij");
    assert.equal(result.terminalVersion, "0.44.3");
    assert.equal(runtime.zellijCreated, 1);
    assert.equal(runtime.zellijSplitCalls.length, 1);
    assert.equal(runtime.zellijSplitCalls[0]?.direction, configured ? "right" : "up");
    assert.deepEqual(runtime.zellijSplitCalls[0]?.environment, {});
    assert.match(runtime.launcherEnvironments[0]?.PI_FLEET_INVITE ?? "", /^pifleet:v1:/u);
    assert.equal(runtime.tmuxCreated, 0);
    assert.equal(runtime.ghosttyCreated, 0);
    await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  }
});

test("disabled launch confirmation skips every confirmation", async () => {
  const runtime = harness();
  const settings = memorySettingsRuntime({ confirmSessionLaunch: false });
  const controller = new FleetController(runtime.mock.pi, runtime.deps, settings);
  const confirmationTitles: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async (title: string) => {
      confirmationTitles.push(title);
      return true;
    },
  });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await controller.spawn(context.ctx, {});
  assert.deepEqual(confirmationTitles, []);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("settings reload on session start, report invalid data, and flush on shutdown", async () => {
  const runtime = harness();
  const settings = memorySettingsRuntime({}, "invalid settings");
  const controller = new FleetController(runtime.mock.pi, runtime.deps, settings);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  assert.equal(settings.calls.reload, 1);
  assert.match(context.notifications.at(-1)?.message ?? "", /invalid settings/u);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  assert.equal(settings.calls.flush, 1);
});

test("spawn uses Ghostty only after explicit selection and reports compatible metadata", async () => {
  const runtime = harness();
  const controller = new FleetController(runtime.mock.pi, runtime.deps);
  const confirmations: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async (_title: string, message: string) => {
      confirmations.push(message);
      return true;
    },
  });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const result = await controller.spawn(context.ctx, { terminal: "ghostty", direction: "left" });
  assert.equal(runtime.splitCalls.length, 0);
  assert.equal(runtime.tmuxCreated, 0);
  assert.equal(runtime.ghosttyCreated, 1);
  assert.equal(runtime.ghosttySplitCalls.length, 1);
  assert.equal(runtime.ghosttySplitCalls[0]?.direction, "left");
  assert.equal(
    confirmations.some((message) => /Ghostty split: left/u.test(message)),
    true,
  );
  assert.equal(result.terminal, "ghostty");
  assert.equal(result.terminalVersion, "1.3.1");
  assert.equal(result.ghosttyVersion, "1.3.1");
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("a concurrent launch failure cannot roll back another launch's automatic group", async () => {
  const runtime = harness();
  let terminalIndex = 0;
  let availabilityCount = 0;
  let releaseAvailability!: () => void;
  const availabilityReleased = new Promise<void>((resolve) => {
    releaseAvailability = resolve;
  });
  runtime.deps.createTmux = () => {
    const index = terminalIndex;
    terminalIndex += 1;
    return {
      assertAvailable: async () => {
        availabilityCount += 1;
        if (availabilityCount === 2) releaseAvailability();
        await availabilityReleased;
        return "1.3.1";
      },
      spawnSplit: async (options) => {
        if (index === 1) throw new TmuxLaunchError("second launch denied", false);
        const transport = runtime.transports[0];
        assert.ok(transport);
        transport.peers.push({
          protocolVersion: 2,
          sessionId: "successful-child",
          endpointId: "c".repeat(24),
          cwd: options.cwd,
          pid: 789,
          launchId: options.environment.PI_FLEET_LAUNCH_ID,
          acceptsRequests: false,
        });
        return { terminalId: "successful-terminal", version: "1.3.1" };
      },
    };
  };
  const controller = new FleetController(runtime.mock.pi, runtime.deps);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const results = await Promise.allSettled([
    controller.spawn(context.ctx, { name: "First" }),
    controller.spawn(context.ctx, { name: "Second" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await controller.snapshot()).connected, true);
  assert.equal(runtime.transports[0]?.stopped, 0);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  assert.equal(runtime.transports[0]?.stopped, 1);
});

test("spawn rejects an overlong canonical cwd before side effects", async () => {
  const { mock, deps, transports, splitCalls } = harness();
  const controller = new FleetController(mock.pi, deps);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await assert.rejects(controller.spawn(context.ctx, { cwd: "x".repeat(5_000) }), /cwd/u);
  assert.equal(transports.length, 0);
  assert.equal(splitCalls.length, 0);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("spawn rejects unsupported modes and cancellation before side effects", async () => {
  const firstHarness = harness();
  const first = new FleetController(firstHarness.mock.pi, firstHarness.deps);
  const json = createMockContext({ mode: "json", hasUI: false });
  await first.sessionStart({ reason: "startup" }, json.ctx);
  await assert.rejects(first.spawn(json.ctx, {}), /TUI or RPC/u);
  assert.equal(firstHarness.transports.length, 0);
  assert.equal(firstHarness.splitCalls.length, 0);
  await first.sessionShutdown({ reason: "quit" }, json.ctx);

  const secondHarness = harness();
  const second = new FleetController(secondHarness.mock.pi, secondHarness.deps);
  const cancelled = createMockContext({ mode: "tui", hasUI: true, confirm: async () => false });
  await second.sessionStart({ reason: "startup" }, cancelled.ctx);
  await assert.rejects(second.spawn(cancelled.ctx, {}), /cancelled/u);
  assert.equal(secondHarness.transports.length, 0);
  assert.equal(secondHarness.splitCalls.length, 0);
  await second.sessionShutdown({ reason: "quit" }, cancelled.ctx);
});

test("session shutdown suppresses a split after delayed launcher creation", async () => {
  const runtime = harness();
  let signalLauncherStarted!: () => void;
  const launcherStarted = new Promise<void>((resolve) => {
    signalLauncherStarted = resolve;
  });
  let releaseLauncher!: () => void;
  const launcherReleased = new Promise<void>((resolve) => {
    releaseLauncher = resolve;
  });
  let launcherCleaned = false;
  runtime.deps.createLauncher = async () => {
    signalLauncherStarted();
    await launcherReleased;
    return {
      path: "/tmp/pi-fleet-test/launch.sh",
      command: "/tmp/pi-fleet-test/launch.sh",
      cleanup: async () => {
        launcherCleaned = true;
      },
    };
  };
  const controller = new FleetController(runtime.mock.pi, runtime.deps);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const spawning = controller.spawn(context.ctx, {});
  await launcherStarted;
  const shuttingDown = controller.sessionShutdown({ reason: "quit" }, context.ctx);
  releaseLauncher();
  await assert.rejects(spawning, /stale|aborted/u);
  await shuttingDown;
  assert.equal(runtime.splitCalls.length, 0);
  assert.equal(launcherCleaned, true);
});

test("session shutdown waits for an in-flight launch to release its launcher", async () => {
  const runtime = harness({ ready: false });
  let signalSleepEntered!: () => void;
  const sleepEntered = new Promise<void>((resolve) => {
    signalSleepEntered = resolve;
  });
  runtime.deps.sleep = async (_milliseconds, signal) => {
    signalSleepEntered();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new Error("launch wait aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  let releaseCleanup!: () => void;
  let signalCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    signalCleanupStarted = resolve;
  });
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  runtime.deps.createLauncher = async () => ({
    path: "/tmp/pi-fleet-test/launch.sh",
    command: "/tmp/pi-fleet-test/launch.sh",
    cleanup: async () => {
      signalCleanupStarted();
      await cleanupReleased;
    },
  });
  const controller = new FleetController(runtime.mock.pi, runtime.deps);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const spawning = controller.spawn(context.ctx, {});
  await sleepEntered;
  let shutdownResolved = false;
  const shuttingDown = controller.sessionShutdown({ reason: "quit" }, context.ctx).then(() => {
    shutdownResolved = true;
  });
  await cleanupStarted;
  const shutdownState = await Promise.race([
    shuttingDown.then(() => "resolved" as const),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(shutdownState, "pending");
  assert.equal(shutdownResolved, false);
  releaseCleanup();
  await assert.rejects(spawning, /split|ready|aborted/u);
  await shuttingDown;
  assert.equal(context.statuses.get("fleet"), undefined);
});

test("pre-split failure rolls back an automatic group while readiness timeout keeps it", async () => {
  const failedHarness = harness({ launchError: new TmuxLaunchError("denied", false) });
  const failed = new FleetController(failedHarness.mock.pi, failedHarness.deps);
  const firstContext = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await failed.sessionStart({ reason: "startup" }, firstContext.ctx);
  await assert.rejects(failed.spawn(firstContext.ctx, {}), /denied/u);
  assert.equal(failedHarness.transports[0]?.stopped, 1);
  assert.equal(failedHarness.launcherCleaned, true);
  assert.equal((await failed.snapshot()).connected, false);
  await failed.sessionShutdown({ reason: "quit" }, firstContext.ctx);

  const timeoutHarness = harness({ ready: false });
  const timeout = new FleetController(timeoutHarness.mock.pi, timeoutHarness.deps);
  const secondContext = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  await timeout.sessionStart({ reason: "startup" }, secondContext.ctx);
  await assert.rejects(
    timeout.spawn(secondContext.ctx, {}),
    (error: unknown) => error instanceof TmuxLaunchError && error.splitCreated,
  );
  assert.equal(timeoutHarness.launcherCleaned, true);
  assert.equal((await timeout.snapshot()).connected, true);
  await timeout.sessionShutdown({ reason: "quit" }, secondContext.ctx);
});

function memorySettingsRuntime(
  overrides: Partial<FleetSettings> = {},
  issue?: string,
): FleetSettingsRuntime & {
  calls: { reload: number; flush: number };
  patches: FleetSettingsPatch[];
} {
  let state: FleetSettingsState = {
    settings: { ...DEFAULT_FLEET_SETTINGS, ...overrides },
    sources: {
      defaultTerminal: Object.hasOwn(overrides, "defaultTerminal") ? "user" : "built-in",
      confirmSessionLaunch: Object.hasOwn(overrides, "confirmSessionLaunch") ? "user" : "built-in",
    },
    canSave: issue === undefined,
    ...(issue ? { issue: { kind: "invalid", message: issue } } : {}),
  };
  const calls = { reload: 0, flush: 0 };
  const patches: FleetSettingsPatch[] = [];
  return {
    calls,
    patches,
    get: () => state,
    getPath: () => "/tmp/pi-fleet.json",
    reload: async () => {
      calls.reload += 1;
      return state;
    },
    update: async (patch) => {
      patches.push(patch);
      state = { ...state, settings: { ...state.settings, ...patch } };
      return state;
    },
    flush: async () => {
      calls.flush += 1;
    },
  };
}
