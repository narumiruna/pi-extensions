import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { type AnalyticsStorePort, createAnalyticsExtension, isBuiltinReadTool } from "../src/analytics.js";
import { SkillTracker } from "../src/skills.js";
import type { AnalyticsSnapshot, TimeRange } from "../src/storage/queries.js";
import type { SettledRun } from "../src/types.js";

const emptySnapshot: AnalyticsSnapshot = {
  overview: {
    responseCycles: 0,
    llmCalls: 0,
    callsPerResponse: 0,
    p95CallsPerResponse: 0,
    toolCalls: 0,
    toolErrors: 0,
    skillActivations: 0,
    providerErrors: 0,
    recoveredErrors: 0,
  },
  skills: [],
  tools: [],
  reliability: {
    http429: 0,
    http5xx: 0,
    recovered: 0,
    terminal: 0,
    categories: {
      dns: 0,
      timeout: 0,
      connection_refused: 0,
      connection_reset: 0,
      tls: 0,
      network_other: 0,
      provider_other: 0,
    },
  },
  responses: {
    count: 0,
    llmCalls: 0,
    average: 0,
    median: 0,
    p95: 0,
    maximum: 0,
    distribution: { one: 0, twoToThree: 0, fourToSix: 0, sevenPlus: 0 },
  },
};

class FakeStore implements AnalyticsStorePort {
  readonly path = "/tmp/pi-analytics";
  readonly runs: SettledRun[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  closed = 0;
  clears = 0;
  failWrites = false;

  async recordRun(run: SettledRun, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    if (this.failWrites) throw new Error("write failed with /private/path");
    this.runs.push(run);
  }
  async getSnapshot(_range: TimeRange): Promise<AnalyticsSnapshot> {
    return emptySnapshot;
  }
  async clearAll(): Promise<{ cleanupIncomplete: boolean }> {
    this.clears += 1;
    return { cleanupIncomplete: false };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

function lifecycleContext(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    hasUI: true,
    mode: "rpc",
    cwd: "/workspace",
    model: { provider: "openai", id: "gpt-test" },
    ...overrides,
  });
}

async function emit(
  mock: ReturnType<typeof createMockPi>,
  name: string,
  event: Record<string, unknown>,
  ctx: unknown,
): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function settleOneRun(mock: ReturnType<typeof createMockPi>, ctx: unknown, prompt = "run"): Promise<void> {
  await emit(mock, "before_agent_start", { prompt, systemPromptOptions: { skills: [] } }, ctx);
  await emit(mock, "agent_start", {}, ctx);
  await emit(mock, "before_provider_request", { payload: {} }, ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
  await emit(mock, "agent_settled", {}, ctx);
}

test("skill read attribution requires Pi's built-in read tool", () => {
  assert.equal(
    isBuiltinReadTool(createMockPi({ allTools: [{ name: "read", sourceInfo: { source: "builtin" } }] }).pi),
    true,
  );
  assert.equal(
    isBuiltinReadTool(
      createMockPi({
        allTools: [{ name: "read", sourceInfo: { source: "custom-extension" } }],
      }).pi,
    ),
    false,
  );
});

test("factory registers lifecycle hooks without constructing or opening storage", () => {
  let creates = 0;
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: () => {
      creates += 1;
      return new FakeStore();
    },
  })(mock.pi);
  assert.equal(creates, 0);
  assert.ok(mock.commands.has("analytics"));
  assert.deepEqual([...mock.events.keys()].sort(), [
    "after_provider_response",
    "agent_settled",
    "agent_start",
    "before_agent_start",
    "before_provider_request",
    "input",
    "message_end",
    "session_shutdown",
    "session_start",
    "tool_execution_end",
    "tool_execution_start",
    "tool_result",
    "turn_start",
  ]);
});

test("session start synchronously installs a lazy store without notifying", async () => {
  const store = new FakeStore();
  let path = "";
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: (value) => {
      path = value;
      return store;
    },
    getAgentDir: () => "/agent",
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  assert.equal(path, "/agent/pi-analytics");
  assert.deepEqual(started.notifications, []);
});

test("a repeated session start aborts and closes the previous lazy store", async () => {
  const first = new FakeStore();
  const second = new FakeStore();
  let creates = 0;
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => (++creates === 1 ? first : second) })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "session_start", { reason: "reload" }, started.ctx);
  await Promise.resolve();
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  assert.equal(second.closed, 1);
});

test("a settled response is written once with the current session signal", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await settleOneRun(mock, started.ctx);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0]?.outcome, "success");
  assert.equal(store.signals[0]?.aborted, false);
});

test("a delayed skill read cannot attach to a later response cycle", async () => {
  const store = new FakeStore();
  let canonicalCalls = 0;
  let reached!: () => void;
  const matching = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = createMockPi({
    allTools: [{ name: "read", sourceInfo: { source: "builtin" } }],
  });
  createAnalyticsExtension({
    createStore: () => store,
    createSkillTracker: (cwd) =>
      new SkillTracker(cwd, async (filePath) => {
        canonicalCalls += 1;
        if (canonicalCalls === 2) {
          reached();
          await blocked;
        }
        return filePath;
      }),
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const skills = [{ name: "reviewing-code", filePath: "/workspace/SKILL.md" }];
  await emit(mock, "before_agent_start", { prompt: "first", systemPromptOptions: { skills } }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  const reading = emit(
    mock,
    "tool_result",
    {
      toolName: "read",
      input: { path: "/workspace/SKILL.md" },
      isError: false,
    },
    started.ctx,
  );
  await matching;
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "second", systemPromptOptions: { skills } }, started.ctx);
  release();
  await reading;
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  assert.deepEqual(
    store.runs.map(({ skills: runSkills }) => runSkills),
    [[], []],
  );
});

test("shutdown drops an active interrupted response and only closes storage", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "run", systemPromptOptions: { skills: [] } }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  assert.equal(store.runs.length, 0);
  assert.equal(store.closed, 1);
});

test("session shutdown aborts a delayed write and suppresses stale failure feedback", async () => {
  const store = new FakeStore();
  store.recordRun = async (_run, signal) => {
    store.signals.push(signal);
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "run", systemPromptOptions: { skills: [] } }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  const settling = emit(mock, "agent_settled", {}, started.ctx);
  await Promise.resolve();
  const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  await Promise.all([settling, shutdown]);
  assert.equal(store.signals[0]?.aborted, true);
  assert.equal(store.closed, 1);
  assert.equal(started.notifications.filter(({ message }) => message.includes("could not save")).length, 0);
});

test("write failure notifies once and a later success reports recovery without leaking paths", async () => {
  const store = new FakeStore();
  store.failWrites = true;
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await settleOneRun(mock, started.ctx, "first");
  await settleOneRun(mock, started.ctx, "second");
  assert.equal(started.notifications.filter(({ message }) => message.includes("could not save")).length, 1);
  store.failWrites = false;
  await settleOneRun(mock, started.ctx, "third");
  assert.ok(started.notifications.some(({ message }) => message.includes("storage recovered")));
  assert.doesNotMatch(started.notifications.map(({ message }) => message).join("\n"), /private\/path/);
});

test("arguments and noninteractive command modes reject before querying", async () => {
  const store = new FakeStore();
  let loads = 0;
  store.getSnapshot = async () => {
    loads += 1;
    return emptySnapshot;
  };
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const command = mock.commands.get("analytics");
  assert.ok(command);
  const interactive = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, interactive.ctx);
  await command.handler("trailing", interactive.ctx);
  assert.ok(interactive.notifications.some(({ message }) => message.includes("does not accept arguments")));
  for (const mode of ["print", "json"] as const) {
    const noninteractive = lifecycleContext({ hasUI: false, mode });
    await assert.rejects(async () => command.handler("", noninteractive.ctx), /TUI or RPC/);
    await assert.rejects(async () => command.handler("trailing", noninteractive.ctx), /does not accept arguments/);
  }
  assert.equal(loads, 0);
});

test("store construction failures are content-free and keep the command available", async () => {
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: () => {
      throw new Error("failed at /home/private/user");
    },
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const message = started.notifications.find(({ message }) => message.includes("could not be initialized"))?.message;
  assert.match(message ?? "", /No analytics are being collected/);
  assert.doesNotMatch(message ?? "", /private\/user/);
  assert.ok(mock.commands.has("analytics"));
});
