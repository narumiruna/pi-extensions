import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
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

test("thinking selector keeps split bracketed paste ahead of remapped shortcuts", async () => {
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

	tui.send("\x1b[20");
	tui.send("0~");
	tui.send("x");
	assert.equal(tui.isOpen, true);
	tui.send("\x1b[201~\x03");
	assert.deepEqual(await running, { kind: "closed", reason: "close" });
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
