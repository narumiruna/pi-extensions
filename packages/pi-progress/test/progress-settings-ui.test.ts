import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { showProgressSettings } from "../src/progress-settings-ui.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettings } from "../src/settings.js";
import { createContext, createHarness, setProgress } from "./progress-harness.js";

initTheme("dark");

function fixture() {
  const current = createContext();
  const screen = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: screen.custom });
  let settings = { ...DEFAULT_PROGRESS_SETTINGS };
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    get: () => settings,
    save: async (patch: Partial<ProgressSettings>, _signal: AbortSignal) => ({ ...settings, ...patch }),
    apply: (next: ProgressSettings) => {
      settings = next;
    },
  };
  return {
    ...current,
    screen,
    controller,
    options,
    open: () => showProgressSettings(current.ctx as ExtensionCommandContext, options),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("changes all five settings in one screen with bounded rendering", async () => {
  const current = fixture();
  const { screen } = current;
  const patches: Partial<ProgressSettings>[] = [];
  const save = current.options.save;
  current.options.save = async (patch, signal) => {
    patches.push(patch);
    return save(patch, signal);
  };
  const zeroWidth: string[] = [];
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    screen.custom(async (...args) => {
      const component = await factory(...args);
      zeroWidth.push(...component.render(0));
      return component;
    }, options);
  Object.assign(current.ctx.ui, { custom });
  const command = current.open();
  await screen.waitForOpen();
  const initial = screen.render().join("\n");
  for (const width of [1, 20, 80]) {
    for (const line of screen.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  screen.press("tui.select.down");
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  screen.press("tui.select.down");
  screen.send(" ");
  await screen.waitForPending();
  screen.press("tui.select.down");
  screen.press("tui.select.confirm");
  screen.type("1");
  screen.press("tui.input.submit");
  await screen.waitForPending();
  screen.press("tui.select.down");
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  screen.press("ctrl+c");
  assert.equal(await command, "close");
  assert.ok(zeroWidth.length > 0);
  assert.ok(zeroWidth.every((line) => visibleWidth(line) === 0));
  assert.match(initial, /Show widget/u);
  assert.match(initial, /Visible item limit/u);
  assert.deepEqual(patches, [
    { enabled: false },
    { displayMode: "expanded" },
    { showCompleted: false },
    { maxVisibleItems: 1 },
    { showProgress: false },
  ]);
  assert.deepEqual(current.options.get(), {
    enabled: false,
    displayMode: "expanded",
    showCompleted: false,
    maxVisibleItems: 1,
    showProgress: false,
  });
});

test("save failure restores the value and later saves still work", async () => {
  const current = fixture();
  const { screen } = current;
  const save = current.options.save;
  let failures = 1;
  current.options.save = async (patch, signal) => {
    if (failures-- > 0) throw new Error("invalid settings");
    return save(patch, signal);
  };
  const command = current.open();
  await screen.waitForOpen();
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  assert.equal(current.options.get().enabled, true);
  assert.match(stripVTControlCharacters(screen.render().join("\n")), /Show widget\s+true/u);
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  screen.press("ctrl+c");
  await command;
  assert.equal(current.options.get().enabled, false);
  assert.equal(current.notifications.length, 1);
  assert.match(current.notifications[0]?.message ?? "", /invalid settings/u);
});

test.each(["back", "close", "dispose", "parent"] as const)(
  "%s aborts uncommitted work and drains the queue without starting later writes",
  async (cancellation) => {
    const current = fixture();
    const { screen } = current;
    const started = deferred<AbortSignal>();
    const completion = deferred<ProgressSettings>();
    const apply = vi.fn();
    current.options.apply = apply;
    current.options.save = vi.fn(async (_patch, signal) => {
      started.resolve(signal);
      return completion.promise;
    });
    const command = current.open();
    await screen.waitForOpen();
    screen.press("tui.select.confirm");
    const signal = await started.promise;
    screen.press("tui.select.confirm");
    let drained = false;
    void command.then(() => {
      drained = true;
    });
    if (cancellation === "close") screen.press("ctrl+c");
    else if (cancellation === "back") screen.press("tui.select.cancel");
    else if (cancellation === "dispose") screen.dispose();
    else current.controller.abort();
    const aborted = signal.aborted;
    const earlyCompletion = drained;
    completion.reject(signal.reason);
    const result = await command;
    screen.dispose();
    assert.equal(aborted, true);
    assert.equal(earlyCompletion, false);
    assert.equal(result, cancellation === "back" ? "back" : cancellation === "close" ? "close" : "stale");
    assert.equal(vi.mocked(current.options.save).mock.calls.length, 1);
    assert.equal(apply.mock.calls.length, 0);
    assert.deepEqual(current.notifications, []);
  },
);

test("native non-default navigation and cancellation work; Ctrl+C remains a hard cancel", async () => {
  const original = getKeybindings();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+x" }),
  );
  try {
    for (const cancel of ["\u0018", "\u0003"]) {
      const current = fixture();
      const command = current.open();
      await current.screen.waitForOpen();
      current.screen.send("\u000e");
      const lines = current.screen.render().join("\n");
      current.screen.send(cancel);
      assert.equal(await command, cancel === "\u0003" ? "close" : "back");
      assert.match(lines, /Use adaptive, expanded, or collapsed/u);
    }
  } finally {
    setKeybindings(original);
  }
});

test("command saves apply to the active widget without changing progress state", async () => {
  const saved: Partial<ProgressSettings>[] = [];
  const harness = createHarness({
    saveSettings: async (patch) => {
      saved.push(patch);
      return { ...DEFAULT_PROGRESS_SETTINGS, ...patch };
    },
  });
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
  const screen = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: screen.custom });
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  const command = progress.handler("settings", current.ctx as ExtensionCommandContext);
  await screen.waitForOpen();
  screen.press("tui.select.confirm");
  await screen.waitForPending();
  screen.press("ctrl+c");
  await command;
  assert.equal(current.widgets.at(-1)?.content, undefined);
  assert.deepEqual(saved, [{ enabled: false }]);
  assert.deepEqual(harness.entries, []);
  await harness.emit("session_shutdown", current.ctx);
});

test("RPC reports the settings path without opening custom UI", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  const custom = vi.fn();
  Object.assign(current.ctx.ui, { custom });
  await harness.emit("session_start", current.ctx);
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  await progress.handler("settings", current.ctx as ExtensionCommandContext);
  assert.equal(custom.mock.calls.length, 0);
  assert.match(current.notifications.at(-1)?.message ?? "", /Edit settings manually: .*pi-progress.json/u);
  await harness.emit("session_shutdown", current.ctx);
});

test.each(["replacement", "shutdown"] as const)(
  "%s cancels settings work and drains its durability boundary",
  async (boundary) => {
    const started = deferred<AbortSignal>();
    const completion = deferred<ProgressSettings>();
    const harness = createHarness({
      saveSettings: async (_patch, _path, signal) => {
        assert.ok(signal);
        started.resolve(signal);
        return completion.promise;
      },
    });
    const previous = createContext();
    await harness.emit("session_start", previous.ctx);
    const screen = createTuiHarness();
    Object.assign(previous.ctx.ui, { custom: screen.custom });
    const progress = harness.commands.get("progress");
    assert.ok(progress);
    const command = progress.handler("settings", previous.ctx as ExtensionCommandContext);
    await screen.waitForOpen();
    screen.press("tui.select.confirm");
    const signal = await started.promise;
    const current = boundary === "replacement" ? createContext() : previous;
    let settled = false;
    const ownerChange = harness
      .emit(boundary === "replacement" ? "session_start" : "session_shutdown", current.ctx)
      .then(() => {
        settled = true;
      });
    const aborted = signal.aborted;
    const earlyCompletion = settled;
    if (boundary === "replacement") await ownerChange;
    const publications = current.widgets.length;
    completion.resolve({ ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
    await Promise.all([command, ownerChange]);
    assert.equal(aborted, true);
    if (boundary === "shutdown") assert.equal(earlyCompletion, false);
    if (boundary === "replacement") assert.equal(current.widgets.length, publications);
    assert.deepEqual(previous.notifications, []);
    if (boundary === "replacement") await harness.emit("session_shutdown", current.ctx);
  },
);

test("owner cancellation before a delayed host factory never reads settings", async () => {
  const current = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = vi.fn(current.options.get);
  current.options.get = get;
  const custom = current.ctx.ui.custom;
  current.ctx.ui.custom = async (factory, options) => {
    entered.resolve();
    await release.promise;
    return custom(factory, options);
  };
  const command = current.open();
  await entered.promise;
  current.controller.abort();
  release.resolve();
  const result = await command;
  current.screen.dispose();
  assert.equal(result, "stale");
  assert.equal(get.mock.calls.length, 0);
  assert.equal(current.screen.isOpen, false);
  assert.deepEqual(current.notifications, []);
});

test("host failures remain observable to the command owner without duplicate notifications", async () => {
  const current = fixture();
  const error = new Error("host failed");
  Object.assign(current.ctx.ui, {
    custom: async () => {
      throw error;
    },
  });
  await assert.rejects(current.open(), (caught) => caught === error);
  assert.deepEqual(current.notifications, []);
});

test.each(["rpc", "print", "json"] as const)("%s never opens a custom screen", async (mode) => {
  const current = fixture();
  const custom = vi.fn();
  const ctx = { ...current.ctx, mode, ui: { ...current.ctx.ui, custom } } as unknown as ExtensionCommandContext;
  assert.equal(await showProgressSettings(ctx, current.options), "back");
  assert.equal(custom.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});

test("rapid changes save in order without resetting a newer displayed choice", async () => {
  const current = fixture();
  const { screen } = current;
  const patches: Partial<ProgressSettings>[] = [];
  const started = deferred<void>();
  const release = deferred<void>();
  const save = current.options.save;
  current.options.save = async (patch, signal) => {
    patches.push(patch);
    started.resolve();
    await release.promise;
    return save(patch, signal);
  };
  const command = current.open();
  await screen.waitForOpen();
  for (let index = 0; index < 3; index++) screen.press("tui.select.confirm");
  await started.promise;
  const pending = stripVTControlCharacters(screen.render().join("\n"));
  const pendingCount = patches.length;
  release.resolve();
  await screen.waitForPending();
  screen.press("ctrl+c");
  await command;
  assert.equal(pendingCount, 1);
  assert.match(pending, /Show widget\s+false/u);
  assert.deepEqual(patches, [{ enabled: false }, { enabled: true }, { enabled: false }]);
  assert.equal(current.options.get().enabled, false);
});
