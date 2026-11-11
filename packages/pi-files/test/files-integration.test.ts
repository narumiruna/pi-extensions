import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, afterEach, expect, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { ScopeMenuOptions } from "../src/scope/menu.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "pi-files-integration-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { SessionManager, initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
const { registerFiles } = await import("../src/files.js");
const { resolveScopeTarget } = await import("../src/scope/paths.js");
const { createSnapshot, STATE_TYPE } = await import("../src/scope/state.js");
const { createPendingWidget, widgetClick } = await import("./widget-support.js");
const pending: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of pending.splice(0)) await close();
});
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  const allowed = join(directory, "allowed.txt");
  const other = join(directory, "other.txt");
  await writeFile(allowed, "exact snapshot\n");
  await writeFile(other, "other\n");
  const target = await resolveScopeTarget(pathToFileURL(allowed).href, directory, "existing");
  const manager = SessionManager.inMemory(directory);
  const names = ["read", "write", "edit", "bash"];
  const mock = createMockPi({
    activeTools: names,
    allTools: names.map((name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
  });
  Object.assign(mock.rawPi, {
    getSettings: () => ({ codemode: { mode: "on" } }),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) =>
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
  });
  let next = async (_options: ScopeMenuOptions) => {};
  await registerFiles(mock.pi, {
    context: {
      settingsPath: join(directory, "context.json"),
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
      discoverFiles: async () => ["allowed.txt", "other.txt"],
      createGit: async () => undefined,
    },
    scope: { showMenu: async (_ctx, options) => next(options) },
  });
  const tui = createTuiHarness({ width: 90, rows: 22 });
  const base = createMockContext({ mode: "tui", cwd: directory, sessionManager: manager });
  const baseCtx = base.ctx as unknown as ExtensionCommandContext;
  const ctx = Object.assign(baseCtx, { ui: { ...baseCtx.ui, custom: tui.custom } });
  const emit = async (name: string, event: Record<string, unknown> = {}, context = ctx) => {
    let result: unknown;
    for (const hook of mock.events.get(name) ?? []) {
      const value = await hook({ type: name, ...event }, context);
      if (value !== undefined) result = value;
      if ((value as { block?: boolean } | undefined)?.block) break;
    }
    return result;
  };
  const command = async (name: string, args = "", context = ctx) => mock.commands.get(name)?.handler(args, context);
  const close = async () => {
    await emit("session_shutdown");
  };
  pending.push(close);
  await emit("session_start");
  return {
    directory,
    allowed,
    other,
    target,
    manager,
    mock,
    tui,
    base,
    ctx,
    emit,
    command,
    close,
    apply: async () => {
      next = (options) => options.apply([target]);
      await command("scope");
      next = async () => {};
    },
  };
}
async function waitText(tui: ReturnType<typeof createTuiHarness>, text: string) {
  for (let count = 0; count < 500; count++) {
    if (tui.isOpen && tui.render().join("\n").includes(text)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Screen did not show ${text}`);
}
async function quote(f: Awaited<ReturnType<typeof fixture>>) {
  const running = f.command("files", "browse");
  await waitText(f.tui, "File Context · files");
  f.tui.press("tui.select.confirm");
  await waitText(f.tui, "Enter add");
  f.tui.press("tui.select.confirm");
  await running;
}
const gate = (f: Awaited<ReturnType<typeof fixture>>, path: string) =>
  f.emit("tool_call", { toolName: "write", input: { path }, toolCallId: "test" });

test("registers one command surface and keeps context attachment separate from scope", async () => {
  const f = await fixture();
  expect([...f.mock.commands.keys()].sort()).toEqual(["edit-scope", "file-context", "files", "scope"]);
  await quote(f);
  expect(f.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)).toBe(false);
  await f.apply();
  expect(await gate(f, f.allowed)).toBeUndefined();
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  const widget = createPendingWidget(f.base.widgets.get("files")).render(120).join("\n");
  expect(widget).toContain("Editing limited to 1 file");
  expect(widget).toContain("Next prompt context · 1 snippet");
  expect(widget).toContain("/files off");
  expect(await f.emit("before_agent_start", { messageType: "custom" })).toBeUndefined();
  const injected = await f.emit("before_agent_start", { messageType: "user" });
  expect(JSON.stringify(injected)).toContain("exact snapshot");
  expect(await f.emit("before_agent_start", { messageType: "user" })).toBeUndefined();
  expect(await gate(f, f.other)).toMatchObject({ block: true });
});

test("keeps Files collapsed across summary and branch updates, with manager keyboard restoration", async () => {
  const f = await fixture();
  await f.apply();
  let component = createPendingWidget(f.base.widgets.get("files"));
  const expanded = component.render(120);
  expect(expanded[0]).toBe(`─ ▾ Files ${"─".repeat(110)}`);
  // A body click is not limited to the divider or the label.
  expect(widgetClick(component, 0, 1, expanded.length)).toEqual({ handled: true, render: true });
  expect(component.render(120)).toEqual([`─ ▸ Files ${"─".repeat(110)}`]);
  component.dispose?.(); // Pi disposes the previous component before a replacement mount.
  await quote(f);
  component = createPendingWidget(f.base.widgets.get("files"));
  expect(component.render(120)).toHaveLength(1);
  await f.emit("session_tree");
  component.dispose?.();
  component = createPendingWidget(f.base.widgets.get("files"));
  expect(component.render(120)).toHaveLength(1);
  expect(await gate(f, f.other)).toMatchObject({ block: true });

  const running = f.command("files");
  await waitText(f.tui, "Manage edit scope");
  component.dispose?.();
  component = createPendingWidget(f.base.widgets.get("files"));
  const restored = component.render(120);
  expect(restored.join("\n")).toContain("Next prompt context · 1 snippet");
  f.tui.press("ctrl+c");
  await running;
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  // The blank right side of a short body row is also part of the widget.
  expect(widgetClick(component, 119, restored.length - 1, restored.length)).toEqual({
    handled: true,
    render: true,
  });
  expect(component.render(120)).toHaveLength(1);
  await f.emit("before_agent_start", { messageType: "user" });
  component.dispose?.();
  component = createPendingWidget(f.base.widgets.get("files"));
  expect(component.render(120)).toHaveLength(1);
  expect(await gate(f, f.other)).toMatchObject({ block: true });
});

test("resets Files disclosure on session replacement and ignores disposed input", async () => {
  const f = await fixture();
  await f.apply();
  const previous = createPendingWidget(f.base.widgets.get("files"));
  const height = previous.render(120).length;
  widgetClick(previous, 119, 1, height);
  expect(previous.render(120)).toHaveLength(1);
  previous.dispose?.();
  await f.emit("session_start");
  const current = createPendingWidget(f.base.widgets.get("files"));
  expect(current.render(120).length).toBeGreaterThan(1);
  expect(widgetClick(previous, 119, 1, height)).toBeUndefined();
  expect(current.render(120)[0]).toBe(`─ ▾ Files ${"─".repeat(110)}`);
  expect(await gate(f, f.other)).toMatchObject({ block: true });
});

test("off preserves queued snapshots; tree restoration changes scope only", async () => {
  const f = await fixture();
  await quote(f);
  await f.apply();
  await f.command("files", "off");
  expect(await gate(f, f.other)).toBeUndefined();
  expect(createPendingWidget(f.base.widgets.get("files")).render(120).join("\n")).toContain(
    "Next prompt context · 1 snippet",
  );
  f.manager.appendCustomEntry(STATE_TYPE, createSnapshot(f.directory, [f.target]));
  await f.emit("session_tree");
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  expect(JSON.stringify(await f.emit("before_agent_start", { messageType: "user" }))).toContain("exact snapshot");
});

test("serializes manager/legacy/shortcut flows and cancels without ending scope", async () => {
  const f = await fixture();
  await f.apply();
  const running = f.command("files");
  await waitText(f.tui, "Manage edit scope");
  await expect(f.command("scope", "off")).rejects.toThrow("Files menu is already open");
  await expect(f.command("files", "browse")).rejects.toThrow("Files menu is already open");
  await expect(f.command("file-context", "invalid extra")).resolves.toBeUndefined();
  expect(f.base.notifications.at(-1)?.message).toContain("Usage:");
  f.tui.press("ctrl+c");
  await running;
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  await f.command("files", "off");
  expect(await gate(f, f.other)).toBeUndefined();
});

test.each(["rpc", "print", "json"])("rejects files UI in %s before opening a screen", async (mode) => {
  const f = await fixture();
  const ctx = createMockContext({ mode, cwd: f.directory, sessionManager: f.manager })
    .ctx as unknown as ExtensionCommandContext;
  for (const args of ["", "browse", "off"])
    await expect(f.command("files", args, ctx)).rejects.toThrow("requires Pi TUI mode");
  expect(f.tui.openCount).toBe(0);
});

test("rejects unknown files arguments and supplies only known completions", async () => {
  const f = await fixture();
  for (const args of ["help", "browse extra", "off extra", "OFF"])
    await expect(f.command("files", args)).rejects.toThrow("Usage:");
  expect(f.mock.commands.get("files")?.getArgumentCompletions?.("b")).toEqual([
    { value: "browse", label: "browse", description: "Open the context browser" },
  ]);
});

test("retains scope and normalized model prefixes across quote attachment and reload", async () => {
  const f = await fixture();
  await f.apply();
  const initial = f.manager.buildSessionContext().messages;
  const first = await f.emit("context_with_system", { messages: initial });
  expect(await f.emit("context_with_system", { messages: initial })).toEqual(first);
  await quote(f);
  const injection = (await f.emit("before_agent_start", { messageType: "user" })) as {
    message: { customType: string; content: string; display: boolean };
  };
  f.manager.appendCustomMessageEntry(injection.message.customType, injection.message.content, false);
  const later = (await f.emit("context_with_system", { messages: f.manager.buildSessionContext().messages })) as {
    messages: unknown[];
  };
  expect(later.messages.slice(0, initial.length)).toEqual(initial);
  await f.emit("session_shutdown");
  await f.emit("session_start");
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  expect(await f.emit("before_agent_start", { messageType: "user" })).toBeUndefined();
  await expect(readFile(join(f.directory, "context.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("isolates concurrent headless managers sharing the same no-op UI", async () => {
  const f = await fixture();
  await quote(f);
  await f.apply();
  const otherManager = SessionManager.inMemory(f.directory);
  const sharedUI = (createMockContext({ mode: "json" }).ctx as unknown as ExtensionCommandContext).ui;
  const a = createMockContext({ mode: "json", cwd: f.directory, sessionManager: f.manager, ui: sharedUI })
    .ctx as unknown as ExtensionCommandContext;
  const b = createMockContext({ mode: "json", cwd: f.directory, sessionManager: otherManager, ui: sharedUI })
    .ctx as unknown as ExtensionCommandContext;
  await f.emit("session_start", {}, b);
  expect(JSON.stringify(await f.emit("before_agent_start", { messageType: "user" }, a))).toContain("exact snapshot");
  expect(await f.emit("before_agent_start", { messageType: "user" }, b)).toBeUndefined();
  expect(await f.emit("tool_call", { toolName: "write", input: { path: f.other } }, a)).toMatchObject({ block: true });
  expect(await f.emit("tool_call", { toolName: "write", input: { path: f.other } }, b)).toBeUndefined();
  await f.emit("session_shutdown", {}, b);
  expect(await f.emit("tool_call", { toolName: "write", input: { path: f.other } }, a)).toMatchObject({ block: true });
});

test.each(["files", "file-context"])("shortcut reload through %s does not await its own lifecycle", async (route) => {
  const f = await fixture();
  await f.apply();
  let reloads = 0;
  f.ctx.reload = async () => {
    reloads++;
    await f.emit("session_shutdown");
    await f.emit("session_start");
  };
  const running = f.command(route);
  await waitText(f.tui, route === "files" ? "Manage edit scope" : "Add context snippet");
  for (let index = 0; index < 8 && !f.tui.render().join("\n").includes("→ Settings"); index++)
    f.tui.press("tui.select.down");
  expect(f.tui.render().join("\n")).toContain("→ Settings");
  f.tui.press("tui.select.confirm");
  await waitText(f.tui, route === "files" ? "Files Settings" : "File Context Settings");
  f.tui.press("tui.select.confirm");
  await waitText(f.tui, route === "files" ? "Use a Pi key identifier" : "Submit an empty value");
  f.tui.send("\u0015");
  f.tui.type("ctrl+y");
  f.tui.press("tui.input.submit");
  await running;
  expect(reloads).toBe(1);
  expect(JSON.parse(await readFile(join(f.directory, "context.json"), "utf8"))).toEqual({ openShortcut: "ctrl+y" });
  expect(await gate(f, f.other)).toMatchObject({ block: true });
});
