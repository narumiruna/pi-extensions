import assert from "node:assert/strict";
import { CURSOR_MARKER, TuiAltScreen, TuiMainScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { FloatingFrame } from "../src/floating-frame.js";
import { FullscreenTerminal } from "../src/testing/fullscreen-harness.js";

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name}: passive and capturing frames share native focus and restore only owned input`, () => {
    const terminal = new FullscreenTerminal();
    const tui = new Renderer(terminal);
    const received: string[] = [];
    const main = {
      render: () => ["Main editor"],
      invalidate() {},
      handleInput: (key: string) => received.push(`main:${key}`),
    };
    const dialog = { ...main, handleInput: (key: string) => received.push(`dialog:${key}`) };
    tui.addChild(main);
    tui.setFocus(main);
    tui.start();
    try {
      const focus: boolean[] = [];
      const make = (nonCapturing: boolean, prefix: string) =>
        new FloatingFrame({
          getTerminalSize: () => terminal,
          initialBounds: () => ({ col: 4, row: 2, width: 23, height: 8 }),
          minSize: { columns: 20, rows: 6 },
          requestRender: () => tui.requestRender(),
          styleTitle: (s) => s,
          styleBorder: (s) => s,
          title: () => ` ${prefix} `,
          overlay: { nonCapturing },
          body: {
            render: () => [prefix],
            invalidate() {},
            setFocused: (value) => focus.push(value),
            handleInput: (key) => received.push(`${prefix}:${key}`),
          },
        });
      const passive = make(true, "passive");
      const preview = tui.showOverlay(passive, passive.overlayOptions);
      tui.renderNow();
      const initial = preview.getBounds();
      assert.deepEqual(initial, { col: 4, row: 2, width: 23, height: 8 });
      terminal.input("a");
      passive.move(8, 3);
      passive.resize(2, 1);
      tui.renderNow();
      assert.deepEqual(preview.getBounds(), { col: 12, row: 5, width: 25, height: 9 });
      const previous = tui.getFocusedComponent();
      preview.focus();
      terminal.input("b");
      preview.unfocus({ target: previous });
      terminal.input("c");
      preview.setHidden(true);
      const other = tui.showOverlay(dialog);
      terminal.input("d");
      preview.hide();
      assert.equal(other.isFocused(), true);
      other.hide();
      const modal = make(false, "modal");
      const interaction = tui.showOverlay(modal, modal.overlayOptions);
      terminal.input("e");
      interaction.hide();
      terminal.input("f");
      assert.deepEqual(received, ["main:a", "passive:b", "main:c", "dialog:d", "modal:e", "main:f"]);
      assert.deepEqual(focus, [true, false, true, false]);
    } finally {
      tui.stop();
    }
  });
}

test("floating frame reports bounded viewports, preserves cursor cells, and does not move a focused editor on drag", () => {
  const size = { columns: 100, rows: 30 };
  let invalidations = 0;
  let renders = 0;
  const bodyEvents: TuiMouseEvent[] = [];
  const frame = new FloatingFrame({
    getTerminalSize: () => size,
    initialBounds: ({ columns, rows }) => ({ col: columns, row: rows, width: 26, height: 11 }),
    minSize: { columns: 19, rows: 7 },
    requestRender: () => renders++,
    styleBorder: (value) => value,
    styleTitle: (value) => value,
    title: () => " draft ",
    body: {
      invalidate: () => invalidations++,
      render: () => [`${CURSOR_MARKER}草稿`],
      handleMouse: (event) => {
        bodyEvents.push(event);
        return { handled: true };
      },
    },
  });
  frame.invalidate();
  frame.invalidate();
  assert.equal(invalidations, 2);
  assert.deepEqual(frame.bounds, { col: 74, row: 19, width: 26, height: 11 });
  frame.move(-8, -5);
  const mouse = (type: TuiMouseEvent["type"], x: number, y: number) =>
    frame.handleMouse({
      type,
      button: "left",
      x,
      y,
      screenX: frame.bounds.col + x,
      screenY: frame.bounds.row + y,
      width: 26,
      height: 11,
      shift: false,
      alt: false,
      ctrl: false,
    });
  assert.deepEqual(mouse("press", 25, 10), { capture: true });
  assert.deepEqual(mouse("release", 28, 12), { handled: true });
  assert.deepEqual(frame.bounds, { col: 66, row: 14, width: 29, height: 13 });
  assert.equal(renders, 2);
  assert.deepEqual(mouse("wheel", 2, 2), { handled: true });
  assert.equal(bodyEvents[0]?.x, 1);
  assert.equal(bodyEvents[0]?.y, 1);
  const clean = frame.render(frame.bounds.width);
  assert.equal(clean.length, 13);
  assert.ok(clean[1]?.includes(CURSOR_MARKER));
  assert.ok(clean.every((line) => visibleWidth(line) === 29));
  Object.assign(size, { columns: 2, rows: 1 });
  assert.deepEqual(frame.viewport, { columns: 2, rows: 1 });
  assert.deepEqual(frame.bounds, { col: 0, row: 0, width: 2, height: 1 });
  assert.equal(visibleWidth(frame.render(2)[0] ?? ""), 2);
  Object.assign(size, { columns: 0, rows: 0 });
  assert.deepEqual(frame.render(0), []);
  Object.assign(size, { columns: 100, rows: 30 });
  assert.deepEqual(frame.bounds, { col: 66, row: 14, width: 29, height: 13 });
});
