import assert from "node:assert/strict";
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICodexResponsesOptions,
	type Provider,
} from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	createCheckpointDetails,
	fallbackSummary,
	parseCheckpointDetails,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
	type CodexCompactSettingsRuntime,
	type CodexCompactSettingsState,
	DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const model = {
	id: "gpt-5.6",
	name: "GPT-5.6",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} as Model<"openai-codex-responses">;

const usage = {
	input: 20,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 21,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function settingsRuntime(overrides = {}): CodexCompactSettingsRuntime {
	let state: CodexCompactSettingsState = {
		kind: "loaded",
		path: "/tmp/test-pi-codex-compact.json",
		settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, ...overrides },
		document: {},
	};
	return {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch) {
			state = { ...state, settings: { ...state.settings, ...patch } };
			return structuredClone(state);
		},
		async flush() {},
	};
}

function fakeProvider(
	onOptions?: (options: OpenAICodexResponsesOptions) => void,
	providerModel: Model<Api> = model,
	onPreparedPayload?: (payload: unknown) => void,
	protocol: "remote-v2" | "responses-compact" = "remote-v2",
	onContext?: (context: Context) => void,
): Provider {
	return {
		id: providerModel.provider,
		name: "Codex Responses proxy",
		auth: {} as Provider["auth"],
		getModels: () => [providerModel],
		stream(activeModel, context, options) {
			onContext?.(context);
			const codexOptions = options as OpenAICodexResponsesOptions;
			onOptions?.(codexOptions);
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					const input = context.messages.map((message) => {
						const content =
							typeof message.content === "string" ? message.content : message.content[0];
						const text =
							typeof content === "string" ? content : "text" in content ? content.text : "image";
						return { role: "user", content: [{ type: "input_text", text }] };
					});
					const payload = await options?.onPayload?.({ model: activeModel.id, input }, activeModel);
					onPreparedPayload?.(payload);
					const payloadInput = (payload as { input: Array<Record<string, unknown>> }).input;
					assert.equal(
						payloadInput.at(-1)?.type === "compaction_trigger",
						protocol === "remote-v2",
					);
					const response = await options?.fetch?.("https://example.test/responses", {
						method: "POST",
						signal: options?.signal,
					});
					await response?.text();
					const message = {
						role: "assistant" as const,
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage,
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				} catch (error) {
					const message = {
						role: "assistant" as const,
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage,
						stopReason: "error" as const,
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
				}
			})();
			assert.equal(codexOptions.maxRetries, 2);
			return stream;
		},
		streamSimple() {
			throw new Error("not used");
		},
	};
}

function branch(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		},
		{
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
}

function event(
	signal = new AbortController().signal,
	branchEntries = branch(),
	reason: SessionBeforeCompactEvent["reason"] = "manual",
	willRetry = false,
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "assistant",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 123,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
		branchEntries,
		reason,
		willRetry,
		signal,
	};
}

function sseResponse() {
	const item = { type: "compaction", encrypted_content: "opaque" };
	return new Response(
		`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`,
	);
}

function compactJsonResponse() {
	return Response.json({
		id: "resp_compact",
		object: "response.compaction",
		created_at: 1,
		output: [
			{ role: "user", content: [{ type: "input_text", text: "retained" }] },
			{ type: "compaction", encrypted_content: "opaque-openai" },
		],
		usage: {
			input_tokens: 20,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 1,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 21,
		},
	});
}

function legacyFallbackSummary(checkpointId: string): string {
	return [
		`OpenAI Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely.`,
		"Full replay requires @narumitw/pi-codex-compact and an openai-codex model.",
		"Without them, only Pi's retained recent messages remain available.",
	].join(" ");
}

test("command rejects undocumented arguments in every mode", async () => {
	const mock = createMockPi();
	createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
	const command = mock.commands.get("codex-compact");
	assert.ok(command);
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		await assert.rejects(
			async () => {
				await command.handler("unexpected", createMockContext({ mode }).ctx);
			},
			{ message: "Usage: /codex-compact" },
		);
	}
});

test("custom Codex Responses providers compact and replay by API and exact model ID", async () => {
	const mock = createMockPi();
	const customModel = { ...model, provider: "company-codex-proxy" };
	let forwardedHeaders: OpenAICodexResponsesOptions["headers"];
	const runtime = settingsRuntime();
	createCodexCompactExtension({ settingsRuntime: runtime, fetch: async () => sseResponse() })(
		mock.pi,
	);
	assert.equal(
		mock.commands.get("codex-compact")?.description,
		"Compact now or configure Responses compaction",
	);
	const handler = mock.events.get("session_before_compact")?.[0];
	assert.ok(handler);
	const entries = branch();
	const { ctx, statuses } = createMockContext({
		model: customModel,
		getSystemPrompt: () => "system",
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => entries,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				headers: { Authorization: null, "X-Provider-Token": "provider-secret" },
			}),
			getProvider: () =>
				fakeProvider((options) => {
					forwardedHeaders = options.headers;
				}, customModel),
		},
	});
	const result = (await handler?.(event(), ctx)) as {
		compaction: { usage: unknown; details: unknown; summary: string };
	};
	assert.deepEqual(result.compaction.usage, usage);
	assert.deepEqual(forwardedHeaders, {
		Authorization: null,
		"X-Provider-Token": "provider-secret",
	});
	const details = parseCheckpointDetails(result.compaction.details);
	assert.ok(details);
	assert.equal(details.provider, customModel.provider);
	assert.doesNotMatch(JSON.stringify(details), /provider-secret|X-Provider-Token/);
	assert.match(result.compaction.summary, /requires @narumitw\/pi-codex-compact/);
	assert.equal(statuses.get("codex-compact"), undefined);

	const kept = entries[1].type === "message" ? entries[1].message : assert.fail("kept message");
	const persistedReplaySummary = legacyFallbackSummary(details.checkpointId);
	const compactionEntry = {
		type: "compaction" as const,
		id: "compact",
		parentId: "assistant",
		timestamp: "2026-01-01T00:00:02.000Z",
		summary: persistedReplaySummary,
		firstKeptEntryId: "assistant",
		tokensBefore: 123,
		details,
	};
	const replaySessionManager = {
		getSessionId: () => "session",
		getBranch: () => [...entries, compactionEntry],
	};
	const replayContext = createMockContext({
		model: { ...customModel, provider: "second-codex-proxy" },
		sessionManager: replaySessionManager,
	}).ctx;
	const summaryMessage = {
		role: "compactionSummary" as const,
		summary: persistedReplaySummary,
		tokensBefore: 123,
		timestamp: 3,
	};
	const later = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "later" }],
		timestamp: 4,
	};
	const contextHandler = mock.events.get("context")?.[0];
	const contextEvent = { type: "context" as const, messages: [summaryMessage, kept, later] };
	const projected = (await contextHandler?.(contextEvent, replayContext)) as {
		messages: Array<{ content: Array<{ text: string }> }>;
	};
	assert.equal(projected.messages.length, 2);
	const marker = projected.messages[0].content[0].text;
	const payloadHandler = mock.events.get("before_provider_request")?.[0];
	const rewritten = (await payloadHandler?.(
		{
			type: "before_provider_request",
			payload: {
				input: [
					{ role: "user", content: [{ type: "input_text", text: marker }] },
					{ role: "user", content: [{ type: "input_text", text: "later" }] },
				],
			},
		},
		replayContext,
	)) as { input: Array<Record<string, unknown>> };
	assert.equal(rewritten.input.at(-2)?.type, "compaction");
	assert.match(JSON.stringify(rewritten.input.at(-1)), /later/);

	const differentModel = createMockContext({
		model: { ...customModel, id: "gpt-5.6-different" },
		sessionManager: replaySessionManager,
	}).ctx;
	assert.equal(await contextHandler?.(contextEvent, differentModel), undefined);
	const differentApi = createMockContext({
		model: { ...customModel, api: "openai-responses" },
		sessionManager: replaySessionManager,
	}).ctx;
	assert.equal(await contextHandler?.(contextEvent, differentApi), undefined);
});

test("generic OpenAI Responses compacts through the unary endpoint", async () => {
	const mock = createMockPi();
	const openAIModel = {
		...model,
		api: "openai-responses" as const,
		provider: "company-openai-proxy",
		baseUrl: "https://example.test",
	};
	createCodexCompactExtension({
		settingsRuntime: settingsRuntime(),
		fetch: async (input, init) => {
			assert.equal(String(input), "https://example.test/responses/compact");
			assert.equal(new Headers(init?.headers).get("content-encoding"), null);
			return compactJsonResponse();
		},
	})(mock.pi);
	const handler = mock.events.get("session_before_compact")?.[0];
	const entries = branch();
	const { ctx, notifications, statuses } = createMockContext({
		model: openAIModel,
		getSystemPrompt: () => "system",
		sessionManager: { getSessionId: () => "session", getBranch: () => entries },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
			getProvider: () => fakeProvider(undefined, openAIModel, undefined, "responses-compact"),
		},
		hasUI: true,
	});

	const result = (await handler?.(event(), ctx)) as {
		compaction: { details: unknown; usage: unknown };
	};
	const details = parseCheckpointDetails(result.compaction.details);
	assert.ok(details);
	assert.equal(details.api, "openai-responses");
	assert.equal(details.protocol, "responses-compact");
	assert.deepEqual(result.compaction.usage, usage);
	assert.deepEqual(notifications, []);
	assert.equal(statuses.get("codex-compact"), undefined);
});

test("manual, threshold, and overflow compaction preserve Pi preparation boundaries", async () => {
	for (const [reason, willRetry] of [
		["manual", false],
		["threshold", false],
		["overflow", true],
	] as const) {
		const mock = createMockPi();
		createCodexCompactExtension({
			settingsRuntime: settingsRuntime(),
			fetch: async () => sseResponse(),
		})(mock.pi);
		const handler = mock.events.get("session_before_compact")?.[0];
		const { ctx } = createMockContext({
			model,
			getSystemPrompt: () => "system",
			sessionManager: { getSessionId: () => "session", getBranch: () => branch() },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true }),
				getProvider: () => fakeProvider(),
			},
		});
		const compactEvent = event(new AbortController().signal, branch(), reason, willRetry);
		if (reason === "overflow") {
			compactEvent.preparation.isSplitTurn = true;
			compactEvent.preparation.turnPrefixMessages = [
				{ role: "user", content: [{ type: "text", text: "split prefix" }], timestamp: 1 },
			];
		}
		const result = (await handler?.(compactEvent, ctx)) as {
			compaction: { firstKeptEntryId: string; tokensBefore: number };
		};
		assert.equal(result.compaction.firstKeptEntryId, compactEvent.preparation.firstKeptEntryId);
		assert.equal(result.compaction.tokensBefore, compactEvent.preparation.tokensBefore);
	}
});

test("remote requests preserve ordered active tool fields exposed by Pi", async () => {
	const constrainedSampling = { type: "json_schema" as const, strict: "require" as const };
	const mock = createMockPi({
		activeTools: ["second", "first"],
		allTools: [
			{
				name: "first",
				description: "first tool",
				parameters: { type: "object" },
				constrainedSampling,
			},
			{
				name: "second",
				description: "second tool",
				parameters: { type: "object" },
			},
		],
	});
	let observed: Context | undefined;
	createCodexCompactExtension({
		settingsRuntime: settingsRuntime(),
		fetch: async () => sseResponse(),
	})(mock.pi);
	const handler = mock.events.get("session_before_compact")?.[0];
	const { ctx } = createMockContext({
		model,
		getSystemPrompt: () => "system",
		sessionManager: { getSessionId: () => "session", getBranch: () => branch() },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProvider: () =>
				fakeProvider(undefined, model, undefined, "remote-v2", (context) => {
					observed = context;
				}),
		},
	});

	await handler?.(event(), ctx);
	assert.deepEqual(observed?.tools, [
		{
			name: "second",
			description: "second tool",
			parameters: { type: "object" },
		},
		{
			name: "first",
			description: "first tool",
			parameters: { type: "object" },
		},
	]);
});

test("checkpoint projection is idempotent and preserves ordinary request prefixes", async () => {
	const mock = createMockPi();
	const entries = branch();
	const kept = entries[1].type === "message" ? entries[1].message : assert.fail("kept message");
	const details = createCheckpointDetails({
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		protocol: "remote-v2",
		replacementHistory: [
			{ role: "user", content: [{ type: "input_text", text: "older context" }] },
			{ type: "compaction", encrypted_content: "prior-opaque" },
		],
		keptMessages: [kept],
		checkpointId: "prefix-checkpoint",
		createdAt: "2026-01-01T00:00:02.000Z",
	});
	const summary = fallbackSummary(details.checkpointId);
	const checkpointEntry = {
		type: "compaction" as const,
		id: "compact",
		parentId: "assistant",
		timestamp: "2026-01-01T00:00:02.000Z",
		summary,
		firstKeptEntryId: "assistant",
		tokensBefore: 123,
		details,
	};
	createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
	const { ctx } = createMockContext({
		model,
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => [...entries, checkpointEntry],
		},
	});
	const contextHandler = mock.events.get("context")?.[0];
	const payloadHandler = mock.events.get("before_provider_request")?.[0];
	const summaryMessage = {
		role: "compactionSummary" as const,
		summary,
		tokensBefore: 123,
		timestamp: 3,
	};
	const later = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "later" }],
		timestamp: 4,
	};
	const contextEvent = {
		type: "context" as const,
		messages: [summaryMessage, kept, later],
	};
	const firstProjection = (await contextHandler?.(contextEvent, ctx)) as {
		messages: Array<{ content: Array<{ text: string }> }>;
	};
	assert.deepEqual(await contextHandler?.(contextEvent, ctx), firstProjection);
	const marker = firstProjection.messages[0].content[0].text;
	const firstPayload = {
		input: [
			{ role: "user", content: [{ type: "input_text", text: marker }] },
			{ role: "user", content: [{ type: "input_text", text: "later" }] },
		],
	};
	const first = (await payloadHandler?.(
		{ type: "before_provider_request", payload: firstPayload },
		ctx,
	)) as { input: unknown[] };
	const second = (await payloadHandler?.(
		{
			type: "before_provider_request",
			payload: {
				...firstPayload,
				input: [
					...firstPayload.input,
					{ role: "user", content: [{ type: "input_text", text: "new tail" }] },
				],
			},
		},
		ctx,
	)) as { input: unknown[] };
	assert.deepEqual(second.input.slice(0, first.input.length), first.input);
	assert.equal(
		await payloadHandler?.({ type: "before_provider_request", payload: first }, ctx),
		undefined,
	);
});

test("repeated compaction projects a persisted legacy summary across protocols", async () => {
	const mock = createMockPi();
	const entries = branch();
	const kept = entries[1].type === "message" ? entries[1].message : assert.fail("kept message");
	const details = createCheckpointDetails({
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		protocol: "remote-v2",
		replacementHistory: [
			{ role: "user", content: [{ type: "input_text", text: "older context" }] },
			{ type: "compaction", encrypted_content: "prior-opaque" },
		],
		keptMessages: [kept],
		checkpointId: "legacy-checkpoint",
		createdAt: "2026-01-01T00:00:02.000Z",
	});
	const persistedSummary = legacyFallbackSummary(details.checkpointId);
	const checkpointEntry = {
		type: "compaction" as const,
		id: "legacy-compact",
		parentId: "assistant",
		timestamp: "2026-01-01T00:00:02.000Z",
		summary: persistedSummary,
		firstKeptEntryId: "assistant",
		tokensBefore: 123,
		details,
	};
	const repeatedBranch = [...entries, checkpointEntry];
	let preparedPayload: unknown;
	createCodexCompactExtension({
		settingsRuntime: settingsRuntime({ protocol: "responses-compact" }),
		fetch: async () => compactJsonResponse(),
	})(mock.pi);
	const handler = mock.events.get("session_before_compact")?.[0];
	const { ctx, notifications, statuses } = createMockContext({
		model,
		getSystemPrompt: () => "system",
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => repeatedBranch,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProvider: () =>
				fakeProvider(
					undefined,
					model,
					(payload) => {
						preparedPayload = payload;
					},
					"responses-compact",
				),
		},
		hasUI: true,
	});

	const result = (await handler?.(event(new AbortController().signal, repeatedBranch), ctx)) as {
		compaction: { details: unknown };
	};
	const parsed = parseCheckpointDetails(result.compaction.details);
	assert.ok(parsed);
	assert.equal(parsed.protocol, "responses-compact");
	assert.deepEqual((preparedPayload as { input: unknown[] }).input.at(-1), {
		type: "compaction",
		encrypted_content: "prior-opaque",
	});
	assert.doesNotMatch(
		JSON.stringify(preparedPayload),
		/legacy-checkpoint.*stores the older history/,
	);
	assert.deepEqual(notifications, []);
	assert.equal(statuses.get("codex-compact"), undefined);
});

test("valid session startup reloads settings without a package warning", async () => {
	const mock = createMockPi();
	createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
	const start = mock.events.get("session_start")?.[0];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		sessionManager: { getSessionId: () => "session", getBranch: () => [] },
	});

	await start?.({ type: "session_start", reason: "startup" }, ctx);

	assert.deepEqual(notifications, []);
});

test("session lifecycle reloads settings and drops stale reload continuations", async () => {
	const mock = createMockPi();
	let reloads = 0;
	let flushes = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = settingsRuntime();
	const delayed: CodexCompactSettingsRuntime = {
		...runtime,
		async reload(signal) {
			reloads += 1;
			await blocked;
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			return runtime.get();
		},
		async flush() {
			flushes += 1;
		},
	};
	createCodexCompactExtension({ settingsRuntime: delayed })(mock.pi);
	const start = mock.events.get("session_start")?.[0];
	const shutdown = mock.events.get("session_shutdown")?.[0];
	const { ctx, notifications, statuses } = createMockContext({
		hasUI: true,
		sessionManager: { getSessionId: () => "session", getBranch: () => [] },
	});
	const pending = Promise.resolve(start?.({ type: "session_start", reason: "startup" }, ctx));
	await Promise.resolve();
	await shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);
	release();
	await pending;
	assert.equal(reloads, 1);
	assert.equal(flushes, 1);
	assert.equal(notifications.length, 0, "stale startup does not notify through the old session");
	assert.equal(statuses.get("codex-compact"), undefined);
});

test("session shutdown aborts an in-flight remote compaction and clears its status", async () => {
	const mock = createMockPi();
	let requestStarted!: () => void;
	const ready = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	createCodexCompactExtension({
		settingsRuntime: settingsRuntime(),
		fetch: async (_input, init) => {
			requestStarted();
			return new Promise<Response>((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		},
	})(mock.pi);
	const handler = mock.events.get("session_before_compact")?.[0];
	const shutdown = mock.events.get("session_shutdown")?.[0];
	const { ctx, statuses } = createMockContext({
		model,
		getSystemPrompt: () => "system",
		sessionManager: { getSessionId: () => "session", getBranch: () => branch() },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
			getProvider: () => fakeProvider(),
		},
	});
	const pending = handler?.(event(), ctx);
	await ready;
	await shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);
	assert.deepEqual(await pending, { cancel: true });
	assert.equal(statuses.get("codex-compact"), undefined);
});

test("disabled, wrong-API, remote-failed, auth-failed, and aborted paths remain safe", async () => {
	const run = async (options: {
		settings?: CodexCompactSettingsRuntime;
		model?: unknown;
		auth?: unknown;
		signal?: AbortSignal;
		fetch?: typeof globalThis.fetch;
	}) => {
		const mock = createMockPi();
		const activeModel = options.model ?? model;
		createCodexCompactExtension({
			settingsRuntime: options.settings ?? settingsRuntime(),
			fetch: options.fetch ?? (async () => sseResponse()),
		})(mock.pi);
		const handler = mock.events.get("session_before_compact")?.[0];
		const { ctx, notifications, statuses } = createMockContext({
			model: activeModel,
			getSystemPrompt: () => "system",
			sessionManager: { getSessionId: () => "session", getBranch: () => branch() },
			modelRegistry: {
				getApiKeyAndHeaders: async () => options.auth ?? { ok: false, error: "missing auth" },
				getProvider: () => fakeProvider(undefined, activeModel as Model<"openai-codex-responses">),
			},
			hasUI: true,
		});
		return {
			result: await handler?.(event(options.signal), ctx),
			notifications,
			statuses,
		};
	};
	assert.equal((await run({ settings: settingsRuntime({ enabled: false }) })).result, undefined);
	assert.equal(
		(
			await run({
				model: { ...model, provider: "anthropic", api: "anthropic-messages" },
			})
		).result,
		undefined,
	);
	const remoteFailed = await run({
		model: { ...model, provider: "misconfigured-codex-proxy" },
		auth: { ok: true },
		fetch: async () =>
			new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n'),
	});
	assert.equal(remoteFailed.result, undefined);
	assert.match(remoteFailed.notifications.at(-1)?.message ?? "", /using Pi compaction/);
	const authFailed = await run({ auth: { ok: false, error: "missing provider credentials" } });
	assert.equal(authFailed.result, undefined);
	assert.match(authFailed.notifications.at(-1)?.message ?? "", /missing provider credentials/);
	assert.equal(authFailed.statuses.get("codex-compact"), undefined);
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual((await run({ signal: controller.signal })).result, { cancel: true });
});
