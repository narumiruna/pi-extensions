import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  Input,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { displayPath } from "../src/scope/display.js";
import { ScopeInput, showScopePathInput } from "../src/scope/input.js";
import * as paths from "../src/scope/paths.js";
import { exactRows } from "../src/scope/ui.js";

const originalKeys = getKeybindings();
beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(() => {
  setKeybindings(originalKeys);
  vi.restoreAllMocks();
});

function harness(bindings: KeybindingsConfig = {}) {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keys);
  const roles = new Set<string>();
  const zeroFrames: string[][] = [];
  const tui = createTuiHarness({
    width: 90,
    rows: 30,
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
  return { tui, ctx, roles, zeroFrames };
}

test("ScopeInput preserves native editing, newline, submission, and paste semantics", () => {
  const adapted = new ScopeInput();
  const native = new Input();
  const actual: string[] = [];
  const expected: string[] = [];
  adapted.input.onSubmit = (value) => actual.push(value);
  native.onSubmit = (value) => expected.push(value);
  for (const data of [
    "one",
    " ",
    "two",
    "\x7f",
    "o",
    "\x1b[D",
    "X",
    "\x01",
    "A",
    "\x05",
    "\x1b[200~ b\nc\t d\x1b[201~",
    "\x1b[13;2u",
    "\n",
    "\r",
  ]) {
    adapted.handleInput(data, () => false);
    native.handleInput(data);
    expect(adapted.input.getValue()).toBe(native.getValue());
    adapted.render(40);
    native.render(40);
    expect(adapted.input.getValue()).toBe(native.getValue());
  }
  expect(actual).toEqual(expected);
  expect(actual).not.toHaveLength(0);
});

test("paste fragments cannot become screen actions, including a split terminator", () => {
  const editor = new ScopeInput();
  const actions: string[] = [];
  const action = (data: string) => {
    actions.push(data);
    return false;
  };
  for (const data of ["\x1b[200~", " a ", "\x03", "\r", "\x1b[20", "1~", " "]) editor.handleInput(data, action);
  expect(editor.input.getValue()).toBe(" a \x03 ");
  expect(actions).toEqual([" "]);
  editor.handleInput("\x1b[200~b\x1b[201~\x03", action);
  expect(actions).toEqual([" ", "\x03"]);
});

test("display masking never changes the raw draft or exposes terminal/bidi controls", () => {
  const editor = new ScopeInput();
  editor.input.focused = true;
  editor.handleInput("\x1b[200~/a\x1b]52;c;bad\x07/\u202e\u00a0b\x1b[201~", () => false);
  const raw = editor.input.getValue();
  const lines = editor.render(90);
  expect(lines.join("")).toContain(CURSOR_MARKER);
  expect(lines.join("")).not.toContain("\x1b]52;");
  expect(lines.join("")).not.toContain("\u202e");
  expect(editor.input.getValue()).toBe(raw);
  expect(displayPath(raw)).toContain("\\u001b]52;c;bad\\u0007");
  expect(displayPath(raw)).toContain("\\u202e\\u00a0");
  const exact = displayPath(" /a  b\\\n\t終 ");
  expect(exactRows(exact, 9).join("")).toBe(exact);
});

test.each([
  ["bidi", "a\u202eb"],
  ["joiner", "a\u200db"],
  ["emoji-joiner", "a👨\u200d👩b"],
  ["astral-format", "a\u{e0001}b"],
  ["C0", "a\x07b"],
  ["C1", "a\x9bb"],
  ["line-separator", "a\u2028b"],
  ["paragraph-separator", "a\u2029b"],
])("masked %s pointer positions match native visible input, including horizontal scrolling", (_name, raw) => {
  for (const width of [5, 9, 24]) {
    for (const x of [0, 2, 3, 4, 6, 20]) {
      const editor = new ScopeInput();
      const native = new Input();
      editor.handleInput(`\x1b[200~prefix-${raw}-suffix\x1b[201~`, () => false);
      const draft = editor.input.getValue();
      const masked = draft.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => "�".repeat(character.length));
      native.handleInput(`\x1b[200~${masked}\x1b[201~`);
      editor.render(width);
      native.render(width);
      const event: TuiMouseEvent = {
        type: "press",
        button: "left",
        x,
        y: 0,
        screenX: x,
        screenY: 0,
        width,
        height: 1,
        shift: false,
        alt: false,
        ctrl: false,
      };
      expect(editor.handleMouse(event)).toEqual(native.handleMouse(event));
      expect(editor.input.getValue()).toBe(draft);
      editor.handleInput("!", () => false);
      native.handleInput("!");
      const position = native.getValue().indexOf("!");
      expect(editor.input.getValue()).toBe(`${draft.slice(0, position)}!${draft.slice(position)}`);
    }
  }
});

test("mouse failure restores the raw masked-input draft", () => {
  const editor = new ScopeInput();
  editor.input.setValue("a\u202eb");
  vi.spyOn(editor.input, "handleMouse").mockImplementation(() => {
    throw new Error("mouse failure");
  });
  expect(() => editor.handleMouse({} as TuiMouseEvent)).toThrow("mouse failure");
  expect(editor.input.getValue()).toBe("a\u202eb");
});

test("new-path mouse placement matches masked text without changing the submitted raw draft", async () => {
  const validator = vi.spyOn(paths, "resolveScopeTarget").mockRejectedValue(new Error("Keep draft"));
  const { tui, ctx } = harness({ "tui.input.submit": "f2" });
  const running = showScopePathInput(ctx, {
    cwd: tmpdir(),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await tui.waitForOpen();
  tui.send("\x1b[200~a\u202eb\x1b[201~");
  const row = tui.render().findIndex((line) => line.startsWith("> "));
  tui.mouse({ type: "press", x: 4, y: row });
  tui.type("X");
  tui.send("\x1bOQ");
  await tui.waitForPending();
  tui.send("\x03");
  await running;
  expect(validator).toHaveBeenCalledWith("a\u202eXb", tmpdir(), "new", expect.any(AbortSignal));
});

test("new-path rejection retains the draft, allows correction, and creates no target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scope-input-"));
  try {
    await writeFile(join(cwd, "exists"), "");
    const { tui, ctx } = harness();
    const running = showScopePathInput(ctx, { cwd, signal: new AbortController().signal, isCurrent: () => true });
    await tui.waitForOpen();
    tui.setFocused(true);
    tui.type("exists");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    const rejected = stripVTControlCharacters(tui.render().join("\n"));
    expect(rejected).toContain('Draft: "exists"');
    expect(rejected).toContain("already exists");
    tui.send("\x15");
    tui.type("new file");
    tui.press("tui.input.submit");
    const result = await running;
    expect(result).toMatchObject({
      kind: "completed",
      value: { kind: "selected", target: { path: join(cwd, "new file") } },
    });
    await expect(import("node:fs/promises").then((fs) => fs.stat(join(cwd, "new file")))).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("path input uses input.submit, not select.confirm; bounds, focus, theme, and mouse survive resize", async () => {
  const { tui, ctx, roles, zeroFrames } = harness({
    "tui.input.submit": "f2",
    "tui.select.confirm": "f3",
    "tui.select.cancel": "q",
  });
  const validator = vi.spyOn(paths, "resolveScopeTarget").mockRejectedValue(new Error("Rejected draft"));
  const owner = new AbortController();
  const running = showScopePathInput(ctx, { cwd: tmpdir(), signal: owner.signal, isCurrent: () => true });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("scope-not-created");
  tui.send("\x1bOR");
  expect(tui.isOpen).toBe(true);
  expect(tui.render().join("")).toContain(CURSOR_MARKER);
  expect(tui.render().join("")).not.toMatch(/f[23] (submit|confirm)/u);
  for (const rows of [4, 7, 8, 18, 30]) {
    for (const width of [1, 2, 8, 40, 90]) {
      const frame = tui.resize({ rows, width });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  }
  tui.resize({ width: 90, rows: 30 });
  tui.invalidate();
  const inputRow = tui.render().findIndex((line) => line.startsWith("> "));
  tui.mouse({ type: "press", x: 2, y: inputRow });
  tui.type("X");
  expect(stripVTControlCharacters(tui.render().join("\n"))).toContain('Draft: "Xscope-not-created"');
  expect(validator).not.toHaveBeenCalled();
  tui.send("\x1bOQ");
  await tui.waitForPending();
  expect(validator).toHaveBeenCalledWith("Xscope-not-created", tmpdir(), "new", expect.any(AbortSignal));
  expect(stripVTControlCharacters(tui.render().join("\n"))).toContain("Rejected draft");
  tui.send("\x03");
  expect(await running).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
  expect(zeroFrames).toHaveLength(1);
  expect(zeroFrames.flat().every((line) => visibleWidth(line) === 0)).toBe(true);
  expect(roles.has("border")).toBe(true);
  expect(roles.has("muted")).toBe(true);
});

for (const ending of ["back", "close", "dispose", "owner"] as const) {
  test(`path validation aborts and drains owned I/O on ${ending}`, async () => {
    let release!: (value: paths.ResolvedScopeTarget) => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(paths, "resolveScopeTarget").mockImplementation((_raw, _cwd, _requirement, signal) => {
      observedSignal = signal;
      ready();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const { tui, ctx } = harness();
    const owner = new AbortController();
    const running = showScopePathInput(ctx, { cwd: tmpdir(), signal: owner.signal, isCurrent: () => true });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    tui.type("new");
    tui.press("tui.input.submit");
    await started;
    // Input remains frozen while an accepted validation is pending.
    tui.send("\x1b[200~other\x1b[201~");
    if (ending === "dispose") tui.dispose();
    else if (ending === "owner") owner.abort();
    else tui.send(ending === "close" ? "\x03" : "\x1b");
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    release({ path: "/new", canonical: "/new", exists: false });
    const result = await running;
    expect(result).toEqual(
      ending === "owner" || ending === "dispose"
        ? { kind: "stale" }
        : {
            kind: "completed",
            value: { kind: "cancelled", reason: ending },
          },
    );
  });
}

test("paste started during validation is discarded as text, never treated as cancellation", async () => {
  let reject!: (error: Error) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let signal: AbortSignal | undefined;
  vi.spyOn(paths, "resolveScopeTarget").mockImplementation((_raw, _cwd, _requirement, operation) => {
    signal = operation;
    ready();
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const { tui, ctx } = harness();
  const running = showScopePathInput(ctx, {
    cwd: tmpdir(),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await tui.waitForOpen();
  tui.type("new-file");
  tui.press("tui.input.submit");
  await started;
  tui.send("\x1b[200~");
  tui.send("\x03");
  tui.send("\r");
  expect(signal?.aborted).toBe(false);
  reject(new Error("Try another path"));
  await tui.waitForPending();
  tui.send("discarded\x1b[201~");
  expect(stripVTControlCharacters(tui.render().join("\n"))).toContain('Draft: "new-file"');
  tui.type("X");
  expect(stripVTControlCharacters(tui.render().join("\n"))).toContain('Draft: "new-fileX"');
  tui.send("\x03");
  expect(await running).toEqual({ kind: "completed", value: { kind: "cancelled", reason: "close" } });
});

test("ownership changes detected after validation settle the input as stale without a second signal", async () => {
  let release!: (target: paths.ResolvedScopeTarget) => void;
  vi.spyOn(paths, "resolveScopeTarget").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { tui, ctx } = harness();
  let current = true;
  const running = showScopePathInput(ctx, {
    cwd: tmpdir(),
    signal: new AbortController().signal,
    isCurrent: () => current,
  });
  await tui.waitForOpen();
  tui.type("new");
  tui.press("tui.input.submit");
  current = false;
  release({ path: "/new", canonical: "/new", exists: false });
  expect(await running).toEqual({ kind: "stale" });
  expect(tui.isOpen).toBe(false);
});

test.each(["rpc", "json", "print"] as const)("path input does not attempt custom UI in %s", async (mode) => {
  const custom = vi.fn();
  const ctx = { mode, hasUI: mode === "rpc", ui: { custom } } as unknown as ExtensionCommandContext;
  expect(
    await showScopePathInput(ctx, { cwd: "/", signal: new AbortController().signal, isCurrent: () => true }),
  ).toEqual({ kind: "unsupported", mode });
  expect(custom).not.toHaveBeenCalled();
});
