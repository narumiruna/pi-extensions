import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { generateImageRequest } from "../src/image-client.js";
import type { ImagegenMenuOwner, showImagegenMenu } from "../src/menu.js";

const IMAGE = "UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA";
type Factory = typeof import("../src/codex-imagegen.js")["createImagegenExtension"];
type Overrides = NonNullable<Parameters<Factory>[0]>;
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(options: { document?: unknown; mode?: ExtensionContext["mode"]; overrides?: Overrides } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pi-imagegen-extension-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  if (options.document !== undefined) {
    await fs.mkdir(agentDir);
    await fs.writeFile(join(agentDir, "pi-codex-imagegen.json"), JSON.stringify(options.document));
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  // getAgentDir is deliberately evaluated at session_start, never at module load.
  const { createImagegenExtension } = await import("../src/codex-imagegen.js");
  const mock = createMockPi();
  const nativeSettings = { images: { autoResize: false, blockImages: false }, terminal: { showImages: false } };
  const api = Object.assign(mock.rawPi, { getSettings: () => nativeSettings }) as unknown as ExtensionAPI;
  const request = vi.fn<typeof generateImageRequest>(async () => ({ base64: IMAGE, requestId: "fixture-request" }));
  let owner: ImagegenMenuOwner | undefined;
  const menu = vi.fn<typeof showImagegenMenu>(async (_ctx, value) => {
    owner = value;
  });
  createImagegenExtension({ request, menu, ...options.overrides })(api);
  const context = createMockContext({ cwd: root, mode: options.mode ?? "tui" });
  const ctx = context.ctx as ExtensionCommandContext;
  const emit = async (type: "session_start" | "session_shutdown", target: ExtensionContext = ctx) => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, reason: "quit" }, target);
  };
  const command = (args = "") => {
    const registered = mock.commands.get("codex-imagegen");
    if (!registered) throw new Error("Missing codex-imagegen command");
    return registered.handler(args, ctx);
  };
  const tool = () => mock.tools.at(-1) as unknown as ToolDefinition;
  const execute = (params = { prompt: "A small red cube", path: "output/image" }, signal?: AbortSignal) =>
    tool().execute("image-call", params, signal, undefined, ctx as never);
  const getOwner = async () => {
    await command();
    if (!owner) throw new Error("Missing menu owner");
    return owner;
  };
  return {
    ...mock,
    ...context,
    api,
    ctx,
    root,
    agentDir,
    request,
    nativeSettings,
    emit,
    command,
    tool,
    execute,
    getOwner,
  };
}

it("keeps the factory tool hidden and enables it on session start without resolving auth or creating files", async () => {
  const h = await setup();
  expect([...h.commands.keys()]).toEqual(["codex-imagegen"]);
  expect(h.commands.get("codex-imagegen")?.description).toBe("Generate images and manage Codex image settings");
  expect(h.tool().description).toContain("through the Codex image endpoint");
  expect(h.tool().description).not.toMatch(/experimental/i);
  expect(h.tool().description).toContain("Consumes account quota. No automatic retries. Image editing is unsupported.");
  expect(h.tool().exposure).toBe("hidden");
  expect(h.request).not.toHaveBeenCalled();
  await expect(fs.stat(h.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  await h.emit("session_start");
  expect(h.tool().exposure).toBe("direct");
  await expect(fs.stat(h.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it.each(["tui", "rpc", "print", "json"] as const)(
  "keeps invalid settings disabled and reports the load failure in %s",
  async (mode) => {
    const document = { toolEnabled: "invalid" };
    const h = await setup({ document, mode });
    if (h.ctx.hasUI) {
      await h.emit("session_start");
      expect(h.notifications).toContainEqual({ message: expect.stringContaining("Repair"), level: "warning" });
    } else await expect(h.emit("session_start")).rejects.toThrow(/remains disabled/);
    expect(h.tool().exposure).toBe("hidden");
    await expect(h.execute()).rejects.toThrow(/disabled/);
    expect(h.request).not.toHaveBeenCalled();
    expect(await fs.readFile(join(h.agentDir, "pi-codex-imagegen.json"), "utf8")).toBe(JSON.stringify(document));
    await h.emit("session_shutdown");
  },
);

it("reloads explicit tool access overrides without changing them", async () => {
  const h = await setup();
  await h.emit("session_start");
  expect(h.tool().exposure).toBe("direct");
  await fs.mkdir(h.agentDir);
  const path = join(h.agentDir, "pi-codex-imagegen.json");
  for (const enabled of [false, true]) {
    const bytes = JSON.stringify({ toolEnabled: enabled, future: 42 });
    await fs.writeFile(path, bytes);
    await h.emit("session_start");
    expect(h.tool().exposure).toBe(enabled ? "direct" : "hidden");
    expect(await fs.readFile(path, "utf8")).toBe(bytes);
    if (!enabled) await expect(h.execute()).rejects.toThrow(/disabled/);
  }
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it("writes original bytes to the exact session-relative path with default-enabled tool access and structured details", async () => {
  const h = await setup();
  await h.emit("session_start");
  expect(h.tool().exposure).toBe("direct");
  const result = await h.execute({ prompt: "  unmodified prompt  ", path: "assets/cube" });
  const details = result.details as { path: string; requestId: string };
  expect(details.path).toBe(join(h.root, "assets", "cube"));
  expect(h.tool().parameters).toMatchObject({ required: ["prompt", "path"] });
  expect(h.tool().annotations?.destructiveHint).toBe(true);
  expect(await fs.readFile(details.path)).toEqual(Buffer.from(IMAGE, "base64"));
  expect(result.structuredContent).toEqual(result.details);
  expect(details.requestId).toBe("fixture-request");
  expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/webp", data: IMAGE });
  expect(h.request.mock.calls[0]?.[1]).toEqual({ prompt: "  unmodified prompt  ", transparentBackground: false });
  expect(h.statuses.get("codex-imagegen")).toBeUndefined();
  await h.emit("session_shutdown");
});

it("manual generation remains available with the tool hidden and appends without a model turn", async () => {
  const h = await setup({ document: { toolEnabled: false } });
  await h.emit("session_start");
  const owner = await h.getOwner();
  await owner.generate("A landscape", "images/manual", owner.signal);
  expect(h.tool().exposure).toBe("hidden");
  expect(h.sentUserMessages).toEqual([]);
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0]?.options).toEqual({ triggerTurn: false });
  expect(h.sentMessages[0]?.message).toMatchObject({ customType: "codex-imagegen:result", display: true });
  await h.emit("session_shutdown");
});

it("manual publication honors Pi's image-block setting", async () => {
  const h = await setup();
  await h.emit("session_start");
  h.nativeSettings.images.blockImages = true;
  const owner = await h.getOwner();
  await owner.generate("An image", "images/blocked-preview", owner.signal);
  const message = h.sentMessages[0]?.message as { content: { type: string }[] };
  expect(message.content.map((block) => block.type)).toEqual(["text"]);
  await h.emit("session_shutdown");
});

it.each([undefined, null, 42])("requires a string path before authentication or HTTP: %j", async (path) => {
  const h = await setup({ document: { toolEnabled: true } });
  await h.emit("session_start");
  await expect(h.execute({ prompt: "image", path } as never)).rejects.toThrow(/output path/);
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it.each([".", "invalid\0/path"])("preflights invalid destinations before consuming quota: %j", async (path) => {
  const h = await setup({ document: { toolEnabled: true } });
  await h.emit("session_start");
  await expect(h.execute({ prompt: "image", path })).rejects.toThrow();
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it.each(["directory", "file"])("overwrites an exact destination through a %s symlink", async (kind) => {
  const h = await setup({ document: { toolEnabled: true } });
  await h.emit("session_start");
  const directory = join(h.root, "outside");
  await fs.mkdir(directory);
  const target = join(directory, "existing.png");
  await fs.writeFile(target, "previous user file");
  const linked = join(h.root, "linked");
  await fs.symlink(kind === "directory" ? directory : target, linked, kind === "directory" ? "dir" : "file");
  const path = kind === "directory" ? join(linked, "existing.png") : linked;
  const result = await h.execute({ prompt: "image", path });
  expect((result.details as { path: string }).path).toBe(path);
  expect(await fs.readFile(target)).toEqual(Buffer.from(IMAGE, "base64"));
  expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(1);
  await h.emit("session_shutdown");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["new", "new.png", "nested/new"])(
  "rejects an unsearchable destination parent before consuming quota: %j",
  async (name) => {
    const h = await setup({ document: { toolEnabled: true } });
    await h.emit("session_start");
    const directory = join(h.root, "unsearchable");
    await fs.mkdir(directory);
    await fs.chmod(directory, 0o600);
    try {
      await expect(h.execute({ prompt: "image", path: join(directory, name) })).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(directory, 0o700);
      await h.emit("session_shutdown");
    }
  },
);

it("validates image bytes before modifying an existing destination", async () => {
  const h = await setup({
    document: { toolEnabled: true },
    overrides: { request: async () => ({ base64: "not-an-image" }) },
  });
  await h.emit("session_start");
  const path = join(h.root, "existing");
  await fs.writeFile(path, "preserve before validated response");
  await expect(h.execute({ prompt: "image", path })).rejects.toThrow();
  expect(await fs.readFile(path, "utf8")).toBe("preserve before validated response");
  await h.emit("session_shutdown");
});

it("captures path and prompt before asynchronous generation", async () => {
  const started = deferred<void>();
  const response = deferred<{ base64: string }>();
  const h = await setup({
    document: { toolEnabled: true },
    overrides: {
      request: async () => {
        started.resolve();
        return response.promise;
      },
    },
  });
  await h.emit("session_start");
  const params = { prompt: "original prompt", path: "original/destination" };
  const running = h.execute(params);
  await started.promise;
  params.path = "different/destination";
  params.prompt = "changed";
  response.resolve({ base64: IMAGE });
  const result = await running;
  expect((result.details as { path: string }).path).toBe(join(h.root, "original/destination"));
  expect(await fs.readFile(join(h.root, "original/destination"))).toEqual(Buffer.from(IMAGE, "base64"));
  await expect(fs.access(join(h.root, "different"))).rejects.toThrow();
  await h.emit("session_shutdown");
});

it.each(["a".repeat(60_000), "\n".repeat(5000)])(
  "bounds filesystem error text before it becomes a tool result",
  async (path) => {
    const h = await setup({ document: { toolEnabled: true } });
    await h.emit("session_start");
    const error = await h.execute({ prompt: "image", path }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected path error");
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(50 * 1024);
    expect(error.message.split("\n").length).toBeLessThanOrEqual(2000);
    expect(h.request).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  },
);

it("applies setting changes immediately, rejects busy changes, and guards captured tool implementations", async () => {
  const h = await setup({ document: { toolEnabled: false } });
  await h.emit("session_start");
  const owner = await h.getOwner();
  await owner.saveSettings({ toolEnabled: true, transparentBackground: true });
  const enabled = h.tool();
  await h.execute();
  expect(h.request.mock.calls[0]?.[1].transparentBackground).toBe(true);
  await owner.saveSettings({ toolEnabled: false });
  expect(h.tool().exposure).toBe("hidden");
  await expect(
    enabled.execute("stale-tool", { prompt: "image", path: "must-not-write" }, undefined, undefined, h.ctx as never),
  ).rejects.toThrow(/disabled/);
  const idle = h.ctx.isIdle;
  h.ctx.isIdle = () => false;
  await expect(owner.saveSettings({ toolEnabled: true })).rejects.toThrow(/idle/);
  h.ctx.isIdle = idle;
  await h.emit("session_shutdown");
});

it("rolls back partial tool-registration failure together with settings publication", async () => {
  const h = await setup();
  await h.emit("session_start");
  const owner = await h.getOwner();
  const register = h.rawPi.registerTool;
  let fail = true;
  h.rawPi.registerTool = (tool) => {
    register(tool);
    if ((tool as ToolDefinition).exposure === "hidden" && fail) {
      fail = false;
      throw new Error("runtime failure");
    }
  };
  await expect(owner.saveSettings({ toolEnabled: false })).rejects.toThrow();
  expect(owner.getSettings().toolEnabled).toBe(true);
  expect(h.tool().exposure).toBe("direct");
  await expect(fs.stat(join(h.agentDir, "pi-codex-imagegen.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await owner.saveSettings({ toolEnabled: false });
  expect(h.tool().exposure).toBe("hidden");
  await h.emit("session_shutdown");
});

it("aborts a running request on session shutdown, releases busy state, and clears only its status", async () => {
  const started = deferred<void>();
  const request = vi.fn<typeof generateImageRequest>(async (_registry, _params, { signal }) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    return { base64: IMAGE };
  });
  const h = await setup({ document: { toolEnabled: true }, overrides: { request } });
  await h.emit("session_start");
  h.statuses.set("other-extension", "untouched");
  const running = h.execute();
  const failed = expect(running).rejects.toThrow();
  await started.promise;
  await expect(h.execute()).rejects.toThrow(/already running/);
  await h.emit("session_shutdown");
  await failed;
  expect(h.statuses.get("codex-imagegen")).toBeUndefined();
  expect(h.statuses.get("other-extension")).toBe("untouched");
  await h.emit("session_shutdown");
});

it("replaces headless sessions by manager identity even when they share the no-op UI", async () => {
  const h = await setup({ document: { toolEnabled: true }, mode: "print" });
  await h.emit("session_start");
  const oldTool = h.tool();
  const next = createMockContext({ mode: "print", cwd: h.root, ui: h.ctx.ui }).ctx as ExtensionContext;
  await h.emit("session_start", next);
  await expect(
    oldTool.execute("old", { prompt: "image", path: "must-not-write" }, undefined, undefined, h.ctx as never),
  ).rejects.toThrow(/unavailable/);
  const result = await h
    .tool()
    .execute("new", { prompt: "image", path: "new-session/destination" }, undefined, undefined, next as never);
  expect(result.content[0]?.type).toBe("text");
  await h.emit("session_shutdown", next);
});

it("revalidates a delayed response and never publishes after cancellation", async () => {
  const response = deferred<{ base64: string }>();
  const started = deferred<void>();
  const publish = vi.fn<NonNullable<Overrides["publish"]>>();
  const h = await setup({
    document: { toolEnabled: true },
    overrides: {
      request: async () => {
        started.resolve();
        return response.promise;
      },
      publish,
    },
  });
  await h.emit("session_start");
  const controller = new AbortController();
  const running = h.execute({ prompt: "image", path: "cancelled/destination" }, controller.signal);
  const failed = expect(running).rejects.toThrow();
  await started.promise;
  controller.abort();
  response.resolve({ base64: IMAGE });
  await failed;
  expect(publish).not.toHaveBeenCalled();
  expect(h.sentMessages).toEqual([]);
  await h.emit("session_shutdown");
});

it("renderers sanitize control text and handle incomplete or historical results", async () => {
  const h = await setup();
  await h.emit("session_start");
  const theme = { fg: (_role: unknown, text: string) => text, bold: (text: string) => text } as Theme;
  const resultRenderer = h.tool().renderResult;
  if (!resultRenderer) throw new Error("Missing tool renderer");
  const rendered = resultRenderer(
    { content: [{ type: "text", text: "Sign in\x1b]0;injected\x07" }], details: undefined },
    {} as never,
    theme,
    {} as never,
  )
    .render(60)
    .join("\n");
  expect(rendered).toContain("Sign in");
  expect(rendered).not.toContain("injected");
  const renderer = h.messageRenderers.get("codex-imagegen:result");
  if (!renderer) throw new Error("Missing message renderer");
  const component = renderer({ content: "history", details: undefined }, {}, theme) as {
    render(width: number): string[];
  };
  expect(component.render(40).join("\n")).toContain("path unavailable");
  await h.emit("session_shutdown");
});
