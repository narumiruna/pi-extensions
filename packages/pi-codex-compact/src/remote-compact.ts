import type { Usage } from "@earendil-works/pi-ai";
import type { ResponsesCompactionApi } from "./model-api.js";
import {
	CodexCompactionProtocolError,
	type CollectedCompactResponse,
	collectCompactResponse,
	expandRemoteCompactionPayload,
	type JsonObject,
} from "./protocol.js";
import { collectProviderUsage } from "./remote-shared.js";
import {
	abortError,
	assertPreparedInput,
	isJsonObject,
	type RemoteCompactionRequest,
	type RemoteCompactionResponse,
} from "./remote-types.js";

const OFFICIAL_COMPACT_FIELDS = [
	"model",
	"input",
	"instructions",
	"previous_response_id",
	"prompt_cache_key",
	"prompt_cache_retention",
	"service_tier",
] as const;

const CODEX_COMPACT_FIELDS = [
	"model",
	"input",
	"instructions",
	"tools",
	"parallel_tool_calls",
	"reasoning",
	"service_tier",
	"prompt_cache_key",
	"text",
	"access_programs",
] as const;

function compactPayload(payload: JsonObject, api: ResponsesCompactionApi): JsonObject {
	const fields = api === "openai-codex-responses" ? CODEX_COMPACT_FIELDS : OFFICIAL_COMPACT_FIELDS;
	const result: JsonObject = {};
	for (const field of fields) {
		if (Object.hasOwn(payload, field) && payload[field] !== undefined) {
			result[field] = structuredClone(payload[field]);
		}
	}
	if (typeof result.model !== "string" || result.model.length === 0) {
		throw new CodexCompactionProtocolError("Responses payload is missing a model");
	}
	assertPreparedInput(result);
	return result;
}

function requestUrl(input: string | URL | Request): URL {
	return new URL(input instanceof Request ? input.url : String(input));
}

export function responsesCompactUrl(input: string | URL | Request): URL {
	const original = requestUrl(input);
	if (!original.pathname.endsWith("/responses")) {
		throw new CodexCompactionProtocolError(
			"Provider request URL does not end with the Responses endpoint",
		);
	}
	const compact = new URL(original);
	compact.pathname = `${compact.pathname}/compact`;
	if (compact.origin !== original.origin) {
		throw new CodexCompactionProtocolError("Responses Compact URL changed origin");
	}
	return compact;
}

function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init?.headers).forEach((value, name) => {
		headers.set(name, value);
	});
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return headers;
}

function mergedSignal(
	input: string | URL | Request,
	init: RequestInit | undefined,
	ownerSignal: AbortSignal,
): AbortSignal {
	const signals = [ownerSignal];
	if (input instanceof Request) signals.push(input.signal);
	if (init?.signal) signals.push(init.signal);
	return signals.length === 1 ? ownerSignal : AbortSignal.any(signals);
}

function nonRetryableBridgeFailure(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	return Response.json(
		{
			error: {
				message,
				type: "invalid_request_error",
				code: "invalid_compact_response",
			},
		},
		{ status: 400 },
	);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalUsageDetail(details: unknown, field: string): number {
	if (details === undefined || details === null) return 0;
	if (!isJsonObject(details)) {
		throw new CodexCompactionProtocolError("Responses Compact response has invalid usage details");
	}
	const value = details[field];
	if (value === undefined || value === null) return 0;
	if (!nonNegativeInteger(value)) {
		throw new CodexCompactionProtocolError(
			`Responses Compact response has invalid usage detail ${field}`,
		);
	}
	return value;
}

function validatedUsage(response: JsonObject): JsonObject {
	const usage = response.usage;
	if (!isJsonObject(usage)) {
		throw new CodexCompactionProtocolError("Responses Compact response is missing usage");
	}
	for (const field of ["input_tokens", "output_tokens", "total_tokens"] as const) {
		if (!nonNegativeInteger(usage[field])) {
			throw new CodexCompactionProtocolError(`Responses Compact response has invalid ${field}`);
		}
	}
	const inputTokens = usage.input_tokens as number;
	const outputTokens = usage.output_tokens as number;
	const totalTokens = usage.total_tokens as number;
	const cachedTokens = optionalUsageDetail(usage.input_tokens_details, "cached_tokens");
	const cacheWriteTokens = optionalUsageDetail(usage.input_tokens_details, "cache_write_tokens");
	const reasoningTokens = optionalUsageDetail(usage.output_tokens_details, "reasoning_tokens");
	if (cachedTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens) {
		throw new CodexCompactionProtocolError(
			"Responses Compact response has inconsistent usage details",
		);
	}
	if (totalTokens !== inputTokens + outputTokens) {
		throw new CodexCompactionProtocolError(
			"Responses Compact response has inconsistent total usage",
		);
	}
	return structuredClone(usage);
}

function syntheticCompletion(result: CollectedCompactResponse, payload: JsonObject): Response {
	const completed = {
		id: typeof result.response.id === "string" ? result.response.id : "resp_pi_compact_bridge",
		object: "response",
		created_at:
			typeof result.response.created_at === "number"
				? result.response.created_at
				: Math.floor(Date.now() / 1000),
		status: "completed",
		model: payload.model,
		output: [],
		parallel_tool_calls: false,
		tool_choice: "auto",
		tools: [],
		usage: validatedUsage(result.response),
	};
	const events = [
		{ type: "response.created", response: { ...completed, status: "in_progress" } },
		{ type: "response.completed", response: completed },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export async function requestResponsesCompact(
	request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
	if (request.signal.aborted) throw abortError();
	let preparedPayload: JsonObject | undefined;
	let sentInput: JsonObject[] | undefined;
	let compactResult: CollectedCompactResponse | undefined;
	let bridgeError: unknown;
	let successfulResponses = 0;
	const baseFetch = request.fetch ?? globalThis.fetch;
	const bridgeFetch: typeof globalThis.fetch = async (input, init) => {
		if (request.signal.aborted) throw abortError();
		if (successfulResponses > 0) {
			bridgeError = new CodexCompactionProtocolError(
				"Provider dispatched again after Responses Compact succeeded",
			);
			return nonRetryableBridgeFailure(bridgeError);
		}
		if (!preparedPayload) {
			bridgeError = new CodexCompactionProtocolError(
				"Provider dispatched before exposing its request payload",
			);
			return nonRetryableBridgeFailure(bridgeError);
		}
		let compactUrl: URL;
		try {
			compactUrl = responsesCompactUrl(input);
		} catch (error) {
			bridgeError = error;
			return nonRetryableBridgeFailure(error);
		}
		const signal = mergedSignal(input, init, request.signal);
		const response = await baseFetch(compactUrl, {
			...init,
			method: "POST",
			headers: mergedHeaders(input, init),
			body: JSON.stringify(preparedPayload),
			signal,
		});
		if (!response.ok) return response;
		try {
			const result = await collectCompactResponse(response, { signal });
			successfulResponses += 1;
			if (successfulResponses !== 1) {
				throw new CodexCompactionProtocolError(
					"Provider returned more than one successful Responses Compact response",
				);
			}
			compactResult = result;
			return syntheticCompletion(result, preparedPayload);
		} catch (error) {
			bridgeError = error;
			return nonRetryableBridgeFailure(error);
		}
	};

	const stream = request.provider.stream(request.model, request.context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		transport: "sse",
		cacheRetention: "none",
		timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
		maxRetries: request.maxRetries ?? 2,
		fetch: bridgeFetch,
		onPayload: (payload) => {
			if (preparedPayload) {
				throw new CodexCompactionProtocolError(
					"Provider exposed more than one compaction request payload",
				);
			}
			const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
			preparedPayload = compactPayload(expanded, request.model.api);
			sentInput = assertPreparedInput(preparedPayload);
			return expanded;
		},
	});

	let usage: Usage;
	try {
		usage = await collectProviderUsage(stream, request.signal);
	} catch (error) {
		if (bridgeError) throw bridgeError;
		throw error;
	}
	if (request.signal.aborted) throw abortError();
	if (bridgeError) throw bridgeError;
	if (!preparedPayload || !sentInput || !compactResult || successfulResponses !== 1) {
		throw new CodexCompactionProtocolError(
			"Provider did not complete exactly one Responses Compact request",
		);
	}
	return {
		item: compactResult.item,
		promptInput: sentInput,
		compactedOutput: compactResult.output,
		usage,
	};
}
