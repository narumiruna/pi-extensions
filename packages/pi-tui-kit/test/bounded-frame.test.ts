import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type BoundedFrameOptions, renderBoundedFrame } from "../src/index.js";

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
      const lines = renderBoundedFrame({ ...options, width, maxRows });
      assert.ok(lines.length <= maxRows);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
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

for (const dimension of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid dimensions normalize to zero: ${dimension}`, () => {
    assert.deepEqual(renderBoundedFrame({ ...options, maxRows: dimension }), []);
    for (const line of renderBoundedFrame({ ...options, width: dimension })) {
      assert.equal(visibleWidth(line), 0);
    }
  });
}
