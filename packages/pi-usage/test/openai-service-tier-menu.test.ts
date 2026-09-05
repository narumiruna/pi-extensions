import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";
import usageExtension from "../src/usage.js";

const codexModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

function runtime(kind: UsageSettingsState["kind"] = "loaded") {
	let state: UsageSettingsState = {
		kind,
		path: "/tmp/pi-usage.json",
		settings: {
			openaiServiceTier: "default",
			codexStatusResetCountdown: false,
			selectedTargets: {},
		},
		...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
	};
	const patches: unknown[] = [];
	const settingsRuntime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch) {
			patches.push(patch);
			state = {
				...state,
				kind: "loaded",
				settings: { ...state.settings, ...patch },
				document: { ...state.document, ...patch },
			};
			return structuredClone(state);
		},
		async updateSelectedTarget() {
			throw new Error("target selection is not used in service-tier menu tests");
		},
		async flush() {},
	};
	return {
		settingsRuntime,
		patches,
		get state() {
			return state;
		},
	};
}

function registry() {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "codex-token" }),
		getProviderAuth: async () => ({ auth: { apiKey: "codex-token" } }),
		getAvailable: () => [codexModel],
		getAll: () => [codexModel],
		getProviderAuthStatus: () => ({ configured: true }),
		getProviderDisplayName: () => "OpenAI Codex",
	};
}

function response(): Promise<Response> {
	return Promise.resolve(
		new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		),
	);
}

test("/usage shows service-tier state and toggles the same persistent preference", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const memory = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memory.settingsRuntime });
	const choices = ["Turn Priority mode on", "Close"];
	const titles: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.deepEqual(memory.patches, [{ openaiServiceTier: "priority" }]);
	assert.match(titles[0] ?? "", /OpenAI service tier: default/);
	assert.match(titles[0] ?? "", /1\.5× faster.*uses more/);
	assert.match(notifications[0]?.message ?? "", /Priority.*enabled/);
});

test("/usage cancellation does not change service tier and unsupported models show no toggle", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const cancelled = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: cancelled.settingsRuntime });
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (_title: string, values: string[]) => {
			options = values;
			return undefined;
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.ok(options.includes("Turn Priority mode on"));
	assert.deepEqual(cancelled.patches, []);

	const unsupported = runtime();
	const unsupportedMock = createMockPi();
	usageExtension(unsupportedMock.pi, { settingsRuntime: unsupported.settingsRuntime });
	let unsupportedTitle = "";
	let unsupportedOptions: string[] = [];
	const unsupportedModel = { ...codexModel, id: "gpt-5.4-mini" };
	const unsupportedContext = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: unsupportedModel,
		select: async (title: string, values: string[]) => {
			unsupportedTitle = title;
			unsupportedOptions = values;
			return "Close";
		},
		modelRegistry: {
			...registry(),
			getAvailable: () => [unsupportedModel],
			getAll: () => [unsupportedModel],
		},
	});
	await unsupportedMock.commands.get("usage")?.handler("", unsupportedContext.ctx);
	assert.match(unsupportedTitle, /OpenAI service tier: Unavailable/);
	assert.ok(!unsupportedOptions.some((value) => value.includes("Priority mode on")));
});

test("invalid settings make the /usage service-tier actions visibly read-only", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const invalid = runtime("invalid");
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: invalid.settingsRuntime });
	let rendered = "";
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, values: string[]) => {
			rendered = title;
			options = values;
			return "Close";
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.match(rendered, /OpenAI service tier: default/);
	assert.ok(options.includes("Turn Priority mode on"));
	assert.deepEqual(invalid.patches, []);
});
