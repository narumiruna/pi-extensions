import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { powerlineExtensionSeparator, renderPowerlineStatusline } from "../src/powerline.js";
import { formatConfiguredSegment } from "../src/render.js";
import { createDefaultConfig, normalizeStatuslineConfig } from "../src/settings.js";
import type { RenderItem, RenderSegment, SegmentName } from "../src/types.js";

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function segment(name: SegmentName, text: string, block: RenderSegment["block"]): RenderSegment {
	return { name, text, block, color: "accent" };
}

test("powerline renderer preserves configured segment order across repeated blocks", () => {
	const config = createDefaultConfig();
	const rendered = renderPowerlineStatusline(
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
	const rendered = renderPowerlineStatusline(
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

test("configured palette joins reordered time to an adjacent header block", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette.time = { fg: "#090c0c", bg: "#a3aed2" };
	const rendered = renderPowerlineStatusline(
		300,
		[segment("time", "time", "meter"), segment("brand", "brand", "header")],
		config,
	);
	assert.equal(plain(rendered), "░▒▓ time brand");
	assert.equal((plain(rendered).match(//gu) ?? []).length, 1);
});

test("partial custom palette leaves omitted colors unstyled", () => {
	const config = normalizeStatuslineConfig({ palette: { time: { fg: "#ffffff" } } }).config;
	const rendered = renderPowerlineStatusline(300, [segment("time", "time", "meter")], config);
	assert.equal(rendered, `░▒▓${ESCAPE}[38;2;255;255;255m time${ESCAPE}[0m`);
});

test("empty custom palette renders without ANSI color fallback", () => {
	const config = normalizeStatuslineConfig({ palette: {} }).config;
	const rendered = renderPowerlineStatusline(
		300,
		[segment("model", "model", "header"), segment("cwd", "cwd", "directory")],
		config,
	);
	assert.equal(rendered, "░▒▓ model cwd");
	assert.equal(powerlineExtensionSeparator({} as Theme, "custom"), " • ");
});

test("different final segment colors retain the powerline transition", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette.time = { ...config.palette.time, bg: "#123456" };
	const rendered = renderPowerlineStatusline(
		300,
		[segment("time", "time", "meter"), segment("brand", "brand", "header")],
		config,
	);
	assert.equal(plain(rendered), "░▒▓ time brand");
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
	const rendered = renderPowerlineStatusline(300, items, config);
	assert.deepEqual(plain(rendered).split("\n"), ["░▒▓ model", "░▒▓ cwd", "░▒▓ branch"]);
});

test("responsive fitting keeps primary and active information ahead of decorative segments", () => {
	const config = createDefaultConfig();
	const items = [
		segment("brand", "BRAND", "header"),
		segment("provider", "PROVIDER", "header"),
		segment("model", "MODEL", "header"),
		segment("thinking", "THINKING", "header"),
		segment("cwd", "WORKSPACE", "directory"),
		segment("branch", "BRANCH", "git"),
		segment("tools", "ACTIVE", "runtime"),
		segment("context", "CONTEXT", "runtime"),
		segment("tokens", "TOKENS", "runtime"),
		segment("cost", "COST", "meter"),
		segment("time", "TIME", "meter"),
		segment("turn", "TURN", "meter"),
	];

	const normal = plain(renderPowerlineStatusline(60, items, config));
	assert.ok(visibleWidth(normal) <= 60);
	for (const value of ["MODEL", "WORKSPACE", "BRANCH", "ACTIVE", "CONTEXT"]) {
		assert.match(normal, new RegExp(value, "u"));
	}
	assert.doesNotMatch(normal, /BRAND|PROVIDER|TOKENS|TIME|TURN/u);

	const narrow = plain(renderPowerlineStatusline(40, items, config));
	assert.ok(visibleWidth(narrow) <= 40);
	for (const value of ["MODEL", "BRANCH", "ACTIVE", "CONTEXT"]) {
		assert.match(narrow, new RegExp(value, "u"));
	}
	assert.doesNotMatch(narrow, /BRAND|PROVIDER|THINKING|WORKSPACE|TOKENS|COST|TIME|TURN/u);
});

test("responsive fitting preserves explicit row boundaries and fits every rendered line", () => {
	const config = createDefaultConfig();
	const rendered = renderPowerlineStatusline(
		15,
		[
			segment("brand", "DECORATION", "header"),
			segment("context", "CONTEXT", "runtime"),
			{ name: "line_break" },
			segment("model", "MODEL", "header"),
			segment("time", "CLOCK", "meter"),
		],
		config,
	);
	const lines = plain(rendered).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /CONTEXT/u);
	assert.doesNotMatch(lines[0] ?? "", /DECORATION/u);
	assert.match(lines[1] ?? "", /MODEL/u);
	assert.doesNotMatch(lines[1] ?? "", /CLOCK/u);
	assert.ok(lines.every((line) => visibleWidth(line) <= 15));
});

test("responsive fitting truncates one oversized segment and preserves empty explicit rows", () => {
	const config = createDefaultConfig();
	const oversized = renderPowerlineStatusline(
		8,
		[segment("model", "A VERY LONG MODEL", "header")],
		config,
	);
	assert.ok(visibleWidth(oversized) <= 8);

	const multiline = renderPowerlineStatusline(
		20,
		[{ name: "line_break" }, segment("model", "MODEL", "header"), { name: "line_break" }],
		config,
	);
	const lines = multiline.split("\n");
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "");
	assert.equal(lines[2], "");
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
});

test("density and separator configure text inside a contiguous block", () => {
	const config = createDefaultConfig();
	config.separator = "dot";
	config.density = "compact";
	assert.equal(
		plain(
			renderPowerlineStatusline(
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
			renderPowerlineStatusline(
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
		config.palettePreset = palette;
		config.palette.model = { fg: "#ffffff", bg: "#ffffff" };
		const output = renderPowerlineStatusline(
			300,
			[segment("model", "model", "header"), segment("cwd", "cwd", "directory")],
			config,
		);
		assert.equal(plain(output), "░▒▓ model cwd");
		outputs.add(output);
	}
	assert.equal(outputs.size, 7);
});

test("named palettes use cohesive preset-specific background ramps", () => {
	const expected = {
		ocean: ["#7dcfff", "#4f9fba", "#2d6f88", "#23475b", "#182b3a"],
		sunset: ["#ffcf70", "#f59e6f", "#dc718a", "#8f5b78", "#493447"],
		forest: ["#a7c080", "#83c092", "#5f9f75", "#3f6f55", "#293f35"],
		candy: ["#f5c2e7", "#cba6f7", "#89b4fa", "#745f9a", "#403a5c"],
		neon: ["#39ff14", "#00f5ff", "#ff4fd8", "#7a2cf3", "#29134f"],
		mono: ["#d4d4d4", "#a3a3a3", "#686868", "#404040", "#262626"],
	} as const;
	const samples = [
		segment("model", "model", "header"),
		segment("cwd", "cwd", "directory"),
		segment("branch", "branch", "git"),
		segment("tools", "tools", "runtime"),
		segment("time", "time", "meter"),
	];

	for (const [palettePreset, colors] of Object.entries(expected)) {
		const config = createDefaultConfig();
		config.palettePreset = palettePreset as keyof typeof expected;
		const actual = samples.map((item) =>
			backgroundColor(renderPowerlineStatusline(80, [item], config)),
		);
		assert.deepEqual(actual, colors, palettePreset);
	}
});

test("named palette block text meets WCAG AA contrast", () => {
	const samples = [
		segment("model", "model", "header"),
		segment("cwd", "cwd", "directory"),
		segment("branch", "branch", "git"),
		segment("tools", "tools", "runtime"),
		segment("time", "time", "meter"),
	];

	for (const palettePreset of ["ocean", "sunset", "forest", "candy", "neon", "mono"] as const) {
		const config = createDefaultConfig();
		config.palettePreset = palettePreset;
		for (const item of samples) {
			const rendered = renderPowerlineStatusline(80, [item], config);
			const colors = blockColors(rendered);
			assert.ok(colors, `${palettePreset} ${item.block} colors`);
			assert.ok(
				contrastRatio(colors.fg, colors.bg) >= 4.5,
				`${palettePreset} ${item.block} contrast`,
			);
		}
	}
});

function backgroundColor(rendered: string): string | undefined {
	const match = /48;2;(\d+);(\d+);(\d+)/u.exec(rendered);
	return match ? rgbMatchToHex(match.slice(1)) : undefined;
}

function blockColors(rendered: string): { fg: string; bg: string } | undefined {
	const match = /38;2;(\d+);(\d+);(\d+);48;2;(\d+);(\d+);(\d+)/u.exec(rendered);
	return match
		? { fg: rgbMatchToHex(match.slice(1, 4)), bg: rgbMatchToHex(match.slice(4, 7)) }
		: undefined;
}

function rgbMatchToHex(components: string[]): string {
	return `#${components
		.map((component) => Number(component).toString(16).padStart(2, "0"))
		.join("")}`;
}

function contrastRatio(left: string, right: string): number {
	const luminances = [left, right].map(relativeLuminance);
	const lighter = Math.max(...luminances);
	const darker = Math.min(...luminances);
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/../gu)
		?.map((component) => Number.parseInt(component, 16) / 255)
		.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) ?? [
		0, 0, 0,
	];
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

test("segment presentation wraps canonical dynamic values with configured text", () => {
	const config = createDefaultConfig();
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "🔌 anthropic");
	config.segmentText.provider = { prefix: "Provider[", suffix: "]" };
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "Provider[anthropic]");
	config.segmentText.cost = { prefix: "cost=", suffix: " USD" };
	assert.equal(formatConfiguredSegment("cost", "1.25", config), "cost=1.25 USD");
});

test("empty segment arrays render no powerline content", () => {
	assert.equal(renderPowerlineStatusline(80, [], createDefaultConfig()), "");
});
