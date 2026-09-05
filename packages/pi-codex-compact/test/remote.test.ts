import assert from "node:assert/strict";
import {
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICodexResponsesOptions,
	type Provider,
} from "@earendil-works/pi-ai";
import { test } from "vitest";
import { requestRemoteCompaction } from "../src/remote.js";

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
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeProvider(
	observe: (payload: unknown, options: OpenAICodexResponsesOptions) => void,
	inputText = "current",
): Provider {
	return {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {} as Provider["auth"],
		getModels: () => [model],
		stream(_model, _context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					const payload = await options?.onPayload?.(
						{
							model: model.id,
							input: [{ role: "user", content: [{ type: "input_text", text: inputText }] }],
						},
						model,
					);
					observe(payload, options as OpenAICodexResponsesOptions);
					const response = await options?.fetch?.("https://example.test/codex/responses", {
						method: "POST",
					});
					await response?.text();
					const message = {
						role: "assistant" as const,
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				} catch (error) {
					const message = {
						role: "assistant" as const,
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
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
}

function responseSse(content = "opaque") {
	const item = { type: "compaction", encrypted_content: content };
	const body = [
		`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
		`data: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`,
	].join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("uses the public provider stream with SSE, bounded retry options, and a final trigger", async () => {
	let sent: unknown;
	const provider = fakeProvider((payload, options) => {
		sent = payload;
		assert.equal(options.transport, "sse");
		assert.equal(options.cacheRetention, "none");
		assert.equal(options.timeoutMs, 300_000);
		assert.equal(options.maxRetries, 2);
	});
	const result = await requestRemoteCompaction({
		provider,
		model,
		context: { messages: [] } satisfies Context,
		protocol: "remote-v2",
		apiKey: "oauth-token",
		signal: new AbortController().signal,
		fetch: async () => responseSse(),
	});
	assert.deepEqual((sent as { input: unknown[] }).input.at(-1), { type: "compaction_trigger" });
	assert.equal(result.item.encrypted_content, "opaque");
	assert.deepEqual(result.usage, usage);
	assert.equal(result.promptInput.length, 1);
});

test("expands a previous checkpoint before requesting repeated compaction", async () => {
	const marker = "checkpoint marker";
	let sentInput: unknown[] = [];
	const provider = fakeProvider((payload) => {
		sentInput = (payload as { input: unknown[] }).input;
	}, marker);
	await requestRemoteCompaction({
		provider,
		model,
		context: { messages: [] },
		protocol: "remote-v2",
		apiKey: "oauth-token",
		signal: new AbortController().signal,
		priorCheckpoint: {
			marker,
			replacementHistory: [{ type: "compaction", encrypted_content: "prior" }],
		},
		fetch: async () => responseSse("new"),
	});
	assert.equal(
		sentInput[0] && (sentInput[0] as { encrypted_content?: string }).encrypted_content,
		"prior",
	);
	assert.deepEqual(sentInput.at(-1), { type: "compaction_trigger" });
});

test("propagates abort and malformed remote output", async () => {
	const provider = fakeProvider(() => undefined);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model,
			context: { messages: [] },
			protocol: "remote-v2",
			apiKey: "oauth-token",
			signal: controller.signal,
			fetch: async () => responseSse(),
		}),
		/aborted/i,
	);
	await assert.rejects(
		requestRemoteCompaction({
			provider,
			model,
			context: { messages: [] },
			protocol: "remote-v2",
			apiKey: "oauth-token",
			signal: new AbortController().signal,
			fetch: async () =>
				new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n'),
		}),
		/returned 0 distinct/,
	);
});
