import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeMetadataText, sanitizeTerminalText } from "../src/metadata.js";

for (const [name, raw, expected] of [
  ["Unicode", "界 e\u0301 👩‍💻", "界 e\u0301 👩‍💻"],
  ["line separators", "one\ntwo\tthree", "one two three"],
  ["control removal", "one\u0000two", "onetwo"],
  ["Bidi removal", "one\u202etwo", "onetwo"],
  ["ANSI styles", "\u001b[31mred\u001b[0m", "red"],
  ["OSC link", "\u001b]8;;https://example.com\u0007label\u001b]8;;\u001b\\", "label"],
  ["unterminated OSC", "safe\u001b]hidden", "safe"],
  ["unterminated CSI", "safe\u001b[31", "safe"],
] as const) {
  test(`Stamp display sanitizer: ${name}`, () => {
    assert.equal(sanitizeTerminalText(raw), expected);
  });
}

test("Stamp persisted metadata keeps its historical normalization", () => {
  const raw = { modelId: "one\u0000two\u202ethree", label: "\u001b[31mred" };
  const before = structuredClone(raw);
  assert.equal(sanitizeMetadataText(raw.modelId), "one two three");
  assert.equal(sanitizeMetadataText(raw.label), "[31mred");
  assert.deepEqual(raw, before);
});
