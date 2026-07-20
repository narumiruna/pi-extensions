import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	FormatSyntaxError,
	formatVariables,
	parseFormat,
	renderFormat,
} from "../src/format/formatter.js";
import { renderChunksToAnsi } from "../src/format/style.js";

function stripAnsi(value: string): string {
	const escapeSequence = String.fromCharCode(27);
	return value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
}

function render(
	format: string,
	variables: Record<string, string> = {},
	styleVariables: Record<string, string> = {},
) {
	return renderChunksToAnsi(
		renderFormat(parseFormat(format), {
			variables,
			styleVariables,
		}),
	);
}

test("formatter parses variables, scoped variables, literals, and escapes", () => {
	const ast = parseFormat(`left $model \${env:PWD} \\\\ \\[\\]\\(\\)\\$`);
	assert.deepEqual([...formatVariables(ast)].sort(), ["env:PWD", "model"]);
	assert.equal(
		renderChunksToAnsi(
			renderFormat(ast, {
				variables: { model: "opus", "env:PWD": "/repo" },
			}),
		),
		"left opus /repo \\ []()$",
	);
});

test("formatter supports nested text groups and style variables", () => {
	const output = render("outer [middle [inner](blue)]($style)", {}, { style: "red bold" });
	assert.match(output, /outer /);
	assert.ok(output.includes("\u001b[31;1mmiddle "));
	assert.ok(output.includes("\u001b[34minner"));
	assert.equal(stripAnsi(output), "outer middle inner");
});

test("module-owned styles take precedence over outer text-group styles", () => {
	const ast = parseFormat("[$model](red)");
	const output = renderChunksToAnsi(
		renderFormat(ast, {
			variables: {
				model: [{ text: "styled", style: { foreground: { kind: "named", name: "green" } } }],
			},
		}),
	);
	assert.ok(output.includes("\u001b[32mstyled"));
	assert.ok(!output.includes("\u001b[31mstyled"));
});

test("conditional groups render only when at least one nested variable is non-empty", () => {
	assert.equal(render("before (@$value) after", { value: "x" }), "before @x after");
	assert.equal(render("before (@$value) after", { value: "" }), "before  after");
	assert.equal(render("($one ($two))", { one: "", two: "yes" }), " yes");
});

test("formatter leaves unknown variables empty and reports referenced names", () => {
	const ast = parseFormat("$known$unknown$toString");
	assert.deepEqual([...formatVariables(ast)], ["known", "unknown", "toString"]);
	assert.equal(renderChunksToAnsi(renderFormat(ast, { variables: { known: "ok" } })), "ok");
});

test("formatter rejects unescaped functional characters and incomplete variables", () => {
	for (const format of ["[", "$ ", "text (", "[text]red", "${broken"]) {
		assert.throws(() => parseFormat(format), FormatSyntaxError, format);
	}
});

test("styles support named, ANSI, RGB, modifiers, none, and palettes", () => {
	const output = renderChunksToAnsi(
		renderFormat(parseFormat("[a](bold fg:accent bg:17)[b](#010203 underline)[c](none)"), {
			variables: {},
			palette: { accent: "bright-purple" },
		}),
	);
	assert.ok(output.includes("\u001b[95;48;5;17;1ma"));
	assert.ok(output.includes("\u001b[38;2;1;2;3;4mb"));
	assert.ok(output.endsWith("c"));

	const foregroundReset = render("[x](bold bg:red fg:none)");
	assert.ok(foregroundReset.includes("\u001b[41;1mx"));
	assert.equal(render("[x](fg:none)"), "x");
	assert.ok(render("[x](bold fg:red bg:none)").includes("\u001b[31;1mx"));
});

test("prev_fg and prev_bg inherit the previous rendered chunk colors", () => {
	const output = render("[a](fg:#112233 bg:17)[b](fg:prev_bg bg:prev_fg)");
	assert.ok(output.includes("\u001b[38;2;17;34;51;48;5;17ma"));
	assert.ok(output.includes("\u001b[38;5;17;48;2;17;34;51mb"));
});

test("formatter preserves OSC-8 hyperlinks and visible width", () => {
	const link = "\x1b]8;;https://example.test/pr/1\x07#1\x1b]8;;\x07";
	const output = renderChunksToAnsi(
		renderFormat(parseFormat("[$pr](blue)"), { variables: { pr: link } }),
	);
	assert.ok(output.includes(link));
	assert.equal(visibleWidth(output), 2);
});
