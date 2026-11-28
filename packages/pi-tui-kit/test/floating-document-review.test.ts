import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type KeyId, type OverlayHandle, visibleWidth } from "@earendil-works/pi-tui";
import { expect, type TestContext, test, vi } from "vitest";
import { runDocumentReview } from "../src/document-review.js";
import { createRendererHost, deferred } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";
import { createShowcaseOverlay } from "./fixtures/showcase-overlay.js";

const DOCUMENT = {
  presentation: "floating",
  title: "Review\x1b[2J changed settings",
  lines: ["Local → Remote"],
  content: [
    "@@ -1,40 +1,40 @@",
    "-old value",
    "+new value",
    ...Array.from({ length: 38 }, (_, i) => `  row-${i} 界 é  `),
  ].join("\n"),
  format: { kind: "diff" },
  viewportSize: "adaptive",
  enableSearch: true,
} as const;

function fixture(
  t: TestContext,
  mode: "regular" | "fullscreen",
  options: Parameters<typeof createRendererHost>[2] = {},
) {
  const theme = rendererTheme();
  const host = createRendererHost(mode, theme, { width: 80, rows: 24, ...options });
  const overlay = createShowcaseOverlay(host, theme);
  const ctx = host.ctx as ExtensionCommandContext;
  ctx.ui.custom = overlay.custom;
  t.onTestFinished(() => {
    overlay.stop();
    host.stop();
  });
  const { editor, frame, notifications, resize, scroll, send, waitForOpen } = host;
  return {
    ctx,
    editor,
    frame,
    host: host.host,
    notifications,
    overlay,
    resize,
    scroll,
    send,
    theme,
    waitForOpen,
    get component() {
      return host.component;
    },
  };
}

function bounds(handle: OverlayHandle) {
  const value = handle.getBounds();
  if (!value) throw new Error("Review overlay did not render");
  return value;
}

const plain = (rows: readonly string[]) => stripVTControlCharacters(rows.join("\n"));

test("built document-review subpath opens and closes the public floating presentation", async (t) => {
  const { runDocumentReview: review } = await import("@narumitw/pi-tui-kit/document-review");
  const f = fixture(t, "regular");
  const running = review(f.ctx, DOCUMENT);
  const { component, handle } = await Promise.race([
    f.overlay.opened,
    running.then((result) => {
      throw new Error(`Review ended before publishing its overlay: ${result.kind}`);
    }),
  ]);
  expect(plain(component.render(bounds(handle).width))).toContain("+new value");
  f.send("\x1b");
  await expect(running).resolves.toEqual({ kind: "cancelled", reason: "back" });
  expect(f.overlay.completions).toBe(1);
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} mounts a bounded shared diff, handles remapped search and Back, and restores other input`, async (t) => {
    const f = fixture(t, mode, {
      bindings: {
        "tui.select.cancel": "q",
        "tui.select.down": "j",
        "tui.select.up": "k",
        "tui.altScreen.searchClose": "x",
        "tui.altScreen.searchNext": ["ctrl+c", "n"],
        "tui.altScreen.lineDown": "j",
      },
    });
    const underlyingInput = vi.fn();
    const underneath = f.host.showOverlay({ render: () => ["Other"], invalidate() {}, handleInput: underlyingInput });
    t.onTestFinished(() => underneath.hide());
    const running = runDocumentReview(f.ctx, DOCUMENT);
    const { component, handle } = await f.overlay.opened;
    const frame = () => component.render(bounds(handle).width);
    expect(bounds(handle)).toEqual({ col: 4, row: 2, width: 72, height: 19 });
    expect(plain(frame())).toContain("Local → Remote");
    expect(plain(frame())).toContain("-old value");
    expect(plain(frame())).toContain("+new value");
    expect(plain(frame())).toContain("  row-0 界 é  ");
    expect(plain(frame())).toMatch(/^╭─ Review .*changed settings.*╮/u);
    expect(frame().join("\n")).not.toContain("\x1b[2J");
    expect(frame().join("\n")).not.toContain(CURSOR_MARKER);
    expect(plain(frame())).toContain("q back");
    expect(handle.isFocused()).toBe(true);
    f.send("\r");
    expect(f.overlay.completions).toBe(0);

    const transcriptOffset = f.scroll.scrollTop;
    f.send("j");
    expect(plain(frame())).not.toContain("@@ -1,40 +1,40 @@");
    f.send("k");
    expect(plain(frame())).toContain("@@ -1,40 +1,40 @@");
    expect(f.scroll.scrollTop).toBe(transcriptOffset);
    f.send(" ");
    f.send("\x1b[200~row-3\x1b[201~");
    const search = frame().join("\n");
    expect(search).toContain(CURSOR_MARKER);
    expect(plain(frame())).toContain("1/9");
    expect(plain(frame())).toContain("n next");
    expect(plain(frame())).not.toMatch(/ctrl\+c[\s/]+(?:n\s+)?next/u);
    f.send("n");
    expect(plain(frame())).toContain("2/9");
    const above = f.host.showOverlay({ render: () => ["Above"], invalidate() {} });
    try {
      expect(frame().join("\n")).not.toContain(CURSOR_MARKER);
    } finally {
      above.hide();
    }
    expect(frame().join("\n")).toContain(CURSOR_MARKER);

    const light = rendererTheme("light");
    const fg = vi.fn(light.fg.bind(light));
    f.theme.fg = fg;
    f.host.invalidate();
    expect(frame().join("\n")).toContain(light.fg("border", "│"));
    expect(fg).toHaveBeenCalledWith("toolDiffContext", expect.any(String));
    for (const [width, height] of [
      [32, 12],
      [23, 4],
      [3, 3],
      [1, 1],
      [80, 24],
    ] as const) {
      f.resize(width, height);
      const box = bounds(handle);
      expect(box.width + box.col).toBeLessThanOrEqual(width);
      expect(box.height + box.row).toBeLessThanOrEqual(height);
      expect(frame().length).toBeLessThanOrEqual(box.height);
      expect(frame().every((line) => visibleWidth(line) <= box.width)).toBe(true);
    }
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(component.render(width)).toEqual([]);
    expect(plain(frame())).toMatch(/Find: > row-3.* [1-9]\/9/u);
    expect(frame().join("\n")).toContain(CURSOR_MARKER);
    f.send("x");
    expect(frame().join("\n")).not.toContain(CURSOR_MARKER);
    f.send("q");
    await expect(running).resolves.toEqual({ kind: "cancelled", reason: "back" });
    expect(f.overlay.completions).toBe(1);
    expect(underneath.isFocused()).toBe(true);
    f.send("!");
    expect(underlyingInput).toHaveBeenCalledExactlyOnceWith("!");
    expect(f.editor.getValue()).toBe("main draft");
  });
}

test("native fullscreen mouse moves and resizes the same review, preserving focused search until Ctrl+C", async (t) => {
  const f = fixture(t, "fullscreen", { kitty: true, bindings: { "tui.altScreen.searchClose": "ctrl+c" } });
  f.send("\x1b[102;6u");
  const nativeSearch = f.host.getFocusedComponent();
  expect(nativeSearch).not.toBe(f.editor);
  const running = runDocumentReview(f.ctx, DOCUMENT);
  const { component, handle } = await f.overlay.opened;
  const initial = bounds(handle);
  const drag = (x: number, y: number, dx: number, dy: number) => {
    f.send(`\x1b[<0;${x + 1};${y + 1}M`);
    f.send(`\x1b[<32;${x + dx + 1};${y + dy + 1}M`);
    f.send(`\x1b[<0;${x + dx + 1};${y + dy + 1}m`);
  };
  drag(initial.col + 4, initial.row, 2, 1);
  const moved = bounds(handle);
  expect(moved).toEqual({ ...initial, col: initial.col + 2, row: initial.row + 1 });
  f.send("\x1b[32u");
  f.send("row-33");
  drag(moved.col + moved.width - 2, moved.row + moved.height - 1, -8, -3);
  const resized = bounds(handle);
  expect(resized).toEqual({ ...moved, width: moved.width - 8, height: moved.height - 3 });
  const search = component.render(resized.width).join("\n");
  expect(search).toContain(CURSOR_MARKER);
  expect(search).toContain("1/1");
  expect(plain([search])).not.toContain("ctrl+c close search");
  f.resize(2, 2);
  f.send("\x1b[99;5:3u");
  expect(f.overlay.completions).toBe(0);
  f.send("\x1b[99;5u");
  await expect(running).resolves.toEqual({ kind: "cancelled", reason: "close" });
  expect(f.overlay.mounts).toBe(1);
  expect(f.host.getFocusedComponent()).toBe(nativeSearch);
  f.send("\x1b[99;5u");
  expect(f.host.getFocusedComponent()).toBe(f.editor);
});

test("a host-owned Space key is not advertised as document search", async (t) => {
  const f = fixture(t, "fullscreen", { bindings: { "tui.altScreen.search": "space" } });
  const running = runDocumentReview(f.ctx, DOCUMENT);
  const { component, handle } = await f.overlay.opened;
  const frame = () => plain(component.render(bounds(handle).width));
  expect(frame()).not.toContain("space search");
  f.send(" ");
  expect(frame()).not.toContain("Find:");
  expect(handle.isFocused()).toBe(false);
  f.send(" ");
  expect(handle.isFocused()).toBe(true);
  f.send("\x03");
  await expect(running).resolves.toEqual({ kind: "cancelled", reason: "close" });
});

test.for([
  { mode: "regular", width: 23, rows: 20, key: "\x03", kitty: false },
  { mode: "fullscreen", width: 80, rows: 4, key: "\x1b[99;5u", kitty: true },
] as const)("$mode falls back inline at $width x $rows and retains hard cancel", async (size, t) => {
  const f = fixture(t, size.mode, {
    ...size,
    bindings: { "tui.select.cancel": "q", "tui.altScreen.pageDown": "ctrl+c" },
  });
  const running = runDocumentReview(f.ctx, DOCUMENT);
  await f.waitForOpen();
  const lines = f.frame();
  expect(lines.length).toBeLessThanOrEqual(size.rows);
  expect(lines.every((line) => visibleWidth(line) <= size.width)).toBe(true);
  expect(plain(lines)).not.toContain("╭");
  expect(f.overlay.mounts).toBe(0);
  expect(f.host.getFocusedComponent()).toBe(f.component);
  f.send(size.key);
  await expect(running).resolves.toEqual({ kind: "cancelled", reason: "close" });
  expect(f.host.getFocusedComponent()).toBe(f.editor);
});

test.for([
  { width: 80, rows: 24, kitty: false, binding: "ctrl+c" },
  { width: 23, rows: 4, kitty: true, binding: "Ctrl+C" },
])(
  "fullscreen refuses both paths when native search owns Ctrl+C at $width x $rows",
  async ({ binding, ...size }, t) => {
    const f = fixture(t, "fullscreen", { ...size, bindings: { "tui.altScreen.search": binding as KeyId } });
    const reported = vi.fn();
    const result = await runDocumentReview(f.ctx, { ...DOCUMENT, onError: reported });
    expect(result).toEqual({ kind: "error", error: expect.any(Error) });
    if (result.kind !== "error") throw new Error("Expected a typed error");
    expect(String(result.error)).toContain("native fullscreen search owns Ctrl+C");
    expect(reported).toHaveBeenCalledExactlyOnceWith(f.ctx, result.error);
    expect(f.overlay.mounts).toBe(0);
    expect(f.host.getFocusedComponent()).toBe(f.editor);
  },
);

test.for(["abort", "dispose"] as const)(
  "%s drains an accepted copy without touching a newer overlay",
  async (end, t) => {
    const f = fixture(t, "regular");
    const owner = new AbortController();
    const copy = deferred<void>();
    let signal: AbortSignal | undefined;
    const running = runDocumentReview(f.ctx, {
      ...DOCUMENT,
      signal: owner.signal,
      copy: {
        label: "Copy",
        onCopy: (value) => {
          signal = value.signal;
          return copy.promise;
        },
      },
    });
    const { component, handle } = await f.overlay.opened;
    f.send("\x18");
    expect(signal?.aborted).toBe(false);
    const other = f.host.showOverlay({ render: () => ["Unrelated"], invalidate() {} });
    t.onTestFinished(() => other.hide());
    if (end === "abort") owner.abort();
    else f.overlay.disposeFromHost();
    f.overlay.disposeFromHost();
    component.dispose?.();
    owner.abort();
    expect(signal?.aborted).toBe(true);
    expect(handle.getBounds()).toBeUndefined();
    expect(other.isFocused()).toBe(true);
    const settled = vi.fn();
    void running.then(settled);
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();
    copy.resolve();
    await expect(running).resolves.toEqual({ kind: "stale" });
    expect(f.overlay.completions).toBe(end === "abort" ? 1 : 0);
    expect(other.isFocused()).toBe(true);
    expect(f.notifications).toEqual([]);
  },
);

test("abort after the factory but before native mount does not publish an overlay", async (t) => {
  const f = fixture(t, "fullscreen");
  const owner = new AbortController();
  f.ctx.ui.custom = (factory, options) =>
    f.overlay.custom((...args) => {
      const created = factory(...args);
      owner.abort();
      return created;
    }, options);
  await expect(runDocumentReview(f.ctx, { ...DOCUMENT, signal: owner.signal })).resolves.toEqual({ kind: "stale" });
  expect(f.overlay.mounts).toBe(0);
  expect(f.overlay.completions).toBe(1);
  expect(f.host.getFocusedComponent()).toBe(f.editor);
});

test("a stale owner does not mount an inline fallback", async (t) => {
  const f = fixture(t, "regular", { width: 23 });
  let current = true;
  let calls = 0;
  f.ctx.ui.custom = async (factory, options) => {
    calls++;
    const result = await f.overlay.custom(factory, options);
    current = false;
    return result;
  };
  await expect(runDocumentReview(f.ctx, { ...DOCUMENT, isCurrent: () => current })).resolves.toEqual({ kind: "stale" });
  expect(calls).toBe(1);
  expect(f.overlay.mounts).toBe(0);
  expect(f.host.getFocusedComponent()).toBe(f.editor);
});

test("an overlay mount failure returns the original error without closing another overlay", async (t) => {
  const f = fixture(t, "regular");
  const failure = new Error("Mount failed");
  const report = vi.fn();
  const other = f.host.showOverlay({ render: () => ["Unrelated"], invalidate() {} });
  t.onTestFinished(() => other.hide());
  f.ctx.ui.custom = (factory, options) =>
    f.overlay.custom(async (...args) => {
      await factory(...args);
      throw failure;
    }, options);
  await expect(runDocumentReview(f.ctx, { ...DOCUMENT, onError: report })).resolves.toEqual({
    kind: "error",
    error: failure,
  });
  expect(report).toHaveBeenCalledExactlyOnceWith(f.ctx, failure);
  expect(f.overlay.mounts).toBe(0);
  expect(other.isFocused()).toBe(true);
});

test.for([true, false])("floating confirmation revalidates the owner (current=%s)", async (active, t) => {
  const f = fixture(t, "regular", { bindings: { "tui.select.confirm": "y" } });
  let current = true;
  const running = runDocumentReview(f.ctx, {
    ...DOCUMENT,
    confirmation: { label: "Review complete" },
    isCurrent: () => current,
  });
  await f.overlay.opened;
  current = active;
  f.send("y");
  await expect(running).resolves.toEqual({ kind: active ? "confirmed" : "stale" });
  expect(f.host.hasOverlay()).toBe(false);
});
