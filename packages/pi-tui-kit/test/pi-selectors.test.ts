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

test("thinking selector honors remapped save-default binding", async () => {
	const tui = createTuiHarness({
		keybindings: {
			matches: (data, binding) => {
				if (String(binding) === "app.thinking.save") return data === "x";
				if (binding === "tui.select.down") return data === "j";
				if (binding === "tui.select.cancel") return data === "q";
				return data === "\r" && binding === "tui.select.confirm";
			},
			getKeys: (binding) => {
				if (String(binding) === "app.thinking.save") return ["x"];
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
	assert.ok(frame.some((line) => line.includes("alt+t cycles thinking levels in-session")));
	assert.ok(frame.some((line) => line.includes("x set as default")));

	tui.send("j");
	tui.send("x");
	assert.deepEqual(await running, { kind: "saveDefault", level: "high" });
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
