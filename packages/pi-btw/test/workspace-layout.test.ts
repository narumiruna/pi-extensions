import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, type Focusable, isFocusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BtwMainThreadInput, BtwSplitPane, MIN_BTW_SPLIT_COLUMNS } from "../src/workspace-layout.js";

function theme() {
  return {
    fg: (_role: string, text: string) => text,
  } as never;
}

class SideComponent implements Component, Focusable {
  focused = false;
  readonly inputs: string[] = [];

  constructor(private readonly rows: number) {}

  render(width: number): string[] {
    return Array.from({ length: this.rows }, () => truncateToWidth("SIDE", width));
  }

  handleInput(data: string): void {
    this.inputs.push(data);
  }

  invalidate(): void {}
}

class InputComponent implements Component, Focusable {
  focused = false;
  readonly inputs: string[] = [];

  render(): string[] {
    return [];
  }

  handleInput(data: string): void {
    this.inputs.push(data);
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

function split(
  layout: "left-pane" | "right-pane",
  rows = 8,
  paneTheme = theme(),
  options: { sidePaneRatio?: number; persistSidePaneRatio?(ratio: number): Promise<void> } = {},
) {
  const side = new SideComponent(rows);
  const main = new MainThreadComponent();
  const mainInput = new InputComponent();
  const focus = { current: side as Component | null };
  const overlay = { focused: false };
  const renders = { count: 0 };
  const terminal = { columns: 120 };
  side.focused = true;
  const component = new BtwSplitPane({
    sideComponent: side,
    sideLayout: side,
    mainThread: main,
    mainInput,
    layout,
    theme: paneTheme,
    terminalColumns: () => terminal.columns,
    terminalRows: () => rows,
    hasFocusedOverlay: () => overlay.focused,
    setFocus: (next) => {
      if (focus.current && isFocusable(focus.current)) focus.current.focused = false;
      focus.current = next;
      if (isFocusable(next)) next.focused = true;
    },
    setViewportTarget() {},
    requestRender: () => {
      renders.count += 1;
    },
    ...(options.sidePaneRatio === undefined ? {} : { sidePaneRatio: options.sidePaneRatio }),
    ...(options.persistSidePaneRatio ? { persistSidePaneRatio: options.persistSidePaneRatio } : {}),
  });
  return { component, focus, main, mainInput, overlay, renders, side, terminal };
}

function mouse(button: number, column: number, suffix: "M" | "m" = "M"): string {
  return `\u001b[<${button};${column};2${suffix}`;
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

test.each([
  ["left-pane", 110, 10],
  ["right-pane", 10, 110],
] as const)(
  "%s press switches keyboard input between panes while release does not",
  async (layout, mainColumn, sideColumn) => {
    const { component, focus, mainInput, renders, side } = split(layout);

    component.handleTerminalInput(mouse(0, mainColumn));
    assert.equal(focus.current, side);
    await Promise.resolve();
    assert.equal(focus.current, mainInput);
    focus.current?.handleInput?.("main key");

    component.handleTerminalInput(mouse(0, sideColumn, "m"));
    await Promise.resolve();
    assert.equal(focus.current, mainInput);

    component.handleTerminalInput(mouse(0, sideColumn));
    await Promise.resolve();
    assert.equal(focus.current, side);
    focus.current?.handleInput?.("side key");

    assert.deepEqual(mainInput.inputs, ["main key"]);
    assert.deepEqual(side.inputs, ["side key"]);
    assert.equal(renders.count, 2);
  },
);

test("split panes use one muted divider column", async () => {
  const paneTheme = {
    fg: (role: string, text: string) =>
      role === "accent" ? `\u001b[31m${text}\u001b[39m` : `\u001b[90m${text}\u001b[39m`,
  } as never;
  const { component } = split("left-pane", 3, paneTheme);

  const divider = "\u001b[90m│\u001b[39m";
  const initial = component.render(120)[0] ?? "";
  assert.equal(initial.split(divider).length - 1, 1);
  assert.equal(visibleWidth(initial), 120);

  component.handleTerminalInput(mouse(0, 110));
  await Promise.resolve();
  const focusedMain = component.render(120)[0] ?? "";
  assert.equal(focusedMain.split(divider).length - 1, 1);
  assert.equal(visibleWidth(focusedMain), 120);
});

test.each([
  ["left-pane", 30],
  ["right-pane", 89],
] as const)("%s preserves the side-thread ratio across direct and HStack rendering", (layout, dividerColumn) => {
  const { component, terminal } = split(layout, 3, theme(), { sidePaneRatio: 0.25 });

  const direct = stripVTControlCharacters(component.render(120)[0] ?? "");
  const layoutLine = stripVTControlCharacters(component.getFullscreenLayout().render(120)[0] ?? "");
  assert.equal(direct.indexOf("│"), dividerColumn);
  assert.equal(layoutLine.indexOf("│"), dividerColumn);
  assert.equal(visibleWidth(direct), 120);
  assert.equal(visibleWidth(layoutLine), 120);

  terminal.columns = 100;
  const resized = stripVTControlCharacters(component.getFullscreenLayout().render(100)[0] ?? "");
  assert.equal(resized.indexOf("│"), layout === "left-pane" ? 25 : 74);
  assert.equal(visibleWidth(resized), 100);
});

test("ratio-based divider clicks do not switch panes", async () => {
  const { component, focus, mainInput, side } = split("left-pane", 3, theme(), { sidePaneRatio: 0.25 });

  component.handleTerminalInput(mouse(0, 31));
  await Promise.resolve();
  assert.equal(focus.current, side);

  component.handleTerminalInput(mouse(0, 70));
  await Promise.resolve();
  assert.equal(focus.current, mainInput);
});

test("wheel, pointer movement, divider clicks, and focused overlays do not switch panes", async () => {
  const { component, focus, mainInput, overlay, side } = split("left-pane");

  component.handleTerminalInput(mouse(64, 110));
  component.handleTerminalInput(mouse(32, 110));
  component.handleTerminalInput(mouse(0, 60));
  overlay.focused = true;
  component.handleTerminalInput(mouse(0, 110));
  assert.equal(component.handleTerminalInput("\u001b[200~"), false);
  assert.equal(component.handleTerminalInput("\u001b[201~"), false);
  overlay.focused = false;
  assert.equal(component.handleTerminalInput("x"), false);
  await Promise.resolve();

  assert.equal(focus.current, side);
  assert.equal(mainInput.focused, false);
  assert.deepEqual(side.inputs, []);
});

test("queued clicks revalidate overlays and terminal width before changing focus", async () => {
  const { component, focus, overlay, side, terminal } = split("left-pane");

  component.handleTerminalInput(mouse(0, 110));
  overlay.focused = true;
  await Promise.resolve();
  assert.equal(focus.current, side);

  overlay.focused = false;
  component.handleTerminalInput(mouse(0, 110));
  terminal.columns = MIN_BTW_SPLIT_COLUMNS - 1;
  await Promise.resolve();
  assert.equal(focus.current, side);
});

test("bracketed paste is forwarded verbatim without interpreting mouse-shaped text as pane focus", async () => {
  const { component, focus, mainInput } = split("left-pane");
  component.handleTerminalInput(mouse(0, 110));
  await Promise.resolve();
  assert.equal(focus.current, mainInput);

  const chunks = ["\u001b[200~", mouse(0, 10), "payload", "\u001b[201~"];
  for (const chunk of chunks) assert.equal(component.handleTerminalInput(chunk), true);
  await Promise.resolve();

  assert.equal(focus.current, mainInput);
  assert.deepEqual(mainInput.inputs, chunks);
});

test("rendering a narrow terminal synchronously returns focus to the visible side pane", async () => {
  const { component, focus, mainInput, overlay, side, terminal } = split("right-pane");
  component.handleTerminalInput(mouse(0, 10));
  await Promise.resolve();
  assert.equal(focus.current, mainInput);

  terminal.columns = MIN_BTW_SPLIT_COLUMNS - 1;
  overlay.focused = true;
  component.render(terminal.columns);
  assert.equal(focus.current, mainInput);

  overlay.focused = false;
  component.render(terminal.columns);
  assert.equal(focus.current, side);
  focus.current?.handleInput?.("x");
  assert.deepEqual(side.inputs, ["x"]);
});

test("disposing a split pane invalidates a queued click focus change", async () => {
  const { component, focus, side } = split("left-pane");
  component.handleTerminalInput(mouse(0, 110));
  component.dispose();
  await Promise.resolve();

  assert.equal(focus.current, side);
});

test("main-thread input follows Pi's current native target and releases it on disposal", () => {
  const first = new InputComponent();
  const second = new InputComponent();
  let current: Component | null = first;
  let renders = 0;
  const input = new BtwMainThreadInput(
    first,
    () => current,
    () => {
      renders += 1;
    },
  );

  input.focused = true;
  input.handleInput("first");
  current = second;
  input.handleInput("second");
  current = first;
  input.handleInput("first again");

  assert.deepEqual(first.inputs, ["first", "first again"]);
  assert.deepEqual(second.inputs, ["second"]);
  assert.equal(first.focused, true);
  assert.equal(second.focused, false);
  assert.equal(renders, 3);

  input.dispose();
  input.handleInput("ignored");
  assert.equal(input.focused, false);
  assert.equal(first.focused, false);
  assert.deepEqual(first.inputs, ["first", "first again"]);
});
