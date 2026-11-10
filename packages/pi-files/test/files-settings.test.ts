import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type KeybindingsManager as AppKeys,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  InteractiveMode,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  type KeyId,
  SettingsList,
  setKeybindings,
  setKittyProtocolActive,
  type TUI,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import type { ContextService } from "../src/context-service.js";
import type { FileContextMenuState } from "../src/file-context-menu.js";
import { loadFileContextSettings, updateFileContextSettings } from "../src/file-context-settings.js";
import { showFilesSettings } from "../src/files-settings.js";
import type { ScopeService } from "../src/scope/edit-scope.js";

initTheme("dark", false);
const originalKeys = getKeybindings();
const originalKitty = isKittyProtocolActive();
afterEach(() => {
  setKeybindings(originalKeys);
  setKittyProtocolActive(originalKitty);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function pending(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type Screen = Component & Focusable & { dispose(): void };

function fixture(bindings: KeybindingsConfig = {}) {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keys);
  const state: FileContextMenuState = {
    quotes: [],
    shortcut: "f8",
    settingsPath: "/user/pi-file-context.json",
    maximumQuotes: 8,
    maximumBytes: 100_000,
    totalBytes: 0,
  };
  const settings = { showHiddenFiles: false };
  const contextOwner = new AbortController();
  const scopeOwner = new AbortController();
  const commandOwner = new AbortController();
  const context = {
    getState: vi.fn(() => state),
    saveShortcut: vi.fn(async (_ctx: unknown, value: KeyId | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      state.shortcut = value;
    }),
    signal: vi.fn(() => contextOwner.signal),
    open: vi.fn(),
    browse: vi.fn(),
  } satisfies ContextService;
  const scope = {
    getSettings: vi.fn(() => settings),
    saveShowHiddenFiles: vi.fn(async (_ctx: unknown, value: boolean) => {
      settings.showHiddenFiles = value;
    }),
    signal: vi.fn(() => scopeOwner.signal),
    off: vi.fn(),
    open: vi.fn(),
    getView: vi.fn(),
  } satisfies ScopeService;
  let component: Screen;
  let rows = 24;
  let width = 80;
  let stale = false;
  let closed = false;
  const opened = deferred<void>();
  const doneCalls: unknown[] = [];
  const fg = vi.fn((_role: string, value: string) => value);
  const theme = { fg, bold: (value: string) => value } as unknown as Theme;
  const requestRender = vi.fn();
  const tui = {
    terminal: {
      get rows() {
        return rows;
      },
    },
    requestRender,
  } as unknown as TUI;
  const custom = vi.fn(async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
    const outcome = deferred<unknown>();
    const created = await factory(tui, theme, keys as unknown as AppKeys, (value) => {
      closed = true;
      doneCalls.push(value);
      outcome.resolve(value);
    });
    component = created as Screen;
    component.focused = true;
    component.render(width);
    opened.resolve();
    try {
      return await outcome.promise;
    } finally {
      component.dispose();
    }
  });
  const notify = vi.fn();
  const reload = vi.fn(async () => {});
  const ui = { custom, notify };
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: {},
    signal: commandOwner.signal,
    get ui() {
      if (stale) throw new Error("stale UI access");
      return ui;
    },
    reload,
  } as unknown as ExtensionCommandContext;
  const render = (nextWidth = width, nextRows = rows) => {
    width = nextWidth;
    rows = nextRows;
    return component.render(width);
  };
  const send = (data: string) => {
    component.handleInput?.(data);
    if (!closed) render();
  };
  return {
    ctx,
    context,
    scope,
    state,
    settings,
    contextOwner,
    scopeOwner,
    commandOwner,
    opened: opened.promise,
    custom,
    notify,
    reload,
    fg,
    doneCalls,
    requestRender,
    start: () => showFilesSettings(ctx, context, scope),
    render,
    text: () => render().map(stripVTControlCharacters).join("\n"),
    send,
    screen: () => component,
    setStale: () => {
      stale = true;
    },
    shortcut(value: string) {
      send("\r");
      send(value);
      send("\r");
    },
    hidden() {
      send("\x1b[B");
      send(" ");
    },
  };
}

it("uses native SettingsList with two rows and callback-themed shared framing", async () => {
  const native = vi.spyOn(SettingsList.prototype, "render");
  const f = fixture();
  const running = f.start();
  await f.opened;
  const lines = f.render();
  const text = lines.map(stripVTControlCharacters).join("\n");
  const themeCalls = f.fg.mock.calls.slice();
  f.send("\x03");
  await running;
  expect(native).toHaveBeenCalled();
  expect(text).toContain("Files Settings");
  expect(text).toMatch(/Open shortcut\s+f8/u);
  expect(text).toMatch(/Show hidden files\s+false/u);
  expect(lines[0]).toBe("─".repeat(80));
  expect(lines.at(-1)).toBe("─".repeat(80));
  expect(themeCalls.some(([role]) => role === "border")).toBe(true);
  expect(themeCalls.some(([role]) => role === "dim")).toBe(true);
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
  expect(f.scope.off).not.toHaveBeenCalled();
});

it("bounds normal, narrow, zero-width, short, resized, and invalidated frames around the focused row", async () => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.send("\x1b[B");
  const evidence: Array<{ width: number; rows: number; lines: string[] }> = [];
  for (const rows of [4, 5, 7, 8, 12, 24, 7]) {
    for (const width of [80, 24, 8, 1, 0]) {
      f.screen().invalidate();
      evidence.push({ width, rows, lines: f.render(width, rows).map(stripVTControlCharacters) });
    }
  }
  f.send("\x03");
  await running;
  for (const item of evidence) {
    const budget = Math.max(1, item.rows - 3);
    expect(item.lines.length).toBeLessThanOrEqual(budget);
    expect(item.lines.every((line) => visibleWidth(line) <= item.width)).toBe(true);
    if (item.width === 80) {
      expect(item.lines.join("\n")).toContain("→ Show hidden files");
      if (budget >= 5) {
        expect(item.lines[0]).toBe("─".repeat(80));
        expect(item.lines.at(-1)).toBe("─".repeat(80));
      } else expect(item.lines.some((line) => /^─+$/u.test(line))).toBe(false);
    }
  }
});

it("rebuilds callback theme styles after invalidation", async () => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.fg.mockImplementation((_role, text) => `\x1b[31m${text}\x1b[0m`);
  f.screen().invalidate();
  const first = f.render();
  f.fg.mockImplementation((_role, text) => `\x1b[32m${text}\x1b[0m`);
  f.screen().invalidate();
  const second = f.render();
  f.send("\x03");
  await running;
  expect(first[0]).toContain("\x1b[31m");
  expect(second[0]).toContain("\x1b[32m");
  expect(second.join("\n")).not.toContain("\x1b[31m");
});

it("saves hidden files immediately without reload and without touching context or scope", async () => {
  const f = fixture();
  const quotes = f.state.quotes;
  const running = f.start();
  await f.opened;
  f.hidden();
  await pending();
  const text = f.text();
  f.send("\x1b");
  await running;
  expect(f.scope.saveShowHiddenFiles).toHaveBeenCalledWith(f.ctx, true);
  expect(f.settings.showHiddenFiles).toBe(true);
  expect(text).toMatch(/Show hidden files\s+true/u);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
  expect(f.state.quotes).toBe(quotes);
  expect(f.scope.off).not.toHaveBeenCalled();
});

it("retains the effective hidden value after failure and keeps queued actions ordered and usable", async () => {
  const f = fixture();
  const first = deferred<void>();
  const writes: boolean[] = [];
  f.scope.saveShowHiddenFiles.mockImplementation(async (_ctx, value) => {
    writes.push(value);
    if (writes.length === 1) await first.promise;
    f.settings.showHiddenFiles = value;
  });
  const running = f.start();
  await f.opened;
  f.hidden();
  await pending();
  f.send(" ");
  const before = f.text();
  first.reject(new Error("disk \x1b[31mfull"));
  await pending();
  const afterFailure = f.text();
  f.send(" ");
  await pending();
  const afterRetry = f.text();
  f.send("\x03");
  await running;
  expect(before).toMatch(/Show hidden files\s+false/u);
  expect(afterFailure).toMatch(/Show hidden files\s+false/u);
  expect(afterRetry).toMatch(/Show hidden files\s+true/u);
  expect(writes).toEqual([true, false, true]);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.notify.mock.calls[0]?.[0]).not.toContain("\x1b");
});

it.each(["queued", "invalid"] as const)("blocks only the shortcut for %s context settings", async (kind) => {
  const f = fixture();
  if (kind === "queued") {
    f.state.quotes = [{ id: "q1", path: "file", startLine: 1, endLine: 1, text: "saved snapshot" }];
  } else f.state.settingsInvalidReason = "invalid JSON";
  const quotes = f.state.quotes;
  const running = f.start();
  await f.opened;
  f.send("\r");
  const blocked = f.text();
  f.hidden();
  await pending();
  f.send("\x1b");
  await running;
  expect(blocked).not.toContain("> ");
  expect(blocked).toMatch(kind === "queued" ? /queued context/u : /invalid JSON/u);
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.settings.showHiddenFiles).toBe(true);
  expect(f.state.quotes).toBe(quotes);
});

it("leaves malformed context settings bytes unchanged while saving hidden files", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-settings-"));
  try {
    const path = join(root, "pi-file-context.json");
    await writeFile(path, "{malformed");
    const loaded = await loadFileContextSettings(path);
    const f = fixture();
    f.state.settingsPath = path;
    f.state.settingsInvalidReason = loaded.invalidReason;
    f.context.saveShortcut.mockImplementation(async (_ctx, shortcut, signal) => {
      await updateFileContextSettings(shortcut, { settingsPath: path, signal });
    });
    const running = f.start();
    await f.opened;
    f.send("\r");
    f.hidden();
    await pending();
    f.send("\x03");
    await running;
    expect(f.context.saveShortcut).not.toHaveBeenCalled();
    expect(f.settings.showHiddenFiles).toBe(true);
    expect(await readFile(path, "utf8")).toBe("{malformed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["ctrl+shift+x", " SHIFT+CTRL+x ", ""])("normalizes shortcut %j, saves, then reloads once", async (value) => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.shortcut(value);
  await running;
  const expected = value.trim() ? value.trim().toLowerCase() : null;
  expect(f.state.shortcut).toBe(expected);
  expect(f.context.saveShortcut.mock.calls[0]?.[1]).toBe(expected);
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.scope.off).not.toHaveBeenCalled();
});

it("rejects invalid shortcut text without closing the input or saving", async () => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.shortcut("not-a-Pi-key");
  const frame = f.text();
  f.send("\x1b");
  const back = f.text();
  f.send("\x1b");
  await running;
  expect(frame).toContain("> not-a-Pi-key");
  expect(back).toMatch(/Open shortcut\s+f8/u);
  expect(f.notify.mock.calls[0]?.[0]).toContain("Invalid Pi key");
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
});

it("restores the displayed shortcut after a failed save and permits retry", async () => {
  const f = fixture();
  f.context.saveShortcut.mockRejectedValueOnce(new Error("read-only file"));
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+x");
  await pending();
  const frame = f.text();
  f.shortcut("ctrl+y");
  await running;
  expect(frame).toMatch(/Open shortcut\s+f8/u);
  expect(f.context.saveShortcut).toHaveBeenCalledTimes(2);
  expect(f.state.shortcut).toBe("ctrl+y");
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.notify.mock.calls[0]?.[0]).toContain("previous value remains");
});

it("keeps the saved shortcut and reports /reload if reload fails", async () => {
  const f = fixture();
  f.reload.mockRejectedValueOnce(new Error("reload failed"));
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+y");
  await running;
  expect(f.state.shortcut).toBe("ctrl+y");
  expect(f.notify.mock.calls[0]?.[0]).toMatch(/saved.*\/reload/u);
});

it("does not use the old context after successful reload", async () => {
  const f = fixture();
  f.reload.mockImplementation(async () => {
    f.setStale();
    f.context.getState.mockImplementation(() => {
      throw new Error("stale state access");
    });
  });
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+y");
  await running;
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.notify).not.toHaveBeenCalled();
});

it("does not notify through a replaced context when reload rejects", async () => {
  const f = fixture();
  f.reload.mockImplementation(async () => {
    f.contextOwner.abort();
    f.setStale();
    throw new Error("runtime replaced");
  });
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+y");
  await running;
  expect(f.notify).not.toHaveBeenCalled();
});

it("serializes both stores and drains an accepted hidden save before shortcut reload", async () => {
  const f = fixture();
  const write = deferred<void>();
  const order: string[] = [];
  f.context.saveShortcut.mockImplementation(async (_ctx, value) => {
    order.push("shortcut");
    f.state.shortcut = value;
  });
  f.scope.saveShowHiddenFiles.mockImplementation(async (_ctx, value) => {
    order.push("hidden:start");
    await write.promise;
    f.settings.showHiddenFiles = value;
    order.push("hidden:end");
  });
  f.reload.mockImplementation(async () => {
    order.push("reload");
  });
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+y");
  f.hidden();
  await pending();
  const before = order.slice();
  write.resolve();
  await running;
  expect(before).toEqual(["shortcut", "hidden:start"]);
  expect(order).toEqual(["shortcut", "hidden:start", "hidden:end", "reload"]);
});

it("revalidates queued context before a delayed shortcut save", async () => {
  const f = fixture();
  const write = deferred<void>();
  f.scope.saveShowHiddenFiles.mockImplementation(async () => write.promise);
  const running = f.start();
  await f.opened;
  f.hidden();
  await pending();
  f.send("\x1b[A");
  f.shortcut("ctrl+y");
  f.state.quotes = [{ id: "q1", path: "file", startLine: 1, endLine: 1, text: "snapshot" }];
  write.resolve();
  await pending();
  f.send("\x03");
  await running;
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.state.quotes).toHaveLength(1);
});

it("does not discard context queued during shortcut persistence", async () => {
  const f = fixture();
  const write = deferred<void>();
  f.context.saveShortcut.mockImplementation(async (_ctx, value) => {
    await write.promise;
    f.state.shortcut = value;
  });
  const running = f.start();
  await f.opened;
  f.shortcut("ctrl+y");
  await pending();
  f.state.quotes = [{ id: "q1", path: "file", startLine: 1, endLine: 1, text: "snapshot" }];
  write.resolve();
  await running;
  expect(f.state.shortcut).toBe("ctrl+y");
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.notify.mock.calls[0]?.[0]).toMatch(/queued context.*\/reload/u);
  expect(f.state.quotes).toHaveLength(1);
});

it.each(["escape", "ctrl+c", "dispose", "command", "context", "scope"] as const)(
  "cancels and drains delayed writes on %s without stale UI calls or later writes",
  async (kind) => {
    const f = fixture();
    const write = deferred<void>();
    f.scope.saveShowHiddenFiles.mockImplementation(async (_ctx, value) => {
      await write.promise;
      f.settings.showHiddenFiles = value;
    });
    let settled = false;
    const running = f.start().then(() => {
      settled = true;
    });
    await f.opened;
    f.hidden();
    await pending();
    f.send(" ");
    f.send("\x1b[A");
    f.shortcut("ctrl+y");
    if (kind === "escape") f.send("\x1b");
    else if (kind === "ctrl+c") f.send("\x03");
    else if (kind === "dispose") f.screen().dispose();
    else {
      ({ command: f.commandOwner, context: f.contextOwner, scope: f.scopeOwner })[kind].abort();
      f.setStale();
    }
    const renderCount = f.requestRender.mock.calls.length;
    await pending();
    const beforeDrain = settled;
    write.resolve();
    await running;
    f.screen().dispose();
    expect(beforeDrain).toBe(false);
    expect(f.scope.saveShowHiddenFiles).toHaveBeenCalledTimes(1);
    expect(f.context.saveShortcut).not.toHaveBeenCalled();
    expect(f.requestRender).toHaveBeenCalledTimes(renderCount);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.doneCalls).toEqual(kind === "dispose" ? [] : [false]);
  },
);

it("settles locally during Pi host reset without changing its dialog iteration or replacement draft", async () => {
  const f = fixture();
  const mounted = deferred<void>();
  const started = deferred<void>();
  const write = deferred<void>();
  const unrelatedDispose = vi.fn();
  let draft = "obsolete draft";
  const setText = vi.fn((value: string) => {
    draft = value;
  });
  const noop = () => {};
  // Exercise the installed Pi stack, custom completion, and reset implementations.
  // Mock only unrelated host services; do not simulate the reset iteration.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    editor: { getText: () => draft, setText },
    defaultEditor: {},
    keybindings: getKeybindings(),
    extensionDialogs: [],
    extensionOverlays: new Map(),
    editorContainer: { clear: noop, addChild: noop },
    programStatus: { setBlocked: () => mounted.resolve() },
    ui: { terminal: { rows: 24 }, setFocus: noop, requestRender: f.requestRender, hideOverlay: noop },
    clearExtensionTerminalInputListeners: noop,
    setExtensionFooter: noop,
    setExtensionHeader: noop,
    clearExtensionWidgets: noop,
    footerDataProvider: { clearExtensionStatuses: noop },
    footer: { invalidate: noop },
    setCustomEditorComponent: noop,
    setupAutocompleteProvider: noop,
    updateTerminalTitle: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
  }) as {
    extensionDialogs: Array<{ component: Screen }>;
    showExtensionCustom: ExtensionUIContext["custom"];
    resetExtensionUI(): void;
  };
  let hostSettled = false;
  f.custom.mockImplementation(async (factory) => {
    const result = await host.showExtensionCustom((tui, theme, keys, done) =>
      factory(tui, theme, keys, (value) => {
        f.doneCalls.push(value);
        done(value);
      }),
    );
    hostSettled = true;
    return result;
  });
  f.scope.saveShowHiddenFiles.mockImplementation(async (_ctx, value) => {
    started.resolve();
    await write.promise;
    f.settings.showHiddenFiles = value;
  });
  let settled = false;
  const running = f.start().then(() => {
    settled = true;
  });
  await mounted.promise;
  const screen = host.extensionDialogs[0]?.component as Screen;
  screen.focused = true;
  screen.render(80);
  screen.handleInput?.("\x1b[B");
  screen.handleInput?.(" ");
  await started.promise;
  screen.handleInput?.(" "); // Queued hidden save must not start after disposal.
  screen.handleInput?.("\x1b[A");
  screen.render(80);
  screen.handleInput?.("\r");
  screen.handleInput?.("ctrl+y");
  screen.handleInput?.("\r"); // Queue a shortcut behind the started hidden save.
  host.extensionDialogs.push({
    component: { focused: false, render: () => [], invalidate: noop, dispose: unrelatedDispose },
  });
  const dialogs = host.extensionDialogs;
  draft = "replacement session draft";
  host.resetExtensionUI();
  f.setStale();
  const reads = f.context.getState.mock.calls.length;
  f.context.getState.mockImplementation(() => {
    throw new Error("stale state access");
  });
  f.contextOwner.abort();
  f.scopeOwner.abort();
  f.commandOwner.abort();
  screen.dispose();
  screen.handleInput?.("\x03");
  const afterDispose = screen.render(80);
  const renderCount = f.requestRender.mock.calls.length;
  await pending();
  const beforeDrain = settled;
  write.resolve();
  await running;
  screen.dispose();
  expect(beforeDrain).toBe(false);
  expect(settled).toBe(true);
  expect(hostSettled).toBe(false); // Pi leaves custom() unresolved on external reset.
  expect(f.doneCalls).toEqual([]);
  expect(dialogs).toHaveLength(2);
  expect(host.extensionDialogs).toEqual([]);
  expect(unrelatedDispose).toHaveBeenCalledTimes(1);
  expect(setText).not.toHaveBeenCalled();
  expect(draft).toBe("replacement session draft");
  expect(screen.focused).toBe(false);
  expect(afterDispose).toEqual([]);
  expect(f.scope.saveShowHiddenFiles).toHaveBeenCalledTimes(1);
  expect(f.settings.showHiddenFiles).toBe(true);
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
  expect(f.context.getState).toHaveBeenCalledTimes(reads);
  expect(f.requestRender).toHaveBeenCalledTimes(renderCount);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
});

it("drains work after host custom failure without invoking its completion callback", async () => {
  const f = fixture();
  const custom = f.custom.getMockImplementation();
  if (!custom) throw new Error("Missing custom UI fixture");
  const failed = deferred<never>();
  const write = deferred<void>();
  const failure = new Error("host custom failed");
  f.custom.mockImplementation((factory) => Promise.race([custom(factory), failed.promise]));
  f.scope.saveShowHiddenFiles.mockImplementation(async (_ctx, value) => {
    await write.promise;
    f.settings.showHiddenFiles = value;
  });
  let settled = false;
  const running = f.start().catch((error) => {
    settled = true;
    return error;
  });
  await f.opened;
  f.hidden();
  await pending();
  failed.reject(failure);
  await pending();
  const beforeDrain = settled;
  const renderCount = f.requestRender.mock.calls.length;
  f.setStale();
  f.contextOwner.abort();
  write.resolve();
  const error = await running;
  f.screen().dispose();
  expect(error).toBe(failure);
  expect(beforeDrain).toBe(false);
  expect(settled).toBe(true);
  expect(f.doneCalls).toEqual([]);
  expect(f.settings.showHiddenFiles).toBe(true);
  expect(f.scope.saveShowHiddenFiles).toHaveBeenCalledTimes(1);
  expect(f.requestRender).toHaveBeenCalledTimes(renderCount);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.reload).not.toHaveBeenCalled();
});

it("passes cancellation to a delayed shortcut write and waits for its settlement", async () => {
  const f = fixture();
  const write = deferred<void>();
  let signal: AbortSignal | undefined;
  f.context.saveShortcut.mockImplementation(async (_ctx, _value, received) => {
    signal = received;
    await write.promise;
    received.throwIfAborted();
  });
  let settled = false;
  const running = f.start().then(() => {
    settled = true;
  });
  await f.opened;
  f.shortcut("ctrl+y");
  await pending();
  f.screen().dispose();
  await pending();
  const beforeDrain = settled;
  write.resolve();
  await running;
  expect(beforeDrain).toBe(false);
  expect(signal?.aborted).toBe(true);
  expect(f.doneCalls).toEqual([]);
  expect(f.state.shortcut).toBe("f8");
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

it("forwards IME focus and preserves native editing, paste, newline submission, and submenu cancellation", async () => {
  const f = fixture({ "tui.select.cancel": "f4" });
  const running = f.start();
  await f.opened;
  f.send("\r");
  const focused = f.render().join("\n");
  f.screen().focused = false;
  const blurred = f.render().join("\n");
  f.screen().focused = true;
  f.send("\x1b[200~ctrl+");
  f.send("\x03"); // A pasted control byte must not cancel the flow or execute a shortcut.
  f.send("y\x1b[201~");
  const pasted = f.render().join("\n");
  f.send("\x1bOS"); // Configured F4 goes back without saving.
  f.send("\r");
  f.send("ctrl+z");
  f.send("\x7f");
  f.send("y");
  f.send("\n");
  await running;
  expect(focused).toContain(CURSOR_MARKER);
  expect(blurred).not.toContain(CURSOR_MARKER);
  expect(pasted).not.toContain("\x03");
  expect(f.state.shortcut).toBe("ctrl+y");
  expect(f.context.saveShortcut).toHaveBeenCalledTimes(1);
});

it("keeps the native input cursor visible at narrow widths and bounds zero-width submenu frames", async () => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.send("\r");
  f.send("ctrl+y");
  const evidence = [24, 8, 4, 3, 2, 1, 0].map((width) => ({ width, lines: f.render(width, 4) }));
  f.send("\x03");
  await running;
  for (const { width, lines } of evidence) {
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (width >= 3) expect(lines.join("\n")).toContain(CURSOR_MARKER);
  }
});

it("retains the submenu input row at constrained heights and maps visible mouse rows after clipping", async () => {
  const f = fixture();
  const running = f.start();
  await f.opened;
  f.send("\r");
  f.send("ctrl+y");
  const evidence = [4, 5, 7, 8, 24].map((rows) => ({ rows, lines: f.render(80, rows) }));
  f.send("\x1b");
  const lines = f.render(80, 4);
  const row = lines.findIndex((line) => stripVTControlCharacters(line).includes("Open shortcut"));
  f.screen().handleMouse?.({ type: "click", button: "left", x: 4, y: row } as TuiMouseEvent);
  const afterClick = f.render(80, 4).join("\n");
  f.send("\x03");
  await running;
  for (const { rows, lines: frame } of evidence) {
    expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
    expect(frame.join("\n")).toContain("> ctrl+y");
    expect(frame.join("\n")).toContain(CURSOR_MARKER);
  }
  expect(afterClick).toContain("> ");
});

it.each([
  { name: "confirm", bindings: { "tui.select.confirm": "escape" }, expected: "> " },
  { name: "up", bindings: { "tui.select.up": "escape" }, expected: "→ Show hidden files" },
  { name: "down", bindings: { "tui.select.down": "escape" }, expected: "→ Show hidden files" },
  { name: "page", bindings: { "tui.select.pageDown": "escape" }, expected: "→ Show hidden files" },
  {
    name: "confirm before cancel",
    bindings: { "tui.select.confirm": "escape", "tui.select.cancel": "escape" },
    expected: "> ",
  },
  { name: "unassigned Escape", bindings: {}, expected: "→ Open shortcut" },
] as const)("preserves native main-list priority for $name", async ({ bindings, expected }) => {
  const f = fixture({ "tui.select.cancel": "f4", ...bindings });
  const running = f.start();
  await f.opened;
  f.send("\x1b");
  const text = f.text();
  f.send("\x03");
  await running;
  expect(text).toContain(expected);
  expect(f.doneCalls).toEqual([false]);
  expect(f.context.saveShortcut).not.toHaveBeenCalled();
});

it.each([
  { name: "Escape", submit: "escape", bytes: "\x1b", kitty: false, saves: true },
  { name: "matcher alias", submit: "return", bytes: "\r", kitty: false, saves: true },
  { name: "modifier order", submit: "shift+ctrl+x", bytes: "\x1b[120;6u", kitty: true, saves: true },
  { name: "legacy collision", submit: "ctrl+i", bytes: "\t", kitty: false, saves: true },
  { name: "invalid first binding", submit: ["ctrl+f1", "escape"], bytes: "\x1b", kitty: false, saves: true },
  { name: "legacy Alt", submit: "alt+x", bytes: "\x1bx", kitty: false, saves: true },
  { name: "Kitty rejects legacy Alt", submit: "alt+x", bytes: "\x1bx", kitty: true, saves: false },
  { name: "Kitty Alt", submit: "alt+x", bytes: "\x1b[120;3u", kitty: true, saves: true },
] as const)("uses native Input submission for $name", async ({ submit, bytes, kitty, saves }) => {
  setKittyProtocolActive(kitty);
  const f = fixture({ "tui.select.cancel": "f4", "tui.input.submit": submit as KeyId | KeyId[] });
  const running = f.start();
  await f.opened;
  f.send("\r");
  f.send("ctrl+y");
  f.send(bytes);
  await pending();
  f.send("\x03");
  await running;
  expect(f.context.saveShortcut).toHaveBeenCalledTimes(saves ? 1 : 0);
  expect(f.state.shortcut).toBe(saves ? "ctrl+y" : "f8");
  expect(f.reload).toHaveBeenCalledTimes(saves ? 1 : 0);
});

it.each([
  { name: "unassigned Escape", bindings: {}, expected: "f11" },
  { name: "backward deletion", bindings: { "tui.editor.deleteCharBackward": "escape" }, expected: "f1" },
  {
    name: "undo before submit",
    bindings: { "tui.editor.undo": "escape", "tui.input.submit": "escape" },
    expected: null,
  },
  {
    name: "cancel before submit",
    bindings: { "tui.select.cancel": "escape", "tui.input.submit": "escape" },
    expected: undefined,
  },
] as const)("preserves native Input priority for $name", async ({ bindings, expected }) => {
  const f = fixture({ "tui.select.cancel": "f4", ...bindings });
  const running = f.start();
  await f.opened;
  f.send("\r");
  f.send("f11");
  f.send("\x1b");
  const text = f.text();
  if (expected !== undefined) {
    f.send("\n");
    await pending();
  }
  f.send("\x03");
  await running;
  expect(f.state.shortcut).toBe(expected === undefined ? "f8" : expected);
  expect(f.context.saveShortcut).toHaveBeenCalledTimes(expected === undefined ? 0 : 1);
  if (expected === undefined) expect(text).toContain("→ Open shortcut");
});

it.each(["main", "input"] as const)(
  "keeps Ctrl+C as hard cancellation in %s despite configured actions",
  async (screen) => {
    const f = fixture({ "tui.select.cancel": "f4", "tui.select.confirm": "ctrl+c", "tui.input.submit": "ctrl+c" });
    const running = f.start();
    await f.opened;
    if (screen === "input") {
      const lines = f.render();
      const y = lines.findIndex((line) => stripVTControlCharacters(line).includes("Open shortcut"));
      f.screen().handleMouse?.({ type: "click", button: "left", x: 4, y } as TuiMouseEvent);
      f.send("ctrl+y");
    }
    f.send("\x03");
    await running;
    expect(f.doneCalls).toEqual([false]);
    expect(f.context.saveShortcut).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "non-default", confirm: "f2", bytes: "\x1bOQ" },
  { name: "matcher alias", confirm: "return", bytes: "\r" },
  { name: "modifier order", confirm: "shift+ctrl+x", bytes: "\x1b[120;6u" },
  { name: "legacy collision", confirm: "ctrl+i", bytes: "\t" },
  { name: "invalid first binding", confirm: ["ctrl+f1", "f2"], bytes: "\x1bOQ" },
] as const)("uses native settings confirmation with $name bindings", async ({ confirm, bytes }) => {
  const f = fixture({ "tui.select.confirm": confirm as KeyId | KeyId[] });
  const running = f.start();
  await f.opened;
  f.send(bytes);
  const editor = f.text();
  f.send("\x03");
  await running;
  expect(editor).toContain("> ");
});

it.each([
  { kitty: false, bytes: "\x1bx", opens: true },
  { kitty: true, bytes: "\x1bx", opens: false },
  { kitty: true, bytes: "\x1b[120;3u", opens: true },
])("keeps native terminal-mode matching for $kitty / $bytes", async ({ kitty, bytes, opens }) => {
  setKittyProtocolActive(kitty);
  const f = fixture({ "tui.select.confirm": "alt+x" });
  const running = f.start();
  await f.opened;
  f.send(bytes);
  const text = f.text();
  f.send("\x03");
  await running;
  expect(text.includes("> ")).toBe(opens);
});

it("preserves native navigation priority when configured settings actions collide", async () => {
  const f = fixture({ "tui.select.down": "f2", "tui.select.confirm": "f2" });
  const running = f.start();
  await f.opened;
  f.send("\x1bOQ");
  const text = f.text();
  f.send("\x03");
  await running;
  expect(text).toContain("→ Show hidden files");
  expect(text).not.toContain("> ");
  expect(f.scope.saveShowHiddenFiles).not.toHaveBeenCalled();
});

it.each(["rpc", "print", "json"] as const)("rejects %s before entering custom UI", async (mode) => {
  const f = fixture();
  const ctx = { ...f.ctx, mode, hasUI: mode === "rpc" } as ExtensionCommandContext;
  await expect(showFilesSettings(ctx, f.context, f.scope)).rejects.toThrow("Pi TUI mode");
  expect(f.custom).not.toHaveBeenCalled();
  expect(f.context.signal).not.toHaveBeenCalled();
  expect(f.scope.signal).not.toHaveBeenCalled();
});
