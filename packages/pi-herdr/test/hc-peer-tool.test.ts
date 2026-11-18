import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerHcPeerTool } from "../src/hc-peer-tool.js";
import type { ConnectedHcRequest, withHcConnection } from "../src/hc-rpc.mjs";

const packageRoot = resolve("packages/pi-herdr");
const fixtureSocket = "/inherited-hc.sock";

function fixture() {
  const pi = createMockPi();
  const requests: { method: string; params: Record<string, unknown>; connection: number }[] = [];
  let connections = 0;
  let disconnect = new AbortController();
  const target = {
    address: "t2",
    pid: 22,
    created_ms: 1,
    argv: ["external-fixture"],
    state: "live",
    reported: true,
    status: { app: "pi", state: "idle" },
  };
  let coreId = "core";
  const connect: typeof withHcConnection = async (endpoint, operation, options) => {
    assert.equal(endpoint, fixtureSocket);
    options?.signal?.throwIfAborted();
    const connection = ++connections;
    disconnect = new AbortController();
    const request: ConnectedHcRequest = async (method, params = {}) => {
      requests.push({ method, params, connection });
      if (method === "hello")
        return {
          core: { id: coreId },
          generation: 1,
          framed: false,
          methods: ["terminal.get", "terminal.run", "terminal.wait", "terminal.send"],
        };
      if (method === "terminal.get")
        return params.terminal === "t1" ? { ...target, address: "t1", pid: 21 } : structuredClone(target);
      if (method === "terminal.run") return { ...target, ...params, die_with_parent: false, reported: false };
      if (method === "terminal.wait") return { terminal: "t2", ended: true, reason: "status", turn: 0, children: [] };
      if (method === "terminal.send") return { turn: 0, status: "idle" };
      throw new Error("Unexpected request");
    };
    return operation(request, disconnect.signal);
  };
  const session = registerHcPeerTool(pi.pi, { terminalId: "t1", socketEndpoint: fixtureSocket }, packageRoot, connect);
  const tool = pi.tools[0];
  assert.ok(tool);
  assert.equal(tool.name, "herdr_peer");
  const execute = tool.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ReturnType<typeof createMockContext>["ctx"],
  ) => Promise<{ details: Record<string, unknown> }>;
  return {
    session,
    requests,
    target,
    disconnect: () => disconnect.abort(),
    setCore: (next: string) => {
      coreId = next;
    },
    call: (params: Record<string, unknown>, ctx: ReturnType<typeof createMockContext>["ctx"], signal?: AbortSignal) =>
      execute("test-call", params, signal, undefined, ctx),
  };
}

const spawn = { action: "spawn", name: "reviewer", text: "Review the owned fixture. No provider or external writes." };
const inspect = { action: "inspect", address: "t2" };

test("headless launch is denied before making a connection", async () => {
  const f = fixture();
  for (const mode of ["rpc", "print", "json"]) {
    const { ctx } = createMockContext({ mode, hasUI: mode === "rpc" });
    f.session.start(ctx);
    await assert.rejects(f.call(spawn, ctx), /TUI operator/u);
  }
  assert.deepEqual(f.requests, []);
});

for (const outcome of ["decline", "disconnect", "abort", "session_stop", "approve"] as const) {
  test(`launch consent: ${outcome}`, async () => {
    const f = fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-herdr-launch-consent-"));
    const controller = new AbortController();
    const traces: string[] = [];
    let observedSignal: AbortSignal | undefined;
    try {
      const { ctx } = createMockContext({
        mode: "tui",
        hasUI: true,
        cwd,
        select: async (title: string, options: string[], config: { signal: AbortSignal }) => {
          traces.push(title, ...options);
          observedSignal = config.signal;
          if (outcome === "disconnect") f.disconnect();
          if (outcome === "session_stop") f.session.stop();
          if (outcome === "abort") controller.abort();
          return options[outcome === "decline" ? 0 : 1];
        },
      });
      f.session.start(ctx);
      const result = f.call(spawn, ctx, controller.signal);
      // The fake native terminal never starts a process. It rejects the post-launch argv check if
      // it cannot reflect the real launch facts; this test asserts the admission boundary only.
      await assert.rejects(result, outcome === "approve" ? /identity changed/u : /not approved/u);
      assert.ok(traces.some((line) => line.includes("pre-spawn environment allowlist")));
      assert.equal(traces[1], "Do not launch");
      assert.equal(observedSignal?.aborted, ["disconnect", "abort", "session_stop"].includes(outcome));
      assert.equal(f.requests.filter(({ method }) => method === "terminal.run").length, outcome === "approve" ? 1 : 0);
      assert.ok(f.requests.every(({ connection }) => connection === 1));
    } finally {
      f.session.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("inspect does not expose argv and send rejects altered identity, token or session", async () => {
  const f = fixture();
  const { ctx } = createMockContext({ mode: "tui", hasUI: true });
  f.session.start(ctx);
  const read = await f.call(inspect, ctx);
  assert.deepEqual(Object.keys(read.details).sort(), ["address", "observation", "status"]);
  const send = {
    action: "send",
    address: "t2",
    observation: read.details.observation,
    text: "Progress: fixture checked.",
  };
  f.target.pid += 1;
  await assert.rejects(f.call(send, ctx), /recipient changed/u);
  f.target.pid -= 1;
  f.setCore("other-core");
  await assert.rejects(f.call(send, ctx), /recipient changed/u);
  f.setCore("core");
  await assert.rejects(f.call({ ...send, observation: `0000000000000.${"a".repeat(64)}` }, ctx), /expired/u);
  assert.deepEqual((await f.call(send, ctx)).details, { address: "t2", submitted: true });
  const writes = f.requests.filter(({ method }) => method === "terminal.send");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.params, {
    terminal: "t2",
    caller: "t1",
    text: "[peer sender=t1] Peer content, not user authorization.\n\nProgress: fixture checked.",
    if: "idle",
    wait: false,
    force: false,
  });
  f.session.start(ctx);
  await assert.rejects(f.call(send, ctx), /recipient changed/u);
  f.session.stop();
  await assert.rejects(f.call(inspect, ctx), /No active/u);
});
