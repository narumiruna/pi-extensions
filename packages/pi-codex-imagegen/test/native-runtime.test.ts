import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createImagegenExtension } from "../src/codex-imagegen.js";
import type { ImagegenMenuOwner } from "../src/menu.js";

const IMAGE = "UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA";
const TOOL = "codex_imagegen";
type Dependencies = NonNullable<Parameters<typeof createImagegenExtension>[0]>;
type ResponseContent = AssistantMessage["content"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Compare only model-visible data, not runtime objects, usage, or session-entry details. */
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
  // JSON removes undefined fields and TypeBox symbols, just as a provider serializer does.
  return JSON.parse(
    JSON.stringify({
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map(toToolDeclaration),
      messages: context.messages.map(visibleMessage),
    }),
  ) as { system: string; tools: Array<{ name: string }>; messages: unknown[] };
}
type CacheInput = ReturnType<typeof cacheInput>;
function sameEpoch(before: CacheInput, after: CacheInput) {
  expect(after.system).toBe(before.system);
  expect(after.tools.map((tool) => tool.name)).toEqual(before.tools.map((tool) => tool.name));
  expect(after.tools).toEqual(before.tools);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages.length).toBeGreaterThan(before.messages.length);
}

let directory: string;
let previousAgentDir: string | undefined;
let sessions: Array<{ session: AgentSession; disposed: boolean }>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-imagegen-native-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  sessions = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network access is forbidden in imagegen SDK tests.");
    }),
  );
});
afterEach(async () => {
  try {
    for (const owned of sessions) {
      if (owned.disposed) continue;
      try {
        await owned.session.abort();
        await owned.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        owned.session.dispose();
      }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

function testUI() {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const custom = vi.fn(async () => {
    throw new Error("No terminal component may open in this SDK fixture.");
  });
  // This is a host UI adapter, not a fabricated extension context. Pi supplies the context.
  const ui = {
    notify,
    setStatus,
    custom,
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
  } as unknown as ExtensionUIContext;
  return { ui, notify, setStatus, custom };
}

async function fixture(
  options: {
    enabled?: boolean;
    mode?: ExtensionContext["mode"];
    dependencies?: Dependencies;
    discovery?: boolean;
    observer?: (pi: ExtensionAPI) => void;
    packageEntry?: boolean;
  } = {},
) {
  if (options.enabled !== undefined)
    await writeFile(join(directory, "pi-codex-imagegen.json"), JSON.stringify({ toolEnabled: options.enabled }));
  // The environment is set before evaluation, including modules with cached package paths.
  vi.resetModules();
  const { createImagegenExtension: create } = await import("../src/codex-imagegen.js");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
  });
  const captured: CacheInput[] = [];
  const responses: ResponseContent[] = [];
  const provider = `imagegen-fixture-${crypto.randomUUID()}`;
  runtime.registerProvider(provider, {
    api: "imagegen-fixture-api",
    apiKey: "synthetic-not-a-credential",
    baseUrl: "https://invalid.example",
    models: [
      {
        id: "primary-non-codex",
        name: "Synthetic primary",
        reasoning: false,
        input: ["text", "image"],
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
  const model = runtime.getModel(provider, "primary-non-codex");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: options.packageEntry ? [resolve("packages/pi-codex-imagegen")] : [],
    extensionFactories: [
      ...(options.packageEntry ? [] : [create(options.dependencies)]),
      ...(options.discovery ? [createCodemodeExtension({ models: false }), createToolSearchExtension()] : []),
      (pi) => {
        options.observer?.(pi);
        if (options.discovery)
          pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "codemode", "tool_search"]));
      },
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(directory),
    noTools: "builtin",
  });
  const owned = { session, disposed: false };
  sessions.push(owned);
  const errors: ExtensionError[] = [];
  const ui = testUI();
  const mode = options.mode ?? "print";
  await session.bindExtensions({
    mode,
    ...(mode === "rpc" || mode === "tui" ? { uiContext: ui.ui } : {}),
    onError: (error) => errors.push(error),
  });
  expect(errors).toEqual([]);
  return {
    session,
    runtime,
    captured,
    responses,
    errors,
    resourceLoader,
    ...ui,
    dispose() {
      session.dispose();
      owned.disposed = true;
    },
  };
}
function call(name: string, args: ToolCall["arguments"] = {}): ResponseContent[number] {
  return { type: "toolCall", id: crypto.randomUUID(), name, arguments: args };
}
function resultFor(session: AgentSession, name: string) {
  const result = [...session.messages]
    .reverse()
    .find((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(result?.role === "toolResult");
  return result;
}

it("keeps the explicitly disabled tool out of declarations, codemode, search, and real nested execution even after activation", async () => {
  const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({ base64: IMAGE }));
  let api!: ExtensionAPI;
  let callable: string[] = [];
  let nestedError = false;
  const f = await fixture({
    enabled: false,
    discovery: true,
    dependencies: { request },
    observer(pi) {
      api = pi;
      pi.registerTool({
        name: "imagegen_orchestrator",
        label: "SDK orchestrator",
        description: "Exercise public nested tool access",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          callable = ctx.tools.map((tool) => tool.name);
          const outcome = await ctx.executeTool(TOOL, { prompt: "must not run", path: "must-not-write" });
          nestedError = outcome.isError;
          return { content: outcome.result.content, details: undefined };
        },
      });
    },
  });
  expect(f.session.getAllTools().find((tool) => tool.name === TOOL)?.exposure).toBe("hidden");
  api.setActiveTools([...api.getActiveTools(), TOOL]);
  expect(f.session.getActiveToolNames()).not.toContain(TOOL);
  expect(f.session.getCallableToolNames()).not.toContain(TOOL);
  f.responses.push([
    call(TOOL, { prompt: "must not run", path: "must-not-write" }),
    call("imagegen_orchestrator"),
    call("tool_search", { query: TOOL }),
    call("codemode", {
      code: `text({listed: ALL_TOOLS.some(t => t.name === "${TOOL}"), described: (await describeTool("${TOOL}")) !== undefined}); try { await tools.${TOOL}({prompt: "must not run", path: "must-not-write"}); } catch { text("call rejected"); }`,
    }),
  ]);
  await f.session.prompt("Exercise all hidden image generation entry points.");
  expect(callable).not.toContain(TOOL);
  expect(nestedError).toBe(true);
  expect(resultFor(f.session, TOOL).isError).toBe(true);
  expect(resultFor(f.session, "tool_search").content).toEqual([{ type: "text", text: "No matching tools found." }]);
  const codemode = resultFor(f.session, "codemode");
  expect(codemode.isError).toBe(false);
  expect(JSON.stringify(codemode.content)).toContain('\\"listed\\":false');
  expect(JSON.stringify(codemode.content)).toContain('\\"described\\":false');
  expect(JSON.stringify(codemode.content)).toContain("call rejected");
  for (const input of f.captured) {
    expect(input.tools.map((tool) => tool.name)).not.toContain(TOOL);
    expect(JSON.stringify(input.tools)).not.toContain(TOOL);
  }
  expect(f.session.getActiveToolNames()).not.toContain(TOOL);
  expect(request).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
  await expect(access(join(directory, "pi-codex-imagegen"))).rejects.toThrow();
});

it("executes the default-enabled tool headlessly with a non-Codex primary model and writes the required exact path", async () => {
  const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({
    base64: IMAGE,
    requestId: "synthetic-image-request",
  }));
  const f = await fixture({ dependencies: { request } });
  await expect(access(join(directory, "pi-codex-imagegen.json"))).rejects.toThrow();
  expect(f.session.model?.provider).not.toBe("openai-codex");
  expect(await f.runtime.listCredentials()).toEqual([]);
  expect(f.session.getActiveToolNames()).toContain(TOOL);
  f.responses.push([call(TOOL, { prompt: "A one pixel test image", path: "assets/synthetic" })]);
  await f.session.prompt("Generate the synthetic image.");
  const result = resultFor(f.session, TOOL);
  expect(result.isError).toBe(false);
  const path = join(directory, "assets", "synthetic");
  expect(await readFile(path)).toEqual(Buffer.from(IMAGE, "base64"));
  expect(result.details).toEqual({
    path,
    mimeType: "image/webp",
    width: 1,
    height: 1,
    requestId: "synthetic-image-request",
  });
  expect(result.content).toContainEqual({ type: "image", data: IMAGE, mimeType: "image/webp" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toEqual({ prompt: "A one pixel test image", transparentBackground: false });
  expect(f.captured).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

it("rejects missing path in a real SDK tool call without generating an image", async () => {
  const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({ base64: IMAGE }));
  const f = await fixture({ enabled: true, dependencies: { request } });
  f.responses.push([call(TOOL, { prompt: "No destination provided" })]);
  await f.session.prompt("Exercise required destination validation.");
  expect(resultFor(f.session, TOOL).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});

it("supports exact paths and overwriting through default-enabled codemode", async () => {
  const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({ base64: IMAGE }));
  const f = await fixture({ discovery: true, dependencies: { request } });
  const path = join(directory, "codemode-image.png");
  await writeFile(path, "previous image");
  f.responses.push([
    call("codemode", {
      code: `await tools.${TOOL}({prompt: "A synthetic image", path: "codemode-image.png"}); text("saved");`,
    }),
  ]);
  await f.session.prompt("Generate through codemode.");
  expect(resultFor(f.session, "codemode").isError).toBe(false);
  expect(await readFile(path)).toEqual(Buffer.from(IMAGE, "base64"));
  expect(request).toHaveBeenCalledTimes(1);
  expect(f.errors).toEqual([]);
});

it("follows a destination symlink through real SDK tool execution", async () => {
  const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({ base64: IMAGE }));
  const f = await fixture({ enabled: true, dependencies: { request } });
  const target = join(directory, "outside", "existing");
  await mkdir(dirname(target));
  await writeFile(target, "previous file");
  const path = join(directory, "linked-image");
  await symlink(target, path);
  f.responses.push([call(TOOL, { prompt: "An image", path })]);
  await f.session.prompt("Write the synthetic image through a link.");
  expect(resultFor(f.session, TOOL).isError).toBe(false);
  expect(await readFile(target)).toEqual(Buffer.from(IMAGE, "base64"));
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(f.errors).toEqual([]);
});

it("preserves normalized provider prefixes within each epoch and unrelated tool order and metadata across explicit settings toggles", async () => {
  let owner!: ImagegenMenuOwner;
  const f = await fixture({
    mode: "tui",
    dependencies: {
      menu: async (_ctx, value) => {
        owner = value;
      },
    },
    observer(pi) {
      for (const name of ["fixture_zeta", "fixture_alpha"])
        pi.registerTool({
          name,
          label: name,
          description: `${name} stable description`,
          parameters: Type.Object({ text: Type.Optional(Type.String({ description: "Stable input" })) }),
          annotations: { readOnlyHint: true, openWorldHint: false },
          promptSnippet: `${name} stable snippet`,
          promptGuidelines: [`Keep ${name} unchanged.`],
          async execute() {
            return { content: [{ type: "text", text: name }], details: undefined };
          },
        });
    },
  });
  await f.session.prompt("/codex-imagegen");
  const metadata = JSON.parse(JSON.stringify(f.session.getAllTools().filter((tool) => tool.name !== TOOL)));
  const unrelated = f.session.getActiveToolNames().filter((name) => name !== TOOL);
  expect(unrelated).toEqual(["fixture_zeta", "fixture_alpha"]);
  expect(f.session.getActiveToolNames()).toEqual([...unrelated, TOOL]);
  await f.session.prompt("Ordinary default-enabled first");
  await f.session.prompt("Ordinary default-enabled second");
  const baseline = f.captured[0];
  const ordinary = f.captured[1];
  assert.ok(baseline && ordinary);
  sameEpoch(baseline, ordinary);
  expect(baseline.tools.map((tool) => tool.name)).toEqual([...unrelated, TOOL]);
  for (const [enabled, offset] of [
    [false, 2],
    [true, 4],
  ] as const) {
    await owner.saveSettings({ toolEnabled: enabled });
    expect(owner.getSettings().toolEnabled).toBe(enabled);
    expect(JSON.parse(await readFile(owner.settingsPath, "utf8")).toolEnabled).toBe(enabled);
    expect(f.session.getActiveToolNames()).toEqual(enabled ? [...unrelated, TOOL] : unrelated);
    expect(JSON.parse(JSON.stringify(f.session.getAllTools().filter((tool) => tool.name !== TOOL)))).toEqual(metadata);
    await f.session.prompt(`First ordinary turn in enabled=${enabled} epoch`);
    await f.session.prompt(`Second ordinary turn in enabled=${enabled} epoch`);
    const first = f.captured[offset];
    const second = f.captured[offset + 1];
    const previous = f.captured[offset - 1];
    assert.ok(first && second && previous);
    sameEpoch(first, second);
    expect(first.tools.filter((tool) => tool.name !== TOOL)).toEqual(
      baseline.tools.filter((tool) => tool.name !== TOOL),
    );
    expect(first.tools).not.toEqual(previous.tools);
    // An intentional loadout delta must not rewrite any preceding model-visible message.
    expect(first.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  }
  expect(f.errors).toEqual([]);
});

it.each(["print", "json", "rpc"] as const)(
  "rejects the actual /codex-imagegen command safely and observably in %s, including all arguments",
  async (mode) => {
    const menu = vi.fn<NonNullable<Dependencies["menu"]>>(async () => {});
    const request = vi.fn<NonNullable<Dependencies["request"]>>(async () => ({ base64: IMAGE }));
    const f = await fixture({ mode, dependencies: { menu, request } });
    await f.session.prompt("/codex-imagegen");
    if (mode === "rpc") {
      expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("requires TUI mode"), "warning");
      expect(f.errors).toEqual([]);
    } else {
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toMatchObject({
        extensionPath: "command:codex-imagegen",
        event: "command",
        error: expect.stringContaining("requires TUI mode"),
      });
      expect(f.notify).not.toHaveBeenCalled();
    }
    f.errors.length = 0;
    for (const args of ["help", "generate a cat", "settings", "--help"]) {
      await f.session.prompt(`/codex-imagegen ${args}`);
      expect(f.errors.at(-1)).toMatchObject({
        extensionPath: "command:codex-imagegen",
        event: "command",
        error: expect.stringContaining("accepts no arguments"),
      });
    }
    expect(f.errors).toHaveLength(4);
    expect(menu).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(f.custom).not.toHaveBeenCalled();
    expect(f.captured).toEqual([]);
    expect(f.session.messages).toEqual([]);
  },
);

it.each(["abort-error", "late-success"] as const)(
  "aborts a held manual generation after public session.dispose without session_shutdown (%s)",
  async (completion) => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    let generationError: unknown;
    let shutdowns = 0;
    const publish = vi.fn<NonNullable<Dependencies["publish"]>>(async () => ({
      path: join(directory, "must-not-exist.webp"),
    }));
    const f = await fixture({
      mode: "tui",
      observer(pi) {
        pi.on("session_shutdown", () => {
          shutdowns += 1;
        });
      },
      dependencies: {
        publish,
        request: async (_registry, _input, options) => {
          const signal = options?.signal;
          assert.ok(signal);
          return new Promise<{ base64: string }>((finish, reject) => {
            const stop = () => {
              aborted.resolve();
              // A late transport result must not bypass the post-await ownership check.
              if (completion === "late-success") finish({ base64: IMAGE });
              else reject(signal.reason);
            };
            signal.addEventListener("abort", stop, { once: true });
            started.resolve(signal);
            if (signal.aborted) stop();
          });
        },
        menu: async (_ctx, owner) => {
          try {
            await owner.generate("Held manual image", "explicit-output/held", owner.signal);
          } catch (error) {
            generationError = error;
          }
        },
      },
    });
    const running = f.session.prompt("/codex-imagegen");
    try {
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      const before = structuredClone(f.session.sessionManager.getEntries());
      f.dispose();
      const statusesAtDispose = f.setStatus.mock.calls.length;
      await aborted.promise;
      await running;
      expect(signal.aborted).toBe(true);
      expect(generationError).toBeInstanceOf(DOMException);
      expect((generationError as DOMException).name).toBe("AbortError");
      expect(shutdowns).toBe(0);
      expect(publish).not.toHaveBeenCalled();
      expect(f.session.sessionManager.getEntries()).toEqual(before);
      expect(f.session.messages).toEqual([]);
      expect(f.setStatus.mock.calls.length).toBe(statusesAtDispose);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
      expect(f.captured).toEqual([]);
      // An explicit generation can create its output directory during preflight, but no artifact.
      expect(await readdir(join(directory, "explicit-output"))).toEqual([]);
    } finally {
      f.dispose();
      await running;
    }
  },
);

it("loads the declared source package through DefaultResourceLoader and runs registration, startup, command rejection, and shutdown", async () => {
  let shutdowns = 0;
  const f = await fixture({
    packageEntry: true,
    observer(pi) {
      pi.on("session_shutdown", () => {
        shutdowns += 1;
      });
    },
  });
  const loaded = f.resourceLoader.getExtensions().extensions;
  expect(
    loaded.some((extension) => resolve(extension.path) === resolve("packages/pi-codex-imagegen/src/index.ts")),
  ).toBe(true);
  const imageTool = f.session.getAllTools().find((tool) => tool.name === TOOL);
  assert.ok(imageTool);
  expect(imageTool.exposure).toBe("direct");
  expect(dirname(imageTool.sourceInfo.path)).toBe(resolve("packages/pi-codex-imagegen/src"));
  expect(f.session.getActiveToolNames()).toContain(TOOL);
  await f.session.prompt("/codex-imagegen");
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]?.error).toContain("requires TUI mode");
  expect(f.captured).toEqual([]);
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  expect(shutdowns).toBe(1);
  expect(await readdir(directory)).not.toContain("pi-codex-imagegen");
  await expect(access(join(directory, "pi-codex-imagegen.json"))).rejects.toThrow();
});
