import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type Message,
  type ToolCall,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
  setCapabilities,
  setCellDimensions,
  type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRecord, type IllustrateRecord } from "../src/records.js";

const PACKAGE = resolve("packages/pi-illustrate");
const TOOLS = ["illustrate_svg", "illustrate_mermaid"];
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2277bb"/></svg>';
type ResponseContent = AssistantMessage["content"];
type JsonRecord = Record<string, unknown>;

/** Keep only serialized model input, not usage, runtime identity, or session-entry details. */
function visibleMessage(message: Message): unknown {
  switch (message.role) {
    case "system":
      return {
        role: message.role,
        content: message.content,
        sections: message.sections,
        toolsAdded: message.toolsAdded?.map(toToolDeclaration),
        toolsRemoved: message.toolsRemoved,
      };
    case "toolResult":
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
    default:
      return { role: message.role, content: message.content };
  }
}
function cacheInput(context: TranscriptContext) {
  return JSON.parse(
    JSON.stringify({
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map(toToolDeclaration),
      messages: context.messages.map(visibleMessage),
    }),
  ) as { system: string; tools: Array<{ name: string }>; messages: JsonRecord[] };
}
type CacheInput = ReturnType<typeof cacheInput>;

function samePrefix(before: CacheInput, after: CacheInput): void {
  expect(after.system).toBe(before.system);
  expect(after.tools).toEqual(before.tools);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages.length).toBeGreaterThan(before.messages.length);
}

let directory: string;
let previousAgentDir: string | undefined;
let capabilities: ReturnType<typeof getCapabilities>;
let cells: ReturnType<typeof getCellDimensions>;
let sessions: Array<{ session: AgentSession; closed: boolean }>;
let children: ChildProcessWithoutNullStreams[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-illustrate-native-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  capabilities = getCapabilities();
  cells = getCellDimensions();
  setCapabilities({ ...capabilities, images: "kitty" });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  initTheme("dark", false);
  sessions = [];
  children = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network access is forbidden in Illustrate runtime tests.");
    }),
  );
});
afterEach(async () => {
  try {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.kill("SIGKILL");
      await closed;
    }
    for (const owned of sessions) {
      if (owned.closed) continue;
      await owned.session.abort();
      try {
        await owned.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        owned.session.dispose();
        owned.closed = true;
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    setCapabilities(capabilities);
    setCellDimensions(cells);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(mode: ExtensionContext["mode"] = "print", imageInput = true) {
  // Set PI_CODING_AGENT_DIR before each fresh Jiti evaluation of the extension graph.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
  });
  const captured: CacheInput[] = [];
  const responses: ResponseContent[] = [];
  const provider = `illustrate-local-${crypto.randomUUID()}`;
  modelRuntime.registerProvider(provider, {
    api: "illustrate-local-api",
    apiKey: "synthetic-not-a-credential",
    baseUrl: "https://invalid.example",
    models: [
      {
        id: "local-only",
        name: "Local-only test model",
        reasoning: false,
        input: imageInput ? ["text", "image"] : ["text"],
        contextWindow: 100_000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      captured.push(cacheInput(context));
      const content = responses.shift() ?? [{ type: "text" as const, text: "done" }];
      const result: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: result });
      if (result.stopReason === "toolUse") stream.push({ type: "done", reason: "toolUse", message: result });
      else stream.push({ type: "done", reason: "stop", message: result });
      stream.end();
      return stream;
    },
  });
  const model = modelRuntime.getModel(provider, "local-only");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  let starts = 0;
  let shutdowns = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [PACKAGE],
    extensionFactories: [
      (pi) => {
        pi.on("session_start", () => {
          starts++;
        });
        pi.on("session_shutdown", () => {
          shutdowns++;
        });
      },
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
    noTools: "builtin",
  });
  const owned = { session, closed: false };
  sessions.push(owned);
  const errors: ExtensionError[] = [];
  const notify = vi.fn();
  const custom = vi.fn(async () => {
    throw new Error("No custom UI may open in this SDK fixture.");
  });
  // A host UI adapter: Pi, not this test, constructs every extension context.
  const ui = {
    theme: { appearance: "dark" } as Theme,
    notify,
    custom,
    setStatus: vi.fn(),
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({
    mode,
    ...(mode === "tui" || mode === "rpc" ? { uiContext: ui } : {}),
    onError: (error) => errors.push(error),
  });
  expect(errors).toEqual([]);
  return {
    session,
    modelRuntime,
    resourceLoader,
    captured,
    responses,
    errors,
    notify,
    custom,
    get starts() {
      return starts;
    },
    get shutdowns() {
      return shutdowns;
    },
    async shutdown() {
      if (owned.closed) return;
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
        owned.closed = true;
      }
    },
  };
}
function call(name: string, args: ToolCall["arguments"]): ResponseContent[number] {
  return { type: "toolCall", id: crypto.randomUUID(), name, arguments: args };
}
function resultFor(session: AgentSession, name: string) {
  const result = [...session.messages]
    .reverse()
    .find((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(result?.role === "toolResult");
  return result;
}
function mount(session: AgentSession, result: ReturnType<typeof resultFor>, args: ToolCall["arguments"]) {
  const definition = session.getToolDefinition(result.toolName);
  assert.ok(definition?.renderResult);
  const requestRender = vi.fn();
  const component = new ToolExecutionComponent(
    result.toolName,
    result.toolCallId,
    args,
    { showImages: true },
    definition,
    { requestRender } as unknown as TUI,
    directory,
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(result);
  return { component, requestRender };
}
function previews(lines: string[]): number {
  // Count first transmission chunks, not continuation chunks or Kitty image IDs.
  return lines.join("\n").split("\x1b_Ga=T,").length - 1;
}

it("loads the declared package with exactly two tools and one command, starts, and shuts down without a provider request", async () => {
  const f = await fixture();
  expect(
    f.resourceLoader
      .getExtensions()
      .extensions.some((extension) => resolve(extension.path) === join(PACKAGE, "src/index.ts")),
  ).toBe(true);
  expect(f.session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual(TOOLS);
  expect(f.session.getActiveToolNames()).toEqual(TOOLS);
  expect(f.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toEqual(["illustrate"]);
  expect(f.starts).toBe(1);
  await expect(access(join(directory, "pi-illustrate.json"))).rejects.toThrow();
  await f.session.prompt("/illustrate");
  expect(f.errors).toEqual([
    expect.objectContaining({
      extensionPath: "command:illustrate",
      event: "command",
      error: expect.stringContaining("TUI"),
    }),
  ]);
  expect(f.captured).toEqual([]);
  expect(f.session.messages).toEqual([]);
  await f.shutdown();
  await f.shutdown();
  expect(f.shutdowns).toBe(1);
});

it.each([false, true])(
  "executes a real Jiti/worker SVG boundary with one native preview and immutable model delivery=%s",
  async (sendToModel) => {
    const f = await fixture("tui");
    const args = { svg: SVG, cols: 24, ...(sendToModel ? { sendToModel: true } : {}) };
    f.responses.push([call("illustrate_svg", args)]);
    await f.session.prompt("Render the local static diagram.");
    const result = resultFor(f.session, "illustrate_svg");
    expect(result.isError).toBe(false);
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    const record = result.details as unknown as IllustrateRecord;
    expect(record).toMatchObject({ type: "pi-illustrate/v1", cols: 24, layout: { kind: "svg" } });
    if (sendToModel) {
      expect(record.modelImage).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(getPngDimensions(record.modelImage?.data ?? "")).toEqual({ widthPx: 216, heightPx: 108 });
    } else expect(record.modelImage).toBeUndefined();
    const history = JSON.stringify(f.session.messages);
    const entries = JSON.stringify(f.session.sessionManager.getEntries());
    const mounted = mount(f.session, result, args);
    expect(previews(mounted.component.render(80))).toBe(1);
    mounted.component.setExpanded(true);
    expect(previews(mounted.component.render(40))).toBe(1);
    initTheme("light", false);
    mounted.component.invalidate();
    expect(previews(mounted.component.render(40))).toBe(1);
    mounted.component.setShowImages(false);
    expect(previews(mounted.component.render(80))).toBe(0);
    mounted.component.setShowImages(true);
    expect(previews(mounted.component.render(80))).toBe(1);
    // Pi does not promise tool-row disposal: remounts use session-owned preview state.
    const remounted = mount(f.session, result, args);
    expect(previews(remounted.component.render(80))).toBe(1);
    const projected = await f.session.extensionRunner.emitContext([...f.session.messages]);
    const repeated = await f.session.extensionRunner.emitContext(projected);
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(projected));
    const projectedResult = projected.find(
      (message) => message.role === "toolResult" && message.toolCallId === result.toolCallId,
    );
    assert.ok(projectedResult?.role === "toolResult");
    const projectedImages = projectedResult.content.filter((block) => block.type === "image");
    expect(projectedImages).toEqual(sendToModel ? [record.modelImage] : []);
    expect(JSON.stringify(f.session.messages)).toBe(history);
    expect(JSON.stringify(f.session.sessionManager.getEntries())).toBe(entries);
    const providerResult = f.captured.at(-1)?.messages.find((message) => message.role === "toolResult");
    assert.ok(providerResult);
    expect((providerResult.content as Array<{ type: string }>).filter((block) => block.type === "image")).toEqual(
      projectedImages,
    );
    await f.session.prompt("Continue without changing the diagram.");
    await f.session.prompt("Continue once more.");
    for (let index = 1; index < f.captured.length; index++) {
      const before = f.captured[index - 1];
      const after = f.captured[index];
      assert.ok(before && after);
      samePrefix(before, after);
    }
    expect(f.captured[0]?.tools.map((tool) => tool.name)).toEqual(TOOLS);
    const definition = f.session.getToolDefinition(result.toolName);
    assert.ok(definition?.renderResult);
    const renderResult = vi.spyOn(definition, "renderResult");
    const path = join(directory, "session.html");
    await f.session.exportToHtml(path);
    expect(renderResult).toHaveBeenCalled();
    expect(renderResult.mock.calls.every(([, , , context]) => context.showImages === false)).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain("\x1b_G");
    expect(f.errors).toEqual([]);
    await f.shutdown();
    expect(previews(remounted.component.render(80))).toBe(0);
  },
);

it("preserves Pi system and additive-tool patches when projecting an earlier model image", async () => {
  const f = await fixture();
  const tool = f.session.getToolDefinition("illustrate_svg");
  assert.ok(tool);
  const declaration = toToolDeclaration(tool);
  const snapshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const details = createRecord({ kind: "svg", svg: SVG, width: 120, height: 60 }, "auto", {
    png: snapshot,
    width: 1,
    height: 1,
  });
  const transcript: Parameters<typeof f.session.extensionRunner.emitContext>[0] = [
    { role: "system", content: "Original prompt", toolsAdded: [declaration], timestamp: 0 },
    { role: "user", content: "Render", timestamp: 1 },
    {
      role: "toolResult",
      toolName: "illustrate_svg",
      toolCallId: "earlier",
      content: [{ type: "text", text: "Rendered" }],
      details,
      timestamp: 2,
      isError: false,
    },
    {
      role: "system",
      content: "",
      timestamp: 3,
      sections: { lateRule: "Keep this mid-conversation patch" },
      toolsAdded: [{ ...declaration, name: "added_tool" }],
    },
    { role: "user", content: "Continue", timestamp: 3 },
  ];
  const original = JSON.stringify(transcript);
  const projected = await f.session.extensionRunner.emitContext(transcript);
  expect(projected[0]).toEqual(transcript[0]);
  expect(projected[3]).toEqual(transcript[3]);
  expect(projected.filter((message) => message.role === "system")).toHaveLength(2);
  expect(getCurrentTools(projected as Message[]).map((entry) => entry.name)).toEqual(["illustrate_svg", "added_tool"]);
  expect(getCurrentSystemPrompt(projected as Message[])).toContain("Keep this mid-conversation patch");
  const later = await f.session.extensionRunner.emitContext([
    ...transcript,
    { role: "user", content: "One more ordinary request", timestamp: 4 },
  ]);
  expect(later.slice(0, projected.length)).toEqual(projected);
  expect(await f.session.extensionRunner.emitContext(projected)).toEqual(projected);
  expect(JSON.stringify(transcript)).toBe(original);
  expect(f.errors).toEqual([]);
});

it("rejects opted image delivery to a text-only model before parsing either diagram source", async () => {
  const f = await fixture("tui", false);
  f.responses.push([
    call("illustrate_svg", { svg: "not SVG", sendToModel: true }),
    call("illustrate_mermaid", { source: "not Mermaid", sendToModel: true }),
  ]);
  await f.session.prompt("Reject image delivery without rendering.");
  for (const name of TOOLS) {
    const result = resultFor(f.session, name);
    expect(result.isError).toBe(true);
    expect(result.details ?? {}).not.toHaveProperty("type");
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("does not support image") }),
    ]);
  }
  expect(f.errors).toEqual([]);
});

it.each(["print", "json", "rpc"] as const)("rejects both loaded tools before source parsing in %s", async (mode) => {
  const f = await fixture(mode);
  f.responses.push([call("illustrate_svg", { svg: "not SVG" }), call("illustrate_mermaid", { source: "not Mermaid" })]);
  await f.session.prompt("Reject the terminal-only tools without rendering.");
  for (const name of TOOLS) {
    const result = resultFor(f.session, name);
    expect(result.isError).toBe(true);
    expect(result.details ?? {}).not.toHaveProperty("type");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("TUI") })]);
  }
  expect(f.custom).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});

it("runs Pele locally through the loaded Mermaid tool without adding a model image by default", async () => {
  const f = await fixture("tui");
  const args = { source: "flowchart LR\n  A[English] --> B[中文]", cols: 24 };
  f.responses.push([call("illustrate_mermaid", args)]);
  await f.session.prompt("Render the local Mermaid fixture.");
  const result = resultFor(f.session, "illustrate_mermaid");
  expect(result.isError).toBe(false);
  expect(result.content.every((block) => block.type === "text")).toBe(true);
  expect(previews(mount(f.session, result, args).component.render(80))).toBe(1);
  expect(f.errors).toEqual([]);
});

it.each(["print", "json", "rpc"] as const)(
  "rejects /illustrate and all arguments observably in %s without model work or custom UI",
  async (mode) => {
    const f = await fixture(mode);
    await f.session.prompt("/illustrate");
    if (mode === "rpc") {
      expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "warning");
      expect(f.errors).toEqual([]);
    } else {
      expect(f.errors).toEqual([
        expect.objectContaining({
          extensionPath: "command:illustrate",
          event: "command",
          error: expect.stringContaining("TUI"),
        }),
      ]);
      expect(f.notify).not.toHaveBeenCalled();
    }
    f.errors.length = 0;
    for (const args of ["help", "settings", "status trailing", "--help"]) {
      await f.session.prompt(`/illustrate ${args}`);
      expect(f.errors.at(-1)).toMatchObject({
        extensionPath: "command:illustrate",
        event: "command",
        error: expect.stringContaining("arguments"),
      });
    }
    expect(f.errors).toHaveLength(4);
    expect(f.captured).toEqual([]);
    expect(f.custom).not.toHaveBeenCalled();
    expect(f.session.messages).toEqual([]);
  },
);

function cliArgs(): string[] {
  // This preload forbids live requests even if command dispatch regresses.
  const guard = `globalThis.fetch = async () => { throw new Error("ILLUSTRATE_NETWORK_FORBIDDEN"); };`;
  return [
    "--import",
    `data:text/javascript,${encodeURIComponent(guard)}`,
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    PACKAGE,
  ];
}
function childProcess(args: string[]) {
  const child = spawn(process.execPath, [...cliArgs(), ...args], {
    cwd: directory,
    env: { ...process.env, PI_CODING_AGENT_DIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  const closed = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done(code));
  });
  return {
    child,
    closed,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

it.each([
  { mode: "print", message: "/illustrate", error: "TUI" },
  { mode: "print", message: "/illustrate invalid trailing", error: "arguments" },
  { mode: "json", message: "/illustrate", error: "TUI" },
  { mode: "json", message: "/illustrate invalid trailing", error: "arguments" },
] as const)(
  "reports CLI $mode rejection for $message on stderr without corrupting stdout or calling a provider",
  async ({ mode, message, error }) => {
    const process = childProcess([...(mode === "print" ? ["-p"] : ["--mode", "json"]), message]);
    process.child.stdin.end();
    // The default five-second test budget bounds startup and completion; no longer override is used.
    expect(await process.closed).toBe(0);
    expect(process.stderr).toContain("Extension error (command:illustrate):");
    expect(process.stderr).toContain(error);
    expect(process.stderr).not.toContain("ILLUSTRATE_NETWORK_FORBIDDEN");
    if (mode === "print") expect(process.stdout).toBe("");
    else {
      const records = process.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JsonRecord);
      expect(records.map((record) => record.type)).toEqual(["session"]);
    }
  },
);

it("loads the real CLI package in scripted RPC, handshakes, rejects arguments, and closes cleanly without a provider", async () => {
  const process = childProcess(["--mode", "rpc"]);
  const records: JsonRecord[] = [];
  let buffer = "";
  let failure: Error | undefined;
  const listeners = new Set<() => void>();
  process.child.stdout.on("data", (data: string) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      try {
        const record: unknown = JSON.parse(line);
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Expected an RPC object.");
        records.push(record as JsonRecord);
      } catch {
        failure = new Error(`Non-JSON RPC stdout: ${JSON.stringify(line)}`);
      }
    }
    for (const listener of listeners) listener();
  });
  let exited = false;
  void process.closed.then(
    () => {
      exited = true;
      for (const listener of listeners) listener();
    },
    (error: Error) => {
      failure = error;
      for (const listener of listeners) listener();
    },
  );
  process.child.stdin.on("error", (error) => {
    failure = error;
    for (const listener of listeners) listener();
  });
  function waitFor(predicate: (record: JsonRecord) => boolean, signal?: AbortSignal): Promise<JsonRecord> {
    return new Promise((done, reject) => {
      const cleanup = () => {
        listeners.delete(check);
        signal?.removeEventListener("abort", check);
      };
      const check = () => {
        const record = records.find(predicate);
        if (failure || signal?.aborted || record || exited) {
          cleanup();
          if (failure) reject(failure);
          else if (signal?.aborted) reject(signal.reason);
          else if (record) done(record);
          else reject(new Error(`RPC exited before response: ${process.stderr}`));
        }
      };
      listeners.add(check);
      signal?.addEventListener("abort", check, { once: true });
      check();
    });
  }
  function send(command: JsonRecord): void {
    process.child.stdin.write(`${JSON.stringify(command)}\n`);
  }
  // A real get_state response is the readiness boundary, not a fixed startup sleep.
  send({ id: "ready", type: "get_state" });
  expect(await waitFor((record) => record.id === "ready")).toMatchObject({ success: true, data: { messageCount: 0 } });
  const deadline = AbortSignal.timeout(2500);
  send({ id: "commands", type: "get_commands" });
  const commands = await waitFor((record) => record.id === "commands", deadline);
  expect(commands).toMatchObject({
    success: true,
    data: { commands: expect.arrayContaining([expect.objectContaining({ name: "illustrate" })]) },
  });
  send({ id: "reject", type: "prompt", message: "/illustrate invalid trailing" });
  expect(await waitFor((record) => record.type === "extension_error", deadline)).toMatchObject({
    extensionPath: "command:illustrate",
    event: "command",
    error: expect.stringContaining("arguments"),
  });
  expect(await waitFor((record) => record.id === "reject", deadline)).toMatchObject({
    success: true,
    data: { disposition: "handled" },
  });
  send({ id: "messages", type: "get_messages" });
  expect(await waitFor((record) => record.id === "messages", deadline)).toMatchObject({
    success: true,
    data: { messages: [] },
  });
  expect(records.some((record) => record.type === "agent_start")).toBe(false);
  process.child.stdin.end();
  expect(await process.closed).toBe(0);
  expect(buffer).toBe("");
  expect(failure).toBeUndefined();
  expect(process.stderr).not.toContain("ILLUSTRATE_NETWORK_FORBIDDEN");
});
