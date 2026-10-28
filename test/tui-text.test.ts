import assert from "node:assert/strict";
import { test } from "vitest";
import { plainTuiText, stripTuiCursorMarkers } from "./tui-text.js";

test("plain TUI text removes host cursor markers and ANSI styles", () => {
  assert.equal(plainTuiText("\u001b_pi:c\u0007\u001b_pi:fc\u0007\u001b[7ma\u001b[0m\u001b_pi:/fc\u0007bc"), "abc");
});

test("cursor marker removal does not hide untrusted controls from safety tests", () => {
  const unsafe = "\u001b]0;unsafe\u0007\u0007\u009d\u009c\u001b[31m";
  assert.equal(stripTuiCursorMarkers(unsafe), unsafe);
  assert.equal(stripTuiCursorMarkers("\u001b_pi:unknown\u0007"), "\u001b_pi:unknown\u0007");
});
