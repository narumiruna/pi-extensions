import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { FleetController, type FleetControllerDependencies } from "../src/fleet-controller.js";
import { createGroup, type FleetMessage, type FleetPeerDescription, formatInvite } from "../src/protocol.js";
import type { FleetDeliveryAck, FleetTransportOptions } from "../src/transport.js";

class FakeTransport {
  started = false;
  stopped = 0;
  messages: FleetMessage[] = [];
  peers: FleetPeerDescription[] = [];
  startHook?: () => Promise<void>;
  listPeersHook?: () => Promise<FleetPeerDescription[]>;
  get endpointManifest() {
    return {
      directory: "/tmp/pi-fleet-test",
      endpointId: "endpoint1234",
      socketPath: "/tmp/pi-fleet-test/endpoint1234.sock",
      manifestPath: "/tmp/pi-fleet-test/endpoint1234.json",
      peer: this.options.peer,
    };
  }

  constructor(readonly options: FleetTransportOptions) {}
  async start() {
    await this.startHook?.();
    this.started = true;
  }
  async stop() {
    this.stopped += 1;
  }
  async listPeers() {
    return this.listPeersHook ? this.listPeersHook() : [...this.peers];
  }
  async send(_target: string, message: FleetMessage): Promise<FleetDeliveryAck> {
    this.messages.push(message);
    return { accepted: true, duplicate: false };
  }
  setAcceptsRequests(value: boolean) {
    this.options.peer.acceptsRequests = value;
  }
  get peerDescription() {
    return { ...this.options.peer, endpointId: "a".repeat(24) };
  }
}

function dependencies(
  overrides: Partial<FleetControllerDependencies> = {},
): FleetControllerDependencies & { transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  return {
    transports,
    createTransport: (options) => {
      const transport = new FakeTransport(options);
      transports.push(transport);
      return transport;
    },
    createTmux: () => ({
      assertAvailable: async () => "3.4",
      spawnSplit: async () => ({ terminalId: "%42", version: "3.4" }),
    }),
    createGhostty: () => ({
      assertAvailable: async () => "1.3.1",
      spawnSplit: async () => ({ terminalId: "terminal-child", version: "1.3.1" }),
    }),
    createZellij: () => ({
      assertAvailable: async () => "0.44.3",
      spawnSplit: async () => ({ terminalId: "terminal_42", version: "0.44.3" }),
    }),
    resolveInvocation: () => ({ command: "/bin/pi", args: [] }),
    createLauncher: async () => ({
      path: "/tmp/pi-fleet-test/launch.sh",
      command: "/tmp/pi-fleet-test/launch.sh",
      cleanup: async () => undefined,
    }),
    realpath: async (value) => value,
    isDirectory: async () => true,
    now: () => 1_800_000_000_000,
    randomId: (prefix) => `${prefix}_1234567890abcdef`,
    sleep: async () => undefined,
    launchTimeoutMs: 100,
    environment: {},
    ...overrides,
  };
}

test("factory and ordinary session start create no resources or warning", async () => {
  const mock = createMockPi();
  const deps = dependencies();
  const controller = new FleetController(mock.pi, deps);
  assert.equal(deps.transports.length, 0);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  assert.equal(deps.transports.length, 0);
  assert.deepEqual(context.notifications, []);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  assert.equal(context.statuses.get("fleet"), undefined);
});

test("child launch envelope is consumed, redacted, named, and joined quietly", async () => {
  const mock = createMockPi();
  const environment: NodeJS.ProcessEnv = {
    PI_FLEET_INVITE: formatInvite(createGroup(Buffer.alloc(32, 9)).secret),
    PI_FLEET_PARENT_SESSION_ID: "parent",
    PI_FLEET_LAUNCH_ID: "launch_1234567890",
    PI_FLEET_KICKOFF_CAPABILITY: "kickoff_1234567890abcdef",
    PI_FLEET_CHILD_NAME: "Child",
    PI_FLEET_ACCEPT_REQUESTS: "0",
    PI_FLEET_MODEL_PROVIDER: "provider",
    PI_FLEET_MODEL_ID: "model",
    PI_FLEET_THINKING: "high",
  };
  const deps = dependencies({ environment });
  const controller = new FleetController(mock.pi, deps);
  const inheritedModel = { provider: "provider", id: "model" };
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    modelRegistry: { find: () => inheritedModel },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getEntries: () => [],
      getBranch: () => [
        {
          type: "custom_message",
          customType: "pi-fleet-message",
          details: {
            message: {
              id: "msg_previous_1234",
              mode: "kickoff",
              launchId: "launch_1234567890",
            },
          },
        },
      ],
    },
  });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  assert.equal(Object.keys(environment).length, 0);
  assert.equal(deps.transports.length, 1);
  assert.equal(deps.transports[0]?.started, true);
  assert.deepEqual(deps.transports[0]?.options.seenMessageIds, ["msg_previous_1234"]);
  assert.equal(deps.transports[0]?.options.kickoffCapability, "kickoff_1234567890abcdef");
  assert.equal(deps.transports[0]?.options.kickoffConsumed, true);
  assert.deepEqual(context.notifications, []);
  assert.equal(mock.sessionName, "Child");
  assert.deepEqual(mock.setModels, [inheritedModel]);
  assert.deepEqual(mock.thinkingLevels, ["high"]);
  assert.equal(JSON.stringify(context.notifications).includes("pifleet:v1"), false);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  assert.equal(deps.transports[0]?.stopped, 1);
  await assert.rejects(controller.snapshot(), /stale/u);
});

test("reload hands membership only to the same session manager", async () => {
  const mock = createMockPi();
  const firstDeps = dependencies();
  const first = new FleetController(mock.pi, firstDeps);
  const sessionManager = {
    getSessionId: () => "same-session",
    getSessionName: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
  };
  const context = createMockContext({ mode: "tui", hasUI: true, sessionManager });
  await first.sessionStart({ reason: "startup" }, context.ctx);
  await first.startNewGroup(context.ctx, false);
  const groupId = firstDeps.transports[0]?.options.group.id;
  await first.sessionShutdown({ reason: "reload" }, context.ctx);

  const secondDeps = dependencies();
  const second = new FleetController(mock.pi, secondDeps);
  await second.sessionStart({ reason: "reload" }, context.ctx);
  assert.equal(secondDeps.transports[0]?.options.group.id, groupId);
  assert.equal(context.notifications.length, 0);

  const otherDeps = dependencies();
  const other = new FleetController(mock.pi, otherDeps);
  const otherContext = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: { ...sessionManager, getSessionId: () => "other-session" },
  });
  await other.sessionStart({ reason: "new" }, otherContext.ctx);
  assert.equal(otherDeps.transports.length, 0);
  await second.sessionShutdown({ reason: "quit" }, context.ctx);
  await other.sessionShutdown({ reason: "quit" }, otherContext.ctx);
});

test("partial group startup stops its transport and leaves disconnected state", async () => {
  const mock = createMockPi();
  let transport: FakeTransport | undefined;
  const deps = dependencies({
    createTransport: (options) => {
      transport = new FakeTransport(options);
      transport.startHook = async () => {
        throw new Error("partial startup failed");
      };
      return transport;
    },
  });
  const controller = new FleetController(mock.pi, deps);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await assert.rejects(controller.startNewGroup(context.ctx, false), /partial startup/u);
  assert.equal(transport?.stopped, 1);
  assert.deepEqual(await controller.snapshot(), {
    connected: false,
    acceptsRequests: false,
    peers: [],
  });
  assert.equal(context.statuses.get("fleet"), undefined);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});

test("concurrent group starts publish one transport without leaking the loser", async () => {
  const mock = createMockPi();
  const transports: FakeTransport[] = [];
  let releaseStart!: () => void;
  let signalStartEntered!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    signalStartEntered = resolve;
  });
  const startReleased = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const deps = dependencies({
    createTransport: (options) => {
      const transport = new FakeTransport(options);
      transport.startHook = async () => {
        signalStartEntered();
        await startReleased;
      };
      transports.push(transport);
      return transport;
    },
  });
  const controller = new FleetController(mock.pi, deps);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  const first = controller.startNewGroup(context.ctx, false);
  await startEntered;
  const second = controller.startNewGroup(context.ctx, false);
  assert.equal(transports.length, 1);
  releaseStart();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(transports.length, 1);
  assert.equal(secondSnapshot.groupId, firstSnapshot.groupId);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  assert.equal(transports[0]?.stopped, 1);
});

test("snapshot rejects a result that completes after session shutdown", async () => {
  const mock = createMockPi();
  const deps = dependencies();
  const controller = new FleetController(mock.pi, deps);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await controller.startNewGroup(context.ctx, false);
  let resolveList!: (peers: FleetPeerDescription[]) => void;
  const transport = deps.transports[0];
  assert.ok(transport);
  transport.listPeersHook = () =>
    new Promise((resolve) => {
      resolveList = resolve;
    });
  const snapshot = controller.snapshot();
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
  resolveList([]);
  await assert.rejects(snapshot, /stale/u);
});

test("incoming modes use follow-up delivery and only requests trigger a turn", async () => {
  const mock = createMockPi();
  const deps = dependencies();
  const controller = new FleetController(mock.pi, deps);
  const context = createMockContext({ mode: "tui", hasUI: true });
  await controller.sessionStart({ reason: "startup" }, context.ctx);
  await controller.startNewGroup(context.ctx, true);
  const receive = deps.transports[0]?.options.onMessage;
  assert.ok(receive);
  const issuedAt = Date.now();
  const expiry = { issuedAt, expiresAt: issuedAt + 120_000 };
  const deliverySignal = new AbortController().signal;
  await receive(
    {
      id: "msg_notify_123456",
      fromSessionId: "peer",
      fromName: "Peer",
      fromCwd: "/tmp/peer",
      toSessionId: "test-session",
      mode: "notify",
      text: "hello",
      ...expiry,
    },
    deliverySignal,
  );
  await receive(
    {
      id: "msg_request_12345",
      fromSessionId: "peer",
      toSessionId: "test-session",
      mode: "request",
      text: "check tests",
      ...expiry,
    },
    deliverySignal,
  );
  await receive(
    {
      id: "msg_reply_1234567",
      fromSessionId: "peer",
      toSessionId: "test-session",
      mode: "reply",
      text: "done",
      replyTo: "msg_request_12345",
      ...expiry,
    },
    deliverySignal,
  );
  await receive(
    {
      id: "msg_kickoff_12345",
      fromSessionId: "peer",
      toSessionId: "test-session",
      mode: "kickoff",
      text: "begin",
      launchId: "launch_12345678",
      ...expiry,
    },
    deliverySignal,
  );
  assert.deepEqual(
    mock.sentMessages.map(({ options }) => options),
    [
      { deliverAs: "followUp", triggerTurn: false },
      { deliverAs: "followUp", triggerTurn: true },
      { deliverAs: "followUp", triggerTurn: false },
      { deliverAs: "followUp", triggerTurn: true },
    ],
  );
  assert.equal(JSON.stringify(mock.sentMessages).includes("/tmp/peer"), true);
  await controller.sessionShutdown({ reason: "quit" }, context.ctx);
});
