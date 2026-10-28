import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  renderFakeCursor,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMenuScreenComponent } from "../src/components/index.js";
import { createPiSelector } from "../src/components/pi-selectors.js";
import { selectedLabelFallback } from "../src/components/rendering.js";
import type { MenuScreen } from "../src/types.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters).join("\n");

test.each([
  { name: "missing label and row", label: undefined, row: undefined, expected: [] },
  { name: "missing label", label: undefined, row: "→ Selected", expected: [] },
  { name: "empty label", label: "", row: "→ Selected", expected: [] },
  { name: "missing row", label: "Selected", row: undefined, expected: ["Selected"] },
  { name: "empty row", label: "Selected", row: "", expected: ["Selected"] },
  { name: "complete label", label: "Selected", row: "→ Selected", expected: [] },
  { name: "absent label", label: "Selected", row: "→ Other", expected: ["Selected"] },
  { name: "clipped label", label: "Selected", row: "→ Selec…", expected: ["Selected"] },
  { name: "Unicode label", label: "讀取 📖 e\u0301", row: "→ 讀取 📖 e\u0301", expected: [] },
  {
    name: "clipped Unicode label keeps the original value",
    label: " 讀取 📖 e\u0301 ",
    row: "→ 讀取…",
    expected: [" 讀取 📖 e\u0301 "],
  },
  { name: "SGR around the label", label: "Selected", row: "→ \x1b[31mSelected\x1b[0m", expected: [] },
  { name: "SGR within the label", label: "Selected", row: "→ Se\x1b[31mlect\x1b[0med", expected: [] },
  {
    name: "OSC 8 link with BEL terminators",
    label: "Selected",
    row: "→ \x1b]8;;https://example.test\x07Selected\x1b]8;;\x07",
    expected: [],
  },
  {
    name: "OSC 8 link with ST terminators",
    label: "Selected",
    row: "→ \x1b]8;;https://example.test\x1b\\Selected\x1b]8;;\x1b\\",
    expected: [],
  },
  {
    name: "link metadata is not visible label text",
    label: "Selected",
    row: "→ \x1b]8;;https://example.test/Selected\x07Other\x1b]8;;\x07",
    expected: ["Selected"],
  },
  {
    name: "Pi cursor markers around the label",
    label: "Selected",
    row: `→ ${CURSOR_MARKER}${renderFakeCursor("Selected")}`,
    expected: [],
  },
  {
    name: "Pi cursor markers within the label",
    label: "Selected",
    row: `→ Se${CURSOR_MARKER}${renderFakeCursor("l")}ected`,
    expected: [],
  },
  {
    name: "APC with an ST terminator within the label",
    label: "Selected",
    row: "→ Se\x1b_pi:c\x1b\\lected",
    expected: [],
  },
  {
    name: "Pi cursor metadata is not visible label text",
    label: "pi:c",
    row: `${CURSOR_MARKER}→ Other`,
    expected: ["pi:c"],
  },
  {
    name: "Pi cursor markers do not conceal label clipping",
    label: "Selected",
    row: `→ Selec${CURSOR_MARKER}${renderFakeCursor("…")}`,
    expected: ["Selected"],
  },
])("selected label fallback: $name", ({ label, row, expected }) => {
  assert.deepEqual(selectedLabelFallback(label, row), expected);
});

function menu(screen: MenuScreen<"screen", "apply">, rows = 30, selectedItemId = "selected") {
  return createMenuScreenComponent({
    screen,
    selectedItemId,
    tui: { terminal: { rows }, requestRender() {} },
    theme,
    keybindings: keys,
    onEvent() {},
  });
}

for (const kind of ["actions", "choice"] as const) {
  test(`${kind} retains selected descriptions and disabled reasons below the inline-description width`, () => {
    const items = [
      {
        id: "selected",
        label: "Selected",
        description: "Explain the selected alternative",
        disabled: true,
        disabledReason: "Permission\x07 required",
        action: "apply" as const,
      },
    ];
    const screen: MenuScreen<"screen", "apply"> =
      kind === "actions"
        ? { kind, title: "Options", items }
        : { kind, title: "Options", items, action: "apply", currentItemId: "selected" };
    const component = menu(screen);
    for (const width of [20, 40, 41, 79, 80, 120]) {
      const lines = component.render(width);
      const text = plain(lines);
      assert.ok(text.replace(/\s+/gu, " ").includes("Explain the selected alternative"), `${kind} at ${width}`);
      assert.match(text.replace(/\s+/gu, " "), /Unavailable: Permission required/u);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(lines[0], "─".repeat(width));
      assert.equal(lines.at(-1), "─".repeat(width));
      assert.equal(text.includes("\x07"), false);
    }
    component.dispose?.();
  });
}

test("choice keeps cursor and current identity separate, including one-row clipping", () => {
  for (const rows of [4, 5, 6, 8, 10, 24]) {
    const component = menu(
      {
        kind: "choice",
        title: "Choices",
        enableSearch: true,
        action: "apply",
        currentItemId: "current",
        items: [
          { id: "current", label: "Current" },
          { id: "selected", label: "Selected" },
        ],
      },
      rows,
    );
    for (const width of [0, 1, 20, 40, 79, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.length <= rows - 3);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width === 0) assert.deepEqual(lines, []);
      else assert.match(plain(lines), /→/u, `selected row at ${width}x${rows}`);
    }
    if (rows === 24) assert.match(plain(component.render(80)), /Current ✓ current[\s\S]*→ Selected/u);
    component.dispose?.();
  }
});

test("model-style selector retains selection, current, default and wrapped descriptions", () => {
  for (const rows of [4, 5, 6, 8, 10, 30]) {
    const component = createPiSelector({
      rows: [
        { value: "current", primary: "Current", current: true },
        {
          value: "selected",
          primary: "Selected",
          default: true,
          description: "Explain the selected alternative completely",
        },
      ],
      initialValue: "selected",
      saveBinding: "app.models.save",
      filterSelection: "bestMatch",
      valueEquals: (left, right) => left === right,
      onComplete() {},
      tui: { terminal: { rows }, requestRender() {} } as never,
      theme: theme as never,
      keybindings: keys as never,
    });
    for (const width of [0, 1, 20, 40, 79, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.length <= rows - 3);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width > 0) assert.match(plain(lines), /→/u, `${width}x${rows}`);
    }
    if (rows === 30) {
      const text = plain(component.render(20));
      assert.match(text, /✓ Current/u);
      assert.match(text, /→ {3}Selected/u);
      assert.match(plain(component.render(80)), /Selected · default/u);
      assert.ok(text.replace(/\s+/gu, " ").includes("Explain the selected alternative completely"));
    }
    component.dispose();
  }
});

test("empty filtered selectors retain recovery guidance instead of only the query", () => {
  const choice = menu(
    {
      kind: "choice",
      title: "Choices",
      action: "apply",
      enableSearch: true,
      items: [{ id: "selected", label: "Selected" }],
    },
    4,
  );
  choice.handleInput("\x1b[200~missing\x1b[201~");
  assert.match(plain(choice.render(80)), /No matching choices; edit search/u);
  choice.dispose?.();
  const selector = createPiSelector({
    rows: [{ value: "one", primary: "One" }],
    initialSearchInput: "missing",
    saveBinding: "app.models.save",
    filterSelection: "bestMatch",
    valueEquals: (left, right) => left === right,
    onComplete() {},
    tui: { terminal: { rows: 4 }, requestRender() {} } as never,
    theme: theme as never,
    keybindings: keys as never,
  });
  assert.match(plain(selector.render(80)), /No matching options; edit search/u);
  selector.dispose();
});

test("selector framing uses the callback border role after theme invalidation", () => {
  let active = rendererTheme("dark");
  const component = createPiSelector({
    rows: [{ value: "one", primary: "One", current: true, default: true }],
    saveBinding: "app.models.save",
    filterSelection: "bestMatch",
    valueEquals: (left, right) => left === right,
    onComplete() {},
    tui: { terminal: { rows: 24 }, requestRender() {} } as never,
    theme: { fg: (role: Parameters<typeof active.fg>[0], text: string) => active.fg(role, text) } as never,
    keybindings: keys as never,
  });
  const before = component.render(40);
  for (const next of [rendererTheme("light"), rendererTheme("light", true)]) {
    active = next;
    component.invalidate();
    const after = component.render(40);
    assert.equal(plain(after), plain(before));
    assert.equal(after[0], active.fg("border", "─".repeat(40)));
    assert.equal(after.at(-1), active.fg("border", "─".repeat(40)));
  }
  component.dispose();
});
