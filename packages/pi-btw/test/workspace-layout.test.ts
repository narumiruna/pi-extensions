import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BtwSplitPane, MIN_BTW_SPLIT_COLUMNS } from "../src/workspace-layout.js";

function theme() {
  return {
    fg: (_role: string, text: string) => text,
  } as never;
}

class SideComponent implements Focusable {
  focused = false;
  inputs: string[] = [];

  render(width: number): string[] {
    return [`SIDE${this.focused ? CURSOR_MARKER : ""}`.slice(0, width)];
  }

  handleInput(data: string): void {
    this.inputs.push(data);
  }

  invalidate(): void {}
}

function split(layout: "left-pane" | "right-pane", rows = 8) {
  const side = new SideComponent();
  const component = new BtwSplitPane({
    sideComponent: side,
    sideLayout: side,
    layout,
    mainThreadContext: "User: unsafe \u001b]52;c;c2VjcmV0\u0007 context\n\u202eAssistant: answer",
    mainEditorDraft: "draft text",
    theme: theme(),
    terminalRows: () => rows,
  });
  return { component, side };
}

test.each([
  ["left-pane", true],
  ["right-pane", false],
] as const)("%s keeps the side thread on the configured side with a sanitized main snapshot", (layout, sideFirst) => {
  const { component } = split(layout);
  const lines = component.render(120);
  const plain = lines.map((line) => stripVTControlCharacters(line));
  const first = plain[0] ?? "";

  assert.equal(first.indexOf("SIDE") < first.indexOf("main thread"), sideFirst);
  assert.match(plain.join("\n"), /main thread · context snapshot/u);
  assert.match(plain.join("\n"), /draft text/u);
  const rendered = lines.join("\n");
  assert.equal(rendered.includes("\u001b]52"), false);
  assert.equal(rendered.includes("c2VjcmV0"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("split panes collapse to the focused side thread on narrow terminals and preserve input ownership", () => {
  const { component, side } = split("right-pane", 5);
  component.focused = true;
  component.handleInput("x");
  const lines = component.render(MIN_BTW_SPLIT_COLUMNS - 1);

  assert.equal(side.focused, true);
  assert.deepEqual(side.inputs, ["x"]);
  assert.match(lines.join("\n"), /SIDE/u);
  assert.doesNotMatch(lines.join("\n"), /main thread/u);
  assert.equal(lines.join("\n").includes(CURSOR_MARKER), true);
  assert.ok(lines.every((line) => visibleWidth(line) <= MIN_BTW_SPLIT_COLUMNS - 1));
});

test("split-pane rendering remains bounded at minimal widths", () => {
  const { component } = split("left-pane", 3);
  for (const width of [1, 8, 24, MIN_BTW_SPLIT_COLUMNS, 121]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});
