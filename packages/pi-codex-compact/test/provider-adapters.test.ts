import assert from "node:assert/strict";
import type {
	Api,
	AssistantMessageEventStream,
	Model,
	Provider,
	Usage,
} from "@earendil-works/pi-ai";
import { describe, test } from "vitest";

const PROVIDER_MODULES = {
	"openai-responses": {
		specifier: "@earendil-works/pi-ai/providers/openai",
		factory: "openaiProvider",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		expectedUrl: "https://api.openai.com/v1/responses",
		bodyKind: "string",
		contentEncoding: null,
		credentialHeader: "authorization",
	},
	"azure-openai-responses": {
		specifier: "@earendil-works/pi-ai/providers/azure-openai-responses",
		factory: "azureOpenAIResponsesProvider",
		provider: "azure-openai-responses",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		expectedUrl: "https://example.openai.azure.com/openai/v1/responses?api-version=v1",
		bodyKind: "string",
		contentEncoding: null,
		credentialHeader: "api-key",
	},
	"openai-codex-responses": {
		specifier: "@earendil-works/pi-ai/providers/openai-codex",
		factory: "openaiCodexProvider",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		expectedUrl: "https://chatgpt.com/backend-api/codex/responses",
		bodyKind: "object",
		contentEncoding: "zstd",
		credentialHeader: "authorization",
	},
} as const;

type SupportedApi = keyof typeof PROVIDER_MODULES;

const COMPACTION_ITEM = {
	id: "cmp_adapter_fixture",
	type: "compaction",
	encrypted_content: "opaque",
};

const RESPONSE_USAGE = {
	input_tokens: 10,
	input_tokens_details: { cached_tokens: 3 },
	output_tokens: 2,
	output_tokens_details: { reasoning_tokens: 1 },
	total_tokens: 12,
};

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function apiKey(api: SupportedApi): string {
	return api === "openai-codex-responses" ? codexToken() : "fixture-key";
}

function modelFor(api: SupportedApi): Model<Api> {
	const fixture = PROVIDER_MODULES[api];
	return {
		id: "gpt-5.4",
		name: "GPT-5.4 fixture",
		api,
		provider: fixture.provider,
		baseUrl: fixture.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

async function providerFor(api: SupportedApi): Promise<Provider> {
	const fixture = PROVIDER_MODULES[api];
	// Pi can misresolve static API/provider subpath imports, so keep this variable-specifier import.
	const module = (await import(fixture.specifier)) as Record<string, () => Provider>;
	const factory = module[fixture.factory];
	assert.ok(factory, `missing ${fixture.factory}`);
	return factory();
}

function responseObject(output: unknown[]) {
	return {
		id: "resp_adapter_fixture",
		object: "response",
		created_at: 1,
		status: "completed",
		model: "gpt-5.4",
		output,
		parallel_tool_calls: true,
		tool_choice: "auto",
		tools: [],
		usage: RESPONSE_USAGE,
	};
}

function responseSse(output: unknown[]): Response {
	const completed = responseObject(output);
	const events = [
		{ type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
		...output.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item },
			{ type: "response.output_item.done", output_index, item },
		]),
		{ type: "response.completed", response: completed },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function collectDone(stream: AssistantMessageEventStream): Promise<Usage> {
	let usage: Usage | undefined;
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
		if (event.type === "done") usage = event.message.usage;
	}
	assert.ok(usage, "provider stream did not complete");
	return usage;
}

async function collectFailure(stream: AssistantMessageEventStream): Promise<string> {
	let message: string | undefined;
	for await (const event of stream) {
		if (event.type === "error") message = event.error.errorMessage;
	}
	assert.ok(message, "provider stream did not fail");
	return message;
}

function context() {
	return {
		systemPrompt: "system",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "hello" }],
				timestamp: 1,
			},
		],
		tools: [],
	};
}

for (const api of Object.keys(PROVIDER_MODULES) as SupportedApi[]) {
	describe(api, () => {
		test("exposes one HTTP Responses request and accepts a V2 compaction-only SSE", async () => {
			const fixture = PROVIDER_MODULES[api];
			const provider = await providerFor(api);
			const model = modelFor(api);
			let payload: Record<string, unknown> | undefined;
			let fetches = 0;
			const stream = provider.stream(
				model,
				{
					systemPrompt: "system",
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
					tools: [],
				},
				{
					apiKey: apiKey(api),
					transport: "sse",
					cacheRetention: "none",
					maxRetries: 0,
					onPayload(value) {
						assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
						payload = value as Record<string, unknown>;
						assert.ok(Array.isArray(payload.input));
						return {
							...payload,
							input: [...payload.input, { type: "compaction_trigger" }],
						};
					},
					fetch: async (input, init) => {
						fetches += 1;
						assert.equal(String(input), fixture.expectedUrl);
						assert.equal(typeof init?.body, fixture.bodyKind);
						assert.equal(
							new Headers(init?.headers).get("content-encoding"),
							fixture.contentEncoding,
						);
						return responseSse([COMPACTION_ITEM]);
					},
				},
			);

			const usage = await collectDone(stream);
			assert.equal(fetches, 1);
			assert.ok(payload);
			assert.equal(usage.totalTokens, 12);
		});

		test("accepts a synthetic completion after a same-origin compact URL rewrite", async () => {
			const provider = await providerFor(api);
			const model = modelFor(api);
			let payload: Record<string, unknown> | undefined;
			let rewrittenUrl: string | undefined;
			let compactHeaders: Headers | undefined;
			const stream = provider.stream(
				model,
				{
					systemPrompt: "system",
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
					tools: [],
				},
				{
					apiKey: apiKey(api),
					transport: "sse",
					cacheRetention: "none",
					maxRetries: 0,
					onPayload(value) {
						assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
						payload = value as Record<string, unknown>;
						return value;
					},
					fetch: async (input, init) => {
						const original = new URL(String(input));
						const compact = new URL(original);
						compact.pathname = `${compact.pathname.replace(/\/$/, "")}/compact`;
						assert.equal(compact.origin, original.origin);
						rewrittenUrl = compact.toString();
						compactHeaders = new Headers(init?.headers);
						compactHeaders.delete("content-encoding");
						compactHeaders.delete("content-length");
						return responseSse([]);
					},
				},
			);

			const usage = await collectDone(stream);
			assert.ok(payload);
			assert.equal(
				rewrittenUrl,
				`${PROVIDER_MODULES[api].expectedUrl.replace(/\/responses(?=\?|$)/, "/responses/compact")}`,
			);
			assert.equal(compactHeaders?.has("content-encoding"), false);
			assert.equal(compactHeaders?.has(PROVIDER_MODULES[api].credentialHeader), true);
			if (api === "openai-codex-responses") {
				assert.equal(compactHeaders?.get("chatgpt-account-id"), "acct_fixture");
			}
			assert.equal(usage.input, 7);
			assert.equal(usage.cacheRead, 3);
			assert.equal(usage.output, 2);
		});

		test("honors one bounded provider retry", async () => {
			const provider = await providerFor(api);
			const model = modelFor(api);
			let fetches = 0;
			const stream = provider.stream(model, context(), {
				apiKey: apiKey(api),
				transport: "sse",
				cacheRetention: "none",
				maxRetries: 1,
				fetch: async () => {
					fetches += 1;
					if (fetches === 1) {
						return new Response("temporary unavailable", {
							status: 503,
							headers: { "retry-after": "0" },
						});
					}
					return responseSse([]);
				},
			});

			await collectDone(stream);
			assert.equal(fetches, 2);
		});

		test("forwards cancellation to the HTTP request", async () => {
			const provider = await providerFor(api);
			const model = modelFor(api);
			const controller = new AbortController();
			controller.abort();
			let fetches = 0;
			const stream = provider.stream(model, context(), {
				apiKey: apiKey(api),
				transport: "sse",
				cacheRetention: "none",
				maxRetries: 0,
				signal: controller.signal,
				fetch: async () => {
					fetches += 1;
					throw new Error("aborted request should not dispatch");
				},
			});

			assert.match(await collectFailure(stream), /abort/i);
			assert.equal(fetches, 0);
		});
	});
}
