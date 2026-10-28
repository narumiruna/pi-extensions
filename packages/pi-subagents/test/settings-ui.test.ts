import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  type KeyId,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "../src/settings.js";
import { showSubagentSettings } from "../src/settings-ui.js";

initTheme("dark");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Parameters<typeof createTuiHarness>[0] = {}) {
  const tui = createTuiHarness(overrides);
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tui.custom, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  let settings = { ...DEFAULT_SUBAGENT_SETTINGS };
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    isCurrent: () => true,
    get: () => ({ ...settings }),
    save: async (key: keyof SubagentSettings, value: boolean, _signal: AbortSignal) => ({ ...settings, [key]: value }),
    apply: (next: SubagentSettings) => {
      settings = { ...next };
    },
  };
  return { tui, ctx, options, controller, notifications };
}

const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);

test("all four boolean rows save in one native list without moving the selection", async () => {
  const current = fixture();
  const saves: [keyof SubagentSettings, boolean][] = [];
  const save = current.options.save;
  current.options.save = async (key, value, signal) => {
    saves.push([key, value]);
    return save(key, value, signal);
  };
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  const initial = plain(current.tui.render()).join("\n");
  const selected: string[] = [];
  for (let index = 0; index < 4; index++) {
    current.tui.send(index % 2 ? " " : "\r");
    await current.tui.waitForPending();
    selected.push(plain(current.tui.render()).find((line) => line.startsWith("→")) ?? "");
    if (index < 3) current.tui.press("tui.select.down");
  }
  current.tui.press("tui.select.cancel");
  const result = await command;
  assert.equal(result, "back");
  assert.equal(current.tui.openCount, 1);
  assert.deepEqual(saves, [
    ["showWidget", false],
    ["showJobId", true],
    ["showTools", true],
    ["showTiming", false],
  ]);
  assert.deepEqual(current.options.get(), { showWidget: false, showJobId: true, showTools: true, showTiming: false });
  for (const [label, value] of [
    ["Show widget", true],
    ["Show job ID", false],
    ["Show tools", false],
    ["Show timing", true],
  ])
    assert.match(initial, new RegExp(`${label}\\s+${value}`, "u"));
  assert.deepEqual(
    selected.map((line) => line.replace(/\s+(?:true|false)$/u, "").trim()),
    ["→ Show widget", "→ Show job ID", "→ Show tools", "→ Show timing"],
  );
});

test("frame, focused rows, callback theme, invalidation and clipped mouse coordinates stay bounded", async () => {
  const roles: string[] = [];
  const current = fixture({
    width: 80,
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const zeroWidth: string[] = [];
  const custom = current.ctx.ui.custom;
  current.ctx.ui.custom = (factory, options) =>
    custom(async (...args) => {
      const component = await factory(...args);
      zeroWidth.push(...component.render(0));
      return component;
    }, options);
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  const normal = plain(current.tui.render());
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  const frames: { width: number; rows: number; lines: readonly string[] }[] = [];
  for (const rows of [24, 9, 8, 7, 6, 5, 4]) {
    for (const width of [1, 3, 4, 20, 80]) {
      const lines = current.tui.resize({ width, rows });
      frames.push({ width, rows, lines });
    }
  }
  const clipped = plain(current.tui.resize({ width: 80, rows: 8 }));
  const selectedRow = clipped.findIndex((line) => line.startsWith("→"));
  current.tui.mouse({ type: "click", x: 4, y: selectedRow });
  await current.tui.waitForPending();
  current.tui.invalidate();
  const resized = plain(current.tui.resize({ width: 30, rows: 24 }));
  current.tui.press("ctrl+c");
  const result = await command;
  assert.equal(result, "close");
  assert.ok(zeroWidth.length > 0);
  assert.ok(zeroWidth.every((line) => visibleWidth(line) === 0));
  assert.equal(normal[0], "─".repeat(80));
  assert.equal(normal.at(-1), "─".repeat(80));
  for (const { width, rows, lines } of frames) {
    assert.ok(lines.length <= Math.max(1, rows - 3));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width === 80) assert.ok(plain(lines).some((line) => line.startsWith("→ Show timing")));
    if (rows - 3 >= 5 && width > 0) {
      assert.equal(plain(lines)[0], "─".repeat(width));
      assert.equal(plain(lines).at(-1), "─".repeat(width));
    }
  }
  assert.ok(selectedRow > 0);
  assert.equal(current.options.get().showTiming, false);
  assert.equal(current.options.get().showWidget, true);
  assert.ok(resized.some((line) => line.startsWith("→ Show timing")));
  assert.ok(roles.includes("border"));
  assert.ok(roles.includes("accent"));
  assert.ok(roles.includes("muted"));
  assert.ok(roles.includes("dim"));
});

test("rapid saves serialize and keep the newest displayed choice", async () => {
  const current = fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  const saves: boolean[] = [];
  const save = current.options.save;
  current.options.save = async (key, value, signal) => {
    saves.push(value);
    if (saves.length === 1) {
      started.resolve();
      await release.promise;
    }
    return save(key, value, signal);
  };
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.send("\r");
  current.tui.send("\r");
  current.tui.send("\r");
  await started.promise;
  const pending = plain(current.tui.render()).join("\n");
  const countWhilePending = saves.length;
  release.resolve();
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.equal(countWhilePending, 1);
  assert.deepEqual(saves, [false, true, false]);
  assert.match(pending, /Show widget\s+false/u);
  assert.equal(current.options.get().showWidget, false);
});

test.each(["save", "apply"] as const)(
  "%s failure rolls back, sanitizes errors, and does not poison the queue",
  async (failure) => {
    const current = fixture();
    const save = current.options.save;
    const apply = current.options.apply;
    let fail = true;
    if (failure === "save")
      current.options.save = async (key, value, signal) => {
        if (fail) {
          fail = false;
          throw new Error("bad\u001b]0;hidden\u0007 settings");
        }
        return save(key, value, signal);
      };
    else
      current.options.apply = (settings) => {
        if (fail) {
          fail = false;
          throw new Error("bad\u001b]0;hidden\u0007 settings");
        }
        apply(settings);
      };
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await current.tui.waitForPending();
    const rolledBack = current.options.get();
    const frame = plain(current.tui.render()).join("\n");
    current.tui.send("\r");
    await current.tui.waitForPending();
    current.tui.press("ctrl+c");
    await command;
    assert.equal(rolledBack.showWidget, true);
    assert.match(frame, /Show widget\s+true/u);
    assert.equal(current.options.get().showWidget, false);
    assert.equal(current.notifications.length, 1);
    assert.match(current.notifications[0] ?? "", /bad settings/u);
    assert.doesNotMatch(current.notifications[0] ?? "", /hidden|[\p{Cc}\p{Bidi_Control}]/u);
  },
);

test("full save results refresh unrelated rows before the next toggle", async () => {
  const current = fixture();
  const saves: [keyof SubagentSettings, boolean][] = [];
  current.options.save = async (key, value) => {
    saves.push([key, value]);
    return saves.length === 1
      ? { ...current.options.get(), [key]: value, showTools: true }
      : { ...current.options.get(), [key]: value };
  };
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  await current.tui.waitForPending();
  const refreshed = plain(current.tui.render()).join("\n");
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.match(refreshed, /Show tools\s+true/u);
  assert.deepEqual(saves, [
    ["showJobId", true],
    ["showTools", false],
  ]);
  assert.equal(current.options.get().showTools, false);
});

test("full save results retain other queued optimistic changes", async () => {
  const current = fixture();
  const firstStarted = deferred<void>();
  const firstRelease = deferred<void>();
  const secondStarted = deferred<void>();
  const secondRelease = deferred<void>();
  const saves: [keyof SubagentSettings, boolean][] = [];
  current.options.save = async (key, value) => {
    saves.push([key, value]);
    if (saves.length === 1) {
      firstStarted.resolve();
      await firstRelease.promise;
      return { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false, showTiming: false };
    }
    secondStarted.resolve();
    await secondRelease.promise;
    return { ...current.options.get(), [key]: value };
  };
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await firstStarted.promise;
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.down");
  current.tui.send("\r");
  firstRelease.resolve();
  await secondStarted.promise;
  const pending = plain(current.tui.render()).join("\n");
  secondRelease.resolve();
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.match(pending, /Show tools\s+true/u);
  assert.match(pending, /Show timing\s+false/u);
  assert.deepEqual(saves, [
    ["showWidget", false],
    ["showTools", true],
  ]);
  assert.equal(current.options.get().showTools, true);
  assert.equal(current.options.get().showTiming, false);
});

test("application and rollback failures remain observable without poisoning later saves", async () => {
  const current = fixture();
  const apply = current.options.apply;
  const saves: boolean[] = [];
  let failures = 2;
  current.options.apply = (settings) => {
    if (failures-- > 0) throw new Error(failures === 1 ? "application failed" : "rollback failed");
    apply(settings);
  };
  current.options.save = async (key, value) => {
    saves.push(value);
    return { ...current.options.get(), [key]: value };
  };
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await current.tui.waitForPending();
  const rolledBack = plain(current.tui.render()).join("\n");
  current.tui.send("\r");
  await current.tui.waitForPending();
  current.tui.press("ctrl+c");
  await command;
  assert.match(rolledBack, /Show widget\s+true/u);
  assert.equal(current.options.get().showWidget, false);
  assert.deepEqual(saves, [false, false]);
  assert.equal(current.notifications.length, 1);
  assert.match(
    current.notifications[0] ?? "",
    /application failed.*could not restore effective settings: rollback failed/u,
  );
});

test.each(["back", "close", "dispose", "owner"] as const)(
  "%s aborts owned work and drains pending writes",
  async (kind) => {
    const current = fixture();
    const started = deferred<AbortSignal>();
    const completion = deferred<SubagentSettings>();
    const apply = vi.fn(current.options.apply);
    current.options.apply = apply;
    const save = vi.fn(async (_key: keyof SubagentSettings, _value: boolean, signal: AbortSignal) => {
      started.resolve(signal);
      return completion.promise;
    });
    current.options.save = save;
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    const signal = await started.promise;
    // A queued second change must not start once this interaction has closed.
    current.tui.send("\r");
    let drained = false;
    void command.then(() => {
      drained = true;
    });
    if (kind === "owner") current.controller.abort();
    else if (kind === "dispose") current.tui.dispose();
    else current.tui.press(kind === "back" ? "tui.select.cancel" : "ctrl+c");
    const aborted = signal.aborted;
    const earlyCompletion = drained;
    completion.reject(signal.reason);
    const result = await command;
    assert.equal(aborted, true);
    assert.equal(earlyCompletion, false);
    assert.equal(save.mock.calls.length, 1);
    assert.equal(result, kind === "back" ? "back" : kind === "close" ? "close" : "stale");
    assert.deepEqual(current.notifications, []);
    // Rollback can restore the already effective snapshot, but cannot apply the rejected value.
    assert.ok(apply.mock.calls.every(([settings]) => settings.showWidget));
  },
);

test.each([true, false])(
  "successful publication during close applies only to the same session: %s",
  async (sameSession) => {
    const current = fixture();
    const started = deferred<void>();
    const completion = deferred<SubagentSettings>();
    let owned = true;
    current.options.isCurrent = () => owned;
    current.options.save = async () => {
      started.resolve();
      return completion.promise;
    };
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    await started.promise;
    current.tui.press("ctrl+c");
    owned = sameSession;
    completion.resolve({ ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
    const result = await command;
    assert.equal(result, sameSession ? "close" : "stale");
    assert.equal(current.options.get().showWidget, !sameSession);
  },
);

test.each(["\u0018", "\u0003"])("native custom navigation/cancel and hard Ctrl+C: %j", async (cancel) => {
  const original = getKeybindings();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+x",
  });
  setKeybindings(bindings);
  try {
    const current = fixture({ keybindings: bindings });
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send("\u000e");
    current.tui.send("\u0019");
    await current.tui.waitForPending();
    const frame = plain(current.tui.render()).join("\n");
    current.tui.send(cancel);
    const reason = await command;
    assert.equal(reason, cancel === "\u0003" ? "close" : "back");
    assert.equal(current.options.get().showJobId, true);
    assert.equal(current.options.get().showWidget, true);
    assert.match(frame, /→ Show job ID/u);
  } finally {
    setKeybindings(original);
  }
});

test.each([
  { name: "return alias", confirm: ["return"], input: "\r", kitty: false, changed: true },
  { name: "modifier order", confirm: ["shift+ctrl+y"], input: "\u001b[121;6u", kitty: true, changed: true },
  { name: "reverse modifier order", confirm: ["ctrl+shift+y"], input: "\u001b[121;6u", kitty: true, changed: true },
  { name: "legacy Enter and Ctrl+M collision", confirm: ["ctrl+m"], input: "\r", kitty: false, changed: true },
  { name: "legacy newline Enter", confirm: ["enter"], input: "\n", kitty: false, changed: true },
  { name: "Kitty newline is not Enter", confirm: ["enter"], input: "\n", kitty: true, changed: false },
  {
    name: "invalid key uses first usable fallback",
    confirm: ["ctrl++bad", "ctrl+ctrl+y", "ctrl+y"],
    input: "\u0019",
    kitty: false,
    changed: true,
  },
])("native configured-key branches: $name", async ({ confirm, input, kitty, changed }) => {
  const original = getKeybindings();
  const originalMode = isKittyProtocolActive();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    // User JSON can contain invalid strings; exercise the native runtime validator too.
    "tui.select.confirm": confirm as KeyId[],
    "tui.select.cancel": ["esc"],
  });
  setKeybindings(bindings);
  setKittyProtocolActive(kitty);
  try {
    const current = fixture({ keybindings: bindings });
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send(input);
    await current.tui.waitForPending();
    const frame = plain(current.tui.render()).join("\n");
    current.tui.send("\u001b");
    const result = await command;
    assert.equal(result, "back");
    assert.equal(current.options.get().showWidget, !changed);
    assert.match(frame, /Ctrl\+C close/u);
    assert.doesNotMatch(frame, /ctrl\+\+bad|ctrl\+ctrl\+y|Esc to cancel|Enter\/Space/u);
  } finally {
    setKeybindings(original);
    setKittyProtocolActive(originalMode);
  }
});

test("configured collisions keep native navigation priority and Ctrl+C remains hard cancel", async () => {
  const original = getKeybindings();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": ["ctrl+m", "ctrl+c"],
    "tui.select.confirm": "return",
  });
  setKeybindings(bindings);
  try {
    const current = fixture({ keybindings: bindings });
    const command = showSubagentSettings(current.ctx, current.options);
    await current.tui.waitForOpen();
    current.tui.send("\r");
    current.tui.send(" ");
    await current.tui.waitForPending();
    current.tui.send("\u0003");
    const result = await command;
    assert.equal(result, "close");
    assert.equal(current.options.get().showWidget, true);
    assert.equal(current.options.get().showJobId, true);
  } finally {
    setKeybindings(original);
  }
});

test("ownership replacement after an awaited save closes stale UI without applying", async () => {
  const current = fixture();
  const started = deferred<void>();
  const completion = deferred<SubagentSettings>();
  let owned = true;
  current.options.isCurrent = () => owned;
  current.options.save = async () => {
    started.resolve();
    return completion.promise;
  };
  const apply = vi.fn();
  current.options.apply = apply;
  const command = showSubagentSettings(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.send("\r");
  await started.promise;
  owned = false;
  completion.resolve({ ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  const reason = await command;
  assert.equal(reason, "stale");
  assert.equal(apply.mock.calls.length, 0);
  assert.equal(current.tui.isOpen, false);
});

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
  const command = showSubagentSettings(current.ctx, current.options);
  await entered.promise;
  current.controller.abort();
  release.resolve();
  const result = await command;
  current.tui.dispose();
  assert.equal(result, "stale");
  assert.equal(get.mock.calls.length, 0);
  assert.equal(current.tui.isOpen, false);
  assert.deepEqual(current.notifications, []);
});

test("host failures remain observable to the command owner without duplicate notifications", async () => {
  const current = fixture();
  const error = new Error("host failed");
  current.ctx.ui.custom = async () => {
    throw error;
  };
  await assert.rejects(showSubagentSettings(current.ctx, current.options), (caught) => caught === error);
  assert.deepEqual(current.notifications, []);
});

test.each(["rpc", "print", "json"] as const)("%s never opens a custom screen", async (mode) => {
  const current = fixture();
  const custom = vi.fn();
  const ctx = { ...current.ctx, mode, ui: { ...current.ctx.ui, custom } } as ExtensionCommandContext;
  const result = await showSubagentSettings(ctx, current.options);
  assert.equal(result, "back");
  assert.equal(custom.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});
