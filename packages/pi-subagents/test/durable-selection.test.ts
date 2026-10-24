import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { DurableSubagentRuntime } from "../src/durable-runtime.js";

const legacyNames = ["subagent_spawn", "subagent_inspect", "subagent_cancel", "subagent_wait", "subagent_send"];
const durableNames = ["subagent_spawn", "subagent_send", "subagent_stop", "subagent_status", "subagent_wait"];
let root: string;
let agentDir: string;
let sdk: typeof import("@earendil-works/pi-coding-agent");
let ai: typeof import("@earendil-works/pi-ai");
let settings: typeof import("../src/settings.js");
let kernel: typeof import("../src/durable-runtime.js");
let legacyTools: typeof import("../src/tools.js");
let subagents: typeof import("../src/subagents.js").default;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "subagents-selection-"));
  agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  sdk = await import("@earendil-works/pi-coding-agent");
  ai = await import("@earendil-works/pi-ai");
  settings = await import("../src/settings.js");
  kernel = await import("../src/durable-runtime.js");
  legacyTools = await import("../src/tools.js");
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
async function put(durable: boolean) {
  await writeFile(join(agentDir, "pi-subagents.json"), JSON.stringify({ durable }));
}
function names(mock: ReturnType<typeof createMockPi>) {
  return mock.tools.map((tool) => tool.name);
}
function definitions(mock: ReturnType<typeof createMockPi>) {
  return JSON.parse(
    JSON.stringify(
      (mock.tools as unknown as ToolDefinition[]).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        constrainedSampling: tool.constrainedSampling,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
      })),
    ),
  );
}
async function emit(mock: ReturnType<typeof createMockPi>, event: string, ctx: ExtensionContext) {
  for (const handler of mock.events.get(event) ?? []) await handler({ type: event, reason: "test" }, ctx);
}
function context(persisted = false, ui?: ExtensionContext["ui"]) {
  const manager = persisted
    ? sdk.SessionManager.create(root, join(root, `sessions-${crypto.randomUUID()}`))
    : sdk.SessionManager.inMemory(root);
  if (persisted) manager.appendMessage({ role: "user", content: "Existing main history", timestamp: 1 });
  return createMockContext({ cwd: root, sessionManager: manager, mode: "json", ...(ui ? { ui } : {}) })
    .ctx as ExtensionContext;
}
function mockFixture(ctx = context()) {
  const mock = createMockPi();
  subagents(mock.pi);
  cleanup.push(() => emit(mock, "session_shutdown", ctx));
  return { mock, ctx };
}
function fakeRuntime() {
  return {
    resume: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    reports: vi.fn(async () => []),
    status: vi.fn(async () => ({ conversations: [] })),
  } as unknown as DurableSubagentRuntime;
}

it("factory load registers lifecycle and renderers, but does no settings, storage, broker or Pi action work", async () => {
  const readSettings = vi.spyOn(settings, "loadSubagentsSettings");
  const open = vi.spyOn(kernel.DurableSubagentRuntime, "open");
  const mock = createMockPi();
  const thinking = vi.spyOn(mock.rawPi, "getThinkingLevel").mockImplementation(() => {
    throw new Error("Factory action");
  });
  const broker = vi.fn();
  const runChild = vi.fn();
  subagents(mock.pi, { createBroker: broker, runChild });
  expect(names(mock)).toEqual([]);
  expect([...mock.messageRenderers.keys()]).toEqual(["pi-subagents-completion", "pi-subagents-message"]);
  expect(mock.events.has("session_start")).toBe(true);
  expect(mock.events.has("session_shutdown")).toBe(true);
  expect([...mock.commands.keys()]).toEqual(["subagents"]);
  expect(readSettings).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(thinking).not.toHaveBeenCalled();
  expect(broker).not.toHaveBeenCalled();
  expect(runChild).not.toHaveBeenCalled();
  expect(await readdir(agentDir)).toEqual([]);
});

it("absent settings preserve every default legacy definition after awaited session_start", async () => {
  const expected = createMockPi();
  const old = legacyTools.registerSubagentTools(expected.pi);
  cleanup.push(() => old.shutdown());
  const open = vi.spyOn(kernel.DurableSubagentRuntime, "open");
  const f = mockFixture();
  await emit(f.mock, "session_start", f.ctx);
  expect(names(f.mock)).toEqual(legacyNames);
  expect(definitions(f.mock)).toEqual(definitions(expected));
  expect(open).not.toHaveBeenCalled();
  expect(existsSync(join(agentDir, "pi-subagents.json"))).toBe(false);
  expect(existsSync(join(agentDir, "pi-subagents"))).toBe(false);
});

it("explicit durable enablement selects only durable definitions before the first request", async () => {
  await put(true);
  const open = vi.spyOn(kernel.DurableSubagentRuntime, "open");
  const f = mockFixture();
  expect(names(f.mock)).toEqual([]);
  await emit(f.mock, "session_start", f.ctx);
  expect(names(f.mock)).toEqual(durableNames);
  const baseline = definitions(f.mock);
  await emit(f.mock, "agent_settled", f.ctx);
  await emit(f.mock, "session_start", f.ctx);
  expect(definitions(f.mock)).toEqual(baseline);
  expect(open).not.toHaveBeenCalled();
});

it.each([false, true])("backend %s is frozen until a fresh reload runtime", async (initial) => {
  await put(initial);
  const f = mockFixture();
  await emit(f.mock, "session_start", f.ctx);
  const baseline = definitions(f.mock);
  await put(!initial);
  await emit(f.mock, "agent_settled", f.ctx);
  expect(definitions(f.mock)).toEqual(baseline);
  await expect(emit(f.mock, "session_start", f.ctx)).rejects.toThrow(/backend changed.*reload/i);
  expect(definitions(f.mock)).toEqual(baseline);
  await emit(f.mock, "session_shutdown", f.ctx);
  const replacement = mockFixture();
  await emit(replacement.mock, "session_start", replacement.ctx);
  expect(names(replacement.mock)).toEqual(initial ? legacyNames : durableNames);
});

it("shutdown while settings load invalidates startup before registering a family or opening resources", async () => {
  const entered = deferred();
  const gate = deferred<{ durable: boolean; warnings: string[] }>();
  vi.spyOn(settings, "loadSubagentsSettings").mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const open = vi.spyOn(kernel.DurableSubagentRuntime, "open");
  const f = mockFixture();
  const starting = emit(f.mock, "session_start", f.ctx);
  await entered.promise;
  const shutting = emit(f.mock, "session_shutdown", f.ctx);
  gate.resolve({ durable: true, warnings: [] });
  await Promise.all([starting, shutting]);
  expect(names(f.mock)).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  expect(f.mock.sentMessages).toEqual([]);
});

it("a superseded settings load cannot register its family into the newer session", async () => {
  const entered = deferred();
  const gate = deferred<{ durable: boolean; warnings: string[] }>();
  vi.spyOn(settings, "loadSubagentsSettings")
    .mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    })
    .mockResolvedValueOnce({ durable: false, warnings: [] });
  const f = mockFixture();
  const newer = context(false, f.ctx.ui);
  cleanup.push(() => emit(f.mock, "session_shutdown", newer));
  const first = emit(f.mock, "session_start", f.ctx);
  await entered.promise;
  const second = emit(f.mock, "session_start", newer);
  gate.resolve({ durable: true, warnings: [] });
  await Promise.all([first, second]);
  expect(names(f.mock)).toEqual(legacyNames);
});

it("shutdown during durable initialization must not resume the newly opened scheduler", async () => {
  await put(true);
  const opened = deferred();
  const gate = deferred<DurableSubagentRuntime>();
  const runtime = fakeRuntime();
  vi.spyOn(kernel.DurableSubagentRuntime, "open").mockImplementationOnce(async () => {
    opened.resolve();
    return gate.promise;
  });
  const f = mockFixture(context(true));
  const starting = emit(f.mock, "session_start", f.ctx);
  const settled = starting.catch(() => undefined);
  await opened.promise;
  const shutting = emit(f.mock, "session_shutdown", f.ctx);
  gate.resolve(runtime);
  await Promise.all([settled, shutting]);
  expect(runtime.resume).not.toHaveBeenCalled();
  expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  expect(f.mock.sentMessages).toEqual([]);
});

it("stale session shutdown cannot suspend the newer backend even with identical no-op UI", async () => {
  await put(true);
  const first = fakeRuntime();
  const second = fakeRuntime();
  vi.spyOn(kernel.DurableSubagentRuntime, "open").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const f = mockFixture(context(true));
  const newer = context(true, f.ctx.ui);
  cleanup.push(() => emit(f.mock, "session_shutdown", newer));
  await emit(f.mock, "session_start", f.ctx);
  await emit(f.mock, "session_start", newer);
  expect(first.shutdown).toHaveBeenCalledTimes(1);
  expect(f.ctx.ui).toBe(newer.ui);
  await emit(f.mock, "session_shutdown", f.ctx);
  expect(second.shutdown).not.toHaveBeenCalled();
  const status = (f.mock.tools as unknown as ToolDefinition[]).find((tool) => tool.name === "subagent_status");
  assert.ok(status);
  const toolCtx: ExtensionToolContext = {
    ...newer,
    tools: [],
    executeTool: async () => {
      throw new Error("Nested execution is not used by this fixture");
    },
  };
  await status.execute("new-status", {}, undefined, undefined, toolCtx);
  expect(second.status).toHaveBeenCalledTimes(1);
  await emit(f.mock, "session_shutdown", newer);
  expect(second.shutdown).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "public SDK selects durable=%s before first provider request and changes only after reload",
  async (initial) => {
    await put(initial);
    const faux = ai.createFauxCore({
      api: `selection-${crypto.randomUUID()}`,
      provider: `selection-${crypto.randomUUID()}`,
      tokenSize: { min: 100_000, max: 100_000 },
      models: [{ id: "main", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const captured: TranscriptContext[] = [];
    faux.setResponses(
      Array.from({ length: 8 }, () => (request: TranscriptContext) => {
        captured.push(structuredClone(request));
        return ai.fauxAssistantMessage("Original main answer");
      }),
    );
    const runtime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsStore: new ai.InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new sdk.ModelRegistry(runtime);
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "synthetic",
      baseUrl: "http://localhost:0",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const model = registry.find(faux.provider, "main");
    assert.ok(model);
    const manager = sdk.SessionManager.inMemory(root);
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const errors: unknown[] = [];
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      systemPrompt: "Stable original main instructions.",
      extensionFactories: [subagents],
    });
    await loader.reload();
    expect(loader.getExtensions().extensions[0]?.tools.size).toBe(0);
    const { session } = await sdk.createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager,
      sessionManager: manager,
      resourceLoader: loader,
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
    expect(session.getActiveToolNames()).toEqual(initial ? durableNames : legacyNames);
    await session.prompt("First ordinary turn");
    await put(!initial);
    await session.prompt("Second ordinary turn after manual settings edit");
    const normalize = (request: TranscriptContext) => ({
      system: ai.getCurrentSystemPrompt(request.messages),
      tools: ai.getCurrentTools(request.messages).map(ai.toToolDeclaration),
      messages: request.messages.map(({ role, content }) => ({ role, content })),
    });
    const first = normalize(captured[0] as TranscriptContext);
    const second = normalize(captured[1] as TranscriptContext);
    expect(first.tools.map((tool) => tool.name)).toEqual(initial ? durableNames : legacyNames);
    expect(second.system).toBe(first.system);
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    const prefix = structuredClone(session.messages);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(initial ? legacyNames : durableNames);
    expect(session.messages).toEqual(prefix);
    expect(session.sessionManager).toBe(manager);
    expect(session.model).toEqual(model);
    await session.prompt("First turn in explicit reload epoch");
    await session.prompt("Second turn in explicit reload epoch");
    const third = normalize(captured[2] as TranscriptContext);
    const fourth = normalize(captured[3] as TranscriptContext);
    expect(third.tools.map((tool) => tool.name)).toEqual(initial ? legacyNames : durableNames);
    expect(fourth.system).toBe(third.system);
    expect(fourth.tools).toEqual(third.tools);
    expect(fourth.messages.slice(0, third.messages.length)).toEqual(third.messages);
    expect(faux.state.callCount).toBe(4);
    expect(errors).toEqual([]);
    expect(custom).not.toHaveBeenCalled();
    expect(existsSync(join(agentDir, "pi-subagents"))).toBe(false);
  },
);
