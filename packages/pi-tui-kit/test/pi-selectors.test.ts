import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	getKeybindings,
	isKittyProtocolActive,
	KeybindingsManager,
	matchesKey,
	setKeybindings,
	setKittyProtocolActive,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createPiSelector } from "../src/components/pi-selectors.js";
import { runModelSelector, runThinkingSelector } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

const models = [
	{ provider: "openai", id: "gpt-5", name: "GPT 5" },
	{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
	{ provider: "google", id: "gemini-pro", name: "Gemini Pro" },
] as const;

test("model selector renders current and default models and returns Ctrl+S save-default", async () => {
	const tui = createTuiHarness({ width: 48, rows: 20 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models,
		currentModel: models[1],
		defaultModel: models[0],
	});
	await tui.waitForOpen();

	const frame = tui.render();
	assert.ok(frame.some((line) => line.includes("✓ claude-sonnet [anthropic]")));
	assert.ok(frame.some((line) => line.includes("gpt-5 [openai] · default")));
	assert.ok(frame.some((line) => line.includes("ctrl+s set as default")));
	assert.ok(frame.every((line) => visibleWidth(line) <= 48));

	tui.type("default");
	tui.press("app.models.save");
	assert.deepEqual(await running, { kind: "saveDefault", model: models[0] });
});

test("model selector keeps the saved default first for default-prefix searches", async () => {
	const saved = { provider: "test", id: "alpha" };
	const distractor = { provider: "test", id: "default-model" };
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models: [distractor, saved],
		defaultModel: saved,
	});
	await tui.waitForOpen();

	tui.type("def");
	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", model: saved });
});

test("model selector ranks a direct provider match before a proxy model ID", async () => {
	const direct = { provider: "openai", id: "gpt-5" };
	const proxy = { provider: "openrouter", id: "openai/gpt-5" };
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models: [proxy, direct],
		initialSearchInput: "openai/gpt-5",
	});
	await tui.waitForOpen();

	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", model: direct });
});

test("model selector fuzzy-searches sanitized model fields and selects the raw item", async () => {
	const unsafe = {
		provider: "vendor\u001b[31m",
		id: "model\u202e-one",
		name: "Unsafe\nName",
		metadata: 42,
	};
	const tui = createTuiHarness({ width: 32 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, { models: [models[0], unsafe] });
	await tui.waitForOpen();
	tui.send("\u001b[200~Unsafe\u001b]0;hidden\u0007 Name\u001b[201~");
	const frame = tui.render();
	assert.ok(frame.some((line) => line.includes("model-one")));
	assert.ok(
		frame.every(
			(line) =>
				!line.includes("\u001b[31m") &&
				!line.includes("\u001b]0;hidden") &&
				!line.includes("\u202e"),
		),
	);
	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", model: unsafe });
});

test("model selector preserves the query cursor while sanitizing inserted text", async () => {
	const expected = { provider: "test", id: "abXYcd" };
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models: [expected, { provider: "test", id: "other" }],
		initialSearchInput: "abcd",
	});
	await tui.waitForOpen();

	tui.press("home");
	tui.send("\x1b[C");
	tui.send("\x1b[C");
	tui.send("X\u202e");
	tui.type("Y");
	assert.doesNotMatch(tui.render().join("\n"), /No matching options/u);
	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", model: expected });
});

test("model selector preserves Input paste normalization before sanitizing", async () => {
	for (const scenario of [
		{ pasted: "foo\nbar", expectedQuery: "foobar", alternativeId: "foo bar" },
		{ pasted: "foo\r\nbar", expectedQuery: "foobar", alternativeId: "foo bar" },
		{ pasted: "foo\rbar", expectedQuery: "foobar", alternativeId: "foo bar" },
		{ pasted: "foo\tbar", expectedQuery: "foo    bar", alternativeId: "foo bar" },
		{ pasted: "foo\u202ebar", expectedQuery: "foobar", alternativeId: "foo bar" },
	] as const) {
		const expected = { provider: "test", id: scenario.expectedQuery };
		const tui = createTuiHarness();
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		const running = runModelSelector(context.ctx, {
			models: [{ provider: "test", id: scenario.alternativeId }, expected],
		});
		await tui.waitForOpen();

		tui.send(`\x1b[200~${scenario.pasted}\x1b[201~`);
		const inputRow = tui
			.render()
			.map(stripVTControlCharacters)
			.find((line) => line.includes("> "));
		assert.ok(inputRow?.includes(`> ${scenario.expectedQuery}`));
		if (scenario.pasted.includes("\t")) {
			tui.press("ctrl+c");
			assert.deepEqual(await running, { kind: "closed", reason: "close" });
		} else {
			tui.press("tui.select.confirm");
			assert.deepEqual(await running, { kind: "selected", model: expected });
		}
	}
});

test("model selector routes Home and End to query editing", async () => {
	const alpha = { provider: "test", id: "alpha" };
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models: [alpha, { provider: "test", id: "beta" }],
	});
	await tui.waitForOpen();

	tui.type("lph");
	tui.press("home");
	tui.type("a");
	tui.press("end");
	tui.type("a");
	const frame = tui.render().join("\n");
	assert.match(frame, /alpha/u);
	assert.doesNotMatch(frame, /No matching options/u);

	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", model: alpha });
});

test("model selector completes remapped and newline Input submissions", async () => {
	const previousKeybindings = getKeybindings();
	try {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.input.submit": "ctrl+q",
			}),
		);
		for (const data of ["\x11", "\n"]) {
			const tui = createTuiHarness({
				keybindings: {
					matches: (input, binding) => (binding === "tui.select.confirm" ? input === "x" : false),
					getKeys: (binding) => (binding === "tui.select.confirm" ? ["x"] : []),
				},
			});
			const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
			const running = runModelSelector(context.ctx, { models: [models[0]] });
			await tui.waitForOpen();

			tui.send(data);
			assert.deepEqual(await running, { kind: "selected", model: models[0] });
		}
	} finally {
		setKeybindings(previousKeybindings);
	}
});

test("model selector gives save-default priority except for hard Ctrl+C", async () => {
	for (const scenario of [
		{ key: "enter", data: "\r", expected: "saveDefault", shadowedHint: "enter select" },
		{ key: "escape", data: "\x1b", expected: "saveDefault", shadowedHint: "esc cancel" },
		{ key: "ctrl+c", data: "\x03", expected: "closed", shadowedHint: "ctrl+c set as default" },
	] as const) {
		const tui = createTuiHarness({
			keybindings: {
				matches: (data, binding) => {
					if (String(binding) === "app.models.save") return data === scenario.data;
					if (binding === "tui.select.confirm") return data === "\r";
					if (binding === "tui.select.cancel") return data === "\x1b" || data === "\x03";
					return false;
				},
				getKeys: (binding) => {
					if (String(binding) === "app.models.save") return [scenario.key];
					if (binding === "tui.select.confirm") return ["enter"];
					if (binding === "tui.select.cancel") return ["escape", "ctrl+c"];
					return [];
				},
			},
		});
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		const running = runModelSelector(context.ctx, { models: [models[0]] });
		await tui.waitForOpen();
		assert.equal(tui.render().join("\n").includes(scenario.shadowedHint), false);
		tui.send(scenario.data);
		const result = await running;
		if (scenario.expected === "saveDefault") {
			assert.deepEqual(result, { kind: "saveDefault", model: models[0] });
		} else assert.deepEqual(result, { kind: "closed", reason: "close" });
	}
});

test("selector hints honor semantic key collisions and usable fallbacks", async () => {
	try {
		for (const scenario of [
			{
				name: "modifier order",
				kitty: true,
				saveKeys: ["shift+ctrl+x"],
				confirmKeys: ["ctrl+shift+x"],
				data: "\x1b[120;6u",
				expectedKind: "saveDefault",
				shown: ["shift+ctrl+x set as default"],
				hidden: ["shift+ctrl+x select"],
			},
			{
				name: "matcher aliases",
				kitty: false,
				saveKeys: ["return"],
				confirmKeys: ["enter"],
				data: "\r",
				expectedKind: "saveDefault",
				shown: ["enter set as default"],
				hidden: ["enter select"],
			},
			{
				name: "invalid and hard-cancel fallbacks",
				kitty: false,
				saveKeys: ["not-a-key", "ctrl+c", "ctrl+s"],
				confirmKeys: ["enter"],
				data: "\x13",
				expectedKind: "saveDefault",
				shown: ["ctrl+s set as default", "enter select"],
				hidden: ["not-a-key", "ctrl+c set as default"],
			},
			...(
				[
					["Ctrl+I / Tab", "ctrl+i", "tab", "\t"],
					["Ctrl+J / Enter", "ctrl+j", "enter", "\n"],
					["Ctrl+M / Enter", "ctrl+m", "enter", "\r"],
					["Ctrl+[ / Escape", "ctrl+[", "escape", "\x1b"],
					["Ctrl+- / Ctrl+_", "ctrl+-", "ctrl+_", "\x1f"],
					["Alt+B / Alt+Left", "alt+b", "alt+left", "\x1bb"],
					["Alt+F / Alt+Right", "alt+f", "alt+right", "\x1bf"],
					["Alt+P / Alt+Up", "alt+p", "alt+up", "\x1bp"],
					["Alt+N / Alt+Down", "alt+n", "alt+down", "\x1bn"],
					["Ctrl+Alt+H / Alt+Backspace", "ctrl+alt+h", "alt+backspace", "\x1b\x08"],
					["Ctrl+Alt+M / Alt+Enter", "ctrl+alt+m", "alt+enter", "\x1b\r"],
				] as const
			).map(([name, save, confirm, data]) => ({
				name: `legacy ${name}`,
				kitty: false as const,
				saveKeys: [save],
				confirmKeys: [confirm],
				data,
				expectedKind: "saveDefault" as const,
				shown: [`${save} set as default`],
				hidden: [`${confirm} select`],
			})),
			{
				name: "Kitty disambiguation",
				kitty: true,
				saveKeys: ["ctrl+i"],
				confirmKeys: ["tab"],
				data: "\x1b[9u",
				expectedKind: "selected",
				shown: ["tab select", "ctrl+i set as default"],
				hidden: [],
			},
		] as const) {
			setKittyProtocolActive(scenario.kitty);
			const keys = (binding: string): readonly string[] => {
				if (binding === "app.models.save") return scenario.saveKeys;
				if (binding === "tui.select.confirm") return scenario.confirmKeys;
				if (binding === "tui.select.cancel") return ["escape"];
				return [];
			};
			const tui = createTuiHarness({
				keybindings: {
					matches: (data, binding) =>
						keys(String(binding)).some((key) => matchesKey(data, key as never)),
					getKeys: (binding) => [...keys(String(binding))] as never,
				},
			});
			const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
			const running = runModelSelector(context.ctx, { models: [models[0]] });
			await tui.waitForOpen();
			const frame = tui.render().join("\n");
			for (const text of scenario.shown) {
				assert.ok(frame.includes(text), `${scenario.name}: expected ${text}`);
			}
			for (const text of scenario.hidden) {
				assert.equal(frame.includes(text), false, `${scenario.name}: hid ${text}`);
			}
			tui.send(scenario.data);
			assert.equal((await running).kind, scenario.expectedKind, scenario.name);
		}
	} finally {
		setKittyProtocolActive(false);
	}
});

test("selector hints follow Pi's live raw-backspace matcher overlap", async () => {
	try {
		setKittyProtocolActive(false);
		for (const scenario of [
			{
				name: "legacy or remote terminal",
				windowsTerminal: false,
				data: "\x08",
				expectedKind: "saveDefault",
				showsConfirm: false,
			},
			{
				name: "local Windows Terminal",
				windowsTerminal: true,
				data: "\x7f",
				expectedKind: "selected",
				showsConfirm: true,
			},
		] as const) {
			vi.stubEnv("WT_SESSION", scenario.windowsTerminal ? "test" : "");
			for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
			const keys = (binding: string): readonly string[] => {
				if (binding === "app.models.save") return ["ctrl+h"];
				if (binding === "tui.select.confirm") return ["backspace"];
				if (binding === "tui.select.cancel") return ["escape"];
				return [];
			};
			const tui = createTuiHarness({
				keybindings: {
					matches: (data, binding) =>
						keys(String(binding)).some((key) => matchesKey(data, key as never)),
					getKeys: (binding) => [...keys(String(binding))] as never,
				},
			});
			const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
			const running = runModelSelector(context.ctx, { models: [models[0]] });
			await tui.waitForOpen();
			const frame = tui.render().join("\n");
			assert.ok(frame.includes("ctrl+h set as default"), scenario.name);
			assert.equal(frame.includes("backspace select"), scenario.showsConfirm, scenario.name);

			tui.send(scenario.data);
			assert.equal((await running).kind, scenario.expectedKind, scenario.name);
		}
	} finally {
		setKittyProtocolActive(false);
		vi.unstubAllEnvs();
	}
});

test("selector hints and dispatch preserve modifyOtherKeys-disambiguated actions", () => {
	const previousKittyProtocol = isKittyProtocolActive();
	try {
		setKittyProtocolActive(false);
		for (const keyPair of [
			{
				name: "Ctrl+H and Backspace",
				saveKey: "ctrl+h",
				confirmKey: "backspace",
				saveData: "\x1b[27;5;104~",
				confirmData: "\x7f",
			},
			{
				name: "Ctrl+I and Tab",
				saveKey: "ctrl+i",
				confirmKey: "tab",
				saveData: "\x1b[27;5;105~",
				confirmData: "\t",
			},
		] as const) {
			const keys = (binding: string): readonly string[] => {
				if (binding === "app.models.save") return [keyPair.saveKey];
				if (binding === "tui.select.confirm") return [keyPair.confirmKey];
				if (binding === "tui.select.cancel") return ["escape"];
				return [];
			};
			const keybindings = {
				matches: (data: string, binding: string) =>
					keys(binding).some((key) => matchesKey(data, key as never)),
				getKeys: (binding: string) => [...keys(binding)],
			} as never;
			const tui = {
				terminal: { rows: 20, modifyOtherKeysActive: true },
				requestRender() {},
			} as never;
			const theme = { fg: (_role: string, text: string) => text } as never;

			for (const action of [
				{ data: keyPair.saveData, expectedKind: "saveDefault" },
				{ data: keyPair.confirmData, expectedKind: "selected" },
			] as const) {
				let completed: { kind: string } | undefined;
				const component = createPiSelector({
					rows: [{ value: "model", primary: "model" }],
					saveBinding: "app.models.save",
					filterSelection: "bestMatch",
					valueEquals: (left, right) => left === right,
					onComplete: (result) => {
						completed = result;
					},
					tui,
					theme,
					keybindings,
				});
				const frame = component.render(80).join("\n");
				assert.ok(frame.includes(`${keyPair.saveKey} set as default`), keyPair.name);
				assert.ok(frame.includes(`${keyPair.confirmKey} select`), keyPair.name);
				component.handleInput(action.data);
				assert.equal(completed?.kind, action.expectedKind, keyPair.name);
			}
		}
	} finally {
		setKittyProtocolActive(previousKittyProtocol);
	}
});

test("model selector sanitizes duplicate identities in consumer-visible errors", async () => {
	const model = {
		provider: "anthropic\x1b]0;owned\x07\u202e",
		id: "claude\x1b[31m",
		name: "Claude",
	};
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	let reported: unknown;

	const result = await runModelSelector(context.ctx, {
		models: [model, model],
		currentModel: model,
		onError: (_ctx, error) => {
			reported = error;
		},
	});

	assert.equal(result.kind, "error");
	assert.ok(reported instanceof Error);
	assert.equal(reported.message, "Model selector contains duplicate model anthropic/claude");
});

test("thinking selector honors remapped cycle and save-default bindings", async () => {
	const tui = createTuiHarness({
		keybindings: {
			matches: (data, binding) => {
				if (String(binding) === "app.thinking.cycle") return data === "\x1bt";
				if (String(binding) === "app.models.save") return data === "x";
				if (binding === "tui.select.down") return data === "j";
				if (binding === "tui.select.cancel") return data === "q";
				return data === "\r" && binding === "tui.select.confirm";
			},
			getKeys: (binding) => {
				if (String(binding) === "app.models.save") return ["x"];
				if (String(binding) === "app.thinking.cycle") return ["alt+t"];
				if (binding === "tui.select.down") return ["j"];
				if (binding === "tui.select.cancel") return ["q"];
				if (binding === "tui.select.confirm") return ["enter"];
				return [];
			},
		},
	});
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runThinkingSelector(context.ctx, {
		availableLevels: ["off", "low", "high"],
		currentLevel: "low",
		defaultLevel: "off",
	});
	await tui.waitForOpen();
	const frame = tui.render();
	assert.ok(frame.some((line) => line.includes("alt+t cycle choice")));
	assert.ok(frame.some((line) => line.includes("x set as default")));

	tui.send("\x1bt");
	tui.send("x");
	assert.deepEqual(await running, { kind: "saveDefault", level: "high" });
});

test("thinking selector renders every description beside its choice on wide terminals", async () => {
	const tui = createTuiHarness({ width: 100, rows: 30 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runThinkingSelector(context.ctx, {
		availableLevels: ["off", "low", "high"],
		currentLevel: "low",
		defaultLevel: "off",
	});
	await tui.waitForOpen();
	const frame = tui.render().map(stripVTControlCharacters);
	for (const [level, description] of [
		["off", "No reasoning"],
		["low", "Light reasoning (~2k tokens)"],
		["high", "Deep reasoning (~16k tokens)"],
	] as const) {
		const row = frame.find((line) => line.includes(level));
		assert.ok(row?.includes(description), `${level} renders ${description}`);
	}
	assert.ok(frame.every((line) => visibleWidth(line) <= 100));
	tui.press("ctrl+c");
	assert.deepEqual(await running, { kind: "closed", reason: "close" });

	const narrowTui = createTuiHarness({ width: 30, rows: 20 });
	const narrowContext = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: narrowTui.custom,
	});
	const narrowRunning = runThinkingSelector(narrowContext.ctx, {
		availableLevels: ["off", "low", "high"],
		currentLevel: "low",
	});
	await narrowTui.waitForOpen();
	const narrowFrame = narrowTui.render().map(stripVTControlCharacters);
	assert.ok(narrowFrame.some((line) => line.includes("Light reasoning")));
	assert.ok(narrowFrame.every((line) => visibleWidth(line) <= 30));
	narrowTui.press("ctrl+c");
	assert.deepEqual(await narrowRunning, { kind: "closed", reason: "close" });
});

test("thinking selector named cycle key emits Shift+Tab", async () => {
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runThinkingSelector(context.ctx, {
		availableLevels: ["off", "low"],
		currentLevel: "off",
	});
	await tui.waitForOpen();

	tui.press("app.thinking.cycle");
	tui.press("tui.select.confirm");
	assert.deepEqual(await running, { kind: "selected", level: "low" });
});

test("thinking selector keeps every split paste-start boundary ahead of shortcuts", async () => {
	const pasteStart = "\x1b[200~";
	for (let split = 1; split < pasteStart.length; split += 1) {
		const tui = createTuiHarness({
			keybindings: {
				matches: (data, binding) => {
					if (String(binding) === "app.models.save") return data === "x";
					if (binding === "tui.select.confirm") return data === "\r";
					if (binding === "tui.select.cancel") return data === "\x1b" || data === "\x03";
					return false;
				},
				getKeys: (binding) => {
					if (String(binding) === "app.models.save") return ["x"];
					if (binding === "tui.select.confirm") return ["enter"];
					if (binding === "tui.select.cancel") return ["escape", "ctrl+c"];
					return [];
				},
			},
		});
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		const running = runThinkingSelector(context.ctx, {
			availableLevels: ["off", "low"],
			currentLevel: "off",
		});
		await tui.waitForOpen();

		tui.send(pasteStart.slice(0, split));
		tui.send(`${pasteStart.slice(split)}x\x1b[201~`);
		assert.equal(tui.isOpen, true);
		assert.match(tui.render().join("\n"), /No matching options/u);
		tui.press("ctrl+c");
		assert.deepEqual(await running, { kind: "closed", reason: "close" });
	}
});

test("selectors reserve Pi-owned terminal rows", async () => {
	const tui = createTuiHarness({ width: 30, rows: 6 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = runModelSelector(context.ctx, {
		models,
		lines: ["Provider context"],
	});
	await tui.waitForOpen();

	const frame = tui.render();
	assert.equal(frame.length, 3);
	assert.ok(frame.every((line) => visibleWidth(line) <= 30));
	tui.press("ctrl+c");
	assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("selectors forward normalized mouse input and row selection", async () => {
	const edited = { provider: "test", id: "abXcd" };
	const inputTui = createTuiHarness();
	const inputContext = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: inputTui.custom,
	});
	const inputRunning = runModelSelector(inputContext.ctx, {
		models: [edited, { provider: "test", id: "other" }],
		initialSearchInput: "abcd",
	});
	await inputTui.waitForOpen();
	const inputRow = inputTui.render().findIndex((line) => line.includes("> "));
	assert.notEqual(inputRow, -1);
	inputTui.mouse({ type: "press", x: 6, y: inputRow });
	inputTui.type("X");
	inputTui.press("tui.select.confirm");
	assert.deepEqual(await inputRunning, { kind: "selected", model: edited });

	const rowTui = createTuiHarness();
	const rowContext = createMockContext({ mode: "tui", hasUI: true, custom: rowTui.custom });
	const rowRunning = runModelSelector(rowContext.ctx, { models });
	await rowTui.waitForOpen();
	let row = rowTui.render().findIndex((line) => line.includes("gemini-pro"));
	assert.notEqual(row, -1);
	rowTui.mouse({ type: "press", x: 4, y: row });
	row = rowTui.render().findIndex((line) => line.includes("gemini-pro"));
	rowTui.mouse({ type: "click", x: 4, y: row });
	assert.deepEqual(await rowRunning, { kind: "selected", model: models[2] });
});

test("thinking selector sanitizes invalid current levels in consumer-visible errors", async () => {
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	let reported: unknown;

	const result = await runThinkingSelector(context.ctx, {
		availableLevels: ["low"],
		currentLevel: "unsafe\x1b]0;owned\x07\u202e" as never,
		onError: (_ctx, error) => {
			reported = error;
		},
	});

	assert.equal(result.kind, "error");
	assert.ok(reported instanceof Error);
	assert.equal(reported.message, "Current thinking level unsafe is not available");
});

test("selectors preserve Escape and Ctrl+C close reasons", async () => {
	for (const [key, reason] of [
		["tui.select.cancel", "back"],
		["ctrl+c", "close"],
	] as const) {
		const tui = createTuiHarness();
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		const running = runThinkingSelector(context.ctx, {
			availableLevels: ["off"],
			currentLevel: "off",
		});
		await tui.waitForOpen();
		tui.press(key);
		assert.deepEqual(await running, { kind: "closed", reason });
	}
});

test("selectors reject non-TUI modes without opening custom UI", async () => {
	let customCalls = 0;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		custom: async () => {
			customCalls += 1;
			return undefined;
		},
	});
	assert.deepEqual(await runModelSelector(context.ctx, { models }), {
		kind: "unsupported",
		mode: "rpc",
	});
	assert.equal(customCalls, 0);
});
