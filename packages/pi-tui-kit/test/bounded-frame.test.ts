import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type BoundedFrameOptions, renderBoundedFrame, renderBoundedFrameLayout } from "../src/bounded-frame.js";

const options: BoundedFrameOptions = {
  width: 80,
  maxRows: 24,
  rule: "─".repeat(80),
  title: ["Settings"],
  context: ["Current session"],
  content: ["", "Search", "", "First", "Focused", "Other", "", "Description", "Saving…"],
  hints: ["enter change • esc back • ctrl+c close"],
  compactHint: "esc back",
  priorityRows: [1, 4, 8],
  focusedRow: 4,
};

test("bounded frame preserves the full presentation and caller state", () => {
  const before = structuredClone(options);
  assert.deepEqual(renderBoundedFrame(options), [
    options.rule,
    "Settings",
    "Current session",
    "",
    ...options.content,
    ...(options.hints ?? []),
    options.rule,
  ]);
  assert.deepEqual(options, before);
});

for (const width of [0, 1, 2, 12, 80]) {
  for (const maxRows of [0, 1, 2, 3, 4, 5, 8, 24]) {
    test(`bounded frame fits ${width} columns and ${maxRows} rows`, () => {
      const frameOptions = { ...options, width, maxRows };
      const { lines, contentRows } = renderBoundedFrameLayout(frameOptions);
      assert.deepEqual(lines, renderBoundedFrame(frameOptions));
      assert.ok(lines.length <= maxRows);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      for (const { contentIndex, frameIndex } of contentRows) {
        assert.ok(contentIndex >= 0 && contentIndex < options.content.length);
        assert.ok(frameIndex >= 0 && frameIndex < lines.length);
      }
      assert.equal(new Set(contentRows.map((row) => row.frameIndex)).size, contentRows.length);
    });
  }
}

test("compact priorities refer to original indexes, not cursor glyphs or compact indexes", () => {
  const result = renderBoundedFrame({
    ...options,
    maxRows: 4,
    content: ["", "Selected without cursor", "→ Not selected", "", "Saving"],
    priorityRows: [4, 1, 4, 0, -1, 1.5, Number.NaN, 99],
    focusedRow: 1,
  });
  assert.deepEqual(result, ["Settings", "Selected without cursor", "Saving", "enter change • esc back • ctrl+c close"]);
});

test("a one-row viewport preserves the first caller priority", () => {
  assert.deepEqual(renderBoundedFrame({ ...options, maxRows: 1, priorityRows: [8, 4] }), ["Saving…"]);
});

test("focus proximity fills rows without reordering output", () => {
  assert.deepEqual(
    renderBoundedFrame({
      width: 20,
      maxRows: 3,
      rule: "─",
      title: [],
      content: ["zero", "one", "two", "three", "four"],
      priorityRows: [3],
      focusedRow: 3,
    }),
    ["two", "three", "four"],
  );
});

test("compact mode retains a standalone compact hint and ignores blank priorities", () => {
  assert.deepEqual(
    renderBoundedFrame({
      width: 20,
      maxRows: 2,
      rule: "─",
      title: [],
      content: ["", "item", "other"],
      priorityRows: [0, 1],
      compactHint: "ctrl+c close",
    }),
    ["item", "ctrl+c close"],
  );
});

test("static and empty frames remain readable at tiny heights", () => {
  assert.deepEqual(renderBoundedFrame({ ...options, content: [], maxRows: 1 }), ["Current session"]);
  assert.deepEqual(renderBoundedFrame({ ...options, title: [], context: [], content: [], maxRows: 1 }), ["esc back"]);
});

test("resizing restores descriptions, styling, and frame without cached dimensions", () => {
  const styled = {
    ...options,
    content: options.content.map((line) => `\u001b[31m${line}\u001b[0m`),
  };
  const full = renderBoundedFrame(styled);
  assert.ok(full.some((line) => stripVTControlCharacters(line) === "Description"));
  const tiny = renderBoundedFrame({ ...styled, maxRows: 1 });
  assert.equal(stripVTControlCharacters(tiny[0] ?? ""), "Search");
  assert.deepEqual(renderBoundedFrame(styled), full);
});

test("layout metadata maps duplicate and blank rows by original identity in a full frame", () => {
  const frameOptions = { ...options, content: ["same", "", "same"], maxRows: 24 };
  const before = structuredClone(frameOptions);
  const layout = renderBoundedFrameLayout(frameOptions);
  assert.deepEqual(layout.contentRows, [
    { contentIndex: 0, frameIndex: 4 },
    { contentIndex: 1, frameIndex: 5 },
    { contentIndex: 2, frameIndex: 6 },
  ]);
  assert.deepEqual(
    layout.contentRows.map(({ frameIndex }) => layout.lines[frameIndex]),
    frameOptions.content,
  );
  assert.deepEqual(frameOptions, before);
});

test("compact metadata excludes dropped blank rows and tracks focused rows through resize", () => {
  const frameOptions: BoundedFrameOptions = {
    width: 20,
    maxRows: 2,
    rule: "─".repeat(20),
    title: [],
    content: ["same", "", "same", "focused", "tail"],
    priorityRows: [1, 3],
    focusedRow: 3,
  };
  const compact = renderBoundedFrameLayout(frameOptions);
  assert.deepEqual(compact.lines, ["same", "focused"]);
  assert.deepEqual(compact.contentRows, [
    { contentIndex: 2, frameIndex: 0 },
    { contentIndex: 3, frameIndex: 1 },
  ]);
  const full = renderBoundedFrameLayout({ ...frameOptions, maxRows: 20 });
  assert.deepEqual(
    full.contentRows.map(({ contentIndex }) => contentIndex),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(renderBoundedFrameLayout(frameOptions), compact);
  assert.deepEqual(renderBoundedFrameLayout({ ...frameOptions, width: 0 }).contentRows, compact.contentRows);
});

test("layout metadata excludes all non-content rows and handles empty budgets", () => {
  assert.deepEqual(renderBoundedFrameLayout({ ...options, maxRows: 0 }), { lines: [], contentRows: [] });
  for (const maxRows of [1, 5, 24]) {
    assert.deepEqual(renderBoundedFrameLayout({ ...options, content: [], maxRows }).contentRows, []);
  }
});

for (const dimension of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid dimensions normalize to zero: ${dimension}`, () => {
    assert.deepEqual(renderBoundedFrame({ ...options, maxRows: dimension }), []);
    for (const line of renderBoundedFrame({ ...options, width: dimension })) {
      assert.equal(visibleWidth(line), 0);
    }
  });
}
