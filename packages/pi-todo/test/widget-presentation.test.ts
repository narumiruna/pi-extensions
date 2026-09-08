import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	renderCompletionSummary,
	renderTodoWidget,
	sanitizeTodoText,
} from "../src/widget-renderer.js";
import { identityTheme } from "./todo-harness.js";

for (const [name, raw, expected] of [
	["plain Unicode", "  界 e\u0301 👩‍💻  ", "界 e\u0301 👩‍💻"],
	["control spacing", "one\u0000two\u0007three\u007ffour", "one two three four"],
	["line spacing", "one\r\ntwo\tthree\u2028four", "one two three four"],
	["Bidi removal", "one\u202etwo\u2066three", "onetwothree"],
	["ANSI styles", "one\u001b[31mtwo\u001b[0m", "onetwo"],
	["hyperlink", "\u001b]8;;https://example.com\u0007label\u001b]8;;\u001b\\", "label"],
	["unterminated OSC", "safe\u001b]8;;hidden", "safe"],
	["unterminated CSI", "safe\u001b[31", "safe"],
	["C1 string", "safe\u009dhidden\u009cvisible", "safevisible"],
] as const) {
	test(`Todo shared sanitizer: ${name}`, () => {
		assert.equal(sanitizeTodoText(raw), expected);
		const todos = [{ step: raw, status: "pending" as const }];
		const before = structuredClone(todos);
		renderTodoWidget(todos, identityTheme().theme, 80);
		assert.deepEqual(todos, before);
	});
}

for (const width of [0, 1, 2, 10, 80]) {
	test(`Todo separators preserve row ownership at width ${width}`, () => {
		const { theme, calls } = identityTheme();
		for (const lines of [
			renderCompletionSummary(2, theme, width),
			renderTodoWidget([{ step: "pending", status: "pending" }], theme, width),
		]) {
			assert.equal(lines[0], "─".repeat(width));
			assert.equal(
				lines.filter((line) => width > 0 && line === "─".repeat(width)).length,
				width > 0 ? 1 : 0,
			);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
		assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "borderMuted") || width === 0);
	});
}
