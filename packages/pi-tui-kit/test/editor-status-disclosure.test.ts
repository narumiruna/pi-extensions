import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { EditorStatusWidget, type EditorStatusWidgetState } from "../src/editor-status-widget.js";

const theme = { fg: (_role: string, text: string) => text } as Pick<Theme, "fg">;

function pointer(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 39,
    y: 1,
    screenX: 39,
    screenY: 1,
    width: 40,
    height: 3,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

for (const y of [0, 1, 2]) {
  for (const x of [0, 4, 39]) {
    test(`whole-widget cell (${x}, ${y}) collapses on click, not press, and the line restores latest content`, () => {
      let text = "before";
      const widget = new EditorStatusWidget({ name: "Progress", theme, renderBody: () => [text, "second row"] });
      const expanded = widget.render(40);
      assert.match(expanded[0] ?? "", /^─ ▾ Progress ─+$/u);
      assert.equal(expanded.length, 3);
      assert.deepEqual(widget.handleMouse(pointer({ type: "press", x, y })), { handled: true, render: false });
      assert.equal(widget.collapsed, false);
      assert.deepEqual(widget.handleMouse(pointer({ x, y })), { handled: true, render: true });
      assert.equal(widget.collapsed, true);
      text = "updated while collapsed";
      const collapsed = widget.render(40);
      assert.equal(collapsed.length, 1);
      assert.match(collapsed[0] ?? "", /^─ ▸ Progress ─+$/u);
      assert.deepEqual(widget.handleMouse(pointer({ x: 39, y: 0, height: 1 })), { handled: true, render: true });
      assert.deepEqual(widget.render(40).slice(1), [text, "second row"]);
    });
  }
}

test("named dividers sanitize names, use current theme roles, and remain cell-width safe", () => {
  let color = 31;
  const roles: string[] = [];
  const activeTheme = {
    fg(role: string, text: string) {
      roles.push(role);
      return `\u001b[${color}m${text}\u001b[0m`;
    },
  } as Pick<Theme, "fg">;
  const widget = new EditorStatusWidget({
    name: "Progress\u001b[2J\n界\u202e",
    theme: activeTheme,
    renderBody: () => ["界界界", "body"],
  });
  assert.match(stripVTControlCharacters(widget.render(40)[0] ?? ""), /^─ ▾ Progress 界 ─+$/u);
  assert.ok(roles.includes("borderMuted"));
  assert.ok(roles.includes("muted"));
  for (const collapsed of [false, true]) {
    widget.setCollapsed(collapsed);
    for (const width of [0, 1, 2, 3, 4, 5, 9, 40, -1, 5.9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bound = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      const lines = widget.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= bound));
      assert.equal(visibleWidth(lines[0] ?? ""), bound);
    }
  }
  color = 32;
  widget.invalidate();
  assert.ok(widget.render(40)[0]?.includes("\u001b[32m"));
});

for (const event of [
  { type: "move" },
  { type: "drag" },
  { type: "release" },
  { type: "wheel", wheelDelta: 1 },
  { button: "middle" },
  { button: "right" },
  { button: "none" },
  { shift: true },
  { alt: true },
  { ctrl: true },
  { x: -1 },
  { x: 40 },
  { x: Number.NaN },
  { x: 1.5 },
  { y: -1 },
  { y: 3 },
  { y: 1.5 },
  { y: 2, height: 2 },
  { width: 39 },
] satisfies Partial<TuiMouseEvent>[]) {
  test(`non-click or stale/outside geometry is passive: ${JSON.stringify(event)}`, () => {
    const widget = new EditorStatusWidget({ name: "Progress", theme, renderBody: () => ["one", "two"] });
    widget.render(40);
    assert.equal(widget.handleMouse(pointer(event)), undefined);
    assert.equal(widget.collapsed, false);
  });
}

test("invalidated, failed, zero-width, unnamed and disposed widgets cannot toggle", () => {
  let fail = false;
  const state = { collapsed: false };
  const widget = new EditorStatusWidget({
    name: "Progress",
    theme,
    state,
    renderBody: () => {
      if (fail) throw new Error("render failed");
      return ["body"];
    },
  });
  assert.equal(widget.handleMouse(pointer()), undefined);
  widget.render(40);
  widget.invalidate();
  assert.equal(widget.handleMouse(pointer()), undefined);
  widget.render(40);
  fail = true;
  assert.throws(() => widget.render(40), /render failed/u);
  assert.equal(widget.handleMouse(pointer()), undefined);
  fail = false;
  widget.render(0);
  assert.equal(widget.handleMouse(pointer({ width: 0, x: 0 })), undefined);
  widget.render(40);
  widget.dispose();
  widget.dispose();
  assert.equal(widget.handleMouse(pointer()), undefined);
  assert.equal(widget.setCollapsed(true), false);
  assert.deepEqual(widget.render(40), []);
  assert.equal(state.collapsed, false);
  for (const name of [undefined, "", "\u001b[2J\n"]) {
    const passive = new EditorStatusWidget({ name, theme, renderBody: () => ["body"] });
    assert.equal(passive.render(40)[0], "─".repeat(40));
    assert.equal(passive.handleMouse(pointer()), undefined);
    assert.equal(passive.setCollapsed(true), false);
  }
});

test("owner-local state survives replacement, but old components cannot change it or siblings", () => {
  const state: EditorStatusWidgetState = { collapsed: false };
  const old = new EditorStatusWidget({ name: "Progress", theme, state, renderBody: () => ["old"] });
  old.render(40);
  assert.equal(old.setCollapsed(true), true);
  assert.equal(old.setCollapsed(true), false);
  old.dispose();
  const current = new EditorStatusWidget({ name: "Progress", theme, state, renderBody: () => ["latest"] });
  const sibling = new EditorStatusWidget({ name: "Subagents", theme, renderBody: () => ["running"] });
  assert.equal(current.render(40).length, 1);
  assert.equal(sibling.render(40).length, 2);
  assert.equal(old.setCollapsed(false), false);
  assert.equal(current.collapsed, true);
  assert.equal(current.setCollapsed(false), true);
  assert.equal(current.render(40)[1], "latest");
  assert.equal(sibling.collapsed, false);
});

test("redraw cancels a pending press until a fresh click gesture", () => {
  const widget = new EditorStatusWidget({ name: "Progress", theme, renderBody: () => ["body"] });
  widget.render(40);
  assert.deepEqual(widget.handleMouse(pointer({ type: "press" })), { handled: true, render: false });
  widget.render(40);
  assert.deepEqual(widget.handleMouse(pointer()), { handled: true, render: false });
  assert.equal(widget.collapsed, false);
  assert.deepEqual(widget.handleMouse(pointer({ type: "press" })), { handled: true, render: false });
  assert.deepEqual(widget.handleMouse(pointer()), { handled: true, render: true });
  assert.equal(widget.collapsed, true);
});

test("reentrant body disclosure renders the final state without stale body rows", () => {
  let widget: EditorStatusWidget;
  widget = new EditorStatusWidget({
    name: "Progress",
    theme,
    renderBody() {
      widget.setCollapsed(true);
      return ["must not remain visible"];
    },
  });
  const lines = widget.render(40);
  assert.equal(widget.collapsed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^─ ▸ Progress ─+$/u);
});

for (const action of ["dispose", "invalidate", "collapse"] as const) {
  test(`reentrant theme ${action} cannot publish stale rows or hit geometry`, () => {
    let widget: EditorStatusWidget;
    widget = new EditorStatusWidget({
      name: "Progress",
      theme: {
        fg: (_role, text) => {
          if (action === "dispose") widget.dispose();
          else if (action === "invalidate") widget.invalidate();
          else widget.setCollapsed(true);
          return text;
        },
      },
      renderBody: () => ["body"],
    });
    assert.deepEqual(widget.render(40), []);
    assert.equal(widget.handleMouse(pointer()), undefined);
  });
}

test("OSC 8 link cells keep their native behavior while adjacent blank cells collapse", () => {
  const widget = new EditorStatusWidget({
    name: "Progress",
    theme,
    renderBody: () => ["\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"],
  });
  widget.render(40);
  assert.equal(widget.handleMouse(pointer({ type: "press", x: 1 })), undefined);
  assert.equal(widget.handleMouse(pointer({ x: 1 })), undefined);
  assert.equal(widget.collapsed, false);
  assert.deepEqual(widget.handleMouse(pointer()), { handled: true, render: true });
});
