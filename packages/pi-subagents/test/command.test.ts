import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
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
  await vi.waitFor(() => assert.equal(store.settings.showJobId, true));
  const changed = tui.render().join("\n");
  assert.match(changed, /Show job ID\s+true/u);
  assert.equal(tui.openCount, 3, "saving must not reopen the settings screen");
  tui.press("ctrl+c");
  await main;
  assert.equal(store.settings.showJobId, true);
  assert.deepEqual(JSON.parse(await fs.readFile(store.userPath, "utf8")), { showJobId: true });
});

test("reloads manual user preferences and leaves model-visible tools unchanged", async () => {
  const { mock, context, store } = await setup({ mode: "tui" });
  const definitions = JSON.stringify(mock.tools);
  await spawnJob(mock, context);
  assert.match(widgetText(context), /Run test task/u);
  assert.doesNotMatch(widgetText(context), /job_|tools:/u);
  await fs.writeFile(store.userPath, JSON.stringify({ showJobId: true, showTools: true, showTiming: true }));
  await emit(mock, "session_start", context.ctx);
  await spawnJob(mock, context);
  assert.match(widgetText(context), /job_.*Run test task.*tools: read/u);
  await fs.writeFile(store.userPath, JSON.stringify({ showJobId: false, showTools: false, showTiming: false }));
  await emit(mock, "session_start", context.ctx);
  await spawnJob(mock, context);
  assert.match(widgetText(context), /Run test task/u);
  assert.doesNotMatch(widgetText(context), /job_|tools:| · \d+(?:\.\d+)?s/u);
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

test("public hooks compact on consumed user messages, not input attempts or other roles", async () => {
  const tui = createTuiHarness();
  const { mock, context } = await setup({ mode: "tui", custom: tui.custom });
  await spawnJob(mock, context);
  const definitions = JSON.stringify(mock.tools);
  await armTrigger(mock, context, tui, "Next consumed user message");
  for (const role of ["assistant", "custom", "toolResult"]) {
    await emit(mock, "message_start", context.ctx, { message: { role } });
  }
  await emit(mock, "input", context.ctx, { text: "handled, rejected, or queued input" });
  await emit(mock, "agent_end", context.ctx);
  await emit(mock, "message_end", context.ctx, { message: { role: "assistant" } });
  assert.match(widgetText(context), /Run test task/u);
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, {
    message: { role: "user", content: "extension-generated or consumed queue" },
  });
  assert.match(widgetText(context), /1 active · 1 running · 0 queued/u);
  assert.doesNotMatch(widgetText(context), /Run test task/u);
  assert.equal(JSON.stringify(mock.tools), definitions);
  assert.deepEqual(mock.sentMessages, []);
  assert.deepEqual(mock.sentUserMessages, []);
});

test("public settled hooks group retries and queued continuations and require an eligible turn", async () => {
  const tui = createTuiHarness();
  const { mock, context } = await setup({ mode: "tui", custom: tui.custom });
  await spawnJob(mock, context);
  await emit(mock, "agent_start", context.ctx);
  await armTrigger(mock, context, tui, "Next eligible settled cycle");
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.match(widgetText(context), /Run test task/u, "the arming cycle is excluded");
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "toolResult", stopReason: "stop" } });
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.match(widgetText(context), /Run test task/u, "a non-assistant turn cannot establish eligibility");
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "error" } });
  await emit(mock, "agent_end", context.ctx);
  await emit(mock, "agent_start", context.ctx); // Automatic retry, still one cycle.
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "toolUse" } });
  await emit(mock, "agent_end", context.ctx);
  await emit(mock, "agent_start", context.ctx); // Queued follow-up / continuation.
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  assert.match(widgetText(context), /Run test task/u);
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.doesNotMatch(widgetText(context), /Run test task/u);
});

test("menu arming excludes run preparation before the public agent_start hook", async () => {
  const tui = createTuiHarness();
  let idle = true;
  const { mock, context } = await setup({ mode: "tui", custom: tui.custom, isIdle: () => idle });
  await spawnJob(mock, context);
  idle = false; // A later preparation handler is still waiting; no agent_start exists yet.
  await emit(mock, "before_agent_start", context.ctx);
  await armTrigger(mock, context, tui, "Next eligible settled cycle");
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  idle = true;
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.match(widgetText(context), /Run test task/u);
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.doesNotMatch(widgetText(context), /Run test task/u);
});

test("async settings initialization excludes an already-busy cycle even when its start hook was missed", async () => {
  const tui = createTuiHarness();
  let idle = true;
  const { mock, context, store } = await setup({ mode: "tui", custom: tui.custom, isIdle: () => idle });
  const entered = deferred();
  const release = deferred();
  const load = store.load.bind(store);
  vi.spyOn(store, "load").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return load();
  });
  const loading = emit(mock, "session_start", context.ctx);
  await entered.promise;
  idle = false;
  await emit(mock, "agent_start", context.ctx);
  release.resolve();
  await loading;
  await spawnJob(mock, context);
  await armTrigger(mock, context, tui, "Next eligible settled cycle");
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.match(widgetText(context), /Run test task/u);
  await emit(mock, "agent_start", context.ctx);
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
  idle = true;
  await emit(mock, "agent_settled", context.ctx, { aborted: false });
  assert.doesNotMatch(widgetText(context), /Run test task/u);
});

test.each([false, true])(
  "tree navigation with summary=%s does not exclude the first future cycle",
  async (summarize) => {
    const tui = createTuiHarness();
    let idle = true;
    const { mock, context, children } = await setup({ mode: "tui", custom: tui.custom, isIdle: () => idle });
    await spawnJob(mock, context);
    idle = false;
    await emit(mock, "session_before_tree", context.ctx, {
      preparation: { userWantsSummary: summarize },
      signal: new AbortController().signal,
    });
    await emit(mock, "session_tree", context.ctx);
    idle = true; // Navigation clears its controller without agent_settled.
    await armTrigger(mock, context, tui, "Next eligible settled cycle");
    await emit(mock, "agent_start", context.ctx);
    await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
    await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
    await emit(mock, "agent_settled", context.ctx, { aborted: false });
    assert.doesNotMatch(widgetText(context), /Run test task/u);
    assert.equal(children[0]?.signal.aborted, false);
  },
);

for (const reason of ["threshold", "overflow"] as const) {
  for (const willRetry of [false, true]) {
    test(`${reason} retry=${willRetry} is real preparation before agent_start`, async () => {
      const tui = createTuiHarness();
      let idle = true;
      const { mock, context } = await setup({ mode: "tui", custom: tui.custom, isIdle: () => idle });
      await spawnJob(mock, context);
      idle = false;
      await emit(mock, "session_before_compact", context.ctx, { reason, willRetry });
      await armTrigger(mock, context, tui, "Next eligible settled cycle");
      await emit(mock, "session_compact", context.ctx, { reason, willRetry });
      await emit(mock, "before_agent_start", context.ctx);
      await emit(mock, "agent_start", context.ctx);
      await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
      await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
      idle = true;
      await emit(mock, "agent_settled", context.ctx, { aborted: false });
      assert.match(widgetText(context), /Run test task/u);
      idle = false;
      await emit(mock, "before_agent_start", context.ctx);
      await emit(mock, "agent_start", context.ctx);
      await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
      await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
      idle = true;
      await emit(mock, "agent_settled", context.ctx, { aborted: false });
      assert.doesNotMatch(widgetText(context), /Run test task/u);
    });
  }
}

for (const operation of ["session_before_tree", "session_before_compact"] as const) {
  test(`arming during canceled ${operation} permits the next idle user prompt`, async () => {
    const tui = createTuiHarness();
    let idle = true;
    const { mock, context } = await setup({ mode: "tui", custom: tui.custom, isIdle: () => idle });
    await spawnJob(mock, context);
    idle = false;
    await emit(mock, operation, context.ctx, { reason: "manual", signal: new AbortController().signal });
    await armTrigger(mock, context, tui, "Next eligible settled cycle");
    // Native user prompts expose idle through input before starting a run.
    // This resets tracking without counting the input as accepted user activity.
    idle = true;
    await emit(mock, "input", context.ctx, { source: "interactive", text: "Next user prompt" });
    idle = false;
    await emit(mock, "before_agent_start", context.ctx);
    await emit(mock, "agent_start", context.ctx);
    await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
    await emit(mock, "turn_end", context.ctx, { message: { role: "assistant", stopReason: "stop" } });
    idle = true;
    await emit(mock, "agent_settled", context.ctx, { aborted: false });
    assert.doesNotMatch(widgetText(context), /Run test task/u);
  });
}

test("tree navigation closes the old menu and resets presentation without cancelling jobs", async () => {
  const tui = createTuiHarness();
  const { mock, context, children } = await setup({ mode: "tui", custom: tui.custom });
  await spawnJob(mock, context);
  await armTrigger(mock, context, tui, "Next consumed user message");
  const menu = invoke(mock, context, "");
  await tui.waitForOpen();
  await emit(mock, "session_tree", context.ctx);
  await menu;
  await emit(mock, "message_start", context.ctx, { message: { role: "user" } });
  assert.equal(tui.isOpen, false);
  assert.match(widgetText(context), /Run test task/u);
  assert.equal(children[0]?.signal.aborted, false);
  assert.deepEqual(mock.sentMessages, []);
});

async function armTrigger(mock: Mock, context: Context, tui: ReturnType<typeof createTuiHarness>, label: string) {
  const command = invoke(mock, context, "");
  await tui.waitForOpen();
  await choose(tui, "Widget view");
  await choose(tui, "Automatic compaction");
  await choose(tui, label);
  tui.press("ctrl+c");
  await command;
}

async function choose(tui: ReturnType<typeof createTuiHarness>, label: string) {
  for (let index = 0; index < 20; index++) {
    if (tui.render().some((line) => stripVTControlCharacters(line).includes(`→ ${label}`))) {
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      return;
    }
    tui.press("tui.select.down");
  }
  throw new Error(`Menu item not found: ${label}`);
}

test("reports ignored invalid settings without replacing the file", async () => {
  const { mock, context, store } = await setup({ mode: "rpc" });
  const bytes = '{"showWidget":"wrong","showTools":true,"future":123}';
  await fs.writeFile(store.userPath, bytes);
  await emit(mock, "session_start", context.ctx);
  assert.match(context.notifications.at(-1)?.message ?? "", /Ignored invalid.*showWidget/u);
  assert.equal(store.settings.showWidget, true);
  assert.equal(store.settings.showTools, true);
  assert.equal(await fs.readFile(store.userPath, "utf8"), bytes);
});

test.each(["print", "json"])("reports invalid settings through an observable lifecycle error in %s", async (mode) => {
  const { mock, context, store } = await setup({ mode });
  await fs.writeFile(store.userPath, "null");
  await assert.rejects(() => emit(mock, "session_start", context.ctx), /expected a JSON object/u);
  assert.equal(mock.sentMessages.length, 0);
});

async function setup(overrides: Record<string, unknown> = {}) {
  const mock = createMockPi();
  const store = new SubagentSettingsStore(join(directory, "pi-subagents.json"));
  const context = createMockContext({ mode: "rpc", model: { provider: "test", id: "model" }, ...overrides });
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

async function emit(mock: Mock, name: string, ctx: unknown, event: unknown = {}) {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
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
  ctx.modelRegistry.find = (provider, id) =>
    ctx.model?.provider === provider && ctx.model.id === id ? ctx.model : undefined;
  await tool.execute("spawn", { task: "Run test task", tools: ["read"] }, undefined, undefined, ctx);
}

const widgetComponents = new WeakMap<object, Component>();
function widgetText(context: Context) {
  const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as (tui: unknown, theme: Theme) => Component;
  let component = widgetComponents.get(factory);
  if (!component) {
    component = factory({ terminal: { rows: 36 }, requestRender() {} }, (context.ctx as ExtensionContext).ui.theme);
    widgetComponents.set(factory, component);
  }
  return component.render(200).join("\n");
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
