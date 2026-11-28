import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test, vi } from "vitest";
import { createPiTuiKitShowcaseExtension } from "../scripts/showcase/extension.js";
import { runFloatingDiffDemo } from "../scripts/showcase/floating-diff-demo.js";
import { createReviewComponent } from "../src/components/review.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";
import { createShowcaseOverlay } from "./fixtures/showcase-overlay.js";

const LAST_LINE = '+theme = "dark"';
const plain = (rows: readonly string[]) => stripVTControlCharacters(rows.join("\n"));

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} overlay stays bounded, reaches the final change, and restores editor input`, async (t) => {
    const theme = rendererTheme();
    const fg = vi.spyOn(theme, "fg");
    const renderer = createRendererHost(mode, theme, { width: 80, rows: 20 });
    const overlay = createShowcaseOverlay(renderer, theme);
    t.onTestFinished(() => {
      overlay.stop();
      renderer.stop();
    });
    const ctx = renderer.ctx as ExtensionCommandContext;
    ctx.ui.custom = overlay.custom;

    const running = runFloatingDiffDemo(ctx, owner());
    const { component, handle } = await overlay.opened;
    expect(handle.getBounds()).toEqual({ width: 72, height: 16, col: 4, row: 2 });
    const wide = plain(component.render(72));
    expect(wide.match(/Floating diff/gu)).toHaveLength(1);
    expect(wide).toContain("@@ -1,6 +1,6 @@");
    expect(wide).toContain('-title = "Before"');
    expect(wide).toContain('+title = "After"');
    expect(wide).not.toContain(LAST_LINE);
    expect(fg).toHaveBeenCalledWith("toolDiffAdded", expect.any(String));
    expect(fg).toHaveBeenCalledWith("toolDiffRemoved", expect.any(String));
    expect(renderer.host.getFocusedComponent()).toBe(component);

    for (let index = 0; index < 100; index++) renderer.send("\x1b[B");
    expect(plain(component.render(72))).toContain(LAST_LINE);
    expect(plain(component.render(72))).toContain("你好 🙂");

    for (const [width, height] of [
      [32, 9],
      [2, 2],
      [1, 1],
    ] as const) {
      renderer.resize(width, height);
      renderer.send("\x1b[F");
      const bounds = handle.getBounds();
      expect(bounds).toBeDefined();
      if (!bounds) throw new Error("Overlay unexpectedly disappeared");
      const lines = component.render(bounds.width);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width === 32) expect(plain(lines)).toContain(LAST_LINE);
    }

    renderer.resize(80, 20);
    renderer.send(mode === "regular" ? "\x1b" : "\x03");
    await expect(running).resolves.toBe(true);
    expect(renderer.host.getFocusedComponent()).toBe(renderer.editor);
    renderer.send("!");
    expect(renderer.editor.getValue()).toContain("!");
    expect(overlay.completions).toBe(1);
  });
}

test.for(["fullscreen", "regular"] as const)(
  "%s overlay follows remapped scroll and cancel bindings",
  async (mode, t) => {
    const theme = rendererTheme();
    const renderer = createRendererHost(mode, theme, {
      rows: 18,
      bindings: { "tui.select.down": "j", "tui.select.up": "k", "tui.select.cancel": "q" },
    });
    const overlay = createShowcaseOverlay(renderer, theme);
    const ctx = renderer.ctx as ExtensionCommandContext;
    ctx.ui.custom = overlay.custom;
    t.onTestFinished(() => {
      overlay.stop();
      renderer.stop();
    });

    const running = runFloatingDiffDemo(ctx, owner());
    const { component, handle } = await overlay.opened;
    const width = handle.getBounds()?.width ?? 0;
    const initial = plain(component.render(width));
    expect(initial).toContain("j");
    expect(initial).toContain("q close");
    renderer.send("j");
    expect(plain(component.render(width))).not.toBe(initial);
    renderer.send("k");
    expect(plain(component.render(width))).toBe(initial);
    renderer.send("q");
    await expect(running).resolves.toBe(true);
  },
);

test("fullscreen overlay warns and does not mount when Pi owns Ctrl+C", async () => {
  const theme = rendererTheme();
  const renderer = createRendererHost("fullscreen", theme, { bindings: { "tui.altScreen.search": "ctrl+c" } });
  const overlay = createShowcaseOverlay(renderer, theme);
  const ctx = renderer.ctx as ExtensionCommandContext;
  ctx.ui.custom = overlay.custom;
  try {
    await expect(runFloatingDiffDemo(ctx, owner())).resolves.toBe(true);
    expect(overlay.mounts).toBe(0);
    expect(renderer.notifications[0]?.message).toContain("native fullscreen binding owns it");
    expect(renderer.host.getFocusedComponent()).toBe(renderer.editor);
  } finally {
    renderer.stop();
  }
});

test("abort between factory and mount leaves no late overlay", async () => {
  const theme = rendererTheme();
  const renderer = createRendererHost("fullscreen", theme);
  const overlay = createShowcaseOverlay(renderer, theme);
  const controller = new AbortController();
  const ctx = renderer.ctx as ExtensionCommandContext;
  ctx.ui.custom = (factory, options) =>
    overlay.custom((...args) => {
      const component = factory(...args);
      controller.abort();
      return component;
    }, options);
  try {
    await expect(runFloatingDiffDemo(ctx, owner(controller.signal))).resolves.toBe(false);
    expect(overlay.completions).toBe(1);
    expect(overlay.mounts).toBe(0);
  } finally {
    renderer.stop();
  }
});

test.for(["dispose", "session_start", "session_shutdown"] as const)(
  "%s releases the diff without reopening the old showcase or closing an unrelated overlay",
  async (reason, t) => {
    const theme = rendererTheme();
    const renderer = createRendererHost("fullscreen", theme);
    const menu = createTuiHarness({ width: 80, rows: 24 });
    const overlay = createShowcaseOverlay(renderer, theme, menu.custom);
    const events = new Map<string, () => Promise<void>>();
    let run!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    createPiTuiKitShowcaseExtension()({
      on: (event: string, handler: () => Promise<void>) => events.set(event, handler),
      registerCommand: (_name: string, command: { handler: typeof run }) => {
        run = command.handler;
      },
    } as never);
    const ctx = renderer.ctx as ExtensionCommandContext;
    ctx.ui.custom = overlay.custom;
    t.onTestFinished(() => {
      overlay.stop();
      menu.dispose();
      renderer.stop();
    });
    const running = run("", ctx);
    await menu.waitForOpen();
    menu.type("floating diff");
    menu.press("tui.select.confirm");
    await overlay.opened;
    const unrelated = renderer.host.showOverlay({ render: () => ["Unrelated overlay"], invalidate() {} });
    try {
      if (reason === "dispose") overlay.disposeFromHost();
      else await events.get(reason)?.();
      await running;
      expect(overlay.completions).toBe(reason === "dispose" ? 0 : 1);
      expect(overlay.mounts).toBe(1);
      expect(menu.openCount).toBe(1);
      expect(menu.isOpen).toBe(false);
      expect(unrelated.isFocused()).toBe(true);
    } finally {
      unrelated.hide();
    }
  },
);

test("bounded review sanitizes display, hard-wraps tabs and wide text, and invalidates colors", () => {
  const host = { terminal: { rows: 20 }, requestRender() {} };
  let color = 31;
  const review = createReviewComponent({
    screen: {
      kind: "review",
      title: "Inline heading",
      content: "-before\n+\t你好🙂 long-content\u001b]8;;https://unsafe.example\u0007",
      format: { kind: "diff" },
      viewportSize: "adaptive",
    },
    tui: host,
    keybindings: { matches: () => false, getKeys: () => [] },
    theme: {
      fg: (_role, text) => `\u001b[${color}m${text}\u001b[39m`,
      bold: (text) => text,
    },
    onEvent() {},
  });
  const lines = review.render(10, 8);
  const frame = plain(lines);
  expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
  expect(lines.join("\n")).not.toContain("\u001b]8;");
  expect(frame).toContain("+   你好🙂");
  expect(frame).toContain(" long-cont");
  expect(frame).not.toMatch(/Inline heading|unsafe\.example|─/u);
  color = 32;
  review.invalidate();
  expect(review.render(10, 8).join("\n")).toContain("\u001b[32m");
  expect(review.render(10, 8).join("\n")).not.toContain("\u001b[31m");
  expect(plain(review.render(32))).toContain("Inline heading");
  expect(plain(review.render(32))).toContain("─".repeat(32));
});

function owner(signal = new AbortController().signal) {
  return { signal, isCurrent: () => !signal.aborted };
}
