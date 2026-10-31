import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { wrapFormattedStatusline } from "../src/pi-starship.js";

const WIDTHS = [1, 2, 8, 20, 40, 80, 160] as const;
const OVERSIZED_CONJUNCT = `${"क्".repeat(41)}क`;
const LINK_OPEN = "\x1b]8;;https://example.test\x07";
const LINK_CLOSE = "\x1b]8;;\x07";
const ORDINARY = [
  "",
  "first line\nsecond line\n",
  "one two three four five six seven eight",
  "a".repeat(175),
  "\x1b[38;2;80;120;200mcolored words remain wrapped\x1b[0m",
  "\x1b[38;5;140m256-color words\x1b[0m",
  `${LINK_OPEN}linked words wrap normally${LINK_CLOSE} tail`,
  "cafe\u0301 ".repeat(12),
] as const;

test.each(WIDTHS)("ordinary footer wrapping at width %i preserves native rows byte-for-byte", (width) => {
  for (const text of ORDINARY) {
    const native = wrapTextWithAnsi(text, width);
    assert.ok(native.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(wrapFormattedStatusline(text, width), native);
  }
});

test("non-positive footer widths render no rows", () => {
  for (const width of [0, -1, -20]) {
    for (const text of [...ORDINARY, "界", OVERSIZED_CONJUNCT]) {
      assert.deepEqual(wrapFormattedStatusline(text, width), []);
    }
  }
});

test("oversized grapheme fixtures include a valid filesystem component and a multi-cell cluster", () => {
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(OVERSIZED_CONJUNCT)].length, 1);
  assert.ok(Buffer.byteLength(OVERSIZED_CONJUNCT) <= 255);
  assert.ok(visibleWidth(OVERSIZED_CONJUNCT) > 40);
});

for (const [name, grapheme] of [
  ["CJK", "界"],
  ["emoji", "👩‍💻"],
  ["Indic conjunct", "क्ष्म"],
  ["long Indic conjunct", OVERSIZED_CONJUNCT],
] as const) {
  test.each(WIDTHS)(`${name}: final footer rows fit width %i without splitting a grapheme`, (width) => {
    const fixtures = [
      grapheme,
      `prefix/${grapheme}/suffix`,
      `first\n${grapheme}\nlast`,
      `\x1b[38;2;80;120;200m${grapheme}\x1b[0m tail`,
      `\x1b[38;5;140m${grapheme}\x1b[0m tail`,
      `${LINK_OPEN}${grapheme}${LINK_CLOSE} tail`,
    ];
    for (const text of fixtures) {
      const native = wrapTextWithAnsi(text, width);
      const actual = wrapFormattedStatusline(text, width);
      assert.equal(actual.length, native.length);
      for (const [index, line] of actual.entries()) {
        const original = native[index] ?? "";
        assert.ok(visibleWidth(line) <= width, `${name}/${width}: ${JSON.stringify(line)}`);
        if (visibleWidth(original) <= width) {
          assert.equal(line, original);
        } else {
          assert.equal(line, truncateToWidth(original, width, "…"));
          assert.match(stripVTControlCharacters(line), /…$/u);
          assert.ok(!stripVTControlCharacters(line).includes(grapheme), "do not split an oversized cluster");
        }
      }
      assert.deepEqual(wrapFormattedStatusline(text, width), actual);
    }
  });
}
