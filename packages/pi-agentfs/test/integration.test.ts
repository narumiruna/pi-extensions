import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionToolContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";

let root: string;
let previousAgentDir: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-agentfs-integration-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  vi.resetModules();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

function harness(flag?: unknown) {
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  let value = flag;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => value),
  } as unknown as ExtensionAPI;
  const sharedUI = {};
  const context = (sessionManager: object = {}) => ({ sessionManager, ui: sharedUI }) as ExtensionContext;
  return {
    pi,
    tools,
    context,
    setFlag(next: unknown) {
      value = next;
    },
    emit(name: string, ctx: ExtensionContext) {
      return handlers.get(name)?.({} as never, ctx);
    },
    async call(name: string, ctx: ExtensionContext) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool.execute(
        "call",
        name === "bash" ? { command: "pwd" } : { path: "/missing" },
        undefined,
        undefined,
        ctx as ExtensionToolContext,
      );
    },
  };
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}

test.each(["", "   ", "relative.db", "./relative.db", "/invalid\0.db"])(
  "SDK rejects invalid path synchronously: %j",
  async (path) => {
    const { createAgentfsExtension } = await import("../src/factory.js");
    expect(() => createAgentfsExtension({ path })).toThrow(/absolute database path/);
  },
);

test("discovery registers SDK tools but creates no workspace resources", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const open = vi.spyOn(Workspace.prototype, "open");
  const { createAgentfsExtension } = await import("../src/factory.js");
  const path = join(root, "absent", "workspace.db");
  const factory = createAgentfsExtension({ path });
  const host = harness();
  await factory(host.pi);
  expect([...host.tools.keys()].sort()).toEqual(["bash", "edit", "read", "write"]);
  expect(open).not.toHaveBeenCalled();
  await expect(access(dirname(path))).rejects.toThrow();
  await expect(factory.ready({})).rejects.toThrow(/bindExtensions/);
  await expect(host.call("read", host.context())).rejects.toThrow(/not started/);
});

test("loading and failed initialization reject tools and expose readiness errors", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const gate = deferred();
  vi.spyOn(Workspace.prototype, "open").mockImplementation(async () => {
    await gate.promise;
    throw new Error("open failed");
  });
  const close = vi.spyOn(Workspace.prototype, "close").mockResolvedValue();
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: join(root, "workspace.db") });
  const host = harness();
  await factory(host.pi);
  const ctx = host.context();
  const start = Promise.resolve(host.emit("session_start", ctx));
  const rejectedStart = expect(start).rejects.toThrow("open failed");
  await expect(host.call("read", ctx)).rejects.toThrow(/loading/);
  const ready = expect(factory.ready(ctx.sessionManager)).rejects.toThrow("open failed");
  gate.resolve();
  await Promise.all([rejectedStart, ready]);
  await expect(host.call("read", ctx)).rejects.toThrow(/failed/);
  await host.emit("session_shutdown", ctx);
  await host.emit("session_shutdown", ctx);
  expect(close).toHaveBeenCalled();
  await expect(host.call("read", ctx)).rejects.toThrow(/closed/);
});

test("shutdown drains pending initialization and never publishes it as ready", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const gate = deferred();
  vi.spyOn(Workspace.prototype, "open").mockImplementation(() => gate.promise);
  vi.spyOn(Workspace.prototype, "close").mockResolvedValue();
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: join(root, "workspace.db") });
  const host = harness();
  await factory(host.pi);
  const ctx = host.context();
  const start = Promise.resolve(host.emit("session_start", ctx));
  const rejected = expect(start).rejects.toThrow(/closed during initialization/);
  await Promise.resolve();
  const shutdown = host.emit("session_shutdown", ctx);
  gate.resolve();
  await rejected;
  await shutdown;
  await expect(factory.ready(ctx.sessionManager)).rejects.toThrow(/closed during initialization/);
  await expect(host.call("read", ctx)).rejects.toThrow(/closed/);
});

test("a delayed start cannot replace a newer workspace for the same session", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const firstOpen = deferred();
  const secondOpen = deferred();
  const open = vi
    .spyOn(Workspace.prototype, "open")
    .mockImplementationOnce(() => firstOpen.promise)
    .mockImplementationOnce(() => secondOpen.promise);
  const close = vi.spyOn(Workspace.prototype, "close").mockResolvedValue();
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: join(root, "workspace.db") });
  const host = harness();
  await factory(host.pi);
  const ctx = host.context();
  const firstStart = Promise.resolve(host.emit("session_start", ctx));
  const rejected = expect(firstStart).rejects.toThrow(/closed during initialization/);
  await Promise.resolve();
  const secondStart = host.emit("session_start", ctx);
  await Promise.resolve();
  expect(open).toHaveBeenCalledTimes(2);
  firstOpen.resolve();
  await rejected;
  await expect(host.call("read", ctx)).rejects.toThrow(/loading/);
  const ready = factory.ready(ctx.sessionManager);
  secondOpen.resolve();
  await secondStart;
  await ready;
  expect(close.mock.contexts).toEqual([open.mock.contexts[0], open.mock.contexts[0]]);
  await host.emit("session_shutdown", ctx);
  expect(close.mock.contexts.at(-1)).toBe(open.mock.contexts[1]);
});

test("sessionManager isolates headless resources; repeated start replaces only its workspace", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const opened: object[] = [];
  const closed: object[] = [];
  vi.spyOn(Workspace.prototype, "open").mockImplementation(async function (this: InstanceType<typeof Workspace>) {
    opened.push(this);
  });
  vi.spyOn(Workspace.prototype, "close").mockImplementation(async function (this: InstanceType<typeof Workspace>) {
    closed.push(this);
  });
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: join(root, "workspace.db") });
  const host = harness();
  await factory(host.pi);
  const first = host.context();
  const second = host.context();
  await host.emit("session_start", first);
  await host.emit("session_start", second);
  await factory.ready(first.sessionManager);
  await factory.ready(second.sessionManager);
  await host.emit("session_start", first);
  expect(opened).toHaveLength(3);
  expect(closed).toEqual([opened[0]]);
  await host.emit("session_shutdown", first);
  await factory.ready(second.sessionManager);
  await expect(factory.ready(first.sessionManager)).rejects.toThrow(/closed/);
  await host.emit("session_shutdown", second);
  expect(closed).toContain(opened[1]);
  expect(closed).toContain(opened[2]);
});

test.each([undefined, "", "relative.db", "   "])("CLI flag %j is disabled or fails closed", async (flag) => {
  const { default: extension } = await import("../src/agentfs-extension.js");
  const host = harness(flag);
  extension(host.pi);
  expect(host.tools.size).toBe(0);
  const ctx = host.context();
  expect(host.emit("user_bash", ctx)).toBeUndefined();
  if (flag === undefined) {
    await host.emit("session_start", ctx);
    expect(host.tools.size).toBe(0);
    expect(host.emit("user_bash", ctx)).toBeUndefined();
    host.setFlag(join(root, "later.db"));
    await host.emit("session_start", ctx);
    expect(host.tools.size).toBe(0);
  } else {
    await expect(host.emit("session_start", ctx)).rejects.toThrow(/absolute database path/);
    expect([...host.tools.keys()].sort()).toEqual(["bash", "edit", "read", "write"]);
    await expect(host.call("read", ctx)).rejects.toThrow(/failed/);
    expect(() => host.emit("user_bash", ctx)).toThrow(/blocks ! and !!/);
  }
});

test("CLI path is fixed per instance and enabled SDK mode blocks user bash", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const open = vi.spyOn(Workspace.prototype, "open").mockResolvedValue();
  vi.spyOn(Workspace.prototype, "close").mockResolvedValue();
  const { default: extension } = await import("../src/agentfs-extension.js");
  const host = harness(join(root, "first.db"));
  extension(host.pi);
  const ctx = host.context();
  await host.emit("session_start", ctx);
  host.setFlag("invalid-new-value");
  await host.emit("session_start", ctx);
  expect(open).toHaveBeenCalledTimes(2);
  expect(host.pi.getFlag).toHaveBeenCalledTimes(1);
  expect(() => host.emit("user_bash", ctx)).toThrow(/blocks ! and !!/);
  await host.emit("session_shutdown", ctx);
  const { createAgentfsExtension } = await import("../src/factory.js");
  const sdk = harness();
  await createAgentfsExtension({ path: join(root, "sdk.db") })(sdk.pi);
  expect(() => sdk.emit("user_bash", sdk.context())).toThrow(/blocks ! and !!/);
});

async function sdkSession(factory: ExtensionFactory, databasePath?: string, eager = true) {
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [factory],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Use only the AgentFS virtual workspace tools.",
    appendSystemPrompt: [],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  expect(loader.getThemes().themes).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  if (databasePath) await expect(access(databasePath)).rejects.toThrow();
  const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";
  const fauxModule = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxModule.createFauxCore({
    api: `agentfs-${crypto.randomUUID()}`,
    provider: `agentfs-${crypto.randomUUID()}`,
    models: [{ id: "offline", contextWindow: 100_000, maxTokens: 1_000 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(modelRuntime);
  registry.registerProvider(faux.provider, {
    api: faux.api,
    apiKey: "offline",
    baseUrl: "http://localhost",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const model = registry.find(faux.provider, "offline");
  if (!model) throw new Error("Missing faux model");
  const created = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "write", "edit", "bash"],
  });
  expect(
    created.session
      .getAllTools()
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["bash", "edit", "read", "write"]);
  const registered = loader.getExtensions().extensions[0];
  if (eager) {
    for (const name of ["read", "write", "edit", "bash"]) {
      expect(created.session.getToolDefinition(name)).toBe(registered?.tools.get(name)?.definition);
    }
  }
  return { ...created, faux, fauxModule };
}

async function shutdown(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

test("real SDK inventory is exactly four, and operations persist through a new session", async () => {
  const { createAgentfsExtension } = await import("../src/factory.js");
  const path = join(root, "workspace.db");
  const factory = createAgentfsExtension({ path });
  const { session } = await sdkSession(factory, path);
  try {
    expect(session.getCallableToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
    await session.bindExtensions({});
    await factory.ready(session.sessionManager);
    const write = session.agent.state.tools.find((tool) => tool.name === "write");
    if (!write) throw new Error("Missing write tool");
    await write.execute("write", { path: "/kept.txt", content: "persisted" });
  } finally {
    await shutdown(session);
  }
  const reopened = await sdkSession(factory);
  try {
    await reopened.session.bindExtensions({});
    await factory.ready(reopened.session.sessionManager);
    const read = reopened.session.agent.state.tools.find((tool) => tool.name === "read");
    if (!read) throw new Error("Missing read tool");
    const result = await read.execute("read", { path: "/kept.txt" });
    expect(result.content).toEqual([{ type: "text", text: "persisted" }]);
  } finally {
    await shutdown(reopened.session);
  }
});

test("real Pi late CLI activation replaces all four callable tools before requests", async () => {
  const { default: extension } = await import("../src/agentfs-extension.js");
  const { session, extensionsResult } = await sdkSession(extension, undefined, false);
  const before = session.getToolDefinition("read");
  try {
    session.extensionRunner.setFlagValue("agentfs-path", join(root, "late.db"));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    expect(session.getCallableToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(session.getToolDefinition("read")).not.toBe(before);
    const registered = extensionsResult.extensions[0];
    for (const name of ["read", "write", "edit", "bash"]) {
      expect(session.getToolDefinition(name)).toBe(registered?.tools.get(name)?.definition);
    }
    const call = async (name: string, args: unknown) => {
      const tool = session.agent.state.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Missing late tool ${name}`);
      return tool.execute("late", args);
    };
    await call("write", { path: "/late", content: "original" });
    await call("edit", { path: "/late", edits: [{ oldText: "original", newText: "changed" }] });
    const shell = await call("bash", { command: "cat /late | grep changed > /copied" });
    expect(shell.isError).not.toBe(true);
    const read = await call("read", { path: "/copied" });
    expect(read.content).toEqual([{ type: "text", text: "changed\n" }]);
  } finally {
    await shutdown(session);
  }
});

test("real SDK exposes swallowed initialization failures through ready and rejecting replacements", async () => {
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: root });
  const { session } = await sdkSession(factory);
  try {
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(errors).toHaveLength(1);
    await expect(factory.ready(session.sessionManager)).rejects.toThrow();
    const read = session.agent.state.tools.find((tool) => tool.name === "read");
    if (!read) throw new Error("Missing read replacement");
    await expect(read.execute("read", { path: "/host.txt" })).rejects.toThrow(/failed/);
    expect(session.getCallableToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
  } finally {
    await shutdown(session);
  }
});

test("ordinary faux provider requests retain the exact model-visible prefix and tool inventory", async () => {
  const { createAgentfsExtension } = await import("../src/factory.js");
  const factory = createAgentfsExtension({ path: join(root, "workspace.db") });
  const { session, faux, fauxModule } = await sdkSession(factory);
  const requests: Array<{ system: string; tools: unknown; messages: unknown[] }> = [];
  const respond = (context: TranscriptContext) => {
    requests.push({
      system: getCurrentSystemPrompt(context.messages),
      tools: JSON.parse(JSON.stringify(getCurrentTools(context.messages))),
      messages: context.messages.map((message) =>
        message.role === "system"
          ? JSON.parse(
              JSON.stringify({
                role: message.role,
                content: message.content,
                sections: message.sections,
                toolsAdded: message.toolsAdded,
                toolsRemoved: message.toolsRemoved,
              }),
            )
          : JSON.parse(JSON.stringify({ role: message.role, content: message.content })),
      ),
    });
    return fauxModule.fauxAssistantMessage("offline response");
  };
  faux.setResponses([respond, respond]);
  try {
    await session.bindExtensions({});
    await factory.ready(session.sessionManager);
    await session.prompt("first ordinary request");
    await session.prompt("second ordinary request");
    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    if (!first || !second) throw new Error("Expected two provider requests");
    expect(second.system).toBe(first.system);
    expect(second.tools).toEqual(first.tools);
    expect((first.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  } finally {
    await shutdown(session);
  }
});

test("CLI help discovers the flag without opening or creating a database directory", async () => {
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const path = join(root, "must-not-exist", "workspace.db");
  const child = spawn(
    process.execPath,
    [cli, "--offline", "--no-extensions", "-e", resolve("packages/pi-agentfs"), "--agentfs-path", path, "--help"],
    {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "cli-agent"), PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("--agentfs-path");
  await expect(access(dirname(path))).rejects.toThrow();
});

// Exercise Pi's real two-pass CLI flag parsing and Jiti package entrypoint without a model request.
test.each([undefined, "", "relative.db", "absolute"])(
  "CLI RPC loads with agentfs-path=%j and blocks host bash when requested",
  async (flag) => {
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
    const path = join(root, "cli.db");
    const args = [
      cli,
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-session",
      "--mode",
      "rpc",
      "-e",
      resolve("packages/pi-agentfs"),
    ];
    if (flag !== undefined) args.push("--agentfs-path", flag === "absolute" ? path : flag);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "cli-agent"), PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    let pending = "";
    const records: Record<string, unknown>[] = [];
    const waiters = new Map<string, (record: Record<string, unknown>) => void>();
    onTestFinished(() => {
      child.kill("SIGKILL");
    });
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) {
          const record = JSON.parse(line) as Record<string, unknown>;
          records.push(record);
          if (record.type === "response" && typeof record.id === "string") waiters.get(record.id)?.(record);
        }
        newline = pending.indexOf("\n");
      }
    });
    const request = (id: string, data: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((done, reject) => {
        waiters.set(id, done);
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`CLI exited (${code}): ${stderr}`)));
        child.stdin.write(`${JSON.stringify({ id, ...data })}\n`);
      });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    try {
      // This response is the child readiness handshake; no timing deadline starts before it.
      const state = await request("ready", { type: "get_state" });
      expect(state.success).toBe(true);
      for (const excludeFromContext of [false, true]) {
        const marker = `host-probe-${excludeFromContext}.txt`;
        const response = await request(`bash-${excludeFromContext}`, {
          type: "bash",
          command: `printf host-probe > ${marker}`,
          excludeFromContext,
        });
        if (flag === undefined) {
          expect(response.success).toBe(true);
          await access(join(root, marker));
        } else {
          expect(response.success).toBe(false);
          expect(response.error).toMatch(/blocks ! and !!/);
          await expect(access(join(root, marker))).rejects.toThrow();
        }
      }
      if (flag === "absolute") await access(path);
      else await expect(access(path)).rejects.toThrow();
      expect(records.some((record) => record.type === "agent_start")).toBe(false);
    } finally {
      child.stdin.end();
      await exited;
    }
  },
);
