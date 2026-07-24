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

interface PickerComponent {
	render?(width: number): string[];
	handleInput?(data: string): void;
}

function customPalettePicker(inputs: string[], inspect?: (lines: string[]) => void) {
	return async (factory: (...args: unknown[]) => unknown) => {
		let result: unknown;
		const component = factory(
			{ requestRender() {} },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			{},
			(value: unknown) => {
				result = value;
			},
		) as PickerComponent;
		if (inspect && component.render) inspect(component.render(100));
		for (const input of inputs) component.handleInput?.(input);
		return result;
	};
}

test("/statusline registers an argument-free interactive menu", async () => {
	const mock = createMockPi();
	statusline(mock.pi);
	const command = mock.commands.get("statusline");
	assert.equal(command?.getArgumentCompletions, undefined);
	let selectCalls = 0;
	const context = createMockContext({
		mode: "tui",
		select: async () => {
			selectCalls += 1;
			return undefined;
		},
	});

	await command?.handler("palette", context.ctx);

	assert.equal(selectCalls, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /does not accept arguments/u);
});

test("palette picker previews cursor movement and restores the saved preset on cancel", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, JSON.stringify({ palettePreset: "sunset" }));
	try {
		const mock = createMockPi();
		const loaded = loadStatuslineSettings(path);
		const previews: Array<string | undefined> = [];
		let applied = 0;
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply() {
				applied += 1;
			},
			preview(palettePreset) {
				previews.push(palettePreset);
			},
		});
		let customCalls = 0;
		const context = createMockContext({
			mode: "tui",
			select: async (_title: string, choices: string[]) => choices[0],
			custom: customPalettePicker(["\u001b[B", "\u001b"], () => {
				customCalls += 1;
			}),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		assert.equal(customCalls, 1);
		assert.deepEqual(previews, ["forest", undefined]);
		assert.equal(applied, 0);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { palettePreset: "sunset" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
			select: async () => "Edit settings JSON (custom colors, layout, icons)",
			editor: async (_title: string, value: string) => {
				initial = value;
				return edited;
			},
		});
		await mock.commands.get("statusline")?.handler("", context.ctx);
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
		let pickerText = "";
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async (title: string, choices: string[]) => {
				selections.push({ title, choices });
				return choices[0];
			},
			custom: customPalettePicker(["\u001b[B", "\u001b[B", "\r"], (lines) => {
				pickerText = lines.join("\n");
			}),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		assert.deepEqual(selections[0]?.choices, [
			"Palette preset (custom)",
			"Edit settings JSON (custom colors, layout, icons)",
			"Status",
			"Help",
		]);
		assert.match(pickerText, /current: custom/u);
		for (const palettePreset of [
			"tokyo-night",
			"ocean",
			"sunset",
			"forest",
			"candy",
			"neon",
			"mono",
			"custom",
		]) {
			assert.match(pickerText, new RegExp(palettePreset, "u"));
		}
		assert.match(pickerText, /per-segment colors from settings JSON/u);
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

test("custom selection preserves an existing custom palette", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	const palette = { time: { fg: "#112233", bg: "#445566" } };
	writeFileSync(path, JSON.stringify({ palettePreset: "custom", palette, future: true }));
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
			select: async (_title: string, choices: string[]) => choices[0],
			custom: customPalettePicker(["\r"]),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			palettePreset: "custom",
			palette,
			future: true,
		});
		assert.deepEqual(loaded.config.palette, palette);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("custom selection materializes the active legacy preset without losing unknown fields", async () => {
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
			select: async (_title: string, choices: string[]) => choices[0],
			custom: customPalettePicker(["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r"]),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.palettePreset, "custom");
		assert.equal(saved.future, true);
		assert.equal(Object.keys(saved.palette).length, 12);
		assert.equal(saved.palette.model.bg, "#a7c080");
		assert.equal(saved.palette.cwd.bg, "#83c092");
		assert.equal(saved.palette.branch.bg, "#5f9f75");
		assert.equal(saved.palette.tools.bg, "#3f6f55");
		assert.equal(saved.palette.time.bg, "#293f35");
		assert.deepEqual(loaded.config.palette, saved.palette);
		assert.equal(loaded.config.palettePreset, "custom");
		assert.match(context.notifications.at(-1)?.message ?? "", /Edit settings JSON/u);
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
		const context = createMockContext({
			mode: "tui",
			select: async (_title: string, choices: string[]) => choices[0],
			custom: (factory: (...args: unknown[]) => unknown) =>
				customPalettePicker(selection ? ["\u001b[B", "\r"] : ["\u001b"])(factory),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);
		selection = "ocean";
		await mock.commands.get("statusline")?.handler("", context.ctx);

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
		const context = createMockContext({
			mode: "tui",
			select: async () => "Edit settings JSON (custom colors, layout, icons)",
			editor: async () => nextEdit,
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);
		nextEdit = JSON.stringify({ palette: "invalid" });
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*palette/i);
		nextEdit = JSON.stringify({ palette: { time: { fg: "red" } } });
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*palette\.time\.fg/i);
		nextEdit = JSON.stringify({ future: "publish" });
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /publish failed/i);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.deepEqual(loaded.config.segments, ["model"]);
		assert.equal(applied, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status and help remain available from the main menu", async () => {
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
		let selection = "Status";
		const context = createMockContext({ mode: "tui", select: async () => selection });

		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /source: user/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /palette preset: tokyo-night/u);

		selection = "Help";
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /segmentText/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /palettePreset/u);
		assert.match(context.notifications.at(-1)?.message ?? "", /line_break/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/statusline safely rejects non-TUI mode and textual arguments", async () => {
	const mock = createMockPi();
	registerStatuslineCommand(mock.pi, {
		settingsPath: "/tmp/pi-statusline.json",
		getLoaded: () => loadStatuslineSettings("/tmp/missing-pi-statusline.json"),
		apply() {},
	});
	const context = createMockContext({ mode: "rpc", hasUI: true });

	await mock.commands.get("statusline")?.handler("", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /requires an interactive Pi UI/u);

	await mock.commands.get("statusline")?.handler("status", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /does not accept arguments/u);
});
