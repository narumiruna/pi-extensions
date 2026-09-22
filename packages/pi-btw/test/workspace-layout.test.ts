import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BtwSplitPane, MIN_BTW_SPLIT_COLUMNS } from "../src/workspace-layout.js";

function theme() {
  return {
    fg: (_role: string, text: string) => text,
  } as never;
}

class SideComponent implements Component {
  constructor(private readonly rows: number) {}

  render(width: number): string[] {
    return Array.from({ length: this.rows }, () => truncateToWidth("SIDE", width));
  }

  invalidate(): void {}
}

class MainThreadComponent implements Component {
  frame = "initial";
  renderCount = 0;

  render(_width: number): string[] {
    this.renderCount += 1;
    return ["main history", `\u001b[44mMAIN ${this.frame}\u001b[49m`, "main editor"];
  }

  invalidate(): void {}
}

function split(layout: "left-pane" | "right-pane", rows = 8) {
  const side = new SideComponent(rows);
  const main = new MainThreadComponent();
  const component = new BtwSplitPane({
    sideComponent: side,
    sideLayout: side,
    mainThread: main,
    layout,
    theme: theme(),
    terminalRows: () => rows,
  });
  return { component, main };
}

test.each([
  ["left-pane", true],
  ["right-pane", false],
] as const)("%s renders Pi's native main-thread component on the configured side", (layout, sideFirst) => {
  const { component } = split(layout);
  const lines = component.render(120);
  const styledLine = lines.find((line) => line.includes("MAIN initial"));
  assert.ok(styledLine);
  const plainLine = stripVTControlCharacters(styledLine);

  assert.equal(plainLine.indexOf("SIDE") < plainLine.indexOf("MAIN initial"), sideFirst);
  assert.equal(styledLine.includes("\u001b[44mMAIN initial\u001b[49m"), true);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("split panes render live main-thread state instead of an opening snapshot", () => {
  const { component, main } = split("right-pane");
  assert.match(stripVTControlCharacters(component.render(120).join("\n")), /MAIN initial/u);

  main.frame = "updated";
  const updated = stripVTControlCharacters(component.render(120).join("\n"));

  assert.match(updated, /MAIN updated/u);
  assert.doesNotMatch(updated, /MAIN initial/u);
  assert.equal(main.renderCount, 2);
});

test("split panes collapse to the side thread on narrow terminals without rendering main", () => {
  const { component, main } = split("right-pane", 5);
  const lines = component.render(MIN_BTW_SPLIT_COLUMNS - 1);

  assert.match(lines.join("\n"), /SIDE/u);
  assert.doesNotMatch(lines.join("\n"), /MAIN/u);
  assert.equal(main.renderCount, 0);
  assert.ok(lines.every((line) => visibleWidth(line) <= MIN_BTW_SPLIT_COLUMNS - 1));
});

test("split-pane rendering remains bounded at minimal widths", () => {
  const { component } = split("left-pane", 3);
  for (const width of [1, 8, 24, MIN_BTW_SPLIT_COLUMNS, 121]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});
