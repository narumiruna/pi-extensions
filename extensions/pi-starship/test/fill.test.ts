import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BUILT_IN_CONFIG } from "../src/config.js";
import { parseFormat } from "../src/format/formatter.js";
import { renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";

function fixture(): StarshipRuntimeSnapshot {
	return {
		cwd: "/work",
		thinkingLevel: "off",
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		tokenTotals: { input: 0, output: 0, cost: 0 },
		gitBranch: null,
		extensionStatuses: new Map(),
		extensionStatusIconAliases: new Map(),
		now: new Date(0),
	};
}

const FILL = "${" + "fill}";

function fillConfig(format: string, symbol = " ") {
	const config = structuredClone(BUILT_IN_CONFIG);
	config.format = format;
	config.formatAst = parseFormat(format);
	config.modules.fill.symbol = symbol;
	config.modules.fill.format = "[$symbol]($style)";
	config.modules.fill.formatAst = parseFormat("[$symbol]($style)");
	return config;
}

test("fill aligns each logical line and divides multiple fills left to right", () => {
	const single = renderStatusline(fillConfig(`left${FILL}right\nshort${FILL}x`), fixture(), 12);
	assert.equal(stripAnsi(single.ansi), "left   right\nshort      x");
	assert.deepEqual(stripAnsi(single.ansi).split("\n").map(visibleWidth), [12, 12]);

	const multiple = renderStatusline(fillConfig(`a${FILL}b${FILL}c`), fixture(), 10);
	assert.equal(stripAnsi(multiple.ansi), "a    b   c");
	assert.equal(visibleWidth(multiple.ansi), 10);
});

test("fill repeats complete wide patterns, pads remainders, and terminates on zero width", () => {
	assert.equal(
		stripAnsi(renderStatusline(fillConfig(`L${FILL}R`, "界"), fixture(), 9).ansi),
		"L界界界 R",
	);
	assert.equal(
		stripAnsi(renderStatusline(fillConfig(`L${FILL}R`, "\u0301"), fixture(), 5).ansi),
		"L   R",
	);
	assert.equal(
		stripAnsi(renderStatusline(fillConfig(`overflow${FILL}x`), fixture(), 3).ansi),
		"overflowx",
	);
	assert.equal(renderStatusline(fillConfig("$fill"), fixture(), 0).ansi, "");
	assert.equal(stripAnsi(renderStatusline(fillConfig(`L${FILL}`), fixture(), 1).ansi), "L");
	assert.equal(stripAnsi(renderStatusline(fillConfig(`L${FILL}R`), fixture(), 2).ansi), "LR");
});

test("fill uses ANSI-aware Unicode and hyperlink width semantics", () => {
	const link = "\u001b]8;;https://example.test\u0007·\u001b]8;;\u0007";
	const config = fillConfig(`L${FILL}R`, link);
	config.modules.fill.style = "bold red";
	const rendered = renderStatusline(config, fixture(), 8);
	assert.equal(visibleWidth(rendered.ansi), 8);
	assert.match(rendered.ansi, /https:\/\/example\.test/u);
	assert.ok(rendered.ansi.includes(`${String.fromCharCode(27)}[31;1m`));
});

test("fill markers never escape into public chunks or ANSI", () => {
	const rendered = renderStatusline(fillConfig("[$fill](red)"), fixture(), 4);
	assert.equal(visibleWidth(rendered.ansi), 4);
	assert.ok(rendered.chunks.every((chunk) => typeof chunk.text === "string"));
	assert.doesNotMatch(rendered.ansi, /fill|marker/iu);
});

function stripAnsi(value: string): string {
	return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
