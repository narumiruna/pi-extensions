import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
  const command = async (args = "", context = ctx) => {
    const registered = mock.commands.get("files");
    if (!registered) throw new Error("Missing /files");
    return registered.handler(args, context);
  };
  const shortcut = async () => {
    const registered = mock.shortcuts.get("f8");
    if (!registered) throw new Error("Missing browser shortcut");
    return registered.handler(ctx);
  };
  const close = async () => {
    try {
      await emit("session_shutdown");
    } finally {
      tui.dispose();
    }
  };
  const scope = async (action: typeof next) => {
    next = action;
    try {
      const running = command();
      await waitText(tui, "Manage edit scope");
      select(tui, "Manage edit scope");
      await running;
    } finally {
      next = async () => {};
    }
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
    shortcut,
    close,
    apply: () => scope((options) => options.apply([target])),
  };
}
async function waitText(tui: ReturnType<typeof createTuiHarness>, text: string) {
  for (let count = 0; count < 500; count++) {
    if (tui.isOpen && tui.render().join("\n").includes(text)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Screen did not show ${text}`);
}
function select(tui: ReturnType<typeof createTuiHarness>, label: string) {
  for (let index = 0; index < 6 && !tui.render().join("\n").includes(`→ ${label}`); index++)
    tui.press("tui.select.down");
  expect(tui.render().join("\n")).toContain(`→ ${label}`);
  tui.press("tui.select.confirm");
}

async function quote(f: Awaited<ReturnType<typeof fixture>>) {
  const running = f.command(" browse ");
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
  expect([...f.mock.commands.keys()]).toEqual(["files"]);
  for (const legacy of ["file-context", "file-quote", "edit-scope", "scope"])
    expect(f.mock.commands.has(legacy)).toBe(false);
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

  const running = f.command();
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
  await f.command(" off ");
  expect(await gate(f, f.other)).toBeUndefined();
  expect(createPendingWidget(f.base.widgets.get("files")).render(120).join("\n")).toContain(
    "Next prompt context · 1 snippet",
  );
  f.manager.appendCustomEntry(STATE_TYPE, createSnapshot(f.directory, [f.target]));
  await f.emit("session_tree");
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  expect(JSON.stringify(await f.emit("before_agent_start", { messageType: "user" }))).toContain("exact snapshot");
});

test("serializes manager, browser, and shortcut flows and cancels without ending scope", async () => {
  const f = await fixture();
  await f.apply();
  const running = f.command();
  await waitText(f.tui, "Manage edit scope");
  for (const args of ["", "off", "browse"]) await expect(f.command(args)).rejects.toThrow("Files menu is already open");
  await expect(f.shortcut()).rejects.toThrow("Files menu is already open");
  await expect(f.command("invalid extra")).rejects.toThrow("Usage: /files [browse|off]");
  f.tui.press("ctrl+c");
  await running;

  const browsing = f.shortcut();
  await waitText(f.tui, "File Context · files");
  const openCount = f.tui.openCount;
  const joined = [f.shortcut(), f.command("browse")];
  for (const args of ["", "off"]) await expect(f.command(args)).rejects.toThrow("Files menu is already open");
  expect(f.tui.openCount).toBe(openCount);
  f.tui.press("ctrl+c");
  await Promise.all([browsing, ...joined]);
  expect(f.tui.isOpen).toBe(false);
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  await f.command("off");
  expect(await gate(f, f.other)).toBeUndefined();
});

test.each(["isIdle", "hasPendingMessages"] as const)(
  "preserves scope permission-change checks for %s through /files",
  async (check) => {
    const f = await fixture();
    await f.apply();
    f.ctx[check] = () => check === "hasPendingMessages";
    await expect(f.command("off")).rejects.toThrow("Stop the current run");
    const running = f.command();
    const rejected = expect(running).rejects.toThrow("Stop the current run");
    await waitText(f.tui, "Manage edit scope");
    select(f.tui, "Manage edit scope");
    await rejected;
    expect(f.tui.openCount).toBe(2); // Only Files opened for apply and for the rejected selection.
    expect(await gate(f, f.other)).toMatchObject({ block: true });
  },
);

test("tree navigation cancels an open review and leaves queued snapshots available", async () => {
  const f = await fixture();
  await quote(f);
  await f.apply();
  const running = f.command();
  await waitText(f.tui, "Manage edit scope");
  select(f.tui, "Review queued context");
  await waitText(f.tui, "Selected context");
  f.tui.press("tui.select.confirm");
  await waitText(f.tui, "Remove from next prompt");
  await f.emit("session_tree");
  await running;
  expect(f.tui.isOpen).toBe(false);
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  expect(JSON.stringify(await f.emit("before_agent_start", { messageType: "user" }))).toContain("exact snapshot");
});

test.each(["rpc", "print", "json", "tui"])("rejects files UI without an interactive TUI (%s)", async (mode) => {
  const f = await fixture();
  const ctx = createMockContext({ mode, hasUI: mode === "rpc", cwd: f.directory, sessionManager: f.manager })
    .ctx as unknown as ExtensionCommandContext;
  ctx.ui.custom = f.tui.custom;
  for (const args of ["", "browse", "off"]) await expect(f.command(args, ctx)).rejects.toThrow("requires Pi TUI mode");
  await expect(f.command("browse trailing", ctx)).rejects.toThrow("Usage: /files [browse|off]");
  expect(f.tui.openCount).toBe(0);
});

test("rejects unknown files arguments and supplies only known completions", async () => {
  const f = await fixture();
  for (const args of ["help", "remove", "browse extra", "off extra", "OFF", "BROWSE"])
    await expect(f.command(args)).rejects.toThrow("Usage: /files [browse|off]");
  expect(f.tui.openCount).toBe(0);
  const complete = f.mock.commands.get("files")?.getArgumentCompletions;
  const browse = { value: "browse", label: "browse", description: "Open the context browser" };
  const off = { value: "off", label: "off", description: "End the editing restriction" };
  expect(complete?.("")).toEqual([browse, off]);
  expect(complete?.("br")).toEqual([browse]);
  expect(complete?.("o")).toEqual([off]);
  for (const prefix of ["remove", "off extra", "browse ", "OFF"]) expect(complete?.(prefix)).toEqual([]);
});

test("shows current state, Status, and Help without changing scope or queued context", async () => {
  const f = await fixture();
  const empty = f.command();
  await waitText(f.tui, "Manage edit scope");
  expect(f.tui.render().join("\n")).toMatch(/\[-\].*Review queued context \(0\)/u);
  for (const [width, rows] of [
    [20, 6],
    [40, 12],
    [90, 22],
  ]) {
    expect(f.tui.resize({ width, rows }).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  f.tui.press("ctrl+c");
  await empty;
  await quote(f);
  await f.apply();

  const running = f.command();
  await waitText(f.tui, "Manage edit scope");
  expect(f.tui.render().join("\n")).toContain("Edit scope: 1 allowed files");
  select(f.tui, "Status");
  await waitText(f.tui, "Files Status");
  const status = f.tui.render().join("\n");
  expect(status).toContain("Next prompt context: 1/8 snippets");
  expect(status).toContain("Browser shortcut: f8");
  expect(status.replaceAll("\n", "")).toContain(f.allowed);
  f.tui.press("tui.select.cancel");
  await waitText(f.tui, "Manage edit scope");
  select(f.tui, "Help");
  await waitText(f.tui, "Files Help");
  const help = f.tui.render().join("\n");
  expect(help).toContain("Context snapshots attach once");
  expect(help).not.toMatch(/\/(?:file-context|edit-scope|scope)\b/u);
  f.tui.press("tui.select.cancel");
  await waitText(f.tui, "Manage edit scope");
  f.tui.press("ctrl+c");
  await running;
  expect(await gate(f, f.other)).toMatchObject({ block: true });
  expect(JSON.stringify(await f.emit("before_agent_start", { messageType: "user" }))).toContain("exact snapshot");
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

test.each(["ctrl+y", null])(
  "saving shortcut %s in Files Settings can reload without waiting on itself",
  async (shortcut) => {
    const f = await fixture();
    await f.apply();
    let reloads = 0;
    f.ctx.reload = async () => {
      reloads++;
      await f.emit("session_shutdown");
      await f.emit("session_start");
    };
    const running = f.command();
    await waitText(f.tui, "Manage edit scope");
    select(f.tui, "Settings");
    await waitText(f.tui, "Files Settings");
    f.tui.press("tui.select.confirm");
    await waitText(f.tui, "Use a Pi key identifier");
    f.tui.send("\u0015");
    if (shortcut) f.tui.type(shortcut);
    f.tui.press("tui.input.submit");
    await running;
    expect(reloads).toBe(1);
    expect([...f.mock.shortcuts.keys()]).toEqual(["f8"]);
    expect(JSON.parse(await readFile(join(f.directory, "context.json"), "utf8"))).toEqual({ openShortcut: shortcut });
    expect(await gate(f, f.other)).toMatchObject({ block: true });
  },
);
