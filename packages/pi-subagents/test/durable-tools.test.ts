import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { DurableRuntimeOptions, DurableSubagentRuntime } from "../src/durable-runtime.js";
import type { DurableReport } from "../src/durable-state.js";

let root: string;
let agentDir: string;
let ai: typeof import("@earendil-works/pi-ai");
let sdk: typeof import("@earendil-works/pi-coding-agent");
let chord: typeof import("@earendil-works/chord/context");
let registerDurableTools: typeof import("../src/durable-tools.js").registerDurableTools;
let subagents: typeof import("../src/subagents.js").default;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "subagents-tools-"));
  agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  ai = await import("@earendil-works/pi-ai");
  sdk = await import("@earendil-works/pi-coding-agent");
  chord = await import("@earendil-works/chord/context");
  ({ registerDurableTools } = await import("../src/durable-tools.js"));
  ({ default: subagents } = await import("../src/subagents.js"));
  expect(sdk.getAgentDir()).toBe(agentDir);
});
beforeEach(async () => {
  await mkdir(agentDir, { recursive: true });
});
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    await rm(agentDir, { recursive: true, force: true });
  }
});
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function toolsOf(mock: ReturnType<typeof createMockPi>) {
  return mock.tools as unknown as ToolDefinition[];
}
function toolContext(ctx: ExtensionContext): ExtensionToolContext {
  return {
    ...ctx,
    tools: [],
    executeTool: async () => {
      throw new Error("Nested tool execution is not used by this fixture");
    },
  };
}
function definition(tool: ToolDefinition) {
  return JSON.parse(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
    }),
  );
}
function fakeRuntime() {
  return {
    resume: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    reports: vi.fn(async () => []),
    status: vi.fn(async () => ({ conversations: [] })),
  } as unknown as DurableSubagentRuntime;
}
async function ownerFixture(runtime = fakeRuntime(), empty = false) {
  const mock = createMockPi();
  const value = sdk.SessionManager.create(root, join(root, `sessions-${crypto.randomUUID()}`));
  if (!empty) value.appendMessage({ role: "user", content: "Existing main conversation", timestamp: 1 });
  mock.rawPi.appendEntry = (type, data) => {
    value.appendCustomEntry(type, data);
  };
  const ctx = createMockContext({ cwd: root, sessionManager: value, modelRegistry: {}, mode: "json", hasUI: false })
    .ctx as ExtensionContext;
  const opened = deferred();
  const gate = deferred();
  const openRuntime = vi.fn(async (_options: DurableRuntimeOptions) => {
    opened.resolve();
    await gate.promise;
    return runtime;
  });
  const registered = registerDurableTools(mock.pi, { openRuntime });
  cleanup.push(() => registered.shutdown(ctx));
  return { mock, value, ctx, registered, openRuntime, opened, gate, runtime };
}

it("registers exactly five durable definitions with string conversation IDs and no legacy addressing", () => {
  const mock = createMockPi();
  registerDurableTools(mock.pi);
  const tools = toolsOf(mock);
  expect(tools.map((tool) => tool.name)).toEqual([
    "subagent_spawn",
    "subagent_send",
    "subagent_stop",
    "subagent_status",
    "subagent_wait",
  ]);
  const [spawn, send, stop, status, wait] = tools;
  assert.ok(spawn && send && stop && status && wait);
  expect(Object.keys((spawn.parameters as { properties: object }).properties)).toEqual([
    "task",
    "tools",
    "skills",
    "extensions",
    "thinkingLevel",
    "timeout",
  ]);
  for (const tool of [send, stop, wait]) {
    expect(Check(tool.parameters, { conversationId: "2", ...(tool === send ? { message: "Hello" } : {}) })).toBe(true);
    for (const conversationId of [2, "", "0", "-1", "2.5", "2\u001b[2J"]) {
      expect(Check(tool.parameters, { conversationId, ...(tool === send ? { message: "Hello" } : {}) })).toBe(false);
    }
    expect(
      Check(tool.parameters, { jobId: "job_old", recipient: "main", requestId: "req_old", message: "Hello" }),
    ).toBe(false);
  }
  expect(
    (spawn.parameters as { properties: { timeout: { description: string } } }).properties.timeout.description,
  ).toMatch(/spawn.*execution.*wait.*waiter/i);
  expect(Check(status.parameters, {})).toBe(true);
  expect(Check(status.parameters, { conversationId: "2" })).toBe(true);
  expect(Check(spawn.parameters, { task: "Task", skills: [], extensions: [], tools: ["read"] })).toBe(true);
  expect(Check(send.parameters, { conversationId: "2", message: "Next", whenBusy: "followUp" })).toBe(true);
  expect(Check(send.parameters, { conversationId: "2", message: "Next", whenBusy: "invalid" })).toBe(false);
  expect(spawn.description).toMatch(/unsupported.*rejected/i);
  expect(send.description).toMatch(/not the legacy requestId/i);
  expect(wait.description).toMatch(/Timeout or caller cancellation stops only the wait/i);
  expect(wait.prepareArguments?.({ conversationId: "2", timeoutMs: 250 })).toEqual({
    conversationId: "2",
    timeout: 0.25,
  });
  expect(mock.commands.size).toBe(0);
});

it.each([
  { task: "Task", skills: ["local-skill"] },
  { task: "Task", extensions: [{ path: "./extension.ts", tools: [] }] },
  ...["grep", "find", "ls", "codemode"].map((tool) => ({ task: "Task", tools: [tool] })),
])("rejects unsupported capabilities before store or provider work: %j", async (params) => {
  const mock = createMockPi();
  const openRuntime = vi.fn();
  registerDurableTools(mock.pi, { openRuntime });
  const spawn = toolsOf(mock)[0];
  assert.ok(spawn);
  await expect(spawn.execute("spawn", params, undefined, undefined, createMockContext().ctx)).rejects.toThrow(
    /does not support|unsupported tools/i,
  );
  expect(openRuntime).not.toHaveBeenCalled();
  expect(await readdir(agentDir)).toEqual([]);
});

it("starts an empty session without opening storage and rejects use after shutdown", async () => {
  const f = await ownerFixture(undefined, true);
  await f.registered.startSession(f.ctx);
  expect(f.openRuntime).not.toHaveBeenCalled();
  await f.registered.shutdown(f.ctx);
  const status = toolsOf(f.mock).find((tool) => tool.name === "subagent_status");
  assert.ok(status);
  await expect(status.execute("status", {}, undefined, undefined, toolContext(f.ctx))).rejects.toThrow(/not started/i);
  expect(await readdir(agentDir)).toEqual([]);
});

it("initialization failures are observable and shutdown remains safe after partial setup", async () => {
  const f = await ownerFixture();
  f.openRuntime.mockRejectedValueOnce(new Error("Synthetic storage failure"));
  await expect(f.registered.startSession(f.ctx)).rejects.toThrow("Synthetic storage failure");
  const status = toolsOf(f.mock).find((tool) => tool.name === "subagent_status");
  assert.ok(status);
  await expect(status.execute("status", {}, undefined, undefined, toolContext(f.ctx))).rejects.toThrow(
    "Synthetic storage failure",
  );
  expect(f.openRuntime).toHaveBeenCalledTimes(1);
  await f.registered.shutdown(f.ctx);
  await f.registered.shutdown(f.ctx);
  expect(f.runtime.resume).not.toHaveBeenCalled();
  expect(f.mock.sentMessages).toEqual([]);
});

it("shutdown during initialization closes the returned runtime without resuming or publishing", async () => {
  const f = await ownerFixture();
  const starting = f.registered.startSession(f.ctx);
  const rejected = expect(starting).rejects.toThrow(/stopped|stale|suspended/i);
  await f.opened.promise;
  const shutting = f.registered.shutdown(f.ctx);
  f.gate.resolve();
  await Promise.all([shutting, rejected]);
  expect(f.runtime.shutdown).toHaveBeenCalledTimes(1);
  expect(f.runtime.resume).not.toHaveBeenCalled();
  expect(f.mock.sentMessages).toEqual([]);
  await f.registered.shutdown(f.ctx);
  expect(f.runtime.shutdown).toHaveBeenCalledTimes(1);
});

it("isolates owners by SessionManager even when headless sessions share the same no-op UI", async () => {
  const mock = createMockPi();
  const first = fakeRuntime();
  const second = fakeRuntime();
  const openRuntime = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const registered = registerDurableTools(mock.pi, { openRuntime });
  const ui = (createMockContext().ctx as ExtensionContext).ui;
  const contexts = [0, 1].map((index) => {
    const manager = sdk.SessionManager.create(root, join(root, `owners-${index}-${crypto.randomUUID()}`));
    manager.appendMessage({ role: "user", content: "Persisted", timestamp: 1 });
    return createMockContext({ cwd: root, sessionManager: manager, ui, modelRegistry: {}, mode: "json" })
      .ctx as ExtensionContext;
  });
  for (const ctx of contexts) cleanup.push(() => registered.shutdown(ctx));
  const a = contexts[0];
  const b = contexts[1];
  assert.ok(a && b);
  await registered.startSession(a);
  await registered.startSession(b);
  expect(a.ui).toBe(b.ui);
  await registered.shutdown(a);
  await registered.shutdown(a);
  expect(first.shutdown).toHaveBeenCalledTimes(1);
  expect(second.shutdown).not.toHaveBeenCalled();
  const status = toolsOf(mock).find((tool) => tool.name === "subagent_status");
  assert.ok(status);
  await status.execute("new-status", {}, undefined, undefined, toolContext(b));
  expect(second.status).toHaveBeenCalledTimes(1);
  expect(openRuntime).toHaveBeenCalledTimes(2);
});

it("drains a completion that arrives while an earlier report snapshot is being flushed", async () => {
  const f = await ownerFixture();
  f.gate.resolve();
  await f.registered.startSession(f.ctx);
  const { deriveBinding, DURABLE_REPORT_TYPE } = await import("../src/durable-main-bridge.js");
  const bridge = await deriveBinding(f.mock.pi, f.ctx, () => undefined);
  await bridge.admit("first-request", { tool: "spawn", task: "first" });
  await bridge.admit("second-request", { tool: "spawn", task: "second" });
  const pending: DurableReport[] = [
    {
      id: "report-first",
      conversationId: "2",
      requestId: "first-request",
      outcome: "completed",
      result: "first result",
      error: null,
      acknowledged: false,
      suppressed: false,
    },
  ];
  const acknowledgements: string[] = [];
  f.runtime.report = vi.fn(async (id) => pending.find((report) => report.id === id));
  f.runtime.acknowledge = vi.fn(async (id) => {
    const report = pending.find((item) => item.id === id);
    assert.ok(report);
    report.acknowledged = true;
    acknowledgements.push(id);
  });
  const entered = deferred();
  const release = deferred();
  f.runtime.reports = vi.fn(async () => pending.filter((report) => !report.acknowledged));
  vi.mocked(f.runtime.reports).mockImplementationOnce(async () => {
    const snapshot = [...pending];
    entered.resolve();
    await release.promise;
    return snapshot;
  });
  f.mock.rawPi.sendMessage = (message, _options) => {
    const value = message as { customType: string; content: string; display: boolean; details: unknown };
    f.value.appendCustomMessageEntry(value.customType, value.content, value.display, value.details);
  };
  const options = f.openRuntime.mock.calls[0]?.[0];
  assert.ok(options);
  options.changed?.();
  await entered.promise;
  pending.push({
    ...(pending[0] as DurableReport),
    id: "report-second",
    conversationId: "3",
    requestId: "second-request",
    result: "second result",
  });
  options.changed?.();
  release.resolve();
  await f.registered.settled(f.ctx);
  expect(acknowledgements).toEqual(["report-first", "report-second"]);
  expect(f.runtime.reports).toHaveBeenCalledTimes(2);
  const saved = sdk.SessionManager.open(f.value.getSessionFile() as string)
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === DURABLE_REPORT_TYPE);
  expect(saved).toHaveLength(2);
});

async function sdkFixture() {
  await writeFile(join(agentDir, "pi-subagents.json"), JSON.stringify({ durable: true }));
  const faux = ai.createFauxCore({
    api: `tools-${crypto.randomUUID()}`,
    provider: `tools-${crypto.randomUUID()}`,
    tokenSize: { min: 100_000, max: 100_000 },
    models: [{ id: "test", contextWindow: 100_000, maxTokens: 1_000 }],
  });
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsStore: new ai.InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new sdk.ModelRegistry(runtime);
  registry.registerProvider(faux.provider, {
    api: faux.api,
    apiKey: "synthetic-only",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const model = registry.find(faux.provider, "test");
  assert.ok(model);
  const manager = sdk.SessionManager.create(root, join(root, `sdk-${crypto.randomUUID()}`));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const errors: unknown[] = [];
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    systemPrompt: "Original Pi main instructions.",
    extensionFactories: [subagents],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions[0]?.tools.size).toBe(0);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const custom = vi.fn(async () => {
    throw new Error("No custom UI in JSON mode");
  });
  await session.bindExtensions({
    mode: "json",
    uiContext: { ...session.extensionRunner.getUIContext(), custom },
    onError: (error) => errors.push(error),
  });
  expect(errors).toEqual([]);
  expect(session.getActiveToolNames()).toEqual([
    "subagent_spawn",
    "subagent_send",
    "subagent_stop",
    "subagent_status",
    "subagent_wait",
  ]);
  const mainRequests: TranscriptContext[] = [];
  const childRequests: TranscriptContext[] = [];
  const actions = new Map<string, { name: string; params: ToolCall["arguments"] }>();
  const entered = deferred();
  const release = deferred();
  faux.setResponses(
    Array.from({ length: 80 }, () => async (request, options) => {
      const system = ai.getCurrentSystemPrompt(request.messages);
      const child = system.includes("You are an isolated subagent.");
      (child ? childRequests : mainRequests).push(structuredClone(request));
      const user = [...request.messages].reverse().find((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      if (child) {
        if (text === "blocked") {
          entered.resolve();
          await chord.awaitWithContext(
            release.promise,
            chord.withAbortSignal(options?.signal ?? new AbortController().signal, chord.BACKGROUND_CONTEXT),
          );
        }
        return ai.fauxAssistantMessage(`child:${text}`);
      }
      const action = actions.get(text ?? "");
      if (action && request.messages.at(-1)?.role === "user")
        return ai.fauxAssistantMessage([ai.fauxToolCall(action.name, action.params, { id: `call-${text}` })], {
          stopReason: "toolUse",
        });
      return ai.fauxAssistantMessage("Original Pi main reply");
    }),
  );
  async function invoke(name: string, params: ToolCall["arguments"]) {
    const key = `action-${actions.size}`;
    actions.set(key, { name, params });
    await session.prompt(key);
    expect(errors).toEqual([]);
    const result = [...session.messages]
      .reverse()
      .find((message) => message.role === "toolResult" && message.toolCallId === `call-${key}`);
    assert.ok(result?.role === "toolResult", JSON.stringify(session.messages));
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const text = result.content.find((content) => content.type === "text");
    assert.ok(text?.type === "text");
    return { value: JSON.parse(text.text), details: result.details, result };
  }
  return { session, manager, faux, model, mainRequests, childRequests, invoke, entered, release, custom };
}
function normalize(request: TranscriptContext) {
  return {
    system: ai.getCurrentSystemPrompt(request.messages),
    tools: ai.getCurrentTools(request.messages).map(ai.toToolDeclaration),
    messages: request.messages.map(({ role, content }) => ({ role, content })),
  };
}
function assertStableRequests(requests: TranscriptContext[]) {
  for (let index = 1; index < requests.length; index++) {
    const before = normalize(requests[index - 1] as TranscriptContext);
    const after = normalize(requests[index] as TranscriptContext);
    expect(after.system).toEqual(before.system);
    expect(after.tools).toEqual(before.tools);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  }
}

describe.skipIf(process.platform !== "linux")("selected durable tools through original public Pi AgentSession", () => {
  it("runs all five tools, persists wait receipts, retains child history, stops and reuses a conversation", async () => {
    const f = await sdkFixture();
    const manager = f.session.sessionManager;
    const mainModel = f.session.model;
    const definitions = f.session.extensionRunner
      .getAllRegisteredTools()
      .map(({ definition: tool }) => definition(tool));
    const spawn = await f.invoke("subagent_spawn", { task: "alpha" });
    const id = spawn.value.conversationId;
    expect(id).toMatch(/^[1-9]\d*$/u);
    expect(spawn.value.jobId).toBeUndefined();
    const waited = await f.invoke("subagent_wait", { conversationId: id, timeout: 1 });
    expect(waited.value).toMatchObject({
      conversationId: id,
      timedOut: false,
      outcome: "completed",
      result: "child:alpha",
    });
    expect(waited.value.reportIds).toBeUndefined();
    expect(waited.value.piSubagentsDurable).toBeUndefined();
    expect(waited.details).toMatchObject({
      piSubagentsDurable: { storeKey: expect.stringMatching(/^[a-f0-9]{64}$/u), reportIds: [expect.any(String)] },
    });
    const disk = sdk.SessionManager.open(f.manager.getSessionFile() as string);
    expect(disk.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "toolResult",
          toolName: "subagent_wait",
          details: waited.details as unknown,
        }),
      }),
    );
    expect((await f.invoke("subagent_status", {})).value).toMatchObject({
      conversations: [{ conversationId: id, state: "idle" }],
    });
    await f.invoke("subagent_send", { conversationId: id, message: "beta", whenBusy: "followUp" });
    expect((await f.invoke("subagent_wait", { conversationId: id, timeout: 1 })).value).toMatchObject({
      result: "child:beta",
      outcome: "completed",
    });
    assertStableRequests(f.childRequests);
    expect(ai.getCurrentTools(f.childRequests[0]?.messages ?? []).map((tool) => tool.name)).toEqual(["read"]);
    expect(JSON.stringify(f.childRequests)).not.toMatch(/action-0|Original Pi main reply/);
    expect(JSON.stringify(f.childRequests.at(-1)?.messages)).toContain("child:alpha");
    expect(JSON.stringify(f.childRequests)).not.toContain("Original Pi main instructions.");
    await f.invoke("subagent_send", { conversationId: id, message: "blocked" });
    await f.entered.promise;
    expect((await f.invoke("subagent_stop", { conversationId: id })).value).toEqual({
      conversationId: id,
      state: "idle",
    });
    expect((await f.invoke("subagent_wait", { conversationId: id, timeout: 1 })).value).toMatchObject({
      outcome: "cancelled",
      state: "idle",
    });
    await f.invoke("subagent_send", { conversationId: id, message: "reuse" });
    expect((await f.invoke("subagent_wait", { conversationId: id, timeout: 1 })).value).toMatchObject({
      outcome: "completed",
      result: "child:reuse",
    });
    const status = await f.invoke("subagent_status", { conversationId: id });
    expect(status.value).toMatchObject({ conversations: [{ conversationId: id, state: "idle" }] });
    expect(JSON.stringify(status.value)).not.toMatch(/alpha|beta|blocked|reuse|synthetic-only/);
    expect(f.session.sessionManager).toBe(manager);
    expect(f.session.model).toBe(mainModel);
    expect(f.session.getLastAssistantText()).toBe("Original Pi main reply");
    expect(f.session.extensionRunner.getAllRegisteredTools().map(({ definition: tool }) => definition(tool))).toEqual(
      definitions,
    );
    await f.session.prompt("Ordinary main turn");
    assertStableRequests(f.mainRequests);
    expect(f.custom).not.toHaveBeenCalled();
    expect(existsSync(join(agentDir, "pi-subagents"))).toBe(true);
  });

  it("a saved explicit wait receipt prevents a second automatic completion message", async () => {
    const f = await sdkFixture();
    const spawn = await f.invoke("subagent_spawn", { task: "blocked" });
    const conversationId = spawn.value.conversationId;
    await f.entered.promise;
    const waitStarted = deferred();
    const unsubscribe = f.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "subagent_wait") waitStarted.resolve();
    });
    cleanup.push(async () => unsubscribe());
    const waiting = f.invoke("subagent_wait", { conversationId, timeout: 1 });
    await waitStarted.promise;
    f.release.resolve();
    const waited = await waiting;
    expect(waited.value).toMatchObject({ outcome: "completed", result: "child:blocked" });
    await f.session.extensionRunner.emit({ type: "agent_settled", aborted: false });
    const { DURABLE_REPORT_TYPE } = await import("../src/durable-main-bridge.js");
    const entries = sdk.SessionManager.open(f.manager.getSessionFile() as string).getBranch();
    expect(
      entries.filter((entry) => entry.type === "custom_message" && entry.customType === DURABLE_REPORT_TYPE),
    ).toEqual([]);
    expect((await f.invoke("subagent_status", { conversationId })).value).toMatchObject({
      conversations: [{ state: "idle" }],
    });
    expect(f.faux.state.callCount).toBe(7);
  });

  it("a wait timeout or caller cancellation does not stop accepted durable work", async () => {
    const f = await sdkFixture();
    const spawn = await f.invoke("subagent_spawn", { task: "blocked" });
    const conversationId = spawn.value.conversationId;
    await f.entered.promise;
    expect((await f.invoke("subagent_wait", { conversationId, timeout: 0.001 })).value).toMatchObject({
      timedOut: true,
      state: "running",
    });
    const wait = f.session.extensionRunner.getToolDefinition("subagent_wait");
    assert.ok(wait);
    const controller = new AbortController();
    const waiting = wait.execute(
      "cancel-wait",
      { conversationId },
      controller.signal,
      undefined,
      f.session.extensionRunner.createToolContext("cancel-wait", controller.signal),
    );
    const rejected = expect(waiting).rejects.toThrow();
    controller.abort(new Error("Only the caller stopped"));
    await rejected;
    expect((await f.invoke("subagent_status", { conversationId })).value).toMatchObject({
      conversations: [{ state: "running", outcome: null }],
    });
    f.release.resolve();
    expect((await f.invoke("subagent_wait", { conversationId, timeout: 1 })).value).toMatchObject({
      timedOut: false,
      outcome: "completed",
      result: "child:blocked",
    });
    expect(f.custom).not.toHaveBeenCalled();
  });
});
