import assert from "node:assert/strict";
import { test } from "vitest";
import { formatKeyLabel } from "../src/text.js";

// These display-only contracts intentionally differ from Kit's lower-case hint groups.
// Fullscreen key reachability remains covered by fullscreen-ui.test.ts, not this formatter.
for (const [raw, label] of [
  ["ctrl+c", "Ctrl+C"],
  ["shift+ctrl+p", "Shift+Ctrl+P"],
  ["alt+super+k", "Alt+Super+K"],
  ["pageUp", "PageUp"],
  ["pageDown", "PageDown"],
  ["return", "Return"],
  ["escape", "Escape"],
  ["", ""],
] as const) {
  test(`btw retains its specialized label for ${raw || "empty input"}`, () => {
    assert.equal(formatKeyLabel(raw), label);
  });
}
