import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_STATUSLINE_CONFIG,
	DEFAULT_STATUSLINE_DOCUMENT,
	loadOrCreateStatuslineSettings,
	normalizeStatuslineConfig,
	saveStatuslineSettingsDocument,
	settingsFilePath,
} from "../src/settings.js";

test("initial JSON exposes active defaults without materializing an inactive palette", () => {
	assert.equal(DEFAULT_STATUSLINE_CONFIG.palettePreset, "tokyo-night");
	assert.deepEqual(DEFAULT_STATUSLINE_CONFIG.palette.time, {
		fg: "#a0a9cb",
		bg: "#1d2230",
	});
	assert.equal(DEFAULT_STATUSLINE_CONFIG.density, "compact");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.separator, "none");
	assert.deepEqual(DEFAULT_STATUSLINE_CONFIG.segments, [
		"brand",
		"provider",
		"model",
		"thinking",
		"cwd",
		"branch",
		"tools",
		"context",
		"tokens",
		"cost",
		"time",
	]);
	assert.equal(DEFAULT_STATUSLINE_CONFIG.segmentText.provider.prefix, "🔌 ");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.segmentText.turn.prefix, "🔁 #");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons.goal, "🎯");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons.usage, "📊");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons["codex-usage"], "📊");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons.accounts, "👤");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons["google-genai"], "✨");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons.retry, "🔁");
	assert.equal(DEFAULT_STATUSLINE_CONFIG.extensionStatusIcons.sync, "🔄");
	const defaultDocument = JSON.parse(DEFAULT_STATUSLINE_DOCUMENT);
	assert.deepEqual(defaultDocument, {
		palettePreset: "tokyo-night",
		density: "compact",
		separator: "none",
		segments: [
			"brand",
			"provider",
			"model",
			"thinking",
			"cwd",
			"branch",
			"tools",
			"context",
			"tokens",
			"cost",
			"time",
		],
		segmentText: DEFAULT_STATUSLINE_CONFIG.segmentText,
		extensionStatusIcons: {
			accounts: "👤",
			caffeinate: "💊",
			"chrome-devtools": "🌐",
			firecrawl: "🔥",
			"github-pr": "🔎",
			goal: "🎯",
			"google-genai": "✨",
			lsp: "🧰",
			"plan-mode": "📝",
			retry: "🔁",
			subagents: "🧑‍🤝‍🧑",
			sync: "🔄",
			usage: "📊",
		},
	});
	assert.equal(Object.hasOwn(defaultDocument.extensionStatusIcons, "pisync"), false);
	assert.equal(Object.hasOwn(defaultDocument.extensionStatusIcons, "unknown-error-retry"), false);
	assert.equal(Object.hasOwn(defaultDocument.extensionStatusIcons, "codex-usage"), false);
	assert.equal(DEFAULT_STATUSLINE_DOCUMENT.includes('"palette"'), false);
	assert.equal(DEFAULT_STATUSLINE_DOCUMENT.includes('"segmentText"'), true);
	assert.equal(DEFAULT_STATUSLINE_DOCUMENT.includes('"extensionStatusIcons"'), true);
	assert.equal(DEFAULT_STATUSLINE_DOCUMENT.endsWith("\n"), true);
});

test("normalization supports partial icon-only settings and structured overrides", () => {
	const normalized = normalizeStatuslineConfig({
		palette: "ocean",
		density: "cozy",
		separator: "dot",
		segments: ["model", "cwd", "turn"],
		segmentText: {
			model: { prefix: "Model: " },
			turn: { suffix: " turns" },
		},
		extensionStatusIcons: { goal: "", custom: "🧪" },
	});
	assert.equal(normalized.config.palettePreset, "ocean");
	assert.equal(normalized.config.density, "cozy");
	assert.equal(normalized.config.separator, "dot");
	assert.deepEqual(normalized.config.segments, ["model", "cwd", "turn"]);
	assert.deepEqual(normalized.config.segmentText.model, { prefix: "Model: ", suffix: "" });
	assert.deepEqual(normalized.config.segmentText.turn, { prefix: "🔁 #", suffix: " turns" });
	assert.equal(normalized.config.extensionStatusIcons.goal, "");
	assert.equal(normalized.config.extensionStatusIcons.custom, "🧪");
	assert.deepEqual(normalized.diagnostics, []);

	const iconOnly = normalizeStatuslineConfig({ extensionStatusIcons: { goal: "◎" } });
	assert.equal(iconOnly.config.palettePreset, "tokyo-night");
	assert.deepEqual(iconOnly.config.segments, DEFAULT_STATUSLINE_CONFIG.segments);
	assert.equal(iconOnly.config.extensionStatusIcons.goal, "◎");
});

test("legacy status icon keys inherit into canonical keys without rewriting settings", () => {
	const legacyOnly = normalizeStatuslineConfig({
		extensionStatusIcons: { pisync: "OLD-SYNC", "unknown-error-retry": "OLD-RETRY" },
	});
	assert.equal(legacyOnly.config.extensionStatusIcons.sync, "OLD-SYNC");
	assert.equal(legacyOnly.config.extensionStatusIcons.retry, "OLD-RETRY");

	const suppressed = normalizeStatuslineConfig({
		extensionStatusIcons: { pisync: "", "unknown-error-retry": "" },
	});
	assert.equal(suppressed.config.extensionStatusIcons.sync, "");
	assert.equal(suppressed.config.extensionStatusIcons.retry, "");

	const canonicalWins = normalizeStatuslineConfig({
		extensionStatusIcons: {
			pisync: "OLD-SYNC",
			sync: "NEW-SYNC",
			"unknown-error-retry": "OLD-RETRY",
			retry: "NEW-RETRY",
		},
	});
	assert.equal(canonicalWins.config.extensionStatusIcons.sync, "NEW-SYNC");
	assert.equal(canonicalWins.config.extensionStatusIcons.pisync, "NEW-SYNC");
	assert.equal(canonicalWins.config.extensionStatusIcons.retry, "NEW-RETRY");
	assert.equal(canonicalWins.config.extensionStatusIcons["unknown-error-retry"], "NEW-RETRY");

	const directory = mkdtempSync(join(tmpdir(), "pi-statusline-status-icon-migration-"));
	const settingsPath = join(directory, "pi-statusline.json");
	const document = '{"extensionStatusIcons":{"pisync":"CUSTOM","future":"🧪"}}\n';
	try {
		const saved = saveStatuslineSettingsDocument(settingsPath, document);
		assert.equal(saved.config.extensionStatusIcons.sync, "CUSTOM");
		assert.equal(readFileSync(settingsPath, "utf8"), document);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a named preset without custom colors prepares that preset as the custom starting point", () => {
	const normalized = normalizeStatuslineConfig({ palettePreset: "forest" });
	assert.equal(normalized.config.palettePreset, "forest");
	assert.equal(normalized.config.palette.model?.bg, "#a7c080");
	assert.equal(normalized.config.palette.cwd?.bg, "#83c092");
	assert.equal(normalized.config.palette.branch?.bg, "#5f9f75");
	assert.equal(normalized.config.palette.tools?.bg, "#3f6f55");
	assert.equal(normalized.config.palette.time?.bg, "#293f35");
	assert.deepEqual(normalized.diagnostics, []);
});

test("palette object normalizes colors without filling omitted custom colors", () => {
	const normalized = normalizeStatuslineConfig({
		palette: {
			time: { fg: "#090c0c", bg: "#A3AED2" },
			model: { fg: "#ffffff" },
			cwd: { bg: "#123ABC" },
		},
	});
	assert.equal(normalized.config.palettePreset, "custom");
	assert.deepEqual(normalized.config.palette.time, { fg: "#090c0c", bg: "#a3aed2" });
	assert.deepEqual(normalized.config.palette.model, { fg: "#ffffff" });
	assert.deepEqual(normalized.config.palette.cwd, { bg: "#123abc" });
	assert.equal(normalized.config.palette.brand, undefined);
	assert.deepEqual(normalized.diagnostics, []);
});

test("explicit palette preset takes precedence while preserving custom colors", () => {
	const normalized = normalizeStatuslineConfig({
		palettePreset: "forest",
		palette: { time: { fg: "#112233", bg: "#445566" } },
	});
	assert.equal(normalized.config.palettePreset, "forest");
	assert.deepEqual(normalized.config.palette.time, { fg: "#112233", bg: "#445566" });
	assert.deepEqual(normalized.diagnostics, []);

	const defaultedCustom = normalizeStatuslineConfig({ palettePreset: "custom" });
	assert.equal(defaultedCustom.config.palettePreset, "custom");
	assert.deepEqual(defaultedCustom.config.palette, DEFAULT_STATUSLINE_CONFIG.palette);
});

test("palette object reports invalid colors and forward-compatible unknown fields", () => {
	const normalized = normalizeStatuslineConfig({
		palette: {
			time: { fg: "#fff", bg: 7, future: "#ffffff" },
			model: "#ffffff",
			unknown: { fg: "#123456" },
		},
	});
	assert.equal(normalized.config.palettePreset, "custom");
	assert.deepEqual(normalized.config.palette.time, {});
	assert.deepEqual(
		normalized.diagnostics.map(({ code, path }) => ({ code, path })),
		[
			{ code: "invalid", path: "palette.time.fg" },
			{ code: "invalid", path: "palette.time.bg" },
			{ code: "unknown", path: "palette.time.future" },
			{ code: "invalid", path: "palette.model" },
			{ code: "unknown", path: "palette.unknown" },
		],
	);
});

test("line breaks may repeat when separated but consecutive line breaks are invalid", () => {
	const multiline = normalizeStatuslineConfig({
		segments: ["model", "line_break", "cwd", "line_break", "branch"],
	});
	assert.deepEqual(multiline.config.segments, [
		"model",
		"line_break",
		"cwd",
		"line_break",
		"branch",
	]);
	assert.deepEqual(multiline.diagnostics, []);

	const consecutive = normalizeStatuslineConfig({
		segments: ["model", "line_break", "line_break", "cwd", "branch"],
	});
	assert.deepEqual(consecutive.config.segments, ["model", "line_break", "cwd", "branch"]);
	assert.match(consecutive.diagnostics[0]?.message ?? "", /consecutive line_break/iu);
	assert.equal(consecutive.diagnostics[0]?.path, "segments[2]");
});

test("segment text rejects embedded line breaks and terminal control sequences", () => {
	const normalized = normalizeStatuslineConfig({
		segments: ["model"],
		segmentText: { model: { prefix: "before\nafter", suffix: "\u001b[31m" } },
	});
	assert.deepEqual(normalized.config.segmentText.model, { prefix: "🤖 ", suffix: "" });
	assert.equal(normalized.diagnostics[0]?.path, "segmentText.model.prefix");
	assert.match(normalized.diagnostics[0]?.message ?? "", /use line_break/iu);
	assert.equal(normalized.diagnostics[1]?.path, "segmentText.model.suffix");
	assert.match(normalized.diagnostics[1]?.message ?? "", /control characters/iu);
});

test("normalization falls back by field and reports unknown, duplicate, and invalid values", () => {
	const normalized = normalizeStatuslineConfig({
		palette: "invalid",
		palettePreset: "invalid",
		density: 3,
		separator: "bar",
		segments: ["model", "unknown", "model", 3, "time"],
		segmentText: {
			model: { prefix: 7, suffix: "!", future: true },
			unknown: { prefix: "?" },
		},
		extensionStatusIcons: { goal: "◎", bad: 3 },
		preset: "classic",
		showLabels: true,
		future: true,
	});
	assert.equal(normalized.config.palettePreset, "tokyo-night");
	assert.equal(normalized.config.density, "compact");
	assert.equal(normalized.config.separator, "bar");
	assert.deepEqual(normalized.config.segments, ["model", "time"]);
	assert.deepEqual(normalized.config.segmentText.model, { prefix: "🤖 ", suffix: "!" });
	assert.equal(normalized.config.extensionStatusIcons.goal, "◎");
	assert.equal(Object.hasOwn(normalized.config.extensionStatusIcons, "bad"), false);
	const paths = normalized.diagnostics.map((item) => item.path);
	for (const path of [
		"palette",
		"palettePreset",
		"density",
		"segments[1]",
		"segments[2]",
		"segments[3]",
		"segmentText.model.prefix",
		"segmentText.model.future",
		"segmentText.unknown",
		"extensionStatusIcons.bad",
		"preset",
		"showLabels",
		"future",
	]) {
		assert.ok(paths.includes(path), path);
	}
});

test("extension icon overrides preserve prototype-like exact keys", () => {
	const parsed = JSON.parse('{"extensionStatusIcons":{"__proto__":"🧪","constructor":"🛠️"}}');
	const normalized = normalizeStatuslineConfig(parsed);
	assert.equal(Object.hasOwn(normalized.config.extensionStatusIcons, "__proto__"), true);
	assert.equal(Reflect.get(normalized.config.extensionStatusIcons, "__proto__"), "🧪");
	assert.equal(Reflect.get(normalized.config.extensionStatusIcons, "constructor"), "🛠️");
	assert.deepEqual(normalized.diagnostics, []);
});

test("all named palettes, separators, empty segments, and environment independence are accepted", () => {
	const previous = process.env.PI_STATUSLINE_PRESET;
	process.env.PI_STATUSLINE_PRESET = "classic";
	try {
		for (const palettePreset of [
			"tokyo-night",
			"ocean",
			"sunset",
			"forest",
			"candy",
			"neon",
			"mono",
		]) {
			assert.equal(
				normalizeStatuslineConfig({ palettePreset }).config.palettePreset,
				palettePreset,
			);
			assert.equal(
				normalizeStatuslineConfig({ palette: palettePreset }).config.palettePreset,
				palettePreset,
			);
		}
		for (const separator of ["none", "dot", "bar", "powerline", "round"]) {
			assert.equal(normalizeStatuslineConfig({ separator }).config.separator, separator);
		}
		assert.deepEqual(normalizeStatuslineConfig({ segments: [] }).config.segments, []);
		assert.equal(normalizeStatuslineConfig({}).config.palettePreset, "tokyo-night");
	} finally {
		if (previous === undefined) delete process.env.PI_STATUSLINE_PRESET;
		else process.env.PI_STATUSLINE_PRESET = previous;
	}
});

test("missing settings are atomically initialized with the editable default document", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	try {
		const loaded = loadOrCreateStatuslineSettings(root);
		const path = settingsFilePath(root);
		assert.equal(loaded.source, "user");
		assert.equal(loaded.rawDocument, DEFAULT_STATUSLINE_DOCUMENT);
		assert.equal(readFileSync(path, "utf8"), DEFAULT_STATUSLINE_DOCUMENT);
		assert.deepEqual(loaded.config, DEFAULT_STATUSLINE_CONFIG);
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed existing settings are never overwritten", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	const path = settingsFilePath(root);
	try {
		writeFileSync(path, "{broken\n");
		const loaded = loadOrCreateStatuslineSettings(root);
		assert.equal(loaded.source, "built-in");
		assert.equal(readFileSync(path, "utf8"), "{broken\n");
		assert.match(loaded.diagnostics[0]?.message ?? "", /parse JSON/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid legacy settings are not migrated to the canonical path", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	const legacyPath = join(root, "pi-statusline-settings.json");
	const canonicalPath = settingsFilePath(root);
	const raw = `${JSON.stringify({ palette: "invalid", future: true })}\n`;
	try {
		writeFileSync(legacyPath, raw);
		const loaded = loadOrCreateStatuslineSettings(root);
		assert.equal(
			loaded.diagnostics.some((item) => item.path === "palette"),
			true,
		);
		assert.equal(readFileSync(legacyPath, "utf8"), raw);
		assert.equal(existsSync(canonicalPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a concurrent default creator wins without being overwritten", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	const path = settingsFilePath(root);
	try {
		const winner = `${JSON.stringify({ segments: ["model"] }, null, "\t")}\n`;
		const loaded = loadOrCreateStatuslineSettings(root, {
			linkSync(_temporaryPath, canonicalPath) {
				writeFileSync(canonicalPath, winner, { flag: "wx" });
				throw Object.assign(new Error("already exists"), { code: "EEXIST" });
			},
		});
		assert.equal(loaded.source, "user");
		assert.deepEqual(loaded.config.segments, ["model"]);
		assert.equal(readFileSync(path, "utf8"), winner);
		assert.deepEqual(readdirSync(root), ["pi-statusline.json"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("transactional saves preserve unknown fields and roll back publish failures", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	const path = settingsFilePath(root);
	try {
		writeFileSync(path, `${JSON.stringify({ segments: ["model"], future: true })}\n`);
		const raw = `${JSON.stringify({ segments: ["cwd"], future: "kept" }, null, "\t")}\n`;
		const loaded = saveStatuslineSettingsDocument(path, raw);
		assert.deepEqual(loaded.config.segments, ["cwd"]);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).future, "kept");

		assert.throws(
			() =>
				saveStatuslineSettingsDocument(path, `${JSON.stringify({ segments: ["time"] })}\n`, {
					renameSync() {
						throw new Error("publish failed");
					},
				}),
			/publish failed/,
		);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).future, "kept");
		assert.deepEqual(readdirSync(root), ["pi-statusline.json"]);
		assert.throws(() => saveStatuslineSettingsDocument(path, "{broken"), /parse JSON/i);
		assert.equal(existsSync(path), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid recognized fields are rejected on save while unknown fields remain allowed", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-settings-"));
	const path = settingsFilePath(root);
	try {
		assert.throws(
			() => saveStatuslineSettingsDocument(path, JSON.stringify({ palette: "bad" })),
			/palette/i,
		);
		assert.throws(
			() => saveStatuslineSettingsDocument(path, JSON.stringify({ palettePreset: "bad" })),
			/palettePreset/i,
		);
		assert.throws(
			() =>
				saveStatuslineSettingsDocument(
					path,
					JSON.stringify({ palette: { time: { bg: "#abcd" } } }),
				),
			/palette\.time\.bg/i,
		);
		assert.throws(
			() =>
				saveStatuslineSettingsDocument(
					path,
					JSON.stringify({ segments: ["model", "line_break", "line_break", "cwd"] }),
				),
			/consecutive line_break/iu,
		);
		assert.throws(
			() =>
				saveStatuslineSettingsDocument(
					path,
					JSON.stringify({ segmentText: { model: { suffix: "\n\n" } } }),
				),
			/use line_break/iu,
		);
		const loaded = saveStatuslineSettingsDocument(path, JSON.stringify({ future: true }));
		assert.equal(loaded.diagnostics[0]?.path, "future");
		assert.equal(JSON.parse(readFileSync(path, "utf8")).future, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
