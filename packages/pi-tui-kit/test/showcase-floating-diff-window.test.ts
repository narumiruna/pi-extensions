import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type KeybindingsConfig, type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { expect, type TestContext, test } from "vitest";
import { runFloatingDiffDemo } from "../scripts/showcase/floating-diff-demo.js";
import { FloatingDiffWindow } from "../scripts/showcase/floating-diff-window.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";
import { createShowcaseOverlay } from "./fixtures/showcase-overlay.js";

type Point = { x: number; y: number };
type Mode = "regular" | "fullscreen";

async function openDemo(t: TestContext, mode: Mode, options: Parameters<typeof createRendererHost>[2] = {}) {
  const theme = rendererTheme();
  const renderer = createRendererHost(mode, theme, { width: 80, rows: 20, ...options });
  const overlay = createShowcaseOverlay(renderer, theme);
  const ctx = renderer.ctx as ExtensionCommandContext;
  ctx.ui.custom = overlay.custom;
  t.onTestFinished(() => {
    overlay.stop();
    renderer.stop();
  });
  const signal = new AbortController().signal;
  const running = runFloatingDiffDemo(ctx, { signal, isCurrent: () => true });
  const { component, handle } = await overlay.opened;
  const rect = () => {
    const value = handle.getBounds();
    if (!value) throw new Error("No visible diff overlay");
    return value;
  };
  const frame = () => component.render(rect().width).map((line) => stripVTControlCharacters(line));
  const header = () => frame()[0] ?? "";
  const at = (label: string): Point => {
    const title = header();
    const index = title.lastIndexOf(label);
    if (index < 0) throw new Error(`Missing ${label} in ${title}`);
    return { x: rect().col + visibleWidth(title.slice(0, index)), y: rect().row };
  };
  const pointer = (button: number, { x, y }: Point, release = false) =>
    renderer.send(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const click = (label: string, cellOffset = 0) => {
    const { x, y } = at(label);
    const point = { x: x + cellOffset, y };
    pointer(0, point);
    pointer(0, point, true);
  };
  return { renderer, overlay, component, handle, rect, frame, header, at, pointer, click, running };
}

test("native mouse controls keep a single overlay and restore the dragged and resized bounds", async (t) => {
  const w = await openDemo(t, "fullscreen");
  expect(w.header()).toMatch(/^╭─ Floating diff.*─+ − {2}□ {2}× ╮$/u);
  const initial = w.rect();
  const grip = { x: initial.col + 3, y: initial.row };
  w.pointer(0, grip);
  w.pointer(32, { x: grip.x + 3, y: grip.y + 1 });
  w.pointer(0, { x: grip.x + 3, y: grip.y + 1 }, true);
  expect(w.rect()).toEqual({ ...initial, col: initial.col + 3, row: initial.row + 1 });

  const moved = w.rect();
  const corner = { x: moved.col + moved.width - 2, y: moved.row + moved.height - 1 };
  w.pointer(0, corner);
  w.pointer(32, { x: corner.x - 4, y: corner.y - 2 });
  w.pointer(0, { x: corner.x - 4, y: corner.y - 2 }, true);
  const normal = { ...moved, width: moved.width - 4, height: moved.height - 2 };
  expect(w.rect()).toEqual(normal);

  w.click("□", -1);
  const maximized = { width: 80, height: 20, col: 0, row: 0 };
  expect(w.rect()).toEqual(maximized);
  expect(w.header()).toMatch(/^╭─ Floating diff.*─+ − {2}❐ {2}× ╮$/u);
  expect(w.frame().at(-1)).not.toContain("◢");
  for (const start of [
    { x: 2, y: 0 },
    { x: 78, y: 19 },
  ]) {
    w.pointer(0, start);
    w.pointer(32, { x: start.x - 1, y: start.y });
    w.pointer(0, { x: start.x - 1, y: start.y }, true);
    expect(w.rect()).toEqual(maximized);
  }
  w.click("−");
  expect(w.rect()).toEqual({ col: 8, row: 19, width: 64, height: 1 });
  expect(w.header()).toMatch(/ \+ {2}× ╴$/u);
  w.click("+");
  expect(w.rect()).toEqual(maximized);
  w.click("❐");
  expect(w.rect()).toEqual(normal);
  expect(w.overlay.mounts).toBe(1);
  w.click("×", 1);
  await expect(w.running).resolves.toBe(true);
  expect(w.overlay.completions).toBe(1);
  expect(w.renderer.host.getFocusedComponent()).toBe(w.renderer.editor);
  expect(w.renderer.editor.getValue()).toBe("main draft");
});

test("a narrow title shares the top border and leaves the first diff line visible", async (t) => {
  const w = await openDemo(t, "fullscreen", { width: 32, rows: 9 });
  expect(w.rect()).toMatchObject({ width: 28, height: 7 });
  expect(w.header()).toBe("╭─ Floating diff ─ −  □  × ╮");
  expect(w.frame()[1]).toContain("--- a/settings.toml");
  w.click("×", 1);
  await expect(w.running).resolves.toBe(true);
});

test("closing an unfocused diff from its title does not close or focus over another overlay", async (t) => {
  const w = await openDemo(t, "fullscreen");
  const other = w.renderer.host.showOverlay(
    { render: () => ["Unrelated"], invalidate() {} },
    { col: 0, row: 8, width: 18 },
  );
  try {
    expect(other.isFocused()).toBe(true);
    w.click("×");
    await expect(w.running).resolves.toBe(false);
    expect(other.isFocused()).toBe(true);
    expect(w.overlay.completions).toBe(1);
  } finally {
    other.hide();
  }
});

test("native title controls ignore drag-back, right clicks, stale releases and a lost capture", async (t) => {
  const w = await openDemo(t, "fullscreen");
  let x = w.at("×");
  w.pointer(0, x);
  w.pointer(32, { x: x.x - 10, y: x.y });
  w.pointer(32, x);
  w.pointer(0, x, true);
  w.pointer(2, x);
  w.pointer(2, x, true);
  expect(w.overlay.completions).toBe(0);
  w.pointer(0, x);
  w.renderer.resize(81, 20);
  w.pointer(0, x, true);
  expect(w.overlay.completions).toBe(0);
  x = w.at("×");
  w.pointer(0, x);
  w.renderer.send("\x1b[O");
  w.renderer.send("\x1b[I");
  w.pointer(0, x, true);
  expect(w.overlay.completions).toBe(0);

  const normal = w.rect();
  const grip = { x: normal.col + 3, y: normal.row };
  w.pointer(0, grip);
  w.renderer.send("z");
  w.pointer(0, { x: grip.x + 4, y: grip.y + 1 }, true);
  w.renderer.send("z");
  expect(w.rect()).toEqual(normal);
  w.click("×");
  await w.running;
});

test.for(["fullscreen", "regular"] as const)(
  "%s keyboard toggles preserve the hidden review and clamp restored bounds",
  async (mode, t) => {
    const w = await openDemo(t, mode);
    const normal = w.rect();
    w.renderer.send("\x1b[F");
    const atEnd = w.frame();
    expect(atEnd.join("\n")).toContain('+theme = "dark"');
    w.renderer.send("m");
    expect(w.frame()).toHaveLength(1);
    expect(w.header()).toContain("m restore");
    expect(w.renderer.host.getFocusedComponent()).toBe(w.component);
    w.renderer.send("\x1b[A");
    w.renderer.send("\x1b[H");
    w.renderer.send("!");
    expect(w.renderer.editor.getValue()).toBe("main draft");
    w.renderer.send("m");
    expect(w.frame()).toEqual(atEnd);
    w.renderer.send("z");
    expect(w.rect()).toEqual({ col: 0, row: 0, width: 80, height: 20 });
    w.renderer.send("z");
    expect(w.rect()).toEqual(normal);
    w.renderer.send("m");
    w.renderer.resize(32, 9);
    expect(w.rect()).toEqual({ col: 0, row: 8, width: 32, height: 1 });
    w.renderer.send("m");
    expect(w.rect()).toEqual({ col: 0, row: 0, width: 32, height: 9 });
    w.renderer.send("\x1b[F");
    expect(w.frame().join("\n")).toContain('+theme = "dark"');
    w.renderer.send("\x1b");
    await w.running;
  },
);

test.for([
  { mode: "regular", bindings: { "tui.select.down": "m", "tui.select.pageDown": "z" }, keys: ["u", "w"], kitty: false },
  {
    mode: "fullscreen",
    bindings: { "tui.altScreen.search": "m", "tui.select.cancel": "z" },
    keys: ["u", "w"],
    kitty: true,
  },
  {
    mode: "regular",
    bindings: { "tui.altScreen.search": "m", "tui.select.up": "ctrl+alt+m", "tui.select.pageDown": "bad" as KeyId },
    keys: ["m", "z"],
    kitty: false,
  },
  {
    mode: "fullscreen",
    bindings: { "tui.altScreen.lineDown": "m", "tui.select.down": "ctrl+z" },
    keys: ["m", "z"],
    kitty: true,
  },
] satisfies { mode: Mode; bindings: KeybindingsConfig; keys: [string, string]; kitty: boolean }[])(
  "chooses reachable keys in $mode with bindings $bindings",
  async ({ mode, bindings, keys: [minimize, maximize], kitty }, t) => {
    const w = await openDemo(t, mode, { bindings, kitty });
    const send = (key: string) => w.renderer.send(kitty ? `\x1b[${key.charCodeAt(0)}u` : key);
    expect(w.header()).toContain(`${minimize} minimize`);
    expect(w.header()).toContain(`${maximize} maximize`);
    if (bindings["tui.select.down"] === "m") {
      const old = w.frame();
      send("m");
      expect(w.frame()).not.toEqual(old);
      expect(w.rect().height).toBe(16);
    }
    send(minimize);
    expect(w.rect().height).toBe(1);
    send(minimize);
    expect(w.rect().height).toBe(16);
    send(maximize);
    expect(w.rect().height).toBe(20);
    w.renderer.send("\x03");
    await w.running;
  },
);

test("does not minimize in regular mode with no available restore key", async (t) => {
  const w = await openDemo(t, "regular", { bindings: { "tui.select.up": "m", "tui.select.down": "u" } });
  expect(w.header()).not.toContain("−");
  expect(w.header()).not.toContain("minimize");
  w.renderer.send("m");
  w.renderer.send("u");
  expect(w.rect().height).toBe(16);
  w.renderer.send("\x03");
  await w.running;
});

test.for([
  { state: "normal", keys: "\x1b" },
  { state: "normal", keys: "\x03" },
  { state: "maximized", keys: "\x1b" },
  { state: "maximized", keys: "\x03" },
  { state: "minimized", keys: "\x1b" },
  { state: "minimized", keys: "\x03" },
] as const)("$state closes with $keys", async ({ state, keys }, t) => {
  const w = await openDemo(t, "regular");
  if (state !== "normal") w.renderer.send(state === "maximized" ? "z" : "m");
  w.renderer.send(keys);
  await expect(w.running).resolves.toBe(true);
  expect(w.overlay.completions).toBe(1);
  expect(w.renderer.host.getFocusedComponent()).toBe(w.renderer.editor);
});

test("cell width and hit testing agree with wide titles and constrained chrome", (t) => {
  const theme = rendererTheme();
  const renderer = createRendererHost("fullscreen", theme, { width: 32, rows: 8 });
  t.onTestFinished(() => renderer.stop());
  let closes = 0;
  const window = new FloatingDiffWindow({
    title: "寬視窗🙂 title",
    theme,
    tui: renderer.host,
    keybindings: renderer.keys as KeybindingsManager,
    body: { render: () => ["body"], invalidate() {} },
    isCurrent: () => true,
    close: () => {
      closes++;
    },
  });
  const handle = renderer.host.showOverlay(window, window.overlayOptions);
  for (const [width, height] of [
    [32, 8],
    [8, 5],
    [5, 3],
    [2, 2],
    [1, 1],
  ] as const) {
    renderer.resize(width, height);
    const bounds = handle.getBounds();
    expect(bounds).toBeDefined();
    if (!bounds) throw new Error("Missing overlay");
    const frame = window.render(bounds.width).map((line) => stripVTControlCharacters(line));
    expect(frame.length).toBeLessThanOrEqual(height);
    expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (width === 32) expect(frame[0]).toContain("寬視窗🙂");
    if (width === 5) expect(frame[0]).toBe("╭ × ╮");
    if (width < 3) expect(frame.join("\n")).not.toContain("×");
  }
  renderer.resize(8, 5);
  const bounds = handle.getBounds();
  if (!bounds) throw new Error("Missing overlay");
  const left = bounds.col + bounds.width - 4;
  renderer.send(`\x1b[<0;${left + 1};${bounds.row + 1}M`);
  renderer.send(`\x1b[<0;${left + 1};${bounds.row + 1}m`);
  expect(closes).toBe(1);
  handle.hide();
});
