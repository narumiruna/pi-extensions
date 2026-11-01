import { stripVTControlCharacters } from "node:util";
import type {
  KeybindingsManager as AgentKeybindings,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  type KeyId,
  setKeybindings,
  setKittyProtocolActive,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CustomInteractionComponent } from "@narumitw/pi-tui-kit";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { displayPath } from "../display.ts";
import { type ScopePickerOptions, showScopePicker } from "../picker.ts";

const originalKeys = getKeybindings();
const originalKitty = isKittyProtocolActive();
beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(() => {
  setKeybindings(originalKeys);
  setKittyProtocolActive(originalKitty);
});

function setup(overrides: Partial<ScopePickerOptions> = {}, bindings: KeybindingsConfig = {}) {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keys);
  const roles = new Set<string>();
  const zeroFrames: string[][] = [];
  const tui = createTuiHarness({
    width: 100,
    rows: 32,
    keybindings: keys,
    theme: {
      fg: (role, text) => {
        roles.add(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroFrames.push(component.render(0));
      return component;
    }, options);
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify() {} } } as unknown as ExtensionCommandContext;
  const validate = vi.fn(async (paths: readonly string[]) => paths.map((path) => ({ path, canonical: path })));
  const options: ScopePickerOptions = {
    cwd: "/cwd",
    targets: [],
    completionLabel: "Start restriction",
    signal: new AbortController().signal,
    isCurrent: () => true,
    discover: async () => ["/cwd/a file", "/cwd/b", "/cwd/other"],
    validate,
    ...overrides,
  };
  return { tui, options, validate, roles, zeroFrames, running: showScopePicker(ctx, options) };
}

const plain = (lines: readonly string[]) => stripVTControlCharacters(lines.join("\n"));

test("selected absent targets are first, stable, prechecked, and remain selected outside a filter", async () => {
  const targets = ["/outside/z", "/cwd/.hidden", "/cwd/missing"].map((path) => ({ path, canonical: path }));
  const { tui, running, validate } = setup({ targets, completionLabel: "Apply changes" });
  await tui.waitForOpen();
  await tui.waitForPending();
  const initial = plain(tui.render());
  expect(initial.indexOf('[x] "/outside/z"')).toBeLessThan(initial.indexOf('[x] "/cwd/.hidden"'));
  expect(initial.indexOf('[x] "/cwd/missing"')).toBeLessThan(initial.indexOf('[ ] "/cwd/a file"'));
  tui.type("a file");
  tui.press("tui.select.confirm");
  expect(plain(tui.render())).toContain("> a file");
  expect(plain(tui.render())).toContain('[x] "/cwd/a file"');
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  const result = await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/outside/z", "/cwd/.hidden", "/cwd/missing", "/cwd/a file"]);
  expect(result).toMatchObject({ kind: "completed", value: { kind: "selected", targets: expect.any(Array) } });
  expect(targets).toHaveLength(3);
});

test("literal/pasted spaces and no-match search editing never activate completion", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("no-match");
  tui.send(" ");
  tui.press("tui.select.confirm");
  expect(validate).not.toHaveBeenCalled();
  expect(tui.isOpen).toBe(true);
  expect(plain(tui.render())).not.toContain("Start restriction");
  expect(plain(tui.render())).toContain("> no-match ");
  tui.send("\x15");
  tui.send("\x1b[200~a");
  tui.send(" ");
  tui.send("file\x1b[201~");
  expect(plain(tui.render())).toContain('[ ] "/cwd/a file"');
  tui.press("tui.select.confirm");
  expect(plain(tui.render())).toContain("> a file");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "selected" } });
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a file"]);
});

test("validation rejection keeps checked IDs and query in the same picker", async () => {
  let attempts = 0;
  const { tui, running } = setup({
    validate: async (paths) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Changed target");
      return paths.map((path) => ({ path, canonical: path }));
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("a file");
  tui.press("tui.select.confirm");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Changed target");
  expect(plain(tui.render())).toContain("> a file");
  expect(plain(tui.render())).toContain('[x] "/cwd/a file"');
  tui.press("tui.select.confirm");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "selected" } });
});

test("pasted control keys stay inert while final selection validation is pending", async () => {
  let reject!: (error: Error) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let signal: AbortSignal | undefined;
  const { tui, running } = setup({
    targets: [{ path: "/cwd/b", canonical: "/cwd/b" }],
    validate: async (_paths, operation) => {
      signal = operation;
      ready();
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.press("tui.select.up");
  tui.press("tui.select.confirm");
  await started;
  tui.send("\x1b[200~");
  tui.send("\x03");
  expect(signal?.aborted).toBe(false);
  reject(new Error("Retry selection"));
  await tui.waitForPending();
  tui.send("ignored\x1b[201~");
  expect(plain(tui.render())).toContain('[x] "/cwd/b"');
  expect(plain(tui.render())).not.toContain("> ignored");
  tui.send("\x03");
  expect(await running).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
});

test("raw control/Unicode IDs stay distinct and are escaped before display and filtering", async () => {
  const raw = "/cwd/a\x1b]52;c;bad\x07\n\u202e\u00a0 b";
  const other = "/cwd/a]52;c;bad b";
  const { tui, running, validate } = setup({ discover: async () => [raw, other] });
  await tui.waitForOpen();
  await tui.waitForPending();
  const display = plain(tui.render());
  expect(display).toContain(displayPath(raw));
  expect(display).not.toContain("\x1b]52");
  expect(display).not.toContain("\u202e");
  tui.send("\x1b[200~\u202e\u00a0\x1b[201~");
  tui.press("tui.select.confirm");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  expect(await running).toMatchObject({ kind: "completed" });
  expect(validate.mock.calls[0]?.[0]).toEqual([raw]);
});

test("picker rendering uses bounds, frame roles, IME focus, native viewport, and clipped pointer mapping", async () => {
  const files = Array.from({ length: 18 }, (_, index) => `/cwd/file-${index}`);
  const { tui, running, roles, zeroFrames } = setup({ discover: async () => files });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);
  const initial = tui.render();
  expect(initial.join("")).toContain(CURSOR_MARKER);
  expect(initial[0]).toMatch(/^─+$/u);
  expect(initial.at(-1)).toMatch(/^─+$/u);
  for (let index = 0; index < 12; index += 1) tui.press("tui.select.down");
  for (const rows of [4, 7, 8, 18, 32]) {
    for (const width of [1, 2, 8, 40, 100]) {
      const frame = tui.resize({ rows, width });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  }
  const frame = tui.resize({ rows: 8, width: 100 });
  expect(plain(frame)).toContain('→ [ ] "/cwd/file-12"');
  const row = frame.findIndex((line) => line.includes('"/cwd/file-12"'));
  tui.mouse({ type: "press", x: 5, y: row });
  tui.mouse({ type: "click", x: 5, y: row });
  expect(plain(tui.render())).toContain('→ [x] "/cwd/file-12"');
  tui.invalidate();
  tui.send("\x03");
  expect(await running).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
  expect(zeroFrames).toHaveLength(1);
  expect(zeroFrames.flat().every((line) => visibleWidth(line) === 0)).toBe(true);
  expect(roles.has("border")).toBe(true);
  expect(roles.has("muted")).toBe(true);
});

test("mouse click keeps the pressed raw file when selection recenters the viewport", async () => {
  const files = Array.from({ length: 18 }, (_, index) => `/cwd/file-${index}`);
  const { tui, running } = setup({ discover: async () => files });
  await tui.waitForOpen();
  await tui.waitForPending();
  const row = tui.render().findIndex((line) => line.includes('"/cwd/file-7"'));
  expect(row).toBeGreaterThan(0);
  tui.mouse({ type: "press", x: 5, y: row });
  expect(plain(tui.render())).toContain('"/cwd/file-10"');
  tui.mouse({ type: "click", x: 5, y: row });
  const rendered = plain(tui.render());
  expect(rendered).toContain('[x] "/cwd/file-7"');
  expect(rendered).not.toContain('[x] "/cwd/file-10"');
  tui.send("\x03");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "cancelled" } });
});

test("keyboard filtering clears a pending mouse press before another row is clicked", async () => {
  const files = Array.from({ length: 18 }, (_, index) => `/cwd/file-${index}`);
  const { tui, running, validate } = setup({ discover: async () => files });
  await tui.waitForOpen();
  await tui.waitForPending();
  const row = tui.render().findIndex((line) => line.includes('"/cwd/file-7"'));
  tui.mouse({ type: "press", x: 5, y: row });
  tui.type("file-10");
  const clicked = tui.render().findIndex((line) => line.includes('"/cwd/file-10"'));
  tui.mouse({ type: "click", x: 5, y: clicked });
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/file-10"]);
});

// No custom shortcuts/fallback keys are selected. Pi's matcher remains authoritative.
test.each([
  ["RETURN", "\r", false, true],
  ["alt+ctrl+x", "\x1b[120;7u", true, true],
  ["ctrl+alt+x", "\x1b[120;7u", false, true],
  ["ctrl+i", "\t", false, true],
  ["ctrl+i", "\x1b[105;5u", true, true],
  ["ctrl+", "\r", false, false],
  ["not-a-key", "\r", true, false],
] as const)("selection dispatch follows matcher for %s (Kitty=%s)", async (key, data, kitty, toggled) => {
  setKittyProtocolActive(kitty);
  const { tui, running } = setup({}, { "tui.select.confirm": key as KeyId, "tui.select.cancel": "q" });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send(data);
  const rendered = plain(tui.render());
  expect(rendered.includes('[x] "/cwd/a file"')).toBe(toggled);
  expect(rendered).not.toContain(`${key} toggle`);
  tui.send("\x03");
  expect(await running).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
});

for (const stage of ["scan", "validation"] as const) {
  for (const ending of ["back", "close", "dispose", "owner"] as const) {
    test(`picker aborts and drains ${stage} on ${ending}`, async () => {
      let release!: () => void;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let observed: AbortSignal | undefined;
      const blocked = async (signal: AbortSignal) => {
        observed = signal;
        ready();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const owner = new AbortController();
      const { tui, running } = setup({
        signal: owner.signal,
        targets: [{ path: "/cwd/b", canonical: "/cwd/b" }],
        ...(stage === "scan"
          ? {
              discover: async (signal: AbortSignal) => {
                await blocked(signal);
                return ["/cwd/b"];
              },
            }
          : {
              validate: async (_paths: readonly string[], signal: AbortSignal) => {
                await blocked(signal);
                return [];
              },
            }),
      });
      let settled = false;
      void running.then(() => {
        settled = true;
      });
      await tui.waitForOpen();
      if (stage === "validation") {
        await tui.waitForPending();
        tui.press("tui.select.up");
        tui.press("tui.select.confirm");
      }
      await started;
      if (ending === "dispose") tui.dispose();
      else if (ending === "owner") owner.abort();
      else tui.send(ending === "close" ? "\x03" : "\x1b");
      await Promise.resolve();
      expect(observed?.aborted).toBe(true);
      expect(settled).toBe(false);
      release();
      expect(await running).toEqual(
        ending === "dispose" || ending === "owner"
          ? { kind: "stale" }
          : {
              kind: "completed",
              value: { kind: "cancelled", reason: ending },
            },
      );
    });
  }
}

test.each(["scan", "validation"] as const)(
  "ownership changes after %s settle the picker as stale without a second signal",
  async (stage) => {
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const block = async () => {
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    let current = true;
    const { tui, running } = setup({
      isCurrent: () => current,
      targets: [{ path: "/cwd/b", canonical: "/cwd/b" }],
      ...(stage === "scan"
        ? {
            discover: async () => {
              await block();
              return [];
            },
          }
        : {
            validate: async () => {
              await block();
              return [];
            },
          }),
    });
    await tui.waitForOpen();
    if (stage === "validation") {
      await tui.waitForPending();
      tui.press("tui.select.up");
      tui.press("tui.select.confirm");
    }
    await started;
    current = false;
    release();
    expect(await running).toEqual({ kind: "stale" });
    expect(tui.isOpen).toBe(false);
  },
);

test("bounded discovery errors are observable rather than partial inventories", async () => {
  const error = new Error("Scan limit exceeded");
  const { running } = setup({
    discover: async () => {
      throw error;
    },
  });
  expect(await running).toEqual({ kind: "completed", value: { kind: "error", error } });
});

// Exercise the public host input pipeline rather than predicting interception
// from configured key strings. The custom adapters deliberately show no key hints.
test.each([
  ["regular", false, "pageUp", "\x1b[5~", true],
  ["fullscreen", false, "pageUp", "\x1b[5~", false],
  ["fullscreen", true, "PAGEUP", "\x1b[5~", false],
  ["regular", false, "tab", "\t", true],
  ["fullscreen", false, "tab", "\t", false],
  ["fullscreen", true, "ctrl+i", "\x1b[105;5u", false],
] as const)(
  "public %s host dispatch and hint omission (Kitty=%s, key=%s)",
  async (mode, kitty, key, data, delivered) => {
    setKittyProtocolActive(kitty);
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": ["ctrl+" as KeyId, key as KeyId, "f2"],
      "tui.select.pageUp": [],
      "tui.select.cancel": "q",
      "tui.altScreen.pageUp": key === "tab" ? "ctrl+i" : (key as KeyId),
    });
    setKeybindings(keys);
    let send = (_data: string) => {};
    const noop = () => {};
    const terminal: Terminal = {
      columns: 100,
      rows: 32,
      kittyProtocolActive: kitty,
      start: (input) => {
        send = input;
      },
      stop: noop,
      drainInput: async () => {},
      write: noop,
      moveBy: noop,
      hideCursor: noop,
      showCursor: noop,
      clearLine: noop,
      clearFromCursor: noop,
      clearScreen: noop,
      setTitle: noop,
      setProgress: noop,
      setProgramStatus: noop,
    };
    const host =
      mode === "fullscreen"
        ? new TuiAltScreen(terminal, false, undefined, { mouse: false })
        : new TuiMainScreen(terminal);
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let mounted: CustomInteractionComponent | undefined;
    type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
    const custom = (async (factory: Factory) => {
      let done!: (value: unknown) => void;
      const completion = new Promise<unknown>((resolve) => {
        done = resolve;
      });
      const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
      mounted = await factory(host, theme, keys as AgentKeybindings, done);
      host.addChild(mounted);
      host.setFocus(mounted);
      host.start();
      ready();
      try {
        return await completion;
      } finally {
        mounted.dispose?.();
        host.stop();
      }
    }) as ExtensionCommandContext["ui"]["custom"];
    const ctx = { mode: "tui", hasUI: true, ui: { custom, notify() {} } } as unknown as ExtensionCommandContext;
    const running = showScopePicker(ctx, {
      cwd: "/cwd",
      targets: [],
      completionLabel: "Start restriction",
      signal: new AbortController().signal,
      isCurrent: () => true,
      discover: async () => ["/cwd/a"],
      validate: async () => [],
    });
    await opened;
    await mounted?.waitForPending?.();
    send(data);
    const first = plain(mounted?.render(100) ?? []);
    send("\x1bOQ"); // F2 is the first usable configured alternative after host interception.
    const second = plain(mounted?.render(100) ?? []);
    send("\x03");
    const result = await running;
    expect(first.includes('[x] "/cwd/a"')).toBe(delivered);
    expect(second.includes('[x] "/cwd/a"')).toBe(!delivered);
    expect(first).not.toMatch(/pageup|ctrl\+i|f2 (select|toggle)/iu);
    expect(result).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
  },
);
