import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStatuslineCommand } from "../src/commands.js";
import { loadStatuslineSettings, settingsFilePath } from "../src/settings.js";

interface PickerComponent {
	render?(width: number): string[];
	handleInput?(data: string): void;
}

function profilePicker(
	inputs: string[],
	inspect?: (lines: string[]) => void,
	inspectNarrow?: (lines: string[]) => void,
) {
	return async (factory: (...args: unknown[]) => unknown) => {
		let result: unknown;
		const component = factory(
			{ requestRender() {} },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			getKeybindings(),
			(value: unknown) => {
				result = value;
			},
		) as PickerComponent;
		if (inspect && component.render) inspect(component.render(100));
		if (inspectNarrow && component.render) inspectNarrow(component.render(20));
		for (const input of inputs) component.handleInput?.(input);
		return result;
	};
}

function selectInformation(_title: string, choices: string[]): string | undefined {
	return choices.find((choice) => choice.startsWith("Information ("));
}

test("information picker previews exact contents and atomically applies a curated profile", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, `${JSON.stringify({ segments: ["model"], future: true })}\n`);
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
		let pickerText = "";
		let narrowLines: string[] = [];
		const context = createMockContext({
			mode: "tui",
			select: selectInformation,
			custom: profilePicker(
				["\r"],
				(lines) => {
					pickerText = lines.join("\n");
				},
				(lines) => {
					narrowLines = lines;
				},
			),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);

		assert.match(pickerText, /Information level \(current: custom\)/u);
		for (const label of ["Minimal", "Balanced", "Detailed"]) {
			assert.match(pickerText, new RegExp(label, "u"));
		}
		assert.match(pickerText, /Segments: model · thinking · cwd · branch · tools · context · cost/u);
		assert.ok(narrowLines.length > 0);
		assert.ok(narrowLines.every((line) => visibleWidth(line) <= 20));
		assert.deepEqual(loaded.config.segments, [
			"model",
			"thinking",
			"cwd",
			"branch",
			"tools",
			"context",
			"cost",
		]);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			segments: ["model", "thinking", "cwd", "branch", "tools", "context", "cost"],
			future: true,
		});
		assert.equal(applied, 1);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/Information level applied: balanced/iu,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("information picker cancellation and save failure leave custom settings unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
	const path = settingsFilePath(root);
	const original = `${JSON.stringify({ segments: ["model"], future: true })}\n`;
	writeFileSync(path, original);
	try {
		const mock = createMockPi();
		const loaded = loadStatuslineSettings(path);
		let applied = 0;
		let pickerInputs = ["\u001b"];
		registerStatuslineCommand(mock.pi, {
			settingsPath: path,
			getLoaded: () => loaded,
			apply() {
				applied += 1;
			},
			save() {
				throw new Error("disk full");
			},
		});
		const context = createMockContext({
			mode: "tui",
			select: selectInformation,
			custom: (factory: (...args: unknown[]) => unknown) => profilePicker(pickerInputs)(factory),
		});

		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(applied, 0);

		pickerInputs = ["\r"];
		await mock.commands.get("statusline")?.handler("", context.ctx);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(applied, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*disk full/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Advanced provides a shallow Back path to the refreshed main menu", async () => {
	const mock = createMockPi();
	registerStatuslineCommand(mock.pi, {
		settingsPath: "/tmp/missing-pi-statusline-advanced.json",
		getLoaded: () => loadStatuslineSettings("/tmp/missing-pi-statusline-advanced.json"),
		apply() {},
	});
	const titles: string[] = [];
	let call = 0;
	const context = createMockContext({
		mode: "tui",
		select: async (title: string) => {
			titles.push(title);
			call += 1;
			if (call === 1) return "Advanced";
			if (call === 2) return "Back";
			return undefined;
		},
	});

	await mock.commands.get("statusline")?.handler("", context.ctx);

	assert.deepEqual(titles, ["pi-statusline", "pi-statusline — Advanced", "pi-statusline"]);
});
