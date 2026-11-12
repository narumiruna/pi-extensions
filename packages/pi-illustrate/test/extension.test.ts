import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({ layout: vi.fn(), raster: vi.fn(), dispose: vi.fn() }));
vi.mock("../src/rasterizer.js", async (original) => {
  const actual = await original<typeof import("../src/rasterizer.js")>();
  return {
    ...actual,
    Rasterizer: class {
      active = 0;
      layout = work.layout;
      raster = work.raster;
      dispose = work.dispose;
    },
  };
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const layout = {
  kind: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>',
  width: 200,
  height: 100,
};
const oldCaps = getCapabilities();
let directory: string;
let tools: Map<string, ToolDefinition>;
let handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>;
let ctx: ExtensionContext;
let run: (params?: unknown, context?: ExtensionContext, signal?: AbortSignal) => Promise<unknown>;

function getTool(name: string): ToolDefinition {
  const tool = tools.get(name);
  assert.ok(tool);
  return tool;
}
function getHandler(name: string) {
  const handler = handlers.get(name);
  assert.ok(handler);
  return handler;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "illustrate-contract-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.resetModules();
  work.layout.mockReset().mockResolvedValue(layout);
  work.raster.mockReset().mockResolvedValue({ png, width: 1, height: 1 });
  work.dispose.mockReset().mockResolvedValue(undefined);
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  tools = new Map();
  handlers = new Map();
  const { default: extension } = await import("../src/index.js");
  extension({
    on: (event: string, handler: unknown) =>
      handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => Promise<unknown>),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand() {},
  } as unknown as ExtensionAPI);
  ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    model: { input: ["text", "image"] },
    ui: { theme: { appearance: "dark" }, notify: vi.fn() },
  } as unknown as ExtensionContext;
  run = (params = { svg: layout.svg }, context = ctx, signal) =>
    getTool("illustrate_svg").execute("one", params, signal, undefined, context as ExtensionToolContext);
});
afterEach(async () => {
  await handlers.get("session_shutdown")?.({}, ctx);
  setCapabilities(oldCaps);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it("registers stable schemas without factory work or side effects", () => {
  expect([...tools.keys()]).toEqual(["illustrate_svg", "illustrate_mermaid"]);
  expect(work.layout).not.toHaveBeenCalled();
  expect(work.raster).not.toHaveBeenCalled();
  const schema = getTool("illustrate_svg").parameters as { properties: { cols: Record<string, unknown> } };
  expect(schema.properties.cols).not.toHaveProperty("default");
});

it.each(["print", "json", "rpc"] as const)("rejects %s before rendering", async (mode) => {
  await expect(run(undefined, { ...ctx, mode })).rejects.toThrow("TUI mode");
  expect(work.layout).not.toHaveBeenCalled();
});

it.each([null, "iterm2"] as const)("rejects image protocol %s before rendering", async (images) => {
  setCapabilities({ images, trueColor: true, hyperlinks: false });
  await expect(run()).rejects.toThrow("Kitty graphics");
  expect(work.layout).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, "80", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid columns %s", async (cols) => {
  await expect(run({ svg: layout.svg, cols })).rejects.toThrow("cols");
  expect(work.layout).not.toHaveBeenCalled();
});

it("rejects a missing session, invalid source, invalid image opt-in, and text-only model", async () => {
  await expect(run()).rejects.toThrow("not ready");
  await expect(run({ svg: "" })).rejects.toThrow("source");
  await expect(run({ svg: layout.svg, sendToModel: "yes" })).rejects.toThrow("boolean");
  await expect(
    run({ svg: layout.svg, sendToModel: true }, { ...ctx, model: { input: ["text"] } } as unknown as ExtensionContext),
  ).rejects.toThrow("image input");
  expect(work.layout).not.toHaveBeenCalled();
});

it("throws on pre-abort and rechecks ownership after awaiting layout", async () => {
  await getHandler("session_start")({}, ctx);
  const aborted = AbortSignal.abort();
  await expect(run(undefined, ctx, aborted)).rejects.toThrow("cancelled");
  expect(work.layout).not.toHaveBeenCalled();
  let finish!: (value: typeof layout) => void;
  work.layout.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run();
  await Promise.resolve();
  await getHandler("session_shutdown")({}, ctx);
  finish(layout);
  await expect(pending).rejects.toThrow("cancelled");
  expect(work.raster).not.toHaveBeenCalled();
});

it("restores only active-branch records across resume, fork, and tree navigation", async () => {
  vi.useFakeTimers();
  const details = { type: "pi-illustrate/v1", layout, cols: "auto" };
  let branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "illustrate_svg", toolCallId: "restored", details } },
  ];
  ctx = { ...ctx, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  await getHandler("session_start")({ reason: "resume" }, ctx);
  const renderer = getTool("illustrate_svg").renderResult;
  assert.ok(renderer);
  const renderContext = {
    toolCallId: "restored",
    showImages: true,
    isError: false,
    invalidate: vi.fn(),
  } as unknown as Parameters<typeof renderer>[3];
  const renderTheme = { appearance: "dark", fg: (_role: string, text: string) => text } as Theme;
  const component = renderer(
    { content: [{ type: "text", text: "Rendered" }], details },
    { expanded: false, isPartial: false },
    renderTheme,
    renderContext,
  );
  component.render(82);
  await vi.advanceTimersByTimeAsync(0);
  expect(work.raster).toHaveBeenCalledOnce();
  expect(work.layout).not.toHaveBeenCalled();
  branch = [];
  await getHandler("session_tree")({}, ctx);
  expect(component.render(82)).toEqual(["Preview session closed."]);
  const detached = renderer(
    { content: [{ type: "text", text: "Rendered" }], details },
    { expanded: false, isPartial: false },
    renderTheme,
    renderContext,
  );
  expect(detached.render(82)).toEqual(["Preview is outside the active session branch."]);
  const manager = {
    getBranch: () => [
      { type: "message", message: { role: "toolResult", toolName: "illustrate_svg", toolCallId: "restored", details } },
    ],
  };
  ctx = { ...ctx, sessionManager: manager } as unknown as ExtensionContext;
  await getHandler("session_start")({ reason: "fork" }, ctx);
  const forked = renderer(
    { content: [{ type: "text", text: "Rendered" }], details },
    { expanded: false, isPartial: false },
    renderTheme,
    renderContext,
  );
  forked.render(82);
  await vi.advanceTimersByTimeAsync(0);
  expect(work.raster).toHaveBeenCalledTimes(2);
  expect(work.layout).not.toHaveBeenCalled();
});

it("does not resurrect an owner if shutdown races replacement teardown", async () => {
  await getHandler("session_start")({}, ctx);
  let finish!: () => void;
  work.dispose.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const replacing = getHandler("session_tree")({}, ctx);
  await Promise.resolve();
  const shutdown = getHandler("session_shutdown")({}, ctx);
  finish();
  await Promise.all([replacing, shutdown]);
  await expect(run()).rejects.toThrow("not ready");
  expect(work.layout).not.toHaveBeenCalled();
});

it("makes the model opt-in explicit and preserves text-only stored content", async () => {
  await getHandler("session_start")({}, ctx);
  const ordinary = (await run()) as { content: { type: string }[]; details: { modelImage?: unknown } };
  expect(ordinary.content.every((item) => item.type === "text")).toBe(true);
  expect(ordinary.details.modelImage).toBeUndefined();
  const opted = (await run({ svg: layout.svg, sendToModel: true })) as typeof ordinary;
  expect(opted.content.every((item) => item.type === "text")).toBe(true);
  expect(opted.details.modelImage).toMatchObject({ type: "image", mimeType: "image/png", data: png });
});
