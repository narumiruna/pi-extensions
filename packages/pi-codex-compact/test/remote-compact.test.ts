import assert from "node:assert/strict";
import {
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { describe, test } from "vitest";
import type { ResponsesCompactionApi } from "../src/model-api.js";
import { requestRemoteCompaction } from "../src/remote.js";
import { responsesCompactUrl } from "../src/remote-compact.js";

const PROVIDER_MODULES = {
	"openai-responses": {
		specifier: "@earendil-works/pi-ai/providers/openai",
		factory: "openaiProvider",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		compactUrl: "https://api.openai.com/v1/responses/compact",
	},
	"azure-openai-responses": {
		specifier: "@earendil-works/pi-ai/providers/azure-openai-responses",
		factory: "azureOpenAIResponsesProvider",
		provider: "azure-openai-responses",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		compactUrl: "https://example.openai.azure.com/openai/v1/responses/compact?api-version=v1",
	},
	"openai-codex-responses": {
		specifier: "@earendil-works/pi-ai/providers/openai-codex",
		factory: "openaiCodexProvider",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		compactUrl: "https://chatgpt.com/backend-api/codex/responses/compact",
	},
} as const;

const COMPACTION_ITEM = {
	id: "cmp_remote_fixture",
	type: "compaction",
	encrypted_content: "opaque",
};

const RAW_USAGE = {
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

function apiKey(api: ResponsesCompactionApi): string {
	return api === "openai-codex-responses" ? codexToken() : "fixture-key";
}

function modelFor(api: ResponsesCompactionApi): Model<ResponsesCompactionApi> {
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

async function providerFor(api: ResponsesCompactionApi): Promise<Provider> {
	const fixture = PROVIDER_MODULES[api];
	// Pi can misresolve static API/provider subpath imports, so keep this variable-specifier import.
	const module = (await import(fixture.specifier)) as Record<string, () => Provider>;
	const factory = module[fixture.factory];
	assert.ok(factory, `missing ${fixture.factory}`);
	return factory();
}

function context(text = "current"): Context {
	return {
		systemPrompt: "system",
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
		tools: [],
	};
}

function compactResponse(
	output: unknown[] = [
		{ role: "user", content: [{ type: "input_text", text: "retained" }] },
		COMPACTION_ITEM,
	],
): Response {
	return Response.json({
		id: "resp_compact_fixture",
		object: "response.compaction",
		created_at: 1,
		output,
		usage: RAW_USAGE,
	});
}

for (const api of Object.keys(PROVIDER_MODULES) as ResponsesCompactionApi[]) {
	describe(`${api} unary compact bridge`, () => {
		test("makes one authenticated same-origin request and returns provider-normalized usage", async () => {
			const fixture = PROVIDER_MODULES[api];
			const provider = await providerFor(api);
			const model = modelFor(api);
			let fetches = 0;
			let requestBody: Record<string, unknown> | undefined;
			const result = await requestRemoteCompaction({
				provider,
				model,
				context: context(),
				protocol: "responses-compact",
				apiKey: apiKey(api),
				signal: new AbortController().signal,
				maxRetries: 0,
				fetch: async (input, init) => {
					fetches += 1;
					assert.equal(String(input), fixture.compactUrl);
					assert.equal(new URL(String(input)).origin, new URL(fixture.baseUrl).origin);
					const headers = new Headers(init?.headers);
					assert.equal(headers.get("content-encoding"), null);
					assert.equal(headers.get("content-type"), "application/json");
					assert.equal(
						headers.has(api === "azure-openai-responses" ? "api-key" : "authorization"),
						true,
					);
					if (api === "openai-codex-responses") {
						assert.equal(headers.get("chatgpt-account-id"), "acct_fixture");
					}
					assert.equal(typeof init?.body, "string");
					requestBody = JSON.parse(String(init?.body));
					return compactResponse();
				},
			});

			assert.equal(fetches, 1);
			assert.ok(requestBody);
			assert.equal(requestBody.stream, undefined);
			assert.equal(requestBody.store, undefined);
			assert.equal(requestBody.include, undefined);
			assert.ok(Array.isArray(requestBody.input));
			assert.equal(result.item.encrypted_content, "opaque");
			assert.equal(result.compactedOutput?.at(-1)?.type, "compaction");
			assert.equal(result.promptInput.length > 0, true);
			assert.deepEqual(
				{
					input: result.usage.input,
					cacheRead: result.usage.cacheRead,
					output: result.usage.output,
					totalTokens: result.usage.totalTokens,
				},
				{ input: 7, cacheRead: 3, output: 2, totalTokens: 12 },
			);
		});
	});
}

test("unary compact expands a previous checkpoint without adding a trigger", async () => {
	const api = "openai-responses";
	const provider = await providerFor(api);
	let body: Record<string, unknown> | undefined;
	await requestRemoteCompaction({
		provider,
		model: modelFor(api),
		context: context("checkpoint marker"),
		protocol: "responses-compact",
		apiKey: apiKey(api),
		signal: new AbortController().signal,
		priorCheckpoint: {
			marker: "checkpoint marker",
			replacementHistory: [{ type: "compaction", encrypted_content: "prior" }],
		},
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return compactResponse();
		},
	});

	assert.ok(body);
	assert.equal(
		(body.input as Array<Record<string, unknown>>).some(
			(item) => item.type === "compaction" && item.encrypted_content === "prior",
		),
		true,
	);
	assert.equal(
		(body.input as Array<Record<string, unknown>>).some(
			(item) =>
				item.type === "compaction_trigger" || JSON.stringify(item).includes("checkpoint marker"),
		),
		false,
	);
});

test("unary compact retries transient HTTP failures but not malformed successful bodies", async () => {
	const api = "openai-responses";
	const provider = await providerFor(api);
	let fetches = 0;
	await requestRemoteCompaction({
		provider,
		model: modelFor(api),
		context: context(),
		protocol: "responses-compact",
		apiKey: apiKey(api),
		signal: new AbortController().signal,
		maxRetries: 1,
		fetch: async () => {
			fetches += 1;
			return fetches === 1
				? new Response("temporary", { status: 503, headers: { "retry-after": "0" } })
				: compactResponse();
		},
	});
	assert.equal(fetches, 2);

	fetches = 0;
	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model: modelFor(api),
			context: context(),
			protocol: "responses-compact",
			apiKey: apiKey(api),
			signal: new AbortController().signal,
			maxRetries: 2,
			fetch: async () => {
				fetches += 1;
				return new Response("{invalid", { status: 200 });
			},
		}),
		/malformed JSON/,
	);
	assert.equal(fetches, 1);

	fetches = 0;
	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model: modelFor(api),
			context: context(),
			protocol: "responses-compact",
			apiKey: apiKey(api),
			signal: new AbortController().signal,
			maxRetries: 2,
			fetch: async () => {
				fetches += 1;
				return Response.json({ output: [COMPACTION_ITEM] });
			},
		}),
		/missing usage/,
	);
	assert.equal(fetches, 1);

	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model: modelFor(api),
			context: context(),
			protocol: "responses-compact",
			apiKey: apiKey(api),
			signal: new AbortController().signal,
			maxRetries: 0,
			fetch: async () =>
				Response.json({
					id: "resp_bad_usage",
					output: [COMPACTION_ITEM],
					usage: {
						...RAW_USAGE,
						input_tokens_details: { cached_tokens: 11 },
					},
				}),
		}),
		/inconsistent usage details/,
	);
});

test("unary compact rejects duplicate provider dispatch without a second external request", async () => {
	const model = modelFor("openai-responses");
	const provider: Provider = {
		id: model.provider,
		name: "duplicate fixture",
		auth: {} as Provider["auth"],
		getModels: () => [model],
		stream(activeModel, _context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					await options?.onPayload?.({ model: activeModel.id, input: [] }, activeModel);
					await options?.fetch?.("https://example.test/v1/responses", { method: "POST" });
					await options?.fetch?.("https://example.test/v1/responses", { method: "POST" });
					const message = {
						role: "assistant" as const,
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage: {
							input: 7,
							output: 2,
							cacheRead: 3,
							cacheWrite: 0,
							totalTokens: 12,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				} catch (error) {
					stream.end();
					throw error;
				}
			})();
			return stream;
		},
		streamSimple() {
			throw new Error("not used");
		},
	};
	let externalRequests = 0;
	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model,
			context: context(),
			protocol: "responses-compact",
			apiKey: "fixture",
			signal: new AbortController().signal,
			fetch: async () => {
				externalRequests += 1;
				return compactResponse();
			},
		}),
		/dispatched again/,
	);
	assert.equal(externalRequests, 1);
});

test("unary compact preserves cancellation carried by a Request input", async () => {
	const model = modelFor("openai-responses");
	const provider: Provider = {
		id: model.provider,
		name: "Request input fixture",
		auth: {} as Provider["auth"],
		getModels: () => [model],
		stream(activeModel, _context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					await options?.onPayload?.({ model: activeModel.id, input: [] }, activeModel);
					await options?.fetch?.(
						new Request("https://example.test/v1/responses", {
							method: "POST",
							signal: options.signal,
						}),
					);
					assert.fail("Aborted bridge request unexpectedly completed");
				} catch (error) {
					const message = {
						role: "assistant" as const,
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error" as const,
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
				}
			})();
			return stream;
		},
		streamSimple() {
			throw new Error("not used");
		},
	};
	const controller = new AbortController();
	let requestStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	let forwardedSignal: AbortSignal | undefined;
	const pending = requestRemoteCompaction({
		provider,
		model,
		context: context(),
		protocol: "responses-compact",
		apiKey: "fixture",
		signal: controller.signal,
		maxRetries: 0,
		fetch: async (_input, init) => {
			forwardedSignal = init?.signal ?? undefined;
			requestStarted();
			return new Promise<Response>((_resolve, reject) => {
				if (forwardedSignal?.aborted) {
					reject(new DOMException("Compaction aborted", "AbortError"));
					return;
				}
				forwardedSignal?.addEventListener(
					"abort",
					() => reject(new DOMException("Compaction aborted", "AbortError")),
					{ once: true },
				);
			});
		},
	});
	await started;
	controller.abort();
	await assert.rejects(pending, /aborted/i);
	assert.equal(forwardedSignal?.aborted, true);
});

test("unary compact aborts stalled response parsing without publishing output", async () => {
	const api = "openai-responses";
	const provider = await providerFor(api);
	const controller = new AbortController();
	const pending = requestRemoteCompaction({
		provider,
		model: modelFor(api),
		context: context(),
		protocol: "responses-compact",
		apiKey: apiKey(api),
		signal: controller.signal,
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start() {
						queueMicrotask(() => controller.abort());
					},
				}),
				{ status: 200 },
			),
	});
	await assert.rejects(pending, /aborted/i);
});

test("compact URL rewriting rejects unexpected paths and preserves origin and query", () => {
	assert.equal(
		responsesCompactUrl("https://example.test/v1/responses?api-version=v1").toString(),
		"https://example.test/v1/responses/compact?api-version=v1",
	);
	assert.throws(
		() => responsesCompactUrl("https://attacker.test/v1/chat/completions"),
		/does not end with the Responses endpoint/,
	);
});
