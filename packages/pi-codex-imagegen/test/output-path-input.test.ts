import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  getKeybindings,
  Input,
  isFocusable,
  type KeybindingsConfig,
  KeybindingsManager,
  renderFakeCursor,
  setKeybindings,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showImagegenOutputPath } from "../src/output-path-input.js";

const originalKeys = getKeybindings();
beforeEach(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => {
  setKeybindings(originalKeys);
  vi.restoreAllMocks();
});
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters).join("\n");
function fixture() {
  const controller = new AbortController();
  let current = true;
  return {
    owner: { signal: controller.signal, isCurrent: () => current },
    controller,
    replace: () => {
      current = false;
    },
  };
}

it.each(["relative/name", "/absolute/name", "~/name", "@~/name", " $(echo x);*.raw ", "   ", "界/image"])(
  "submits the exact raw path without a generated name or extension: %j",
  async (path) => {
    const tui = createTuiHarness();
    const { owner } = fixture();
    const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showImagegenOutputPath(ctx, owner);
    await tui.waitForOpen();
    const initial = plain(tui.render());
    tui.type(path);
    tui.send("\r");
    expect(await running).toEqual({ kind: "submitted", path });
    expect(initial).toContain("Existing files are overwritten. Symlinks are followed.");
    expect(initial).toContain("generation request's working directory");
    expect(initial).not.toMatch(/\.png|\.jpg/);
  },
);

it("keeps an empty submission open with a safe required-path error, then accepts an exact path", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.send("\r");
  const open = tui.isOpen;
  const frame = plain(tui.render());
  tui.type("no-extension");
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", path: "no-extension" });
  expect(open).toBe(true);
  expect(frame).toContain("An output path is required.");
  expect(notifications).toEqual([]);
});

it("preserves native editing, paste cleanup, split-paste shortcuts and raw display controls", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.deleteCharBackward": "ctrl+h",
    "tui.input.submit": "ctrl+t",
    "tui.select.cancel": "ctrl+q",
  });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys, width: 100 });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("ab");
  tui.send("\x08");
  tui.send("\x1b[D");
  tui.type("X");
  tui.send("\x1b[F");
  tui.send("\x1b[200~");
  tui.send("\x11"); // A cancel key inside native paste is data, not navigation.
  tui.send("\x14"); // A submit key inside native paste is data, not submission.
  tui.send("\x1b[201~");
  tui.send("\x1b[200~b\r\nc\td\u202e\x1b]0;unsafe\x07\x1b[201~");
  const frame = tui.render();
  tui.send("\x14");
  expect(await running).toEqual({ kind: "submitted", path: "Xa\x11\x14bc    d\u202e\x1b]0;unsafe\x07" });
  expect(frame.join("")).not.toContain("\u202e");
  expect(frame.join("")).not.toContain("\x1b]0;unsafe");
  expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
});

it.each([
  { name: "return alias", config: { "tui.input.submit": "return" }, raw: "\r", kind: "submitted" },
  { name: "modifier order", config: { "tui.select.cancel": "alt+ctrl+x" }, raw: "\x1b\x18", kind: "back" },
  { name: "Kitty modifiers", config: { "tui.select.cancel": "ctrl+alt+x" }, raw: "\x1b[120;7u", kind: "back" },
  { name: "legacy Ctrl+M collision", config: { "tui.select.cancel": "ctrl+m" }, raw: "\r", kind: "back" },
  {
    name: "cancel precedes editing",
    config: { "tui.select.cancel": "ctrl+h", "tui.editor.deleteCharBackward": "ctrl+h" },
    raw: "\x08",
    kind: "back",
  },
  { name: "invalid configured string", config: { "tui.select.cancel": "not+a+key" }, raw: "\r", kind: "submitted" },
  {
    name: "first usable fallback",
    config: { "tui.select.cancel": ["not+a+key", "ctrl+q"] },
    raw: "\x11",
    kind: "back",
  },
  {
    name: "hard cancel despite remapping",
    config: { "tui.select.cancel": "ctrl+q", "tui.input.submit": "ctrl+c" },
    raw: "\x03",
    kind: "close",
  },
  {
    name: "editor submit instead of select confirm",
    config: { "tui.select.confirm": "ctrl+y", "tui.input.submit": "ctrl+t" },
    raw: "\x14",
    kind: "submitted",
  },
])("uses native effective keys for $name", async ({ config, raw, kind }) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, config as KeybindingsConfig);
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.type("exact path");
  tui.send(raw);
  expect(await running).toEqual(kind === "submitted" ? { kind, path: "exact path" } : { kind });
});

it("forwards focus and keeps zero, narrow, short and resized frames bounded", async () => {
  const roles: string[] = [];
  const tui = createTuiHarness({
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const { owner } = fixture();
  let zeroWidth: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, keys, done) => {
      const component = await factory(host, theme, keys, done);
      zeroWidth = component.render(0);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.type("界".repeat(50));
  tui.setFocused(true);
  const frames: { width: number; rows: number; frame: readonly string[] }[] = [];
  for (const width of [1, 3, 40, 100])
    for (const rows of [4, 7, 12, 24]) {
      const frame = tui.resize({ width, rows });
      frames.push({ width, rows, frame });
      tui.invalidate();
      frames.push({ width, rows, frame: tui.render() });
    }
  const focused = tui.resize({ width: 100, rows: 24 });
  tui.setFocused(false);
  const unfocused = tui.render();
  tui.press("ctrl+c");
  expect(await running).toEqual({ kind: "close" });
  expect(zeroWidth.every((line) => visibleWidth(line) === 0)).toBe(true);
  for (const { width, rows, frame } of frames) {
    expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
    expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (rows - 3 >= 5 && width > 0) {
      expect(frame[0]).toBe("─".repeat(width));
      expect(frame.at(-1)).toBe(frame[0]);
    }
    if (width > 2) expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  }
  expect(focused.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  expect(unfocused.some((line) => line.includes(CURSOR_MARKER))).toBe(false);
  expect(roles).toEqual(expect.arrayContaining(["border", "muted", "warning"]));
});

it("retains native Input mouse geometry across press, release and synthesized click without rendering", async () => {
  const tui = createTuiHarness({ width: 80 });
  const { owner } = fixture();
  let component!: Component;
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, keys, done) => {
      component = await factory(host, theme, keys, done);
      return component;
    });
  const nativeMouse = vi.spyOn(Input.prototype, "handleMouse");
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("abcdef");
  const frame = tui.render();
  const y = frame.findIndex((line) => line.includes(CURSOR_MARKER));
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  const border = component.handleMouse?.({ ...event, y: 0 });
  const press = component.handleMouse?.(event);
  const release = component.handleMouse?.({ ...event, type: "release" });
  const click = component.handleMouse?.({ ...event, type: "click", clickCount: 1 });
  tui.type("X");
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", path: "abXcdef" });
  expect(border).toBeUndefined();
  expect(press).toMatchObject({ handled: true, focus: true });
  expect(release).toBeUndefined();
  expect(click).toBeUndefined();
  expect(nativeMouse.mock.calls.map(([event]) => [event.type, event.y, event.height])).toEqual([
    ["press", 0, 1],
    ["release", 0, 1],
    ["click", 0, 1],
  ]);
});

it.each(["abort", "dispose", "replacement"])("releases the dialog and cannot submit after %s", async (method) => {
  const tui = createTuiHarness();
  const { owner, controller, replace } = fixture();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenOutputPath(ctx, owner);
  await tui.waitForOpen();
  tui.type("never write");
  if (method === "abort") controller.abort();
  else if (method === "dispose") tui.dispose();
  else {
    replace();
    tui.send("\r");
  }
  expect(await running).toEqual({ kind: "stale" });
  const renders = tui.requestRenderCount;
  tui.send("\r");
  expect(tui.isOpen).toBe(false);
  expect(tui.requestRenderCount).toBe(renders);
  expect(notifications).toEqual([]);
});

it.each([
  { name: "known cursor metadata", attack: `${CURSOR_MARKER.repeat(2)}${renderFakeCursor("FORGED")}${CURSOR_MARKER}` },
  {
    name: "unknown APC prefix with real terminal controls",
    attack: "\x1b_pi:unknown\x07\x1b]52;c;Y2xpcA==\x07\x1b]0;foreign-title\x07\x1b[2J\x1b[999;999H",
  },
])("sanitizes $name in the path callback without changing submission", async ({ attack }) => {
  const [fakeStart = "", fakeEnd = ""] = renderFakeCursor("CELL").split("CELL");
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+t" });
  setKeybindings(keys);
  const tui = createTuiHarness({
    keybindings: keys,
    theme: { fg: (_role, text) => `\x1b[36m${text}\x1b[39m`, bold: (text) => text },
  });
  const path = `left${attack}right`;
  const frames: { width: number; focused: boolean; lines: string[] }[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      component.handleInput?.(`\x1b[200~${path}\x1b[201~`);
      for (const focused of [true, false]) {
        if (isFocusable(component)) component.focused = focused;
        for (const width of [0, 1, 3, 8, 400]) frames.push({ width, focused, lines: component.render(width) });
      }
      if (isFocusable(component)) component.focused = true;
      // Put the cursor directly after the attack, including adjacent forged markers.
      for (let index = 0; index < "right".length; index++) component.handleInput?.("\x1b[D");
      frames.push({ width: 400, focused: true, lines: component.render(400) });
      component.handleInput?.("\x14");
      return component;
    });
  const { ctx, notifications } = createMockContext({ mode: "tui", custom });
  const result = await showImagegenOutputPath(ctx, fixture().owner);
  expect(result).toEqual({ kind: "submitted", path });
  expect(notifications).toEqual([]);
  expect(frames).toHaveLength(11);
  for (const { width, focused, lines } of frames) {
    const frame = lines.join("");
    const hasCursor = width > 2;
    expect(frame.split(CURSOR_MARKER).length - 1).toBe(Number(focused && hasCursor));
    expect(frame.split(fakeStart).length - 1).toBe(Number(hasCursor));
    expect(frame.split(fakeEnd).length - 1).toBe(Number(hasCursor));
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    // Trusted frame theme SGR is allowed; no draft controls or foreign metadata are.
    expect(
      frame
        .replaceAll(CURSOR_MARKER, "")
        .replaceAll(fakeStart, "")
        .replaceAll(fakeEnd, "")
        .replaceAll("\x1b[36m", "")
        .replaceAll("\x1b[39m", "")
        .replaceAll("\x1b[0m", ""),
    ).not.toMatch(/\p{Cc}|\p{Bidi_Control}/u);
    if (width === 400) expect(frame).toContain("\x1b[36m");
  }
});

it("keeps the path hardware cursor and fake cell at the native position after editing", async () => {
  const tui = createTuiHarness();
  let frame: string[] = [];
  let reference: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      const native = new Input();
      if (isFocusable(component)) component.focused = true;
      native.focused = true;
      for (const data of ["ab界e\u0301🙂z", "\x1b[D", "\x1b[D", "Q", "\x7f"]) {
        component.handleInput?.(data);
        native.handleInput(data);
      }
      frame = component.render(80);
      reference = native.render(80);
      component.handleInput?.("\r");
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  expect(await showImagegenOutputPath(ctx, fixture().owner)).toEqual({ kind: "submitted", path: "ab界e\u0301🙂z" });
  const cursor = frame.find((line) => line.includes(CURSOR_MARKER)) ?? "";
  expect(cursor).toBe(reference[0]);
  expect(cursor).toContain(`${CURSOR_MARKER}${renderFakeCursor("🙂")}`);
  expect(visibleWidth(cursor.slice(0, cursor.indexOf(CURSOR_MARKER)))).toBe(7);
});

it.each(["rpc", "print", "json"] as const)("does not open a native dialog in %s", async (mode) => {
  const tui = createTuiHarness();
  const { ctx } = createMockContext({ mode, custom: tui.custom });
  expect(await showImagegenOutputPath(ctx, fixture().owner)).toEqual({ kind: "stale" });
  expect(tui.openCount).toBe(0);
});
