import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import btw, {
	BTW_SETTINGS_FILE,
	buildConversationContext,
	buildUserPrompt,
	completeSideQuestion,
	loadBtwThinkingLevel,
	normalizeBtwSettings,
	parseBtwModelReference,
	readBtwSettings,
	resolveBtwModel,
	sanitizeSingleLine,
} from "../src/btw.js";
import { formatKeyLabel } from "../src/text.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function withTempSettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-btw-test-"));
	try {
		await run(join(directory, BTW_SETTINGS_FILE));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

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
	assert.equal(normalizeBtwSettings({ model: "provider/model\u0000suffix" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "provider/\u001b]52;c;payload\u0007" }), undefined);
	assert.equal(normalizeBtwSettings({ model: "provider/model\u009b31m" }), undefined);
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

test("resolveBtwModel preserves deletion markers without treating null-only headers as auth", async () => {
	const configuredModel = { provider: "custom", id: "side" } as Model<Api>;
	const mixedHeaders = { Authorization: null, "X-Provider-Token": "test" };
	const mixed = await resolveBtwModel({
		settings: { model: "custom/side" },
		currentModel: undefined,
		modelRegistry: {
			find: () => configuredModel,
			getApiKeyAndHeaders: async () => ({ ok: true as const, headers: mixedHeaders }),
		} as never,
	});
	assert.deepEqual(mixed?.auth.headers, mixedHeaders);

	const warnings: string[] = [];
	const nullOnly = await resolveBtwModel({
		settings: { model: "custom/side" },
		currentModel: undefined,
		modelRegistry: {
			find: () => configuredModel,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				headers: { Authorization: null },
			}),
		} as never,
		warn: (message) => warnings.push(message),
	});
	assert.equal(nullOnly, undefined);
	assert.match(warnings[0] ?? "", /no request credentials/u);
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

test("btw command routes no arguments through the menu and preserves direct questions", async () => {
	const mock = createMockPi({ thinkingLevel: "low" });
	const selected = {
		model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const menuCalls: string[] = [];
	let fullscreenRuns = 0;
	const fullscreenCopyModes: Array<boolean | undefined> = [];
	const threadStarts: Array<{
		initialQuestion?: string;
		thinkingLevel: string;
		rememberThinkingLevelChanges?: boolean;
	}> = [];
	btw(mock.pi, {
		showCommandMenu: async () => {
			menuCalls.push("menu");
			return "start";
		},
		loadSettings: async () => ({ thinkingLevel: "medium" }),
		resolveModel: async () => ({ kind: "selected", selected }),
		runFullscreen: async (ctx, run, options) => {
			fullscreenRuns += 1;
			fullscreenCopyModes.push(options?.copyOnSelect);
			return run(ctx);
		},
		runThread: async (options) => {
			threadStarts.push({
				initialQuestion: options.initialQuestion,
				thinkingLevel: options.thinkingLevel,
				rememberThinkingLevelChanges: options.rememberThinkingLevelChanges,
			});
			return { kind: "closed" };
		},
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	let idleWaits = 0;
	const interactive = createMockContext({
		mode: "tui",
		hasUI: true,
		waitForIdle: async () => {
			idleWaits += 1;
		},
	});

	await command.handler("", interactive.ctx);
	await command.handler("direct question", interactive.ctx);

	assert.deepEqual(menuCalls, ["menu"]);
	assert.equal(fullscreenRuns, 2);
	assert.deepEqual(fullscreenCopyModes, [true, true]);
	assert.equal(idleWaits, 0);
	assert.deepEqual(threadStarts, [
		{
			initialQuestion: undefined,
			thinkingLevel: "medium",
			rememberThinkingLevelChanges: true,
		},
		{
			initialQuestion: "direct question",
			thinkingLevel: "medium",
			rememberThinkingLevelChanges: true,
		},
	]);
	assert.deepEqual(mock.thinkingLevels, []);
});

test("btw resolves automatic selection copying once from each invocation's loaded settings", async () => {
	const mock = createMockPi();
	const selected = {
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const loaded = [{}, {}, { fullscreenCopyOnSelect: false }] as const;
	const copyModes: Array<boolean | undefined> = [];
	let settingsReads = 0;
	btw(mock.pi, {
		loadSettings: async () => loaded[settingsReads++] ?? {},
		resolveModel: async () => ({ kind: "selected", selected }),
		runFullscreen: async (ctx, run, options) => {
			copyModes.push(options?.copyOnSelect);
			return run(ctx);
		},
		runThread: async () => ({ kind: "closed" }),
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	const interactive = createMockContext({ mode: "tui", hasUI: true });

	await command.handler("missing default", interactive.ctx);
	await command.handler("omitted default", interactive.ctx);
	await command.handler("manual override", interactive.ctx);

	assert.equal(settingsReads, 3);
	assert.deepEqual(copyModes, [true, true, false]);
});

test("btw same-as-main mode starts fresh threads from the current main level without remembering shortcut changes", async () => {
	const mock = createMockPi({ thinkingLevel: "high" });
	const selected = {
		model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const threadStarts: Array<{
		initialQuestion?: string;
		thinkingLevel: string;
		rememberThinkingLevelChanges?: boolean;
	}> = [];
	btw(mock.pi, {
		loadSettings: async () => ({}),
		resolveModel: async () => ({ kind: "selected", selected }),
		runFullscreen: async (ctx, run) => run(ctx),
		runThread: async (options) => {
			threadStarts.push({
				initialQuestion: options.initialQuestion,
				thinkingLevel: options.thinkingLevel,
				rememberThinkingLevelChanges: options.rememberThinkingLevelChanges,
			});
			return { kind: "closed" };
		},
	});
	const command = mock.commands.get("btw");
	assert.ok(command);

	await command.handler("same as main", createMockContext({ mode: "tui", hasUI: true }).ctx);

	assert.deepEqual(threadStarts, [
		{
			initialQuestion: "same as main",
			thinkingLevel: "high",
			rememberThinkingLevelChanges: false,
		},
	]);
	assert.deepEqual(mock.thinkingLevels, []);
});

test("btw starts a fresh side thread from a selected main-thread branch snapshot", async () => {
	const mock = createMockPi();
	const selected = {
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const rootEntry = {
		type: "message",
		id: "root",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: "Shared root context" },
	};
	const selectedEntry = {
		type: "message",
		id: "abandoned-user",
		parentId: "root",
		timestamp: "2026-01-01T00:00:02.000Z",
		message: { role: "user", content: "Selected abandoned branch" },
	};
	const activeEntry = {
		type: "message",
		id: "active-user",
		parentId: "root",
		timestamp: "2026-01-01T00:00:03.000Z",
		message: { role: "user", content: "Current active branch" },
	};
	const entries = [rootEntry, selectedEntry, activeEntry];
	const branchReads: Array<string | undefined> = [];
	let activeLeaf = "active-user";
	let settingsLoads = 0;
	let modelResolutions = 0;
	let capturedContext = "";
	const interactive = createMockContext({
		mode: "tui",
		hasUI: true,
		editorText: "main draft",
		sessionManager: {
			getLeafId: () => activeLeaf,
			getEntries: () => [...entries],
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getBranch: (id?: string) => {
				branchReads.push(id);
				return id === "abandoned-user" ? [rootEntry, selectedEntry] : [rootEntry, activeEntry];
			},
		},
	});
	btw(mock.pi, {
		showCommandMenu: async () => "tree",
		pickMainEntry: async () => {
			entries.push({
				...activeEntry,
				id: "later-active-assistant",
				message: { role: "assistant", content: "Later active response" },
			});
			activeLeaf = "later-active-assistant";
			return { kind: "selected", entryId: "abandoned-user" };
		},
		loadSettings: async () => {
			settingsLoads += 1;
			return {};
		},
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "selected", selected };
		},
		runFullscreen: async (ctx, run) => run(ctx),
		runThread: (async (options: { state: { thread: { conversationContext: string } } }) => {
			capturedContext = options.state.thread.conversationContext;
			return { kind: "closed" };
		}) as never,
	});

	await mock.commands.get("btw")?.handler("", interactive.ctx);

	assert.deepEqual(branchReads, ["abandoned-user"]);
	assert.match(capturedContext, /Shared root context/);
	assert.match(capturedContext, /Selected abandoned branch/);
	assert.doesNotMatch(capturedContext, /Current active branch|Later active response/);
	assert.equal(settingsLoads, 1);
	assert.equal(modelResolutions, 1);
	assert.equal(activeLeaf, "later-active-assistant");
	assert.equal(interactive.editorText, "main draft");
	assert.equal(entries.length, 4);
});

test("btw returns from a cancelled tree picker to the menu without resolving credentials", async () => {
	const mock = createMockPi();
	const menuResults = ["tree", "closed"];
	let pickerCalls = 0;
	let settingsLoads = 0;
	let modelResolutions = 0;
	let threadRuns = 0;
	btw(mock.pi, {
		showCommandMenu: async () => menuResults.shift() as never,
		pickMainEntry: async () => {
			pickerCalls += 1;
			return { kind: "back" };
		},
		loadSettings: async () => {
			settingsLoads += 1;
			return {};
		},
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "unavailable" };
		},
		runThread: async () => {
			threadRuns += 1;
			return { kind: "closed" };
		},
	});

	await mock.commands.get("btw")?.handler("", createMockContext({ mode: "tui", hasUI: true }).ctx);

	assert.equal(pickerCalls, 1);
	assert.equal(settingsLoads, 0);
	assert.equal(modelResolutions, 0);
	assert.equal(threadRuns, 0);
});

test("btw closes from a tree picker Ctrl+C without resolving credentials or creating a thread", async () => {
	const mock = createMockPi();
	let modelResolutions = 0;
	let threadRuns = 0;
	btw(mock.pi, {
		showCommandMenu: async () => "tree",
		pickMainEntry: async () => ({ kind: "closed" }),
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "unavailable" };
		},
		runThread: async () => {
			threadRuns += 1;
			return { kind: "closed" };
		},
	});

	await mock.commands.get("btw")?.handler("", createMockContext({ mode: "tui", hasUI: true }).ctx);

	assert.equal(modelResolutions, 0);
	assert.equal(threadRuns, 0);
});

test("btw rejects a stale selected tree entry without falling back to the active branch", async () => {
	const mock = createMockPi();
	const menuResults = ["tree", "closed"];
	let branchReads = 0;
	let modelResolutions = 0;
	const interactive = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getEntry: () => undefined,
			getBranch: () => {
				branchReads += 1;
				return [];
			},
		},
	});
	btw(mock.pi, {
		showCommandMenu: async () => menuResults.shift() as never,
		pickMainEntry: async () => ({ kind: "selected", entryId: "missing" }),
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "unavailable" };
		},
	});

	await mock.commands.get("btw")?.handler("", interactive.ctx);

	assert.equal(branchReads, 0);
	assert.equal(modelResolutions, 0);
	assert.ok(interactive.notifications.some(({ message }) => /no longer available/i.test(message)));
});

test("btw keeps multiple in-memory threads, resumes the selected one, and keeps direct questions fresh", async () => {
	const mock = createMockPi({ thinkingLevel: "low" });
	const selected = {
		model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const menuResults: unknown[] = ["start", { kind: "resume", threadId: "btw-1" }, "closed"];
	const menuSnapshots: Array<Array<{ id: string; title: string; questionCount: number }>> = [];
	const states: Array<{
		id: string;
		title?: string;
		thread: { turns: Array<{ kind: "error"; question: string; answer: string }> };
		thinkingLevel: string;
		updatedAt: number;
	}> = [];
	const initialQuestions: Array<string | undefined> = [];
	const fullscreenCopyModes: Array<boolean | undefined> = [];
	let modelResolutions = 0;
	btw(mock.pi, {
		showCommandMenu: (async (
			_pi: unknown,
			_ctx: unknown,
			resumeThreads: Array<{ id: string; title: string; questionCount: number }>,
		) => {
			menuSnapshots.push(resumeThreads.map((thread) => ({ ...thread })));
			return menuResults.shift();
		}) as never,
		loadSettings: async () => ({ thinkingLevel: "medium" }),
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "selected", selected };
		},
		runFullscreen: async (ctx, run, options) => {
			fullscreenCopyModes.push(options?.copyOnSelect);
			return run(ctx);
		},
		runThread: (async (options: {
			initialQuestion?: string;
			state: {
				id: string;
				title?: string;
				thread: { turns: Array<{ kind: "error"; question: string; answer: string }> };
				thinkingLevel: string;
				updatedAt: number;
			};
		}) => {
			initialQuestions.push(options.initialQuestion);
			states.push(options.state);
			if (states.length === 1) {
				options.state.title = "First side topic";
				options.state.thread.turns.push({
					kind: "error",
					question: "First side topic",
					answer: "first error",
				});
				options.state.thinkingLevel = "high";
				options.state.updatedAt = 10;
			} else if (states.length === 3) {
				options.state.title = "Direct side topic";
				options.state.thread.turns.push({
					kind: "error",
					question: "Direct side topic",
					answer: "direct error",
				});
				options.state.updatedAt = 20;
			}
			return { kind: "closed" };
		}) as never,
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	const interactive = createMockContext({ mode: "tui", hasUI: true });

	await command.handler("", interactive.ctx);
	await command.handler("", interactive.ctx);
	await command.handler("Direct side topic", interactive.ctx);
	await command.handler("", interactive.ctx);

	assert.deepEqual(initialQuestions, [undefined, undefined, "Direct side topic"]);
	assert.equal(states[1], states[0]);
	assert.equal(states[1]?.thinkingLevel, "high");
	assert.notEqual(states[2], states[0]);
	assert.equal(states[2]?.thread.turns.length, 1);
	assert.equal(modelResolutions, 3);
	assert.deepEqual(fullscreenCopyModes, [true, true, true]);
	assert.deepEqual(menuSnapshots, [
		[],
		[{ id: "btw-1", title: "First side topic", questionCount: 1 }],
		[
			{ id: "btw-2", title: "Direct side topic", questionCount: 1 },
			{ id: "btw-1", title: "First side topic", questionCount: 1 },
		],
	]);
});

test("an empty fresh btw thread does not enter or erase the in-memory Resume list", async () => {
	const mock = createMockPi();
	const selected = {
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const menuResults = ["start", "closed"];
	const menuSnapshots: Array<Array<{ id: string }>> = [];
	const states: Array<{
		id: string;
		title?: string;
		thread: { turns: unknown[] };
		updatedAt: number;
	}> = [];
	btw(mock.pi, {
		showCommandMenu: (async (_pi: unknown, _ctx: unknown, resumeThreads: Array<{ id: string }>) => {
			menuSnapshots.push(resumeThreads.map((thread) => ({ id: thread.id })));
			return menuResults.shift();
		}) as never,
		loadSettings: async () => ({}),
		resolveModel: async () => ({ kind: "selected", selected }),
		runFullscreen: async (ctx, run) => run(ctx),
		runThread: (async (options: {
			state: { id: string; title?: string; thread: { turns: unknown[] }; updatedAt: number };
		}) => {
			states.push(options.state);
			if (states.length === 1) {
				options.state.title = "Retained";
				options.state.thread.turns.push({ kind: "error" });
				options.state.updatedAt = 1;
			}
			return { kind: "closed" };
		}) as never,
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	const interactive = createMockContext({ mode: "tui", hasUI: true });

	await command.handler("Retained", interactive.ctx);
	await command.handler("", interactive.ctx);
	await command.handler("", interactive.ctx);

	assert.deepEqual(menuSnapshots, [[{ id: "btw-1" }], [{ id: "btw-1" }]]);
	assert.equal(states.length, 2);
	assert.equal(states[1]?.thread.turns.length, 0);
});

test("separate btw extension instances do not share in-memory Resume state", async () => {
	const first = createMockPi();
	const second = createMockPi();
	const snapshots: unknown[][] = [];
	const register = (mock: ReturnType<typeof createMockPi>) =>
		btw(mock.pi, {
			showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
				snapshots.push([...threads]);
				return "closed";
			}) as never,
		});
	register(first);
	register(second);
	const interactive = createMockContext({ mode: "tui", hasUI: true });

	await first.commands.get("btw")?.handler("", interactive.ctx);
	await second.commands.get("btw")?.handler("", interactive.ctx);

	assert.deepEqual(snapshots, [[], []]);
});

test("btw command cancellation at the no-argument menu does not resolve a model", async () => {
	const mock = createMockPi();
	let modelResolutions = 0;
	btw(mock.pi, {
		showCommandMenu: async () => "closed",
		loadSettings: async () => ({}),
		resolveModel: async () => {
			modelResolutions += 1;
			return { kind: "unavailable" };
		},
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	await command.handler("", createMockContext({ mode: "tui", hasUI: true }).ctx);

	assert.equal(modelResolutions, 0);
});

test("btw command ignores stale-context notification failures after an async boundary", async () => {
	const mock = createMockPi();
	btw(mock.pi, {
		loadSettings: async () => ({}),
		resolveModel: async () => ({ kind: "unavailable" }),
	});
	const command = mock.commands.get("btw");
	assert.ok(command);
	const interactive = createMockContext({
		mode: "tui",
		hasUI: true,
		ui: {
			notify() {
				throw new Error("Extension context is no longer active");
			},
		},
	});

	assert.equal(await command.handler("direct question", interactive.ctx), undefined);
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

test("buildConversationContext keeps its 40,000-character tail bound", () => {
	const context = buildConversationContext([
		{
			type: "message",
			message: { role: "user", content: `old-marker-${"x".repeat(41_000)}-new-marker` },
		},
	]);

	assert.match(context, /^\[Earlier context omitted; showing the last 40000 characters\.\]/);
	assert.equal(context.endsWith("-new-marker"), true);
	assert.doesNotMatch(context, /old-marker/);
});

test("buildUserPrompt falls back when no conversation context exists", () => {
	const prompt = buildUserPrompt("What now?", "");

	assert.match(prompt, /<side_question>\nWhat now\?\n<\/side_question>/);
	assert.match(prompt, /No prior conversation context was available/);
});

test("sanitizeSingleLine removes controls and collapses whitespace", () => {
	assert.equal(sanitizeSingleLine(" /btw\nhello\t\u0000 world  "), "/btw hello world");
});

test("formatKeyLabel humanizes effective keys after stripping terminal controls", () => {
	assert.equal(formatKeyLabel("ctrl+shift+x"), "Ctrl+Shift+X");
	assert.equal(formatKeyLabel("\u001b\u009bctrl+x\n"), "Ctrl+X");
	assert.equal(formatKeyLabel(""), "");
});
