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
import { displayPath } from "../src/display.js";
import { type ScopePickerOptions, showScopePicker } from "../src/picker.js";
import { MAX_TARGETS } from "../src/state.js";

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
  const resolvePath = vi.fn(async (raw: string) => ({ path: raw, canonical: raw }));
  const options: ScopePickerOptions = {
    cwd: "/cwd",
    targets: [],
    completionLabel: "Start restriction",
    signal: new AbortController().signal,
    isCurrent: () => true,
    discover: async () => ["/cwd/a file", "/cwd/b", "/cwd/other"],
    resolvePath,
    validate,
    ...overrides,
  };
  return { tui, options, validate, resolvePath, roles, zeroFrames, running: showScopePicker(ctx, options) };
}

const plain = (lines: readonly string[]) => stripVTControlCharacters(lines.join("\n"));

test("picker mouse placement uses the masked search geometry and retains raw path input", async () => {
  const { tui, running, resolvePath } = setup({}, { "tui.select.confirm": "f3" });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send("\x1b[200~./a\u202eb\x1b[201~");
  const row = tui.render().findIndex((line) => line.startsWith("> "));
  tui.mouse({ type: "press", x: 6, y: row });
  tui.type("X");
  tui.send("\x1bOR");
  await tui.waitForPending();
  tui.send("\x03");
  await running;
  expect(resolvePath).toHaveBeenCalledWith("./a\u202eXb", expect.any(AbortSignal));
});

test.each([
  ["~/src/another_project/AGENTS.md", "/home/fixture/src/another_project/AGENTS.md"],
  ["~/.plan/PLAN_A.md", "/home/fixture/.plan/PLAN_A.md"],
  ["/home/narumi/.config/PLAN_B.md", "/home/narumi/.config/PLAN_B.md"],
  ["/home/narumi/.config/atuin/config.toml", "/home/narumi/.config/atuin/config.toml"],
  ["../shared/a file.md", "/shared/a file.md"],
  ["file:///outside/a%20file.md", "/outside/a file.md"],
])("explicitly adds %s as checked without resolving keystrokes or applying early", async (raw, path) => {
  const prior = { path: "/cwd/b", canonical: "/cwd/b" };
  const target = { path, canonical: path };
  const resolvePath = vi.fn(async () => target);
  const validate = vi.fn(async (paths: readonly string[], _signal: AbortSignal, _added: readonly (typeof target)[]) =>
    paths.map((value) => ({ path: value, canonical: value })),
  );
  const { tui, running, options } = setup({ targets: [prior], resolvePath, validate });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send(`\x1b[200~${raw}\x1b[201~`);
  expect(plain(tui.render())).toContain(`Add file: ${displayPath(raw)}`);
  expect(resolvePath).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(resolvePath).toHaveBeenCalledWith(raw, expect.any(AbortSignal));
  expect(plain(tui.render())).toContain(`→ [x] ${displayPath(path)}`);
  expect(plain(tui.render())).toContain("2 selected");
  expect(plain(tui.render())).toContain("Outside the current directory");
  expect(plain(tui.render())).not.toContain(`> ${raw}`);
  expect(options.targets).toEqual([prior]);
  expect(validate).not.toHaveBeenCalled();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "selected" } });
  expect(validate).toHaveBeenCalledWith([prior.path, path], expect.any(AbortSignal), [target]);
});

test.each([
  ["/outside/file", "/cwd/archive/outside/file"],
  ["/cwd/b", "/cwd/b"],
])("path input %s focuses Add rather than an exact or substring file match", async (raw, match) => {
  const { tui, running, resolvePath, validate } = setup({ discover: async () => [match] });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type(raw);
  const before = plain(tui.render());
  expect(before).toContain(`→ Add file: ${displayPath(raw)}`);
  expect(before).not.toContain("Start restriction");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(resolvePath).toHaveBeenCalledWith(raw, expect.any(AbortSignal));
  expect(plain(tui.render())).toContain(`→ [x] ${displayPath(raw)}`);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual([raw]);
});

test("a path typed during discovery remains the focused Add action when scanning finishes", async () => {
  const scan = Promise.withResolvers<string[]>();
  const { tui, running, resolvePath } = setup({ discover: async () => scan.promise });
  await tui.waitForOpen();
  tui.type("/outside/file");
  tui.press("tui.select.confirm");
  expect(resolvePath).not.toHaveBeenCalled();
  scan.resolve(["/cwd/archive/outside/file"]);
  await tui.waitForPending();
  expect(plain(tui.render())).toContain('→ Add file: "/outside/file"');
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(resolvePath).toHaveBeenCalledOnce();
  tui.send("\x03");
  await running;
});

test("manual action and redirected-path previews retain frame bounds and escaped identities", async () => {
  const path = `/outside/${"a  終".repeat(30)}\u202e\u00a0`;
  const canonical = `/physical/${"b  終".repeat(30)}\u202e\u00a0`;
  const { tui, running } = setup({ discover: async () => [], resolvePath: async () => ({ path, canonical }) });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("/outside/input");
  for (const rows of [4, 8, 32])
    for (const width of [1, 2, 8, 40, 100]) {
      const frame = tui.resize({ rows, width });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  tui.resize({ rows: 40, width: 100 });
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  const full = plain(tui.resize({ rows: 40, width: 240 }));
  expect(full).toContain(`Canonical target: ${displayPath(canonical)}`);
  expect(full).not.toContain("\u202e");
  for (const rows of [4, 8, 32])
    for (const width of [1, 2, 8, 40, 100]) {
      const frame = tui.resize({ rows, width });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  tui.invalidate();
  tui.send("\x03");
  await running;
});

test("failed add retains its input and checked draft, and correction works in the same picker", async () => {
  const resolvePath = vi
    .fn()
    .mockRejectedValueOnce(new Error("Not an existing regular file"))
    .mockResolvedValueOnce({ path: "/outside/fixed", canonical: "/outside/fixed" });
  const { tui, running } = setup({ targets: [{ path: "/cwd/b", canonical: "/cwd/b" }], resolvePath });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("/outside/bad");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("> /outside/bad");
  expect(plain(tui.render())).toContain("Not an existing regular file");
  expect(plain(tui.render())).toContain("1 selected");
  tui.send("\x15");
  tui.type("/outside/fixed");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain('[x] "/cwd/b"');
  expect(plain(tui.render())).toContain('[x] "/outside/fixed"');
  tui.send("\x03");
  await running;
});

test("duplicate normalized paths stay checked once and expose pinned canonical metadata", async () => {
  const target = { path: "/outside/alias", canonical: "/physical/file" };
  const resolvePath = vi.fn(async () => target);
  const validate = vi.fn(
    async (_paths: readonly string[], _signal: AbortSignal, added: readonly (typeof target)[]) => added,
  );
  const { tui, running } = setup({ discover: async () => [], resolvePath, validate });
  await tui.waitForOpen();
  await tui.waitForPending();
  for (const raw of ["/outside/alias", "file:///outside/alias"]) {
    tui.type(raw);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    expect(plain(tui.render())).toContain("1 selected");
    expect(plain(tui.render())).toContain(`Canonical target: ${displayPath(target.canonical)}`);
    expect(plain(tui.render()).match(/\[x\]/gu)).toHaveLength(1);
  }
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await running;
  expect(validate).toHaveBeenCalledWith([target.path], expect.any(AbortSignal), [target]);
});

test("manual paths are bounded without dropping the draft, and an existing entry still works at the cap", async () => {
  const { tui, running, validate } = setup({
    discover: async () => [],
    resolvePath: async (raw) => ({ path: raw.replace("file://", ""), canonical: raw.replace("file://", "") }),
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  for (let index = 0; index < MAX_TARGETS; index += 1) {
    tui.type(`/outside/file-${index}`);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
  }
  tui.type("/outside/too-many");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain(`Add no more than ${MAX_TARGETS}`);
  expect(plain(tui.render())).toContain("> /outside/too-many");
  expect(plain(tui.render())).toContain(`${MAX_TARGETS} selected`);
  tui.send("\x15");
  tui.type(`file:///outside/file-${MAX_TARGETS - 1}`);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain(`${MAX_TARGETS} selected`);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toHaveLength(MAX_TARGETS);
});

test("manual resolution respects remapped confirmation and leaves pasted controls as data", async () => {
  const raw = "/outside/a\x1b]52;c;bad\x07\u202e\u00a0 file";
  const target = { path: raw, canonical: raw };
  const resolvePath = vi.fn(async () => target);
  const { tui, running } = setup(
    { discover: async () => [], resolvePath },
    { "tui.select.confirm": "f2", "tui.select.cancel": "q" },
  );
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send(`\x1b[200~${raw}\x1b[201~`);
  tui.send("\r");
  expect(resolvePath).not.toHaveBeenCalled();
  const before = plain(tui.render());
  expect(before).toContain(`Add file: ${displayPath(raw)}`);
  expect(before).not.toContain("\u202e");
  tui.send("\x1bOQ"); // The harness press helper uses default Enter bytes, not remapped keys.
  await tui.waitForPending();
  expect(resolvePath).toHaveBeenCalledWith(raw, expect.any(AbortSignal));
  expect(plain(tui.render())).toContain(`Path: ${displayPath(raw)}`);
  tui.send("\x03");
  await running;
});

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

test("paste begun during a manual lookup cannot cancel it or replace the path draft", async () => {
  const started = Promise.withResolvers<void>();
  const resolution = Promise.withResolvers<{ path: string; canonical: string }>();
  let signal: AbortSignal | undefined;
  const { tui, running } = setup({
    resolvePath: async (_raw, operation) => {
      signal = operation;
      started.resolve();
      return resolution.promise;
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("/outside/file");
  tui.press("tui.select.confirm");
  await started.promise;
  tui.send("\x1b[200~");
  tui.send("\x03");
  tui.send("\r");
  expect(signal?.aborted).toBe(false);
  resolution.reject(new Error("Correct the path"));
  await tui.waitForPending();
  tui.send("ignored\x1b[201~");
  expect(plain(tui.render())).toContain("> /outside/file");
  expect(plain(tui.render())).not.toContain("> /outside/fileignored");
  tui.send("\x03");
  await running;
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

for (const stage of ["scan", "validation", "path"] as const) {
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
          : stage === "path"
            ? {
                resolvePath: async (_raw: string, signal: AbortSignal) => {
                  await blocked(signal);
                  return { path: "/outside/file", canonical: "/outside/file" };
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
      if (stage !== "scan") {
        await tui.waitForPending();
        if (stage === "path") tui.type("/outside/file");
        else tui.press("tui.select.up");
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

test.each(["scan", "validation", "path"] as const)(
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
        : stage === "path"
          ? {
              resolvePath: async () => {
                await block();
                return { path: "/outside/file", canonical: "/outside/file" };
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
    if (stage !== "scan") {
      await tui.waitForPending();
      if (stage === "path") tui.type("/outside/file");
      else tui.press("tui.select.up");
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
      resolvePath: async (raw) => ({ path: raw, canonical: raw }),
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
