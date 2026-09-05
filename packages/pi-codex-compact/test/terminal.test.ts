import assert from "node:assert/strict";
import { test } from "vitest";
import { terminalText } from "../src/terminal.js";

test("strips terminal controls without mutating printable text", () => {
	assert.equal(terminalText("model\u001b[31m\nname\u009b"), "model [31m name ");
	assert.equal(terminalText("openai/gpt-5.4"), "openai/gpt-5.4");
});
