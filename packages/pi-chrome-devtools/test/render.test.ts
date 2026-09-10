import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { renderTextResult, renderToolCall, withStatus } from "../src/render.js";

const plainTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};
const theme = {
	...plainTheme,
	fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
};

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function renderExpanded(text: string, width: number) {
	return renderTextResult(textResult(text), { expanded: true, isPartial: false }, theme).render(
		width,
	);
}

test("expanded evaluation output stays within the supplied terminal width", () => {
	const value = "一一一一一".repeat(50);
	const output = JSON.stringify({ result: { type: "string", value } }, null, 2);
	const width = 110;
	const lines = renderExpanded(output, width);

	assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test.each([
	{ name: "CJK at one column", input: "一", width: 1, expected: "" },
	{ name: "emoji at three columns", input: "🙂".repeat(3), width: 3, expected: "🙂" },
	{
		name: "combining graphemes",
		input: "e\u0301".repeat(5),
		width: 3,
		expected: "e\u0301".repeat(3),
	},
	{ name: "zero-width rendering", input: "abc", width: 0, expected: "" },
])("bounds $name without splitting graphemes", ({ input, width, expected }) => {
	const lines = renderExpanded(input, width);

	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	assert.equal(stripTerminalSequences(lines[0] ?? ""), expected);
});

test("expanded output sanitizes terminal controls before truncation", () => {
	const input =
		"safe\u001b[31m red\u001b[0m" +
		"\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007" +
		"\u001b_hidden\u001b\\\u0001\u0085\u202eend";
	const result = textResult(input);
	const component = renderTextResult(result, { expanded: true, isPartial: false }, plainTheme);

	assert.deepEqual(component.render(80), ["safe redlink���end"]);
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, input);
	assert.deepEqual(
		renderTextResult(
			textResult("\u001b[31m".repeat(10_000)),
			{ expanded: true, isPartial: false },
			plainTheme,
		).render(80),
		[],
	);
});

test("tool rendering preserves compact, progress, tab, line, and truncation behavior", () => {
	assert.deepEqual(
		renderTextResult(textResult("hidden"), { expanded: false, isPartial: false }, theme).render(80),
		[],
	);
	assert.equal(
		stripTerminalSequences(
			renderTextResult(textResult("ignored"), { expanded: true, isPartial: true }, theme).render(
				80,
			)[0] ?? "",
		),
		"Running...",
	);
	assert.deepEqual(renderExpanded("first\tvalue\nsecond", 80).map(stripTerminalSequences), [
		"first   value",
		"second",
	]);
	assert.equal(stripTerminalSequences(renderExpanded("abcdef", 3)[0] ?? ""), "abc");
	assert.deepEqual(renderToolCall("evaluate")().render(0), [""]);
});

test("concurrent tool statuses restore the latest remaining activity", async () => {
	const statuses: Array<string | undefined> = [];
	const sessionManager = {};
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
	};
	const firstContext = { sessionManager, ui };
	const secondContext = { sessionManager, ui };
	let finishFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	let finishSecond: (() => void) | undefined;
	const secondBlocked = new Promise<void>((resolve) => {
		finishSecond = resolve;
	});
	const first = withStatus(firstContext, "first", () => firstBlocked);
	const second = withStatus(secondContext, "second", () => secondBlocked);
	finishFirst?.();
	await first;
	assert.equal(statuses.at(-1), "second");
	finishSecond?.();
	await second;
	assert.equal(statuses.at(-1), undefined);
});
