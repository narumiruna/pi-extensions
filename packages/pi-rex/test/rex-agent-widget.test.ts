import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, TuiAltScreen, type TuiMouseEvent, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { RexAgentWidget } from "../src/rex-agent-widget.js";
import type { RexDisplay } from "../src/rex-widget.js";
import { pane } from "./fixtures.js";

function fixture() {
  let display: RexDisplay = { entries: [pane], warnings: [] };
  let current = true;
  const state = { collapsed: false };
  const navigate = vi.fn();
  const disposed = vi.fn();
  const widget = new RexAgentWidget({
    display: () => display,
    theme: () => ({ fg: (_role, value) => value }) as Theme,
    rows: () => 36,
    isCurrent: () => current,
    state,
    here: {},
    navigate,
    disposed,
  });
  widget.render(80);
  const mouse = (type: TuiMouseEvent["type"], y = 1, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type,
    button: "left",
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width: 80,
    height: 2,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  });
  const click = (y = 1) => {
    widget.handleMouse(mouse("press", y));
    return widget.handleMouse(mouse("click", y));
  };
  return {
    widget,
    mouse,
    click,
    navigate,
    disposed,
    state,
    setDisplay(value: RexDisplay) {
      display = value;
      widget.invalidate();
    },
    stale() {
      current = false;
    },
  };
}

test("agent rows navigate exact payloads and only the divider collapses", () => {
  const f = fixture();
  assert.deepEqual(f.click(), { handled: true });
  assert.equal(f.navigate.mock.calls[0]?.[0], pane);
  assert.equal(f.state.collapsed, false);
  f.click(0);
  assert.equal(f.state.collapsed, true);
  assert.equal(f.click(), undefined, "collapsed body is inactive even before the next paint");
  assert.equal(f.widget.render(80).length, 1);
  assert.equal(f.click(), undefined);
  assert.equal(f.navigate.mock.calls.length, 1);
  f.click(0);
  assert.equal(f.state.collapsed, false);
});

test("unchanged selection redraws preserve eligible presses and release-without-button works", () => {
  const f = fixture();
  f.widget.handleMouse(f.mouse("press"));
  f.widget.render(80);
  assert.equal(f.widget.handleMouse(f.mouse("release", 1, { button: "none" })), undefined);
  assert.deepEqual(f.widget.handleMouse(f.mouse("click", 1, { button: "none" })), { handled: true });
  assert.equal(f.navigate.mock.calls.length, 1);
});

test.each([
  "missing-press",
  "move",
  "shift",
  "ctrl",
  "alt",
  "right",
  "wheel",
  "geometry",
  "height",
  "width",
  "invalid-x",
  "invalid-y",
])("does not activate invalid gesture class: %s", (kind) => {
  const f = fixture();
  if (kind !== "missing-press") f.widget.handleMouse(f.mouse("press"));
  let event = f.mouse("click");
  if (kind === "move") f.widget.handleMouse(f.mouse("move", 1, { x: 5 }));
  if (kind === "shift" || kind === "ctrl" || kind === "alt") event = { ...event, [kind]: true };
  if (kind === "right") event.button = "right";
  if (kind === "wheel") event = { ...event, type: "wheel", button: "none" };
  if (kind === "geometry") event.screenY += 1;
  if (kind === "height") event.height++;
  if (kind === "width") event.width++;
  if (kind === "invalid-x") event.x = -1;
  if (kind === "invalid-y") event.y = 1.5;
  assert.equal(f.widget.handleMouse(event), undefined);
  assert.equal(f.navigate.mock.calls.length, 0);
  assert.equal(f.state.collapsed, false);
});

test.each(["data", "reordered-identical-labels", "resize", "invalidate", "stale-owner", "dispose"])(
  "rejects a press after %s",
  (kind) => {
    const f = fixture();
    f.widget.handleMouse(f.mouse("press"));
    if (kind === "data") f.setDisplay({ entries: [{ ...pane, state: "done" }], warnings: [] });
    if (kind === "reordered-identical-labels")
      f.setDisplay({ entries: [{ ...pane, blockId: "block:00000000-0000-0000-0000-000000000099" }], warnings: [] });
    if (kind === "resize") f.widget.render(79);
    if (kind === "invalidate") f.widget.invalidate();
    if (kind === "stale-owner") f.stale();
    if (kind === "dispose") f.widget.dispose();
    f.widget.render(80);
    assert.equal(f.widget.handleMouse(f.mouse("click")), undefined);
    assert.equal(f.navigate.mock.calls.length, 0);
  },
);

test("stale, warning, empty, and omitted rows are never navigation targets", () => {
  for (const display of [
    { entries: [pane], warnings: [], error: "offline" },
    { entries: [], warnings: [] },
    { entries: [pane], warnings: ["partial"] },
  ]) {
    const f = fixture();
    f.setDisplay(display);
    f.widget.render(80);
    assert.equal(f.click(), undefined);
    assert.equal(f.navigate.mock.calls.length, 0);
  }
});

test("partial warnings keep their healthy agent rows separate from warning hit targets", () => {
  const f = fixture();
  f.setDisplay({ entries: [pane], warnings: ["partial"] });
  f.widget.render(80);
  f.widget.handleMouse(f.mouse("press", 2, { height: 3, screenY: 2 }));
  f.widget.handleMouse(f.mouse("click", 2, { height: 3, screenY: 2 }));
  assert.equal(f.navigate.mock.calls[0]?.[0], pane);
});

test("all widths remain bounded and disposal is idempotent", () => {
  const f = fixture();
  for (let width = 0; width <= 100; width++)
    for (const line of f.widget.render(width)) assert.ok(visibleWidth(line) <= width);
  f.widget.dispose();
  f.widget.dispose();
  assert.equal(f.disposed.mock.calls.length, 1);
  assert.deepEqual(f.widget.render(80), []);
});

class NativeHost extends TuiAltScreen {
  flush() {
    this.doRender();
  }
}
function mouseBytes(x: number, y: number, button = 0, release = false) {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
}

test("native fullscreen click navigation preserves editor focus, drag selection, and exact copy", async () => {
  const terminal = new FullscreenTerminal();
  const copied: string[] = [];
  const host = new NativeHost(terminal, false, undefined, {
    copyOnSelect: false,
    copySelection: async (value) => {
      copied.push(value);
      return true;
    },
  });
  const f = fixture();
  const editor = new Input();
  host.setLayoutRoot(new VStack([f.widget, editor]));
  host.setFocus(editor);
  host.start();
  const send = (value: string) => {
    terminal.input(value);
    host.flush();
  };
  try {
    host.flush();
    send(mouseBytes(0, 1));
    send(mouseBytes(8, 1, 32));
    send(mouseBytes(8, 1, 0, true));
    assert.equal(f.navigate.mock.calls.length, 0);
    assert.equal(await host.copyActiveSelectionToClipboard(), true);
    assert.deepEqual(copied, ["● Working"]);
    assert.equal(f.state.collapsed, false);
    send(mouseBytes(60, 1));
    send(mouseBytes(60, 1, 0, true));
    assert.equal(f.navigate.mock.calls.length, 1);
    assert.equal(f.state.collapsed, false);
    assert.equal(host.getFocusedComponent(), editor);
    send("draft");
    assert.equal(editor.getValue(), "draft");
    send(mouseBytes(60, 0));
    send(mouseBytes(60, 0, 0, true));
    assert.equal(f.state.collapsed, true);
  } finally {
    f.widget.dispose();
    host.stop({ preserveScreen: true });
  }
});
