import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableRuntimeOptions, DurableSubagentRuntime } from "../src/durable-runtime.js";
import type { DurableReport } from "../src/durable-state.js";

let root: string;
let agentDir: string;
let ai: typeof import("@earendil-works/pi-ai");
let sdk: typeof import("@earendil-works/pi-coding-agent");
let durable: typeof import("@earendil-works/pi-durable");
let kernel: typeof import("../src/durable-runtime.js");
let bridge: typeof import("../src/durable-main-bridge.js");
let subagents: typeof import("../src/subagents.js").default;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "subagents-authorization-"));
  agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  ai = await import("@earendil-works/pi-ai");
  sdk = await import("@earendil-works/pi-coding-agent");
  durable = await import("@earendil-works/pi-durable");
  kernel = await import("../src/durable-runtime.js");
  bridge = await import("../src/durable-main-bridge.js");
  ({ default: subagents } = await import("../src/subagents.js"));
  expect(sdk.getAgentDir()).toBe(agentDir);
});
beforeEach(async () => {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "pi-subagents.json"), JSON.stringify({ durable: true }));
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
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function bytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await bytes(path))) result[join(entry.name, name)] = value;
    } else result[entry.name] = (await readFile(path)).toString("base64");
  }
  return result;
}
function value(
  result: Awaited<ReturnType<NonNullable<ReturnType<AgentSession["extensionRunner"]["getToolDefinition"]>>["execute"]>>,
) {
  const text = result.content.find((part) => part.type === "text");
  assert.ok(text?.type === "text");
  return JSON.parse(text.text);
}

async function providerFixture(initiallyAvailable = true) {
  const id = `authorization-${crypto.randomUUID()}`;
  const faux = ai.createFauxCore({
    api: id,
    provider: id,
    tokenSize: { min: 100_000, max: 100_000 },
    models: [{ id: "chat", contextWindow: 100_000, maxTokens: 1_000 }],
  });
  faux.setResponses(Array.from({ length: 20 }, () => () => ai.fauxAssistantMessage("saved child answer")));
  let key: string | undefined = initiallyAvailable ? "synthetic-fixture-one" : undefined;
  let checkGate: ((signal: AbortSignal) => Promise<void>) | undefined;
  const checkedSignals: AbortSignal[] = [];
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsStore: new ai.InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new sdk.ModelRegistry(runtime);
  registry.registerProvider(
    ai.createProvider({
      id,
      models: faux.models as Model<Api>[],
      auth: {
        apiKey: {
          name: "Synthetic fixture",
          check: async ({ signal }) => {
            checkedSignals.push(signal);
            await checkGate?.(signal);
            return key ? { type: "api_key" } : undefined;
          },
          resolve: async () => (key ? { auth: { apiKey: key } } : undefined),
        },
      },
      api: { stream: faux.streamSimple, streamSimple: faux.streamSimple },
    }),
  );
  // Settle registration's automatic refresh before changing the dynamic auth source.
  // No refresh occurs after the change under test.
  await registry.refresh({ allowNetwork: false });
  const model = registry.find(id, "chat");
  assert.ok(model);
  expect(registry.hasConfiguredAuth(model)).toBe(initiallyAvailable);
  return {
    runtime,
    registry,
    model,
    faux,
    checkedSignals,
    setKey(next: string | undefined) {
      key = next;
    },
    gateCheck(gate: (signal: AbortSignal) => Promise<void>) {
      checkGate = gate;
    },
  };
}

async function sessionFixture(
  provider: Awaited<ReturnType<typeof providerFixture>>,
  options: { manager?: SessionManager; bind?: boolean; notifyThrows?: boolean } = {},
) {
  const manager = options.manager ?? sdk.SessionManager.create(root, join(root, `main-${crypto.randomUUID()}`));
  if (!options.manager) manager.appendMessage({ role: "user", content: "Persisted main conversation", timestamp: 1 });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const errors: unknown[] = [];
  const notices: string[] = [];
  const warned = deferred();
  let ghost = false;
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        const send = pi.sendMessage;
        pi.sendMessage = (message, delivery) => {
          if (!ghost) return send(message, delivery);
          const file = manager.getSessionFile();
          assert.ok(file);
          // Exercise Pi's real swallowed append failure: memory advances, disk does not.
          renameSync(file, `${file}.saved`);
          mkdirSync(file);
          try {
            send(message, delivery);
          } finally {
            rmSync(file, { recursive: true });
            renameSync(`${file}.saved`, file);
          }
        };
        subagents(pi);
      },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: provider.runtime,
    model: provider.model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  cleanup.push(close);
  const notify = vi.fn((message: string) => {
    notices.push(message);
    warned.resolve();
    if (options.notifyThrows) throw new Error("Synthetic notification failure");
  });
  async function bind() {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
      onError: (error) => errors.push(error),
    });
  }
  async function invoke(name: string, params: Record<string, unknown> = {}, id: string = crypto.randomUUID()) {
    const tool = session.extensionRunner.getToolDefinition(name);
    assert.ok(tool, name);
    const ctx = session.extensionRunner.createToolContext(id, undefined);
    return tool.execute(id, params, undefined, undefined, ctx);
  }
  if (options.bind !== false) await bind();
  return {
    session,
    manager,
    errors,
    notices,
    warned,
    notify,
    invoke,
    bind,
    close,
    ghostReports() {
      ghost = true;
    },
  };
}

function captureRuntime() {
  const nativeOpen = kernel.DurableSubagentRuntime.open;
  const opened: { options: DurableRuntimeOptions; runtime: DurableSubagentRuntime }[] = [];
  const open = vi.spyOn(kernel.DurableSubagentRuntime, "open").mockImplementation(async (options) => {
    const runtime = await nativeOpen(options);
    opened.push({ options, runtime });
    return runtime;
  });
  return { open, opened };
}
async function seed(provider: Awaited<ReturnType<typeof providerFixture>>) {
  const capture = captureRuntime();
  const session = await sessionFixture(provider);
  expect(session.errors).toEqual([]);
  const spawned = value(await session.invoke("subagent_spawn", { task: "Complete the fixture assignment" }, "seed"));
  const waited = value(await session.invoke("subagent_wait", { conversationId: spawned.conversationId, timeout: 1 }));
  expect(waited).toMatchObject({ outcome: "completed", result: "saved child answer" });
  const saved = capture.opened[0];
  assert.ok(saved);
  await session.close();
  return { ...session, ...capture, saved, conversationId: spawned.conversationId as string };
}

describe.skipIf(process.platform !== "linux")("durable controller live authorization", () => {
  it("blocks revoked credentials despite a positive snapshot before Harness open or resume and preserves store bytes", async () => {
    const provider = await providerFixture();
    const first = await seed(provider);
    const before = await bytes(first.saved.options.directory);
    const mainBefore = await readFile(first.manager.getSessionFile() as string);
    provider.setKey(undefined);
    expect(provider.registry.hasConfiguredAuth(provider.model)).toBe(true);
    const open = vi.spyOn(durable.Harness, "open");
    const resume = vi.spyOn(kernel.DurableSubagentRuntime.prototype, "resume");
    const next = await sessionFixture(provider, {
      manager: sdk.SessionManager.open(first.manager.getSessionFile() as string),
    });
    expect(next.errors).toContainEqual(
      expect.objectContaining({ event: "session_start", error: expect.stringMatching(/credentials unavailable/i) }),
    );
    await expect(next.invoke("subagent_status")).rejects.toThrow(/not started/i);
    expect(open).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(provider.registry.hasConfiguredAuth(provider.model)).toBe(true);
    await next.close();
    expect(await bytes(first.saved.options.directory)).toEqual(before);
    expect(await readFile(first.manager.getSessionFile() as string)).toEqual(mainBefore);
    expect(provider.faux.state.callCount).toBe(1);
  });

  it("accepts newly supplied working auth despite a negative snapshot without copying the key into options or state", async () => {
    const provider = await providerFixture(false);
    const capture = captureRuntime();
    const session = await sessionFixture(provider);
    expect(session.errors).toEqual([]);
    provider.setKey("synthetic-fixture-new");
    expect(provider.registry.hasConfiguredAuth(provider.model)).toBe(false);
    const spawned = value(await session.invoke("subagent_spawn", { task: "Use newly supplied fixture auth" }));
    const waited = value(await session.invoke("subagent_wait", { conversationId: spawned.conversationId, timeout: 1 }));
    expect(waited).toMatchObject({ outcome: "completed", result: "saved child answer" });
    const saved = capture.opened[0];
    assert.ok(saved);
    expect(provider.registry.hasConfiguredAuth(provider.model)).toBe(false);
    expect(provider.faux.state.callCount).toBe(1);
    expect(JSON.stringify({ options: saved.options, state: await saved.runtime.state(), waited })).not.toContain(
      "synthetic-fixture-new",
    );
    expect(await readFile(join(saved.options.directory, "policy.json"), "utf8")).not.toContain("synthetic-fixture-new");
    expect(saved.options).not.toHaveProperty("apiKey");
    expect(saved.options).not.toHaveProperty("headers");
  });

  it("rejects a provider removed while current authentication is awaited before admitting child work", async () => {
    const provider = await providerFixture();
    const capture = captureRuntime();
    const session = await sessionFixture(provider);
    const saved = capture.opened[0];
    assert.ok(saved);
    const before = await bytes(saved.options.directory);
    const entered = deferred();
    const release = deferred();
    provider.gateCheck(async () => {
      entered.resolve();
      await release.promise;
    });
    const failure = session.invoke("subagent_spawn", { task: "Do not use a removed provider" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    cleanup.push(async () => {
      release.resolve();
      await failure;
    });
    await entered.promise;
    provider.registry.unregisterProvider(provider.model.provider);
    release.resolve();
    expect(String(await failure)).toMatch(/model\/provider changed/i);
    expect(await saved.runtime.status()).toEqual({ conversations: [] });
    expect(await bytes(saved.options.directory)).toEqual(before);
    expect(provider.faux.state.callCount).toBe(0);
  });

  it("rejects keyless virtual profiles without dispatching or admitting child work", async () => {
    const provider = await providerFixture();
    provider.registry.registerVirtualModel({
      provider: "routing",
      id: "alias",
      name: "Alias",
      route: () => ({ model: provider.model, thinkingLevel: "off" }),
    });
    await provider.registry.refresh({ allowNetwork: false });
    const model = provider.registry.find("routing", "alias");
    assert.ok(model);
    expect(model.api).toBe("pi-virtual");
    expect(await provider.registry.getAvailableOfType("chat", "routing")).toContainEqual(model);
    const capture = captureRuntime();
    const session = await sessionFixture({ ...provider, model });
    expect(session.errors).toEqual([]);
    await expect(session.invoke("subagent_spawn", { task: "Do not dispatch a virtual route" })).rejects.toThrow(
      /physical model/i,
    );
    expect(await capture.opened[0]?.runtime.status()).toEqual({ conversations: [] });
    expect(provider.faux.state.callCount).toBe(0);
  });

  it("allows physical models whose provider and ID contain virtual-looking names", async () => {
    const provider = await providerFixture();
    const model = { ...provider.model, provider: "virtual-provider", id: "virtual-model" };
    provider.registry.registerProvider(
      ai.createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: "Synthetic keyless fixture", resolve: async () => ({ auth: {} }) } },
        api: { stream: provider.faux.streamSimple, streamSimple: provider.faux.streamSimple },
      }),
    );
    await provider.registry.refresh({ allowNetwork: false });
    const session = await sessionFixture({ ...provider, model });
    expect(session.errors).toEqual([]);
    const spawned = value(await session.invoke("subagent_spawn", { task: "Use the physical model" }));
    const waited = value(await session.invoke("subagent_wait", { conversationId: spawned.conversationId, timeout: 1 }));
    expect(waited).toMatchObject({ outcome: "completed", result: "saved child answer" });
  });

  it("aborts a pending public auth check on shutdown without opening Harness or changing saved storage", async () => {
    const provider = await providerFixture();
    const first = await seed(provider);
    const before = await bytes(first.saved.options.directory);
    const mainBefore = await readFile(first.manager.getSessionFile() as string);
    const next = await sessionFixture(provider, {
      manager: sdk.SessionManager.open(first.manager.getSessionFile() as string),
      bind: false,
    });
    const entered = deferred<AbortSignal>();
    const cancelled = deferred();
    provider.gateCheck(async (signal) => {
      entered.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          cancelled.resolve();
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });
    const open = vi.spyOn(durable.Harness, "open");
    const resume = vi.spyOn(kernel.DurableSubagentRuntime.prototype, "resume");
    const starting = next.bind();
    const signal = await entered.promise;
    // The same lifetime signal cancels both provider preflight and OS-lock acquisition.
    const pendingOptions = first.open.mock.calls.at(-1)?.[0];
    expect(pendingOptions?.signal).toBe(signal);
    await next.close();
    expect(pendingOptions?.signal?.aborted).toBe(true);
    await starting;
    await cancelled.promise;
    expect(signal.aborted).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(await bytes(first.saved.options.directory)).toEqual(before);
    expect(await readFile(first.manager.getSessionFile() as string)).toEqual(mainBefore);
    expect(provider.faux.state.callCount).toBe(1);
  });

  it.each([false, true])(
    "requires a real disk reopen after a report append ghost (notify throws: %s)",
    async (notifyThrows) => {
      const provider = await providerFixture();
      const capture = captureRuntime();
      const first = await sessionFixture(provider, { notifyThrows });
      first.ghostReports();
      const spawned = value(await first.invoke("subagent_spawn", { task: "Retain this saved result" }, "ghost-spawn"));
      await first.warned.promise;
      await nextTurn();
      const saved = capture.opened[0];
      assert.ok(saved);
      expect(first.notices[0]).toMatch(/wait/i);
      expect(first.notices[0]).toMatch(/close.*Pi.*reopen.*saved/i);
      expect(first.notices[0]).toMatch(/\/reload.*(does not|cannot|won.t)/i);
      expect(await saved.runtime.reports()).toHaveLength(1);
      const file = first.manager.getSessionFile() as string;
      const reportEntries = (manager: SessionManager) =>
        manager
          .getBranch()
          .filter((entry) => entry.type === "custom_message" && entry.customType === bridge.DURABLE_REPORT_TYPE);
      expect(reportEntries(first.manager)).toHaveLength(1);
      expect(reportEntries(sdk.SessionManager.open(file))).toHaveLength(0);
      const beforeReload = await readFile(file);
      await first.session.reload();
      expect(first.session.sessionManager).toBe(first.manager);
      expect(first.errors).toContainEqual(
        expect.objectContaining({ event: "session_start", error: expect.stringMatching(/disk|reopen|receipt/i) }),
      );
      await expect(first.invoke("subagent_status")).rejects.toThrow(/not started/i);
      expect(capture.open).toHaveBeenCalledTimes(1);
      expect(await readFile(file)).toEqual(beforeReload);
      await first.close();
      const reopened = await sessionFixture(provider, { manager: sdk.SessionManager.open(file) });
      expect(reopened.errors).toEqual([]);
      expect(reportEntries(sdk.SessionManager.open(file))).toHaveLength(1);
      const waited = value(
        await reopened.invoke("subagent_wait", { conversationId: spawned.conversationId, timeout: 1 }),
      );
      expect(waited).toMatchObject({ outcome: "completed", result: "saved child answer", timedOut: false });
      expect(provider.faux.state.callCount).toBe(1);
      expect(await capture.opened[1]?.runtime.reports()).toEqual([]);
    },
  );
});

it("drains a changed report in the microtask after the final loop check but before the old outer cleanup", async () => {
  const provider = await providerFixture();
  const pending: DurableReport[] = [];
  const acknowledged: string[] = [];
  const runtime = {
    resume: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    reports: vi.fn(async () => pending.filter((report) => !report.acknowledged)),
    report: vi.fn(async (id: string) => pending.find((report) => report.id === id)),
    acknowledge: vi.fn(async (id: string) => {
      const report = pending.find((report) => report.id === id);
      assert.ok(report);
      report.acknowledged = true;
      acknowledged.push(id);
    }),
    spawn: vi.fn(async (id: string) => ({ conversationId: id === "first" ? "2" : "3", requestId: id })),
  } as unknown as DurableSubagentRuntime;
  let options!: DurableRuntimeOptions;
  vi.spyOn(kernel.DurableSubagentRuntime, "open").mockImplementation(async (value) => {
    options = value;
    return runtime;
  });
  const session = await sessionFixture(provider);
  expect(session.errors).toEqual([]);
  // Real wrapped public tools create both disk-backed admission receipts.
  await session.invoke("subagent_spawn", { task: "first" }, "first");
  await session.invoke("subagent_spawn", { task: "second" }, "second");
  const report = (id: string, conversationId: string): DurableReport => ({
    id: `report-${id}`,
    conversationId,
    requestId: id,
    outcome: "completed",
    result: id,
    error: null,
    acknowledged: false,
    suppressed: false,
  });
  pending.push(report("first", "2"));
  const entered = deferred();
  const gate = deferred<import("../src/durable-main-bridge.js").DurableFlushResult>();
  vi.spyOn(bridge.DurableMainBridge.prototype, "flush").mockImplementationOnce(() => {
    entered.resolve();
    return gate.promise;
  });
  vi.mocked(runtime.reports).mockClear();
  options.changed?.();
  await entered.promise;
  // The controller's await continuation is already registered. This reaction runs
  // after its final loop check, but before an outer await/finally can clear flushing.
  const injected = gate.promise.then(() => {
    pending.push(report("second", "3"));
    options.changed?.();
  });
  gate.resolve({ acknowledged: [], pending: ["report-first"] });
  await injected;
  await nextTurn();
  expect(acknowledged).toEqual(["report-first", "report-second"]);
  expect(runtime.reports).toHaveBeenCalledTimes(2);
  expect(
    sdk.SessionManager.open(session.manager.getSessionFile() as string)
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === bridge.DURABLE_REPORT_TYPE),
  ).toHaveLength(2);
});
