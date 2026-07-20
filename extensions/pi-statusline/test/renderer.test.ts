import assert from "node:assert/strict";
import test from "node:test";
import { formatConfiguredSegment } from "../src/render.js";
import { createDefaultConfig } from "../src/settings.js";
import { renderTokyoNightStatusline } from "../src/tokyo-night.js";
import type { RenderItem, RenderSegment, SegmentName } from "../src/types.js";

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function segment(name: SegmentName, text: string, block: RenderSegment["block"]): RenderSegment {
	return { name, text, block, color: "accent" };
}

test("Tokyo Night renderer preserves configured segment order across repeated blocks", () => {
	const config = createDefaultConfig();
	const rendered = renderTokyoNightStatusline(
		300,
		[
			segment("model", "model", "header"),
			segment("time", "time", "meter"),
			segment("provider", "provider", "header"),
		],
		config,
	);
	assert.match(plain(rendered), /^░▒▓ model time provider$/u);
});

test("Tokyo Night default retains the exact powerline colors", () => {
	const rendered = renderTokyoNightStatusline(
		300,
		[segment("model", "model", "header")],
		createDefaultConfig(),
	);
	assert.equal(
		rendered,
		"\u001b[38;2;163;174;210m░▒▓\u001b[0m" +
			"\u001b[38;2;9;12;12;48;2;163;174;210m model\u001b[0m" +
			"\u001b[38;2;163;174;210m\u001b[0m",
	);
});

test("line breaks render separated repeated markers as independent powerline rows", () => {
	const config = createDefaultConfig();
	const items: RenderItem[] = [
		segment("model", "model", "header"),
		{ name: "line_break" },
		segment("cwd", "cwd", "directory"),
		{ name: "line_break" },
		segment("branch", "branch", "git"),
	];
	const rendered = renderTokyoNightStatusline(300, items, config);
	assert.deepEqual(plain(rendered).split("\n"), ["░▒▓ model", "░▒▓ cwd", "░▒▓ branch"]);
});

test("density and separator configure text inside a contiguous block", () => {
	const config = createDefaultConfig();
	config.separator = "dot";
	config.density = "compact";
	assert.equal(
		plain(
			renderTokyoNightStatusline(
				300,
				[segment("provider", "one", "header"), segment("model", "two", "header")],
				config,
			),
		),
		"░▒▓ one • two",
	);
	config.density = "cozy";
	assert.equal(
		plain(
			renderTokyoNightStatusline(
				300,
				[segment("provider", "one", "header"), segment("model", "two", "header")],
				config,
			),
		),
		"░▒▓  one  •  two ",
	);
});

test("all named palettes render deterministic distinct ANSI output", () => {
	const outputs = new Set<string>();
	for (const palette of [
		"tokyo-night",
		"ocean",
		"sunset",
		"forest",
		"candy",
		"neon",
		"mono",
	] as const) {
		const config = createDefaultConfig();
		config.palette = palette;
		const output = renderTokyoNightStatusline(
			300,
			[segment("model", "model", "header"), segment("cwd", "cwd", "directory")],
			config,
		);
		assert.equal(plain(output), "░▒▓ model cwd");
		outputs.add(output);
	}
	assert.equal(outputs.size, 7);
});

test("segment presentation wraps canonical dynamic values with configured text", () => {
	const config = createDefaultConfig();
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "🔌 anthropic");
	config.segmentText.provider = { prefix: "Provider[", suffix: "]" };
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "Provider[anthropic]");
	config.segmentText.cost = { prefix: "cost=", suffix: " USD" };
	assert.equal(formatConfiguredSegment("cost", "1.25", config), "cost=1.25 USD");
});

test("empty segment arrays render no powerline content", () => {
	assert.equal(renderTokyoNightStatusline(80, [], createDefaultConfig()), "");
});
