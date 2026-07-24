import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStatuslineCommand } from "../src/commands.js";
import {
	DEFAULT_STATUSLINE_DOCUMENT,
	loadStatuslineSettings,
	saveStatuslineSettingsDocument,
	settingsFilePath,
} from "../src/settings.js";
import statusline from "../src/statusline.js";

test("/statusline registers palette, settings, status, and help autocomplete", () => {
	const mock = createMockPi();
	statusline(mock.pi);
	const command = mock.commands.get("statusline");
	assert.ok(command?.getArgumentCompletions);
	assert.deepEqual(
		(command.getArgumentCompletions("") as Array<{ value: string }>).map((item) => item.value),
		["palette", "settings", "status", "help"],
	);
	assert.deepEqual(
		(command.getArgumentCompletions("st") as Array<{ value: string }>).map((item) => item.value),
		["status"],
	);
});

test("settings edits raw JSON transactionally and applies it immediately", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, DEFAULT_STATUSLINE_DOCUMENT);
	try {
		const mock = createMockPi();
		let loaded = loadStatuslineSettings(path);
		let renders = 0;
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				renders += 1;
			},
		});
		let initial = "";
		const edited = `${JSON.stringify(
			{ segments: ["model"], segmentText: { model: { prefix: "Model: " } }, future: true },
			null,
			"\t",
		)}\n`;
		const context = createMockContext({
			mode: "tui",
			editor: async (_title: string, value: string) => {
				initial = value;
				return edited;
			},
		});
		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		assert.equal(initial, DEFAULT_STATUSLINE_DOCUMENT);
		assert.equal(readFileSync(path, "utf8"), edited);
		assert.deepEqual(loaded.config.segments, ["model"]);
		assert.equal(loaded.config.segmentText.model.prefix, "Model: ");
		assert.equal(renders, 1);
		assert.match(context.notifications.at(-1)?.message ?? "", /saved.*applied/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("palette picker preserves custom colors and unknown fields while applying a preset", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(
		path,
		JSON.stringify({
			palette: { time: { fg: "#112233", bg: "#445566" } },
			future: { retained: true },
		}),
	);
	try {
		const mock = createMockPi();
		let loaded = loadStatuslineSettings(path);
		let applied = 0;
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				applied += 1;
			},
		});
		const selections: Array<{ title: string; choices: string[] }> = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async (title: string, choices: string[]) => {
				selections.push({ title, choices });
				return title === "pi-statusline" ? choices[0] : "ocean";
			},
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		assert.deepEqual(selections[0]?.choices, [
			"Palette preset (custom)",
			"Edit JSON settings",
			"Status",
			"Help",
		]);
		assert.match(selections[1]?.title ?? "", /current: custom/u);
		assert.deepEqual(selections[1]?.choices, [
			"tokyo-night",
			"ocean",
			"sunset",
			"forest",
			"candy",
			"neon",
			"mono",
			"custom",
		]);
		assert.equal(loaded.config.palettePreset, "ocean");
		assert.deepEqual(loaded.config.palette.time, { fg: "#112233", bg: "#445566" });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			palette: { time: { fg: "#112233", bg: "#445566" } },
			future: { retained: true },
			palettePreset: "ocean",
		});
		assert.equal(applied, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("palette picker migrates a legacy string without losing unknown fields", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, JSON.stringify({ palette: "forest", future: true }));
	try {
		const mock = createMockPi();
		let loaded = loadStatuslineSettings(path);
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
			},
		});
		const context = createMockContext({
			mode: "tui",
			select: async () => "custom",
		});

		await mock.commands.get("statusline")?.handler("palette", context.ctx);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.palettePreset, "custom");
		assert.equal(saved.future, true);
		assert.equal(typeof saved.palette, "object");
		assert.deepEqual(saved.palette.time, { fg: "#a0a9cb", bg: "#1d2230" });
		assert.equal(loaded.config.palettePreset, "custom");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("palette picker cancellation and malformed settings leave the file unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "{broken");
	try {
		const mock = createMockPi();
		const loaded = loadStatuslineSettings(path);
		let applied = 0;
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply() {
				applied += 1;
			},
		});
		let selection: string | undefined;
		const context = createMockContext({ mode: "tui", select: async () => selection });

		await mock.commands.get("statusline")?.handler("palette", context.ctx);
		selection = "ocean";
		await mock.commands.get("statusline")?.handler("palette", context.ctx);

		assert.equal(readFileSync(path, "utf8"), "{broken");
		assert.equal(applied, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /Fix pi-statusline\.json/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancelled, invalid, and failed settings edits preserve file and runtime state", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	const original = `${JSON.stringify({ segments: ["model"] })}\n`;
	writeFileSync(path, original);
	try {
		const mock = createMockPi();
		let loaded = loadStatuslineSettings(path);
		let applied = 0;
		let nextEdit: string | undefined;
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				applied += 1;
			},
			save: (settingsPath, rawDocument) => {
				if (rawDocument.includes("publish")) throw new Error("publish failed");
				return saveStatuslineSettingsDocument(settingsPath, rawDocument);
			},
		});
		const context = createMockContext({ mode: "tui", editor: async () => nextEdit });

		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		nextEdit = JSON.stringify({ palette: "invalid" });
		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*palette/i);
		nextEdit = JSON.stringify({ palette: { time: { fg: "red" } } });
		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*palette\.time\.fg/i);
		nextEdit = JSON.stringify({ future: "publish" });
		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /publish failed/i);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.deepEqual(loaded.config.segments, ["model"]);
		assert.equal(applied, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("settings is TUI-only while status and help are protocol-safe", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, DEFAULT_STATUSLINE_DOCUMENT);
	try {
		const mock = createMockPi();
		const loaded = loadStatuslineSettings(path);
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply() {},
		});
		let editorCalls = 0;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			editor: async () => {
				editorCalls += 1;
				return undefined;
			},
		});
		await mock.commands.get("statusline")?.handler("settings", context.ctx);
		assert.equal(editorCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /Edit settings manually/u);
		await mock.commands.get("statusline")?.handler("palette", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /Edit palettePreset manually/u);
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /open the statusline menu/u);
		await mock.commands.get("statusline")?.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /source: user/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /palette preset: tokyo-night/u);
		await mock.commands.get("statusline")?.handler("help", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /segmentText/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /palettePreset/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /line_break/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
