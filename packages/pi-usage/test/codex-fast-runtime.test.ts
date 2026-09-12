import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { correctCodexFastMessageCost } from "../src/codex-fast.js";
import { registerCodexFastMode } from "../src/codex-fast-runtime.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";

const codexModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function memoryRuntime(
  options: {
    kind?: UsageSettingsState["kind"];
    enabled?: boolean;
    failUpdates?: number;
    reload?: () => Promise<UsageSettingsState>;
  } = {},
) {
  let state: UsageSettingsState = {
    kind: options.kind ?? "loaded",
    path: "/tmp/pi-usage.json",
    settings: {
      codexFastMode: options.enabled ?? false,
      codexStatusResetCountdown: false,
      selectedTargets: {},
    },
    ...(options.kind === "invalid" ? { issue: "bad file" } : { document: {} }),
  };
  let failUpdates = options.failUpdates ?? 0;
  let flushes = 0;
  const patches: unknown[] = [];
  const runtime: UsageSettingsRuntime = {
    get: () => structuredClone(state),
    async reload() {
      if (options.reload) state = await options.reload();
      return structuredClone(state);
    },
    async update(patch, signal) {
      signal?.throwIfAborted();
      patches.push(patch);
      if (failUpdates > 0) {
        failUpdates -= 1;
        throw new Error("disk full");
      }
      state = {
        ...state,
        kind: "loaded",
        settings: { ...state.settings, ...patch },
        document: { ...state.document, ...patch },
      };
      return structuredClone(state);
    },
    async updateSelectedTarget() {
      throw new Error("target selection is not used in Codex Fast tests");
    },
    async flush() {
      flushes += 1;
    },
  };
  return {
    runtime,
    patches,
    get state() {
      return state;
    },
    get flushes() {
      return flushes;
    },
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    hasUI: true,
    mode: "rpc",
    model: codexModel,
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [],
      getEntries: () => [],
    },
    ...overrides,
  });
}

test("/fast toggles one persistent setting on and off with visible usage guidance", async () => {
  const memory = memoryRuntime();
  const mock = createMockPi();
  let refreshes = 0;
  registerCodexFastMode(mock.pi, memory.runtime, () => {
    refreshes += 1;
  });
  const command = mock.commands.get("fast");
  assert.ok(command);
  const first = context();
  await command.handler("", first.ctx);
  assert.equal(memory.state.settings.codexFastMode, true);
  assert.match(first.notifications[0]?.message ?? "", /1\.5× faster.*uses more/);
  const second = context();
  await command.handler("", second.ctx);
  assert.equal(memory.state.settings.codexFastMode, false);
  assert.match(second.notifications[0]?.message ?? "", /standard routing/);
  assert.equal(refreshes, 2);
});

test("/fast rejects arguments and unsafe modes before mutation", async () => {
  const memory = memoryRuntime();
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
  const command = mock.commands.get("fast");
  assert.ok(command);
  const rpc = context();
  await command.handler("on", rpc.ctx);
  assert.match(rpc.notifications[0]?.message ?? "", /does not accept arguments/);
  const print = context({ hasUI: false, mode: "print" });
  await assert.rejects(Promise.resolve(command.handler("", print.ctx)), /requires TUI or RPC/);
  const json = context({ hasUI: false, mode: "json" });
  await assert.rejects(Promise.resolve(command.handler("on", json.ctx)), /does not accept arguments/);
  assert.deepEqual(memory.patches, []);
});

test("/fast rejects foreign, unsupported, custom-origin, and invalid-file contexts", async () => {
  for (const currentModel of [
    { ...codexModel, provider: "openrouter" },
    { ...codexModel, id: "gpt-5.4-mini" },
    { ...codexModel, baseUrl: "https://proxy.example.test" },
  ]) {
    const memory = memoryRuntime();
    const mock = createMockPi();
    registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
    const current = context({ model: currentModel });
    await mock.commands.get("fast")?.handler("", current.ctx);
    assert.deepEqual(memory.patches, []);
    assert.equal(current.notifications[0]?.level, "warning");
  }
  const invalid = memoryRuntime({ kind: "invalid" });
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, invalid.runtime, () => undefined);
  const current = context();
  await mock.commands.get("fast")?.handler("", current.ctx);
  assert.deepEqual(invalid.patches, []);
  assert.equal(current.notifications[0]?.level, "error");
});

test("failed persistence rolls back effective state and the queue permits retry", async () => {
  const memory = memoryRuntime({ failUpdates: 1 });
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
  const command = mock.commands.get("fast");
  assert.ok(command);
  const failed = context();
  await command.handler("", failed.ctx);
  assert.equal(memory.state.settings.codexFastMode, false);
  assert.match(failed.notifications[0]?.message ?? "", /disk full/);
  const retried = context();
  await command.handler("", retried.ctx);
  assert.equal(memory.state.settings.codexFastMode, true);
});

test("provider payload captures the toggle state when its hook begins", async () => {
  const memory = memoryRuntime();
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
  const hook = mock.events.get("before_provider_request")?.[0];
  assert.ok(hook);
  const current = context();
  const before = await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
  await mock.commands.get("fast")?.handler("", current.ctx);
  const after = await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
  assert.deepEqual(before, { model: "gpt-5.4", service_tier: "default" });
  assert.deepEqual(after, { model: "gpt-5.4", service_tier: "priority" });
});

test("cost correction follows the captured request tier across a later toggle", async () => {
  const memory = memoryRuntime();
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
  const hook = mock.events.get("before_provider_request")?.[0];
  const messageEnd = mock.events.get("message_end")?.[0];
  assert.ok(hook);
  assert.ok(messageEnd);
  const current = context();
  await mock.commands.get("fast")?.handler("", current.ctx);
  await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
  await mock.commands.get("fast")?.handler("", current.ctx);
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 130,
    cost: {
      input: 0.00025,
      output: 0.0003,
      cacheRead: 0.0000025,
      cacheWrite: 0,
      total: 0.0005525,
    },
  };
  const correction = (await messageEnd(
    {
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4",
        usage,
      },
    },
    current.ctx,
  )) as { message?: { usage: typeof usage } };
  assert.equal(correction.message?.usage.cost.total, usage.cost.total * 2);
  assert.equal(
    await messageEnd(
      {
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage,
        },
      },
      current.ctx,
    ),
    undefined,
    "one request marker is consumed exactly once",
  );
});

test("an already-correct cost still consumes its request marker", async () => {
  const memory = memoryRuntime({ enabled: true });
  const mock = createMockPi();
  registerCodexFastMode(mock.pi, memory.runtime, () => undefined);
  const hook = mock.events.get("before_provider_request")?.[0];
  const messageEnd = mock.events.get("message_end")?.[0];
  assert.ok(hook);
  assert.ok(messageEnd);
  const current = context();
  await hook({ payload: { model: "gpt-5.4" } }, current.ctx);
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 130,
    cost: {
      input: 0.0005,
      output: 0.0006,
      cacheRead: 0.000005,
      cacheWrite: 0,
      total: 0.001105,
    },
  };
  const alreadyCorrect = correctCodexFastMessageCost(
    {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-5.4",
      usage,
    },
    codexModel as never,
    true,
  ) as { usage: typeof usage };
  assert.ok(alreadyCorrect);
  const event = { message: alreadyCorrect };
  assert.equal(await messageEnd(event, current.ctx), undefined);
  alreadyCorrect.usage.cost.total = 0;
  assert.equal(
    await messageEnd(event, current.ctx),
    undefined,
    "the completed request cannot affect a later assistant message",
  );
});

test("session reload warns for invalid settings, refreshes status, and shutdown flushes", async () => {
  const memory = memoryRuntime({ kind: "invalid" });
  const mock = createMockPi();
  let refreshes = 0;
  registerCodexFastMode(mock.pi, memory.runtime, () => {
    refreshes += 1;
  });
  const current = context();
  await mock.events.get("session_start")?.[0]?.({}, current.ctx);
  assert.match(current.notifications[0]?.message ?? "", /Invalid pi-usage\.json/);
  assert.equal(refreshes, 1);
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
  assert.equal(memory.flushes, 1);
});

test("session replacement aborts stale loads and accepted writes before UI publication", async () => {
  let releaseLoad!: (state: UsageSettingsState) => void;
  const slowLoad = new Promise<UsageSettingsState>((resolve) => {
    releaseLoad = resolve;
  });
  const memory = memoryRuntime({ reload: () => slowLoad });
  const mock = createMockPi();
  let refreshes = 0;
  registerCodexFastMode(mock.pi, memory.runtime, () => {
    refreshes += 1;
  });
  const first = context();
  const pendingLoad = mock.events.get("session_start")?.[0]?.({}, first.ctx);
  await mock.events.get("session_shutdown")?.[0]?.({}, first.ctx);
  releaseLoad({
    kind: "loaded",
    path: "/tmp/pi-usage.json",
    settings: { codexFastMode: true, codexStatusResetCountdown: false, selectedTargets: {} },
    document: { codexFastMode: true },
  });
  await pendingLoad;
  assert.equal(refreshes, 0);
  assert.deepEqual(first.notifications, []);
});
