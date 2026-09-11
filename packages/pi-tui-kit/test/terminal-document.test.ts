import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "../src/terminal-document.js";

test("sanitizes multiline terminal documents without losing line feeds or tabs", () => {
  assert.equal(sanitizeTerminalDocument("a\r\nb\rc\td"), "a\nb\nc\td");
  assert.equal(sanitizeTerminalDocument("a\u0000b\u0085c\u007fd"), "a b c d");
  assert.equal(sanitizeTerminalDocument("left\u202eright\u2066end"), "leftrightend");
});

test("removes complete and unterminated terminal sequences", () => {
  assert.equal(sanitizeTerminalDocument("a\u001b[31mred\u001b[0mz"), "aredz");
  assert.equal(sanitizeTerminalDocument("a\u001b]8;;https://example.test\u0007link"), "alink");
  assert.equal(sanitizeTerminalDocument("safe\u001b]8;;unterminated"), "safe");
  assert.equal(sanitizeTerminalDocument("a\u001bXsecret\u001b\\z"), "az");
  assert.equal(sanitizeTerminalDocument("a\u0098secret\u009cz"), "az");
  assert.equal(sanitizeTerminalDocument("a\u001b[31\u001bXsecret\u001b\\z"), "az");
  assert.equal(sanitizeTerminalDocument("a\u001b]title\u001bXsecret\u001b\\z"), "az");
  assert.equal(sanitizeTerminalDocument("a\u001bPdata\u0098secret\u009cz"), "az");
  assert.equal(sanitizeTerminalDocument("a\u009b31\u0098secret\u009cz"), "az");
  assert.equal(sanitizeTerminalDocument("\u001b[".repeat(5_000)), "");
  assert.equal(sanitizeTerminalDocument("\u009b".repeat(5_000)), "");
  assert.equal(sanitizeTerminalDocument("safe\u009b31"), "safe");
});

test("hard wraps by cells while preserving graphemes and printable whitespace", () => {
  assert.deepEqual(hardWrapTerminalDocument("  a  b", 4), ["  a ", " b"]);
  assert.deepEqual(hardWrapTerminalDocument("a\tb", 5), ["a   b"]);
  assert.deepEqual(hardWrapTerminalDocument("abc\td", 5), ["abc d"]);
  assert.deepEqual(hardWrapTerminalDocument("abc\tde", 5), ["abc d", "e"]);
  assert.deepEqual(hardWrapTerminalDocument("e\u0301你🙂", 3), ["e\u0301你", "🙂"]);
  for (const line of hardWrapTerminalDocument("e\u0301你🙂", 3)) {
    assert.ok(visibleWidth(line) <= 3);
  }
});

test("handles oversized graphemes and unusable widths deterministically", () => {
  assert.deepEqual(hardWrapTerminalDocument("你", 1), ["?"]);
  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(hardWrapTerminalDocument("text", width), [""]);
  }
});
