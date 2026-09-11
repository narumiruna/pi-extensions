import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { sanitizeTerminalText } from "../src/index.js";

test("sanitizes untrusted terminal display text without changing printable identity", () => {
  assert.equal(sanitizeTerminalText("model/😀/e\u0301"), "model/😀/e\u0301");
  assert.equal(sanitizeTerminalText("a\tb\nc\rd\u0085e\u2028f\u2029g"), "a b c d e f g");
  assert.equal(sanitizeTerminalText("a\u0000\u0007\u007f\u0080g"), "ag");
  assert.equal(sanitizeTerminalText("safe\u202eevil\u2066text"), "safeeviltext");
});

test("removes complete and unterminated terminal control sequences as units", () => {
  assert.equal(sanitizeTerminalText("before\u001b[31mred\u001b[0mafter"), "beforeredafter");
  assert.equal(sanitizeTerminalText("before\u009b31mred\u009b0mafter"), "beforeredafter");
  assert.equal(
    sanitizeTerminalText("before\u001b]8;;https://example.com\u0007label\u001b]8;;\u001b\\after"),
    "beforelabelafter",
  );
  assert.equal(sanitizeTerminalText("before\u001bPpayload\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b_private\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b^private\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b]unterminated"), "before");
  assert.equal(sanitizeTerminalText("before\u001b[31"), "before");
  assert.equal(sanitizeTerminalText("before\u001bXprivate\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u0098private\u009cafter"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b[31\u001bXprivate\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b]title\u001bXprivate\u001b\\after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001bPdata\u0098private\u009cafter"), "beforeafter");
  assert.equal(sanitizeTerminalText("\u001b[".repeat(5_000)), "");
  assert.equal(sanitizeTerminalText("\u009b".repeat(5_000)), "");
});

test("parses generic ESC sequences without corrupting following Unicode", () => {
  assert.equal(sanitizeTerminalText("before\u001b(0after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b#8after"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b!/Aafter"), "beforeafter");
  assert.equal(sanitizeTerminalText("before\u001b😀after"), "before😀after");
  assert.equal(sanitizeTerminalText("before\u001b(😀after"), "before(😀after");
});

test("composes with Pi TUI cell-aware truncation", () => {
  const sanitized = sanitizeTerminalText("\u001b[31m目標😀value\u001b[0m");
  assert.equal(sanitized.includes("\u001b"), false);
  const rendered = truncateToWidth(sanitized, 8, "");
  assert.ok(visibleWidth(rendered) <= 8);
});
