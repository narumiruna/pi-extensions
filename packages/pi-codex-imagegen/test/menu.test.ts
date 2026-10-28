import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
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
import { type ImagegenMenuOwner, showImagegenMenu } from "../src/menu.js";
import { showImagegenPrompt } from "../src/prompt-editor.js";

const originalKeys = getKeybindings();
beforeEach(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => setKeybindings(originalKeys));
function fixture() {
  const controller = new AbortController();
  let current = true;
  let settings = { toolEnabled: false, transparentBackground: false };
  const owner: ImagegenMenuOwner = {
    signal: controller.signal,
    isCurrent: () => current,
    getSettings: () => ({ ...settings }),
    settingsPath: "/tmp/\x1b[2Jsettings.json",
    getAuthStatus: vi.fn(() => "Pi OAuth metadata present (not verified)"),
    isBusy: () => false,
    saveSettings: vi.fn(async (patch) => {
      settings = { ...settings, ...patch };
    }),
    generate: vi.fn(async () => {}),
  };
  return {
    owner,
    controller,
    replace: () => {
      current = false;
      controller.abort();
    },
  };
}
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters).join("\n");
async function opened(tui: ReturnType<typeof createTuiHarness>, count: number) {
  await vi.waitFor(() => expect(tui.openCount).toBe(count));
}

it("uses one Kit navigator for actions, status and help without resolving authentication", async () => {
  const tui = createTuiHarness();
  const { ctx } = createMockContext({
    mode: "tui",
    custom: tui.custom,
    modelRegistry: new Proxy(
      {},
      {
        get() {
          throw new Error("auth resolution forbidden");
        },
      },
    ),
  });
  const { owner } = fixture();
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  const main = plain(tui.render());
  expect(main).toMatch(/Generate Image[\s\S]*Settings[\s\S]*Status[\s\S]*Help/);
  expect(main).toContain("Codex internal image endpoint");
  expect(main).not.toMatch(/experimental/i);
  expect(owner.getAuthStatus).not.toHaveBeenCalled();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  const status = plain(tui.render());
  expect(status).toMatch(/metadata present/);
  expect(status).toContain("Endpoint: ChatGPT/Codex internal image API");
  expect(status).not.toMatch(/experimental/i);
  expect(status).toMatch(/not verify account entitlement/);
  expect(status).toMatch(/Tool access: disabled/);
  expect(status).toContain("Each generation requires an output path.");
  expect(status).not.toMatch(/Output directory|outputDir/);
  expect(status).not.toContain("injected");
  expect(tui.render().join("")).not.toContain("\x1b[2J");
  tui.press("tui.select.cancel");
  await opened(tui, 3);
  // Kit retains the Status selection on Back.
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 4);
  expect(plain(tui.render())).toMatch(/quota refund/);
  tui.press("ctrl+c");
  await running;
  expect(owner.generate).not.toHaveBeenCalled();
  expect(owner.saveSettings).not.toHaveBeenCalled();
});

it("closes root before standalone Settings, then reopens root on Back", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  expect(plain(tui.render())).toMatch(/Image Generation Settings/);
  tui.press("tui.select.cancel");
  await opened(tui, 3);
  expect(plain(tui.render())).toMatch(/Generate Image/);
  tui.press("ctrl+c");
  await running;
});

it("preserves native editing, multiline paste expansion, focused cursor and bounded prompt frames", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.deleteCharBackward": "ctrl+h",
    "tui.select.cancel": "ctrl+q",
  });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  let zeroWidth: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      zeroWidth = component.render(0);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  expect(zeroWidth.every((line) => visibleWidth(line) === 0)).toBe(true);
  tui.type("ab");
  tui.send("\x08");
  tui.send("\x0a");
  const pasted = "wide 界\n".repeat(30);
  tui.send(`\x1b[200~${pasted}\x1b[201~`);
  expect(plain(tui.render())).toMatch(/paste #/);
  for (const width of [1, 8, 80])
    for (const rows of [4, 7, 24]) {
      const frame = tui.resize({ width, rows });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  const frame = tui.resize({ width: 80, rows: 24 });
  expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  tui.invalidate();
  expect(tui.render()).toEqual(frame);
  // External-editor launch is unavailable; no unreachable native hint is shown.
  expect(plain(frame)).not.toMatch(/external editor/i);
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: `a\n${pasted}`.trim() });
});

it("clips wide prompt graphemes safely at zero and narrow widths", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  let component!: Component;
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      component = await factory(host, theme, bindings, done);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("界🙂");
  expect(component.render(0).every((line) => visibleWidth(line) === 0)).toBe(true);
  for (const width of [1, 2, 3]) {
    const frame = tui.resize({ width, rows: 7 });
    expect(frame.length).toBeLessThanOrEqual(4);
    expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  tui.resize({ width: 80, rows: 24 });
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: "界🙂" });
});

it("positions the native editor cursor after press, release and synthesized click without another frame", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+t" });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys, width: 80 });
  const { owner } = fixture();
  let component!: Component;
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      component = await factory(host, theme, bindings, done);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send("\x1b[200~first line\nsecond line\x1b[201~");
  const frame = tui.render();
  const y = frame.findIndex((line) => stripVTControlCharacters(line).includes("first line"));
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width: 80,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  // Pi's selection fallback sends the click synchronously after the unhandled release.
  // Do not use tui.mouse(): the harness renders after each event and hides this regression.
  const press = component.handleMouse?.(event);
  const release = component.handleMouse?.({ ...event, type: "release" });
  const click = component.handleMouse?.({ ...event, type: "click", clickCount: 1 });
  tui.type("X");
  tui.send("\x14");
  expect(await running).toEqual({ kind: "submitted", prompt: "firXst line\nsecond line" });
  expect(press).toBeUndefined();
  expect(release).toBeUndefined();
  expect(click).toMatchObject({ handled: true, focus: true });
});

it.each(["ctrl+q", "ALT+CTRL+x"])("hard Ctrl+C cancels prompt even when selection cancel is %s", async (cancel) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": cancel } as KeybindingsConfig);
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("do not submit");
  tui.press("ctrl+c");
  expect(await running).toEqual({ kind: "close" });
});

it.each([
  { name: "return alias", config: { "tui.input.submit": "return" }, raw: "\r", kind: "submitted" },
  { name: "modifier order", config: { "tui.select.cancel": "alt+ctrl+x" }, raw: "\x1b\x18", kind: "back" },
  { name: "Kitty modifiers", config: { "tui.select.cancel": "ctrl+alt+x" }, raw: "\x1b[120;7u", kind: "back" },
  { name: "legacy Ctrl+M collision", config: { "tui.select.cancel": "ctrl+m" }, raw: "\r", kind: "back" },
  {
    name: "cancel wins over native delete",
    config: { "tui.select.cancel": "ctrl+h", "tui.editor.deleteCharBackward": "ctrl+h" },
    raw: "\x08",
    kind: "back",
  },
  {
    name: "invalid config leaves submission",
    config: { "tui.select.cancel": "not+a+key" },
    raw: "\r",
    kind: "submitted",
  },
  {
    name: "first usable configured fallback",
    config: { "tui.select.cancel": ["not+a+key", "ctrl+q"] },
    raw: "\x11",
    kind: "back",
  },
])("keeps native key matching for $name", async ({ config, raw, kind }) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, config as KeybindingsConfig);
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("native draft");
  tui.send(raw);
  expect(await running).toMatchObject({ kind });
});

it("suppresses external-editor launch without changing native draft or displaying its hint", async () => {
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.editor.external": { defaultKeys: "ctrl+g" } });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("native draft");
  tui.send("\x07");
  expect(plain(tui.render())).toContain("native draft");
  expect(plain(tui.render())).not.toMatch(/external editor/i);
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: "native draft" });
});

it("sanitizes bidirectional prompt display without changing the native submitted draft", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.send("\x1b[200~one\u202etwo\x1b[201~");
  expect(tui.render().join("")).not.toContain("\u202e");
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: "one\u202etwo" });
});

it.each([
  { name: "known cursor metadata", attack: `${CURSOR_MARKER.repeat(2)}${renderFakeCursor("FORGED")}${CURSOR_MARKER}` },
  {
    name: "unknown APC prefix with real terminal controls",
    attack: "\x1b_pi:unknown\x07\x1b]52;c;Y2xpcA==\x07\x1b]0;foreign-title\x07\x1b[2J\x1b[999;999H",
  },
])("sanitizes $name in the prompt callback without changing native submission", async ({ attack }) => {
  const [fakeStart = "", fakeEnd = ""] = renderFakeCursor("CELL").split("CELL");
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+t" });
  setKeybindings(keys);
  const tui = createTuiHarness({
    keybindings: keys,
    theme: { fg: (_role, text) => `\x1b[36m${text}\x1b[39m`, bold: (text) => text },
  });
  // Native Editor accepts a printable-leading input chunk verbatim. Native paste
  // has its own C0 filter, so do not change that behavior to exercise this boundary.
  const prompt = `left${attack}right`;
  const frames: { width: number; focused: boolean; lines: string[] }[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      component.handleInput?.(prompt);
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
  const result = await showImagegenPrompt(ctx, fixture().owner);
  expect(result).toEqual({ kind: "submitted", prompt });
  expect(notifications).toEqual([]);
  expect(frames).toHaveLength(11);
  for (const { width, focused, lines } of frames) {
    const frame = lines.join("");
    // At width one, native Editor puts its end-of-line cursor beyond the one
    // visible cell. The bounded frame clips that cursor, not the draft.
    const hasCursor = width > 1;
    expect(frame.split(CURSOR_MARKER).length - 1, `width=${width}, focused=${focused}`).toBe(
      Number(focused && hasCursor),
    );
    expect(frame.split(fakeStart).length - 1).toBe(Number(hasCursor));
    expect(frame.split(fakeEnd).length - 1).toBe(Number(hasCursor));
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
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

it("keeps the prompt hardware cursor and fake cell at the native position after editing", async () => {
  const tui = createTuiHarness();
  let frame: string[] = [];
  let reference: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      const native = new Editor(host, {
        borderColor: (text) => text,
        selectList: {
          selectedPrefix: (text) => text,
          selectedText: (text) => text,
          description: (text) => text,
          scrollInfo: (text) => text,
          noMatch: (text) => text,
        },
      });
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
  expect(await showImagegenPrompt(ctx, fixture().owner)).toEqual({ kind: "submitted", prompt: "ab界e\u0301🙂z" });
  const cursor = frame.find((line) => line.includes(CURSOR_MARKER)) ?? "";
  const nativeCursor = reference.find((line) => line.includes(CURSOR_MARKER)) ?? "";
  expect(cursor).toBe(nativeCursor);
  expect(cursor).toContain(`${CURSOR_MARKER}${renderFakeCursor("🙂")}`);
  expect(visibleWidth(cursor.slice(0, cursor.indexOf(CURSOR_MARKER)))).toBe(5);
});

it.each(["abort", "dispose"])("does not generate after stale prompt %s", async (method) => {
  const tui = createTuiHarness();
  const { owner, replace } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("a draft");
  if (method === "abort") replace();
  else tui.dispose();
  await running;
  tui.send("\r");
  expect(owner.generate).not.toHaveBeenCalled();
});

it.each(["abort", "dispose", "close", "back"])("does not generate after output path %s", async (method) => {
  const tui = createTuiHarness();
  const { owner, replace } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("a complete prompt");
  tui.send("\r");
  await opened(tui, 3);
  tui.send("\r");
  const blankFrame = plain(tui.render());
  tui.type("an unsubmitted destination");
  if (method === "abort") replace();
  else if (method === "dispose") tui.dispose();
  else if (method === "close") tui.press("ctrl+c");
  else {
    tui.press("tui.select.cancel");
    await opened(tui, 4);
    tui.press("ctrl+c");
  }
  await running;
  expect(blankFrame).toContain("An output path is required.");
  expect(owner.generate).not.toHaveBeenCalled();
});

it("runs generation only after explicit path submission and aborts owned work on task disposal", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  let taskSignal: AbortSignal | undefined;
  owner.generate = vi.fn(async (_prompt, _path, signal) => {
    taskSignal = signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("A small circle");
  tui.send("\r");
  await opened(tui, 3);
  expect(owner.generate).not.toHaveBeenCalled();
  expect(plain(tui.render())).toContain("Image Output Path");
  const path = " @~/literal $(image).data ";
  tui.type(path);
  expect(owner.generate).not.toHaveBeenCalled();
  tui.send("\r");
  await opened(tui, 4);
  expect(owner.generate).toHaveBeenCalledWith("A small circle", path, expect.any(AbortSignal));
  expect(taskSignal?.aborted).toBe(false);
  tui.dispose();
  await running;
  expect(taskSignal?.aborted).toBe(true);
});

it("keeps manual generation available when tool access is disabled and reopens after success", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  // Hold completion until the task component is mounted.
  let finish!: () => void;
  owner.generate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("circle");
  tui.send("\r");
  await opened(tui, 3);
  expect(owner.generate).not.toHaveBeenCalled();
  tui.type("./exact-name");
  tui.send("\r");
  await opened(tui, 4);
  finish();
  await opened(tui, 5);
  expect(plain(tui.render())).toMatch(/Generate Image/);
  tui.press("ctrl+c");
  await running;
  expect(owner.generate).toHaveBeenCalledTimes(1);
});
