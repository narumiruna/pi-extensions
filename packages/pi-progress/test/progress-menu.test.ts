import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { DEFAULT_PROGRESS_SETTINGS } from "../src/settings.js";
import { createContext, createHarness, setProgress } from "./progress-harness.js";

initTheme("dark");

function openMenu(harness: ReturnType<typeof createHarness>, ctx: ReturnType<typeof createContext>["ctx"], args = "") {
  const command = harness.commands.get("progress");
  assert.ok(command);
  return command.handler(args, ctx as ExtensionCommandContext);
}

function frame(tui: ReturnType<typeof createTuiHarness>) {
  return stripVTControlCharacters(tui.render().join("\n"));
}

test("TUI opens a Kit main menu and read-only Status and Help views", async () => {
  const harness = createHarness();
  const current = createContext();
  const tui = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [
    { text: "active", status: "in_progress" },
    { text: "waiting", status: "blocked" },
    { text: "done", status: "completed" },
  ]);
  const running = openMenu(harness, current.ctx, "  ");
  await tui.waitForOpen();
  const main = frame(tui);
  for (const label of ["Settings", "Status", "Help", "Clear widget"]) assert.match(main, new RegExp(label, "u"));
  assert.doesNotMatch(main, /Hide widget/u);
  assert.match(main, /^→ Clear widget\s+Keep saved progress unchanged/mu);
  assert.match(main, /Widget: visible · 1\/3 steps completed/u);
  for (const width of [1, 20, 80]) for (const line of tui.render(width)) assert.ok(visibleWidth(line) <= width);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const status = frame(tui);
  assert.match(status, /Progress Status/u);
  assert.match(status, /3 total, 1 completed, 1 in progress, 1 blocked/u);
  // Long temporary paths can wrap after the label or inside the path.
  assert.match(status, /User settings:\s+[\s\S]*?pi-progress\.json/u);
  assert.doesNotMatch(status, /^→/mu);
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const help = frame(tui);
  assert.match(help, /Progress Help/u);
  assert.match(help, /\/progress settings/u);
  assert.match(help, /show incomplete progress again/u);
  assert.doesNotMatch(help, /^→/mu);
  tui.press("ctrl+c");
  await running;
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(current.notifications, []);
  tui.dispose();
  await harness.emit("session_shutdown", current.ctx);
});

test("Settings reuses the direct screen, applies saves, and Back returns to the main menu", async () => {
  const saveSettings = vi.fn(async (patch) => ({ ...DEFAULT_PROGRESS_SETTINGS, ...patch }));
  const harness = createHarness({ saveSettings });
  const current = createContext();
  const tui = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  const running = openMenu(harness, current.ctx);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(frame(tui), /Progress Settings/u);
  tui.press("tui.select.confirm");
  await vi.waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));
  await vi.waitFor(() => assert.match(frame(tui), /Show widget\s+false/u));
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  assert.match(frame(tui), /Widget: disabled/u);
  tui.press("ctrl+c");
  await running;
  assert.deepEqual(saveSettings.mock.calls[0]?.[0], { enabled: false });
  tui.dispose();
  await harness.emit("session_shutdown", current.ctx);
});

test("Ctrl+C in Settings closes the entire flow without reopening the menu", async () => {
  const harness = createHarness();
  const current = createContext();
  const tui = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  const running = openMenu(harness, current.ctx);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  tui.press("ctrl+c");
  await running;
  assert.equal(tui.openCount, 2);
  assert.equal(tui.isOpen, false);
  tui.dispose();
  await harness.emit("session_shutdown", current.ctx);
});

test("Clear widget uses the clear operation and refreshes menu state without changing progress", async () => {
  const harness = createHarness();
  const current = createContext();
  const tui = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
  const running = openMenu(harness, current.ctx);
  await tui.waitForOpen();
  assert.match(frame(tui), /^→ Clear widget\s+Keep saved progress unchanged/mu);
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(frame(tui), /Widget: hidden/u);
  assert.equal(current.widgets.at(-1)?.content, undefined);
  assert.match(current.notifications.at(-1)?.message ?? "", /Saved progress is unchanged/u);
  tui.press("ctrl+c");
  await running;
  assert.deepEqual(harness.entries, []);
  tui.dispose();
  await harness.emit("session_shutdown", current.ctx);
});

test("RPC main menu adapts Settings, Status, Help, and Clear widget without custom UI", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  const rpc = createRpcHarness([
    { kind: "select", response: "Settings" },
    { kind: "select", response: "Status" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Help" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Clear widget" },
    { kind: "select", response: "Close" },
  ]);
  Object.assign(current.ctx.ui, rpc.ui);
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
  await openMenu(harness, current.ctx);
  rpc.assertConsumed();
  assert.deepEqual(rpc.dialogs[0]?.options, [
    "Clear widget",
    "Settings",
    "Status",
    "Help",
    "Widget view",
    "Task items",
    "Close",
  ]);
  assert.match(rpc.dialogs[2]?.title ?? "", /Progress Status/u);
  assert.match(rpc.dialogs[4]?.title ?? "", /Progress Help/u);
  assert.match(rpc.dialogs[6]?.title ?? "", /Widget: hidden/u);
  assert.match(current.notifications[0]?.message ?? "", /Edit settings manually: .*pi-progress.json/u);
  assert.deepEqual(harness.entries, []);
  await harness.emit("session_shutdown", current.ctx);
});

for (const boundary of ["replacement", "shutdown"] as const) {
  test(`${boundary} cancels an open menu and prevents late settings or widget changes`, async () => {
    const harness = createHarness();
    const previous = createContext({ mode: "rpc" });
    const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
    Object.assign(previous.ctx.ui, rpc.ui);
    await harness.emit("session_start", previous.ctx);
    const running = openMenu(harness, previous.ctx);
    await rpc.waitForCall();
    await openMenu(harness, previous.ctx, "settings");
    assert.match(previous.notifications.at(-1)?.message ?? "", /already open/u);
    if (boundary === "replacement") {
      const current = createContext();
      await harness.emit("session_start", current.ctx);
      const publications = current.widgets.length;
      await running;
      assert.equal(current.widgets.length, publications);
      await harness.emit("session_shutdown", current.ctx);
    } else {
      await Promise.all([harness.emit("session_shutdown", previous.ctx), running]);
    }
    rpc.assertConsumed();
    assert.deepEqual(harness.entries, []);
  });
}

test("main menu uses injected non-default keys and preserves Ctrl+C hard cancellation", async () => {
  for (const cancellation of ["\u0018", "\u0003"]) {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "ctrl+n",
      "tui.select.cancel": "ctrl+x",
    });
    const harness = createHarness();
    const current = createContext();
    const tui = createTuiHarness({ keybindings });
    Object.assign(current.ctx.ui, { custom: tui.custom });
    await harness.emit("session_start", current.ctx);
    const running = openMenu(harness, current.ctx);
    await tui.waitForOpen();
    tui.send("\u000e");
    tui.send("\u000e");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(frame(tui), /Progress Status/u);
    tui.send("\u0018");
    await tui.waitForOpen();
    assert.match(frame(tui), /Settings/u);
    tui.send(cancellation);
    await running;
    assert.equal(tui.isOpen, false);
    tui.dispose();
    await harness.emit("session_shutdown", current.ctx);
  }
});

for (const action of ["Clear widget", "Settings", "Status", "Help", "Close"] as const) {
  test(`mouse activates the ${action} main-menu action`, async () => {
    const harness = createHarness();
    const current = createContext();
    const tui = createTuiHarness();
    Object.assign(current.ctx.ui, { custom: tui.custom });
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
    const running = openMenu(harness, current.ctx);
    try {
      await tui.waitForOpen();
      const y = tui
        .render()
        .map(stripVTControlCharacters)
        .findIndex((line) => new RegExp(`^(?:→ |  )${action}(?:\\s|$)`, "u").test(line));
      assert.ok(y >= 0);
      tui.mouse({ type: "press", x: 1, y });
      tui.mouse({ type: "click", x: 1, y });
      if (action === "Close") {
        await running;
        assert.equal(tui.isOpen, false);
      } else {
        const expected = action === "Clear widget" ? /Widget: hidden/u : new RegExp(`Progress ${action}`, "u");
        await vi.waitFor(() => assert.match(frame(tui), expected));
        tui.press("ctrl+c");
        await running;
      }
      assert.deepEqual(harness.entries, []);
    } finally {
      tui.dispose();
      await running;
      await harness.emit("session_shutdown", current.ctx);
    }
  });
}

test("external menu disposal does not invoke settings or hide the widget", async () => {
  const saveSettings = vi.fn(async () => ({ ...DEFAULT_PROGRESS_SETTINGS }));
  const harness = createHarness({ saveSettings });
  const current = createContext();
  const tui = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  const publications = current.widgets.length;
  const running = openMenu(harness, current.ctx);
  await tui.waitForOpen();
  tui.dispose();
  await running;
  assert.equal(current.widgets.length, publications);
  assert.equal(saveSettings.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
  await harness.emit("session_shutdown", current.ctx);
});
