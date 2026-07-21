import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createMockContext, createMockPi } from "../../../test/support.js";
import btw, {
	BTW_SETTINGS_FILE,
	buildConversationContext,
	buildUserPrompt,
	completeSideQuestion,
	loadBtwThinkingLevel,
	loadCompleteSimple,
	normalizeBtwSettings,
	parseBtwModelReference,
	readBtwSettings,
	resolveBtwModel,
	sanitizeSingleLine,
} from "../src/btw.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function withTempSettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-btw-test-"));
	try {
		await run(join(directory, BTW_SETTINGS_FILE));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("loadCompleteSimple prefers compat and falls back to the root module", async () => {
	const compatCompleteSimple = async () => ({ source: "compat" });
	const rootCompleteSimple = async () => ({ source: "root" });
	const preferredImports: string[] = [];
	const preferred = await loadCompleteSimple(async (moduleId) => {
		preferredImports.push(moduleId);
		return moduleId.endsWith("/compat")
			? { completeSimple: compatCompleteSimple }
			: { completeSimple: rootCompleteSimple };
	});

	assert.equal(preferred, compatCompleteSimple);
	assert.deepEqual(preferredImports, ["@earendil-works/pi-ai/compat"]);

	const fallbackImports: string[] = [];
	const fallback = await loadCompleteSimple(async (moduleId) => {
		fallbackImports.push(moduleId);
		if (moduleId.endsWith("/compat")) throw new Error("missing compat export");
		return { completeSimple: rootCompleteSimple };
	});

	assert.equal(fallback, rootCompleteSimple);
	assert.deepEqual(fallbackImports, ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]);
});

test("loadCompleteSimple reports when neither module exports completeSimple", async () => {
	await assert.rejects(
		loadCompleteSimple(async (moduleId) => {
			if (moduleId.endsWith("/compat")) throw new Error("missing compat export");
			return {};
		}),
		/@earendil-works\/pi-ai does not export completeSimple/,
	);
});

test("normalizeBtwSettings accepts optional model and thinking level", () => {
	assert.deepEqual(normalizeBtwSettings({}), {});
	assert.deepEqual(normalizeBtwSettings({ futureOption: true }), {});
	assert.deepEqual(normalizeBtwSettings({ model: "anthropic/claude-sonnet-4-5" }), {
		model: "anthropic/claude-sonnet-4-5",
	});
	assert.deepEqual(normalizeBtwSettings({ model: "openrouter/anthropic/claude-sonnet" }), {
		model: "openrouter/anthropic/claude-sonnet",
	});

	for (const thinkingLevel of THINKING_LEVELS) {
		assert.deepEqual(normalizeBtwSettings({ thinkingLevel }), { thinkingLevel });
		assert.deepEqual(normalizeBtwSettings({ model: "test/model", thinkingLevel }), {
			model: "test/model",
			thinkingLevel,
		});
	}

	assert.equal(normalizeBtwSettings(null), undefined);
	assert.equal(normalizeBtwSettings([]), undefined);
	assert.equal(normalizeBtwSettings({ model: "" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "model-without-provider" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "/model" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "provider/" }), undefined);
	assert.equal(normalizeBtwSettings({ model: " provider/model" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "provider/model " }), undefined);
	assert.equal(normalizeBtwSettings({ model: "provider/\nmodel" }), undefined);
	assert.equal(normalizeBtwSettings({ thinkingLevel: null }), undefined);
	assert.equal(normalizeBtwSettings({ thinkingLevel: "huge" }), undefined);
});

test("parseBtwModelReference splits only the first slash", () => {
	assert.deepEqual(parseBtwModelReference("openrouter/anthropic/claude-sonnet"), {
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet",
	});
	assert.equal(parseBtwModelReference("invalid"), undefined);
});

test("resolveBtwModel selects configured model and its credentials", async () => {
	const currentModel = { provider: "current", id: "main" } as Model<Api>;
	const configuredModel = { provider: "openrouter", id: "anthropic/claude" } as Model<Api>;
	const credentialReads: Model<Api>[] = [];
	const warnings: string[] = [];
	const result = await resolveBtwModel({
		settings: { model: "openrouter/anthropic/claude", thinkingLevel: "low" },
		currentModel,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === "openrouter" && modelId === "anthropic/claude" ? configuredModel : undefined,
			getApiKeyAndHeaders: async (model: Model<Api>) => {
				credentialReads.push(model);
				return { ok: true as const, apiKey: "configured-key", headers: { test: "yes" } };
			},
		} as never,
		warn: (message) => warnings.push(message),
	});

	assert.equal(result?.model, configuredModel);
	assert.equal(result?.auth.apiKey, "configured-key");
	assert.deepEqual(credentialReads, [configuredModel]);
	assert.deepEqual(warnings, []);
});

test("resolveBtwModel accepts header-only and environment-only configured auth", async () => {
	for (const auth of [
		{ ok: true as const, headers: { Authorization: "Bearer test" } },
		{ ok: true as const, env: { PROVIDER_TOKEN: "test" } },
	]) {
		const configuredModel = { provider: "custom", id: "side" } as Model<Api>;
		const result = await resolveBtwModel({
			settings: { model: "custom/side" },
			currentModel: undefined,
			modelRegistry: {
				find: () => configuredModel,
				getApiKeyAndHeaders: async () => auth,
			} as never,
		});

		assert.equal(result?.model, configuredModel);
		assert.deepEqual(result?.auth.headers, auth.headers);
		assert.deepEqual(result?.auth.env, auth.env);
	}
});

test("resolveBtwModel inherits current model when no model is configured", async () => {
	const currentModel = { provider: "current", id: "main" } as Model<Api>;
	const result = await resolveBtwModel({
		settings: { thinkingLevel: "high" },
		currentModel,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "current-key" }),
		} as never,
	});

	assert.equal(result?.model, currentModel);
	assert.equal(result?.auth.apiKey, "current-key");
});

test("resolveBtwModel warns and falls back for unavailable configured models", async () => {
	const currentModel = { provider: "current", id: "main" } as Model<Api>;
	for (const configuredAuth of [
		{ ok: true as const, apiKey: undefined },
		{ ok: false as const, error: "credential command failed" },
	]) {
		const configuredModel = { provider: "other", id: "side" } as Model<Api>;
		const warnings: string[] = [];
		const result = await resolveBtwModel({
			settings: { model: "other/side" },
			currentModel,
			modelRegistry: {
				find: () => configuredModel,
				getApiKeyAndHeaders: async (model: Model<Api>) =>
					model === configuredModel ? configuredAuth : { ok: true as const, apiKey: "current-key" },
			} as never,
			warn: (message) => warnings.push(message),
		});

		assert.equal(result?.model, currentModel);
		assert.equal(result?.auth.apiKey, "current-key");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /other\/side/);
		assert.match(warnings[0] ?? "", /current\/main/);
	}

	const warnings: string[] = [];
	const missing = await resolveBtwModel({
		settings: { model: "missing/model" },
		currentModel,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "current-key" }),
		} as never,
		warn: (message) => warnings.push(message),
	});
	assert.equal(missing?.model, currentModel);
	assert.match(warnings[0] ?? "", /not found/);
});

test("resolveBtwModel does not retry credentials when configured and current models are identical", async () => {
	const model = { provider: "same", id: "model" } as Model<Api>;
	let credentialReads = 0;
	const result = await resolveBtwModel({
		settings: { model: "same/model" },
		currentModel: model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => {
				credentialReads += 1;
				throw new Error("credential command failed");
			},
		} as never,
	});

	assert.equal(result, undefined);
	assert.equal(credentialReads, 1);
});

test("resolveBtwModel returns undefined when neither configured nor current model is usable", async () => {
	const warnings: string[] = [];
	const result = await resolveBtwModel({
		settings: { model: "missing/model" },
		currentModel: undefined,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false as const, error: "unused" }),
		} as never,
		warn: (message) => warnings.push(message),
	});

	assert.equal(result, undefined);
	assert.equal(warnings.length, 1);
});

test("missing pi-btw settings inherit silently without creating a file", async () => {
	await withTempSettings(async (settingsPath) => {
		assert.deepEqual(await readBtwSettings(settingsPath), { kind: "missing" });

		const warnings: string[] = [];
		assert.equal(
			await loadBtwThinkingLevel("high", {
				settingsPath,
				warn: (message) => warnings.push(message),
			}),
			"high",
		);
		assert.deepEqual(warnings, []);
		await assert.rejects(readFile(settingsPath, "utf8"), (error: unknown) => {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		});
	});
});

test("pi-btw settings override the current runtime thinking level", async () => {
	await withTempSettings(async (settingsPath) => {
		await writeFile(settingsPath, "{}\n", "utf8");
		assert.equal(await loadBtwThinkingLevel("medium", { settingsPath }), "medium");

		for (const thinkingLevel of THINKING_LEVELS) {
			await writeFile(settingsPath, `${JSON.stringify({ thinkingLevel })}\n`, "utf8");
			assert.equal(await loadBtwThinkingLevel("medium", { settingsPath }), thinkingLevel);
		}
	});
});

test("invalid pi-btw settings warn and fall back to the runtime level", async () => {
	await withTempSettings(async (settingsPath) => {
		for (const contents of ["{not-json", '{"thinkingLevel":42}\n', '{"thinkingLevel":"huge"}\n']) {
			await writeFile(settingsPath, contents, "utf8");
			const warnings: string[] = [];
			assert.equal(
				await loadBtwThinkingLevel("low", {
					settingsPath,
					warn: (message) => warnings.push(message),
				}),
				"low",
			);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /pi-btw settings ignored/);
			assert.match(warnings[0] ?? "", /thinkingLevel/);
			assert.match(warnings[0] ?? "", new RegExp(BTW_SETTINGS_FILE));
		}

		await rm(settingsPath, { force: true });
		await mkdir(settingsPath);
		const warnings: string[] = [];
		assert.equal(
			await loadBtwThinkingLevel("medium", {
				settingsPath,
				warn: (message) => warnings.push(message),
			}),
			"medium",
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /pi-btw settings ignored/);
	});
});

test("side-question completion maps thinking levels into provider-neutral options", async () => {
	for (const thinkingLevel of THINKING_LEVELS) {
		let capturedContext: unknown;
		let capturedOptions: Record<string, unknown> | undefined;
		const response = { role: "assistant", stopReason: "stop", content: [] };
		const result = await completeSideQuestion({
			completeSimple: (async (
				_model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			) => {
				capturedContext = context;
				capturedOptions = options as Record<string, unknown>;
				return response as never;
			}) as never,
			model: { id: "test-model" } as never,
			question: "Why?",
			conversationContext: "User: context",
			thinkingLevel,
			auth: {
				apiKey: "test-key",
				headers: { "x-test": "yes" },
				env: { TEST_ENV: "yes" },
			},
		});

		assert.equal(result, response);
		assert.match(JSON.stringify(capturedContext), /<side_question>\\nWhy\?/);
		assert.equal(capturedOptions?.apiKey, "test-key");
		assert.deepEqual(capturedOptions?.headers, { "x-test": "yes" });
		assert.deepEqual(capturedOptions?.env, { TEST_ENV: "yes" });
		if (thinkingLevel === "off") {
			assert.equal(Object.hasOwn(capturedOptions ?? {}, "reasoning"), false);
		} else {
			assert.equal(capturedOptions?.reasoning, thinkingLevel);
		}
	}
});

test("btw command rejects non-TUI mode before reading the runtime thinking level", async () => {
	const mock = createMockPi();
	let thinkingLevelReads = 0;
	mock.rawPi.getThinkingLevel = () => {
		thinkingLevelReads += 1;
		return "medium";
	};
	btw(mock.pi);
	assert.equal(thinkingLevelReads, 0);

	const command = mock.commands.get("btw");
	assert.ok(command);
	const nonInteractive = createMockContext({ mode: "print", hasUI: false });
	await command.handler("", nonInteractive.ctx);

	assert.equal(mock.commands.size, 1);
	assert.equal(
		command.description,
		"Ask a quick side question without adding it to the main conversation",
	);
	assert.equal(nonInteractive.notifications[0]?.level, "error");
	assert.doesNotMatch(nonInteractive.notifications[0]?.message ?? "", /Usage/);
	assert.equal(thinkingLevelReads, 0);
});

test("buildConversationContext formats user, assistant, and tool content", () => {
	const context = buildConversationContext([
		{ type: "ignored", message: { role: "user", content: "skip" } },
		{
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: " Inspect this " },
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "toolResult", name: "read", result: { ok: true } }],
			},
		},
	]);

	assert.match(context, /User: Inspect this\nTool call: read\(\{"path":"README\.md"\}\)/);
	assert.match(context, /Assistant \(length\): Tool result from read: \{"ok":true\}/);
	assert.doesNotMatch(context, /skip/);
});

test("buildUserPrompt falls back when no conversation context exists", () => {
	const prompt = buildUserPrompt("What now?", "");

	assert.match(prompt, /<side_question>\nWhat now\?\n<\/side_question>/);
	assert.match(prompt, /No prior conversation context was available/);
});

test("sanitizeSingleLine removes controls and collapses whitespace", () => {
	assert.equal(sanitizeSingleLine(" /btw\nhello\t\u0000 world  "), "/btw hello world");
});
