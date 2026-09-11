import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { FleetSnapshot, SpawnSessionResult } from "../src/fleet-controller.js";
import { type FleetToolController, registerFleetTools } from "../src/tools.js";

function stubController(overrides: Partial<FleetToolController> = {}) {
  const calls: unknown[] = [];
  const snapshot: FleetSnapshot = {
    connected: true,
    acceptsRequests: false,
    peers: [
      {
        protocolVersion: 2,
        sessionId: "peer-1",
        endpointId: "b".repeat(24),
        name: "Peer One",
        cwd: "/tmp/peer",
        pid: 123,
        acceptsRequests: true,
      },
    ],
  };
  const spawnResult: SpawnSessionResult = {
    sessionId: "child",
    name: "Child",
    cwd: "/tmp/child",
    terminal: "tmux",
    terminalId: "%42",
    terminalVersion: "3.4",
    kickoffAccepted: true,
  };
  const controller: FleetToolController = {
    spawn: async (_ctx, input) => {
      calls.push({ kind: "spawn", input });
      return spawnResult;
    },
    snapshot: async () => snapshot,
    send: async (_ctx, input) => {
      calls.push({ kind: "send", input });
      const issuedAt = Date.now();
      return {
        message: {
          id: "msg_1234567890",
          fromSessionId: "self",
          toSessionId: input.targetSessionId,
          mode: input.mode,
          text: input.text,
          issuedAt,
          expiresAt: issuedAt + 120_000,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        },
        acknowledgement: { accepted: true, duplicate: false },
      };
    },
    ...overrides,
  };
  return { controller, calls, snapshot, spawnResult };
}

test("registers separate spawn and bus tools with focused schemas", () => {
  const mock = createMockPi();
  const { controller } = stubController();
  registerFleetTools(mock.pi, controller);
  assert.deepEqual(
    mock.tools.map((tool) => tool.name),
    ["session_spawn", "session_bus"],
  );
  const spawn = mock.tools[0] as {
    parameters: { properties?: Record<string, { enum?: string[] }> };
  };
  const bus = mock.tools[1] as { parameters: { properties?: Record<string, unknown> } };
  assert.deepEqual(Object.keys(spawn.parameters.properties ?? {}).sort(), [
    "cwd",
    "direction",
    "name",
    "task",
    "terminal",
  ]);
  assert.deepEqual(spawn.parameters.properties?.terminal?.enum, ["tmux", "ghostty", "zellij"]);
  assert.deepEqual(Object.keys(bus.parameters.properties ?? {}).sort(), [
    "action",
    "message",
    "mode",
    "replyTo",
    "targetSessionId",
  ]);
});

test("session_spawn delegates launch input and returns readiness without secrets", async () => {
  const mock = createMockPi();
  const { controller, calls } = stubController();
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_spawn") as {
    execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
  };
  const context = createMockContext({ mode: "tui", hasUI: true });
  const result = await tool.execute(
    "call-1",
    { direction: "down", task: "check tests", name: "Child", cwd: "/tmp/child" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(calls, [
    {
      kind: "spawn",
      input: { direction: "down", task: "check tests", name: "Child", cwd: "/tmp/child" },
    },
  ]);
  assert.match(result.content[0]?.text ?? "", /child.*ready.*tmux/iu);
  assert.equal(JSON.stringify(result).includes("pifleet:v1"), false);
});

test("session_spawn forwards an explicit Ghostty override", async () => {
  const mock = createMockPi();
  const ghosttyResult: SpawnSessionResult = {
    sessionId: "ghostty-child",
    cwd: "/tmp/child",
    terminal: "ghostty",
    terminalId: "terminal-child",
    terminalVersion: "1.3.1",
    ghosttyVersion: "1.3.1",
    kickoffAccepted: false,
  };
  const { controller, calls } = stubController({
    spawn: async (_ctx, input) => {
      calls.push({ kind: "spawn", input });
      return ghosttyResult;
    },
  });
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_spawn") as {
    execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
  };
  const context = createMockContext({ mode: "rpc", hasUI: true });
  const result = await tool.execute(
    "call-ghostty",
    { terminal: "ghostty", direction: "right" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(calls, [{ kind: "spawn", input: { terminal: "ghostty", direction: "right" } }]);
  assert.match(result.content[0]?.text ?? "", /ready.*Ghostty/iu);
});

test("session_spawn forwards and labels an explicit Zellij override", async () => {
  const mock = createMockPi();
  const zellijResult: SpawnSessionResult = {
    sessionId: "zellij-child",
    cwd: "/tmp/child",
    terminal: "zellij",
    terminalId: "terminal_42",
    terminalVersion: "0.44.3",
    kickoffAccepted: false,
  };
  const { controller, calls } = stubController({
    spawn: async (_ctx, input) => {
      calls.push({ kind: "spawn", input });
      return zellijResult;
    },
  });
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_spawn") as {
    execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
  };
  const context = createMockContext({ mode: "rpc", hasUI: true });
  const result = await tool.execute(
    "call-zellij",
    { terminal: "zellij", direction: "left" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(calls, [{ kind: "spawn", input: { terminal: "zellij", direction: "left" } }]);
  assert.match(result.content[0]?.text ?? "", /ready.*Zellij/iu);
});

test("session_bus lists peers, sends requests, and correlates replies", async () => {
  const mock = createMockPi();
  const { controller, calls } = stubController();
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_bus") as {
    execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
  };
  const context = createMockContext({ mode: "tui", hasUI: true });
  const listed = await tool.execute("call-list", { action: "list" }, undefined, undefined, context.ctx);
  assert.match(listed.content[0]?.text ?? "", /Peer One/u);
  await tool.execute(
    "call-send",
    { action: "send", targetSessionId: "peer-1", mode: "request", message: "review" },
    undefined,
    undefined,
    context.ctx,
  );
  await tool.execute(
    "call-reply",
    {
      action: "reply",
      targetSessionId: "peer-1",
      replyTo: "msg_original_1234",
      message: "done",
    },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(calls.slice(0), [
    {
      kind: "send",
      input: { targetSessionId: "peer-1", text: "review", mode: "request" },
    },
    {
      kind: "send",
      input: {
        targetSessionId: "peer-1",
        text: "done",
        mode: "reply",
        replyTo: "msg_original_1234",
      },
    },
  ]);
});

test("session_bus bounds aggregate peer text and details by UTF-8 bytes", async () => {
  const mock = createMockPi();
  const peers: FleetSnapshot["peers"] = Array.from({ length: 64 }, (_, index) => ({
    protocolVersion: 2,
    sessionId: `peer-${index}`,
    endpointId: index.toString(16).padStart(24, "0"),
    name: `Peer ${index} ${"名".repeat(60)}`,
    cwd: `/${"界".repeat(1_365)}`,
    pid: index + 1,
    acceptsRequests: false,
  }));
  const { controller } = stubController({
    snapshot: async () => ({ connected: true, acceptsRequests: false, peers }),
  });
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_bus") as {
    execute(...args: unknown[]): Promise<{
      content: Array<{ text: string }>;
      details: { peers: FleetSnapshot["peers"]; truncated: boolean };
    }>;
  };
  const context = createMockContext({ mode: "tui", hasUI: true });
  const result = await tool.execute("call-list-bounded", { action: "list" }, undefined, undefined, context.ctx);
  assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") <= 40 * 1024, true);
  assert.equal(result.details.peers.length < peers.length, true);
  assert.equal(result.details.truncated, true);
  assert.equal(
    result.details.peers.every((peer) => result.content[0]?.text.includes(peer.sessionId)),
    true,
  );
});

test("session_bus exposes bounded discovery diagnostics without transport secrets", async () => {
  const mock = createMockPi();
  const { controller } = stubController({
    snapshot: async () => ({
      connected: true,
      acceptsRequests: false,
      peers: [],
      discoveryIssues: [{ code: "peer_unreachable", sessionId: "peer-1", endpointId: "b".repeat(24) }],
    }),
  });
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_bus") as {
    execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }>;
  };
  const context = createMockContext({ mode: "tui", hasUI: true });
  const result = await tool.execute("call-list-diagnostics", { action: "list" }, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /transport issue/u);
  assert.equal(JSON.stringify(result.details).includes("peer_unreachable"), true);
  assert.equal(JSON.stringify(result).includes("pifleet:v1"), false);
});

test("session_bus throws on invalid action fields and rejected acknowledgement", async () => {
  const mock = createMockPi();
  const rawAckError = "Target session\u001b]0;owned\u0007 does not allow agent requests\r";
  const { controller } = stubController({
    send: async () => ({
      message: {
        id: "msg_1234567890",
        fromSessionId: "self",
        toSessionId: "peer-1",
        mode: "request",
        text: "review",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 120_000,
      },
      acknowledgement: {
        accepted: false,
        duplicate: false,
        error: rawAckError,
      },
    }),
  });
  registerFleetTools(mock.pi, controller);
  const tool = mock.tools.find(({ name }) => name === "session_bus") as {
    execute(...args: unknown[]): Promise<unknown>;
  };
  const context = createMockContext({ mode: "tui", hasUI: true });
  await assert.rejects(
    tool.execute(
      "call-send",
      { action: "send", targetSessionId: "peer-1", mode: "request", message: "review" },
      undefined,
      undefined,
      context.ctx,
    ),
    (error: unknown) =>
      error instanceof Error &&
      /does not allow agent requests/u.test(error.message) &&
      !error.message.includes("\u001b") &&
      !error.message.includes("\u0007") &&
      !error.message.includes("\r"),
  );
  assert.equal(rawAckError.includes("\u001b"), true);
  await assert.rejects(
    tool.execute("call-reply", { action: "reply", message: "missing ids" }, undefined, undefined, context.ctx),
    /targetSessionId/u,
  );
});
