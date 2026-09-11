import assert from "node:assert/strict";
import { test } from "vitest";
import { safeTerminalText } from "../src/text.js";

test("terminal text removes carriage returns while preserving line feeds", () => {
  assert.equal(safeTerminalText("first\rrewrite\r\nsecond\nthird"), "firstrewrite\nsecond\nthird");
});
