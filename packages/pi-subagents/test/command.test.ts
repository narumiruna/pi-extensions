import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { SubagentSettingsStore } from "../src/settings.js";
import type subagents from "../src/subagents.js";
import type { ChildRequest, ChildResult } from "../src/types.js";
import { SUBAGENT_WIDGET_KEY } from "../src/widget.js";

type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;
let directory: string;
let extension: typeof subagents;
const sessions: { mock: Mock; context: Context }[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-command-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.resetModules();
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  extension = (await import("../src/subagents.js")).default;
});

afterEach(async () => {
  for (const { mock, context } of sessions.splice(0)) await emit(mock, "session_shutdown", context.ctx);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

test("registers only the documented routes and completes known arguments", async () => {
  const { mock, context } = await setup();
  const command = mock.commands.get("subagents");
  assert.ok(command);
  for (const prefix of ["", "s", "settings"]) {
    assert.deepEqual(command.getArgumentCompletions?.(prefix), [
      { value: "settings", label: "settings", description: "Configure the subagent widget" },
    ]);
  }
  for (const prefix of ["jobs", "settings ", "settings x", "Settings"]) {
    assert.equal(command.getArgumentCompletions?.(prefix), null);
  }
  for (const route of ["jobs", "help", "status", "settings extra", "settings\nextra", "SETTINGS"]) {
    await command.handler(route, context.ctx);
    assert.match(context.notifications.at(-1)?.message ?? "", /^Usage:/u);
  }
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(mock.sentMessages.length, 0);
});

test.each(["print", "json"])("rejects interactive routes observably in %s mode", async (mode) => {
  const custom = vi.fn(async () => undefined);
  const { mock, context } = await setup({ mode, custom });
  const command = mock.commands.get("subagents");
  assert.ok(command);
  for (const route of ["", "settings", "bad"]) {
    await assert.rejects(() => Promise.resolve(command.handler(route, context.ctx)), /requires TUI or RPC/u);
  }
  assert.equal(custom.mock.calls.length, 0);
  assert.equal(mock.sentMessages.length, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("RPC settings reports the sanitized user path without custom TUI or writes", async () => {
  const custom = vi.fn(async () => undefined);
  const { mock, context, store } = await setup({ mode: "rpc", custom });
  await invoke(mock, context, " settings ");
  assert.equal(custom.mock.calls.length, 0);
  assert.match(context.notifications[0]?.message ?? "", /Edit user settings:.*pi-subagents\.json.*\/reload/u);
  assert.equal(context.notifications[0]?.message.includes(store.userPath), true);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("sanitizes settings paths and lifecycle errors at the notification boundary", async () => {
  const { mock, context, store } = await setup({ mode: "rpc" });
  const rawPath = `${directory}/\u001b]0;hidden title\u0007\u061c\u200e\u200f\u202euser\nsettings.json`;
  Object.defineProperty(store, "userPath", { value: rawPath });
  await invoke(mock, context, "settings");
  const pathMessage = context.notifications.at(-1)?.message ?? "";
  assert.doesNotMatch(pathMessage, /hidden title|[\p{Cc}\p{Bidi_Control}]/u);
  assert.match(pathMessage, /user settings\.json/u);
  assert.equal(store.userPath, rawPath, "sanitization must not change the file payload");
  vi.spyOn(store, "load").mockResolvedValue({
    settings: { showWidget: true, showJobId: true, showTools: true, showTiming: true },
    diagnostics: ["bad\u001b[31m file\u001b[0m\u061c\u200e\u200f\tinput"],
  });
  await emit(mock, "session_start", context.ctx);
  const errorMessage = context.notifications.at(-1)?.message ?? "";
  assert.doesNotMatch(errorMessage, /[\p{Cc}\p{Bidi_Control}]|\[31m/u);
  assert.match(errorMessage, /bad file input/u);
});

test("main-menu and direct settings routes share one screen and apply durable changes immediately", async () => {
  const tui = createTuiHarness({ width: 90 });
  const { mock, context, store } = await setup({ mode: "tui", custom: tui.custom });
  const direct = invoke(mock, context, "settings");
  await tui.waitForOpen();
  const directFrame = tui.render();
  tui.press("ctrl+c");
  await direct;
  const main = invoke(mock, context, "");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Jobs.*|Subagents/u);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.deepEqual(tui.render(), directFrame);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await vi.waitFor(() => assert.equal(store.settings.showJobId, false));
  const changed = tui.render().join("\n");
  assert.match(changed, /Show job ID\s+false/u);
  assert.equal(tui.openCount, 3, "saving must not reopen the settings screen");
  tui.press("ctrl+c");
  await main;
  assert.equal(store.settings.showJobId, false);
  assert.deepEqual(JSON.parse(await fs.readFile(store.userPath, "utf8")), { showJobId: false });
});

test("reloads manual user preferences and leaves model-visible tools unchanged", async () => {
  const { mock, context, store } = await setup({ mode: "tui" });
  const definitions = JSON.stringify(mock.tools);
  await spawnJob(mock, context);
  assert.match(widgetText(context), /job_.*tools: read/u);
  await fs.writeFile(store.userPath, JSON.stringify({ showJobId: false, showTools: false, showTiming: false }));
  await emit(mock, "session_start", context.ctx);
  await spawnJob(mock, context);
  assert.match(widgetText(context), /▶|○/u);
  assert.doesNotMatch(widgetText(context), /job_|tools:|no timeout/u);
  assert.equal(JSON.stringify(mock.tools), definitions);
  assert.equal(mock.sentUserMessages.length, 0);
});

test("session replacement drains a committed save before loading new preferences", async () => {
  const tui = createTuiHarness();
  const { mock, context, store, children } = await setup({ mode: "tui", custom: tui.custom });
  await spawnJob(mock, context);
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === store.userPath) {
      entered.resolve();
      await release.promise;
    }
    await rename(from, to);
  });
  const command = invoke(mock, context, "settings");
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await entered.promise;
  const replacement = createMockContext({ mode: "tui", custom: tui.custom, model: { provider: "test", id: "model" } });
  sessions.push({ mock, context: replacement });
  const loading = emit(mock, "session_start", replacement.ctx);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(tui.isOpen, false);
  try {
    await vi.waitFor(() => assert.equal(children[0]?.signal.aborted, true));
    assert.deepEqual(mock.sentMessages, [], "old children must stop without publishing into the replacement");
    release.resolve();
    await Promise.all([command, loading]);
    assert.equal(store.settings.showWidget, false);
    await spawnJob(mock, replacement);
    assert.equal(replacement.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
    await invoke(mock, context, "settings");
    assert.match(context.notifications.at(-1)?.message ?? "", /unavailable/u);
  } finally {
    release.resolve();
    await Promise.allSettled([command, loading]);
  }
});

test("shutdown closes an owned screen, flushes settings, and permits a fresh session", async () => {
  const tui = createTuiHarness();
  const { mock, context, store } = await setup({ mode: "tui", custom: tui.custom });
  const flush = vi.spyOn(store, "flush");
  const command = invoke(mock, context, "settings");
  await tui.waitForOpen();
  await emit(mock, "session_shutdown", context.ctx);
  await command;
  assert.equal(tui.isOpen, false);
  assert.equal(flush.mock.calls.length, 1);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  await emit(mock, "session_start", context.ctx);
  const fresh = invoke(mock, context, "settings");
  await tui.waitForOpen();
  tui.press("ctrl+c");
  await fresh;
});

test("blocks duplicate screens and loading or stale command contexts", async () => {
  const tui = createTuiHarness();
  const { mock, context, store } = await setup({ mode: "tui", custom: tui.custom });
  const command = invoke(mock, context, "settings");
  await tui.waitForOpen();
  await invoke(mock, context, "settings");
  assert.match(context.notifications.at(-1)?.message ?? "", /already open/u);
  assert.equal(tui.openCount, 1);
  const loaded = deferred();
  const release = deferred();
  const load = store.load.bind(store);
  vi.spyOn(store, "load").mockImplementation(async () => {
    loaded.resolve();
    await release.promise;
    return load();
  });
  const start = emit(mock, "session_start", context.ctx);
  await loaded.promise;
  await command;
  await invoke(mock, context, "settings");
  assert.match(context.notifications.at(-1)?.message ?? "", /loading/u);
  release.resolve();
  await start;
});

test("reports ignored invalid settings without replacing the file", async () => {
  const { mock, context, store } = await setup({ mode: "rpc" });
  const bytes = '{"showWidget":"wrong","showTools":false,"future":123}';
  await fs.writeFile(store.userPath, bytes);
  await emit(mock, "session_start", context.ctx);
  assert.match(context.notifications.at(-1)?.message ?? "", /Ignored invalid.*showWidget/u);
  assert.equal(store.settings.showWidget, true);
  assert.equal(store.settings.showTools, false);
  assert.equal(await fs.readFile(store.userPath, "utf8"), bytes);
});

test.each(["print", "json"])("reports invalid settings through an observable lifecycle error in %s", async (mode) => {
  const { mock, context, store } = await setup({ mode });
  await fs.writeFile(store.userPath, "null");
  await assert.rejects(() => emit(mock, "session_start", context.ctx), /expected a JSON object/u);
  assert.equal(mock.sentMessages.length, 0);
});

test.each([false, true])("old-session events cannot abort replacement menus: durable=%s", async (durable) => {
  await fs.writeFile(join(directory, "pi-subagents.json"), JSON.stringify({ durable }));
  const tui = createTuiHarness();
  const { mock, context, children } = await setup({ mode: "tui", custom: tui.custom });
  if (!durable) await spawnJob(mock, context);
  const replacement = createMockContext({
    mode: "tui",
    custom: tui.custom,
    model: { provider: "test", id: "model" },
    sessionManager: SessionManager.inMemory(directory),
  });
  sessions.push({ mock, context: replacement });
  const replacing = emit(mock, "session_start", replacement.ctx);
  await emit(mock, "session_tree", context.ctx);
  await emit(mock, "session_shutdown", context.ctx);
  await replacing;
  if (!durable) assert.equal(children[0]?.signal.aborted, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const command = invoke(mock, replacement, "settings");
    await tui.waitForOpen();
    tui.press("ctrl+c");
    await command;
  }
  assert.deepEqual(replacement.notifications, []);
});

test.each([false, true])("headless widget diagnostics do not shut down durable=%s", async (durable) => {
  await fs.writeFile(join(directory, "pi-subagents.json"), JSON.stringify({ durable }));
  const { mock, context, store, children } = await setup({ mode: "json" });
  const definitions = JSON.stringify(mock.tools);
  await fs.writeFile(store.userPath, JSON.stringify({ durable, showWidget: "invalid" }));
  await assert.rejects(() => emit(mock, "session_start", context.ctx), /Ignored invalid.*showWidget/u);
  const command = mock.commands.get("subagents");
  assert.ok(command);
  await command.handler("settings", { ...(context.ctx as ExtensionContext), mode: "rpc", hasUI: true });
  assert.match(context.notifications.at(-1)?.message ?? "", /Edit user settings:/u);
  assert.equal(JSON.stringify(mock.tools), definitions);
  if (!durable) {
    await spawnJob(mock, context);
    assert.equal(children.length, 1);
    assert.equal(children[0]?.signal.aborted, false);
  }
});

test("durable mode keeps process controls unavailable without opening storage or changing tools", async () => {
  await fs.writeFile(join(directory, "pi-subagents.json"), JSON.stringify({ durable: true }));
  const custom = vi.fn(async () => undefined);
  const { mock, context } = await setup({ mode: "rpc", custom });
  const definitions = JSON.stringify(mock.tools);
  assert.deepEqual(
    mock.tools.map((tool) => tool.name),
    ["subagent_spawn", "subagent_send", "subagent_stop", "subagent_status", "subagent_wait"],
  );
  await invoke(mock, context, "");
  assert.match(context.notifications.at(-1)?.message ?? "", /only in process mode.*subagent_status/u);
  await invoke(mock, context, "settings");
  assert.match(context.notifications.at(-1)?.message ?? "", /Edit user settings:/u);
  assert.equal(custom.mock.calls.length, 0);
  assert.equal(JSON.stringify(mock.tools), definitions);
  assert.deepEqual(await fs.readdir(directory), ["pi-subagents.json"]);
});

test("durable mode widget saves preserve the backend flag without activating a process runtime", async () => {
  await fs.writeFile(join(directory, "pi-subagents.json"), JSON.stringify({ durable: true, future: 42 }));
  const tui = createTuiHarness();
  const { mock, context, store, children } = await setup({ mode: "tui", custom: tui.custom });
  const definitions = JSON.stringify(mock.tools);
  const command = invoke(mock, context, "settings");
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await vi.waitFor(() => assert.equal(store.settings.showWidget, false));
  tui.press("ctrl+c");
  await command;
  assert.deepEqual(JSON.parse(await fs.readFile(store.userPath, "utf8")), {
    durable: true,
    future: 42,
    showWidget: false,
  });
  assert.equal(JSON.stringify(mock.tools), definitions);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(children.length, 0);
  assert.deepEqual(await fs.readdir(directory), ["pi-subagents.json"]);
});

test.each(["session_tree", "session_shutdown"])("durable %s closes an owned settings screen", async (event) => {
  await fs.writeFile(join(directory, "pi-subagents.json"), JSON.stringify({ durable: true }));
  const tui = createTuiHarness();
  const { mock, context, store } = await setup({ mode: "tui", custom: tui.custom });
  const flush = vi.spyOn(store, "flush");
  const command = invoke(mock, context, "settings");
  await tui.waitForOpen();
  await emit(mock, event, context.ctx);
  await command;
  assert.equal(tui.isOpen, false);
  assert.equal(flush.mock.calls.length, 1);
  assert.deepEqual(await fs.readdir(directory), ["pi-subagents.json"]);
  await invoke(mock, context, "settings");
  assert.match(context.notifications.at(-1)?.message ?? "", /unavailable/u);
});

async function setup(overrides: Record<string, unknown> = {}) {
  const mock = createMockPi();
  const store = new SubagentSettingsStore(join(directory, "pi-subagents.json"));
  const context = createMockContext({
    mode: "rpc",
    model: { provider: "test", id: "model" },
    sessionManager: SessionManager.inMemory(directory),
    ...overrides,
  });
  const children: ChildRequest[] = [];
  extension(mock.pi, {
    settingsStore: store,
    runChild: (request) => {
      children.push(request);
      return waitForCancellation(request);
    },
  });
  sessions.push({ mock, context });
  await emit(mock, "session_start", context.ctx);
  return { mock, context, store, children };
}

async function emit(mock: Mock, name: string, ctx: unknown) {
  for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
}

async function invoke(mock: Mock, context: Context, route: string) {
  await mock.commands.get("subagents")?.handler(route, context.ctx);
}

async function spawnJob(mock: Mock, context: Context) {
  const tool = mock.tools.find((candidate) => candidate.name === "subagent_spawn") as {
    execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>;
  };
  // Spawn auth belongs to the existing tool contract, not the menu.
  const ctx = context.ctx as unknown as ExtensionContext;
  ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "environment" });
  ctx.modelRegistry.getRegisteredProviderIds = () => [];
  await tool.execute("spawn", { task: "Run test task", tools: ["read"] }, undefined, undefined, ctx);
}

function widgetText(context: Context) {
  const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as (tui: unknown, theme: Theme) => Component;
  return factory({}, { fg: (_role: string, text: string) => text } as Theme)
    .render(200)
    .join("\n");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForCancellation(request: ChildRequest): Promise<ChildResult> {
  return new Promise((resolve) => {
    const finish = () => resolve({ state: "cancelled", limitations: [], truncated: false });
    if (request.signal.aborted) finish();
    else request.signal.addEventListener("abort", finish, { once: true });
  });
}
