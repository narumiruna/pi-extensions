import assert from "node:assert/strict";
import test from "node:test";

test("E2E runner discovers compiled Node tests", () => {
	assert.equal(typeof process.execPath, "string");
});
