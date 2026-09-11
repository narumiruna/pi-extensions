import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_AUTHENTICATED_URL = "https://api.you.com/mcp";
const DEFAULT_KEYLESS_URL = "https://api.you.com/mcp?profile=free";
const STATUS_KEY = "youcom";
const REQUEST_TIMEOUT_MS = 60_000;

export interface YoucomJsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

let requestCounter = 0;

function nextRequestId(): number {
	requestCounter += 1;
	return requestCounter;
}

/**
 * The You.com MCP endpoint uses the streamable-HTTP transport: requests are
 * plain JSON-RPC POSTs and responses arrive as `text/event-stream` frames of
 * `data:` lines. Parse those frames and return the first JSON-RPC result.
 */
export function parseSseStream(streamText: string): unknown {
	const frames = streamText
		.split("\n\n")
		.map((frame) => frame.trim())
		.filter(Boolean);
	for (const frame of frames) {
		for (const line of frame.split("\n")) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice("data:".length).trim();
			if (!payload) continue;
			const parsed = parseJson(payload);
			if (parsed === undefined) continue;
			const message = asRecord(parsed);
			if (!message) continue;
			if (message.error !== undefined) {
				const error = asRecord(message.error);
				throw new Error(`You.com MCP error: ${String(error?.message ?? message.error)}`);
			}
			if (message.result !== undefined) return message.result;
		}
	}
	throw new Error("You.com MCP response contained no JSON-RPC result frame.");
}

export async function youcomRequest(
	method: string,
	params: Record<string, unknown> | undefined,
	signal: AbortSignal | undefined,
	fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
	const serverUrl = configuredServerUrl();
	const request: YoucomJsonRpcRequest = {
		jsonrpc: "2.0",
		id: nextRequestId(),
		method,
		...(params === undefined ? {} : { params }),
	};
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const apiKey = process.env.YDC_API_KEY?.trim();
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new YoucomRequestTimeoutError());
	}, REQUEST_TIMEOUT_MS);
	const mergedSignal = mergeSignals(signal, controller.signal);
	let response: Response;
	try {
		response = await fetchImplementation(serverUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			signal: mergedSignal,
		});
	} catch (error) {
		if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
		throw new Error(`You.com MCP request failed: ${errorMessage(error)}`);
	} finally {
		clearTimeout(timeout);
	}

	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`You.com MCP request failed (HTTP ${response.status}): ${boundedExcerpt(responseText)}`,
		);
	}
	return parseSseStream(responseText);
}

export class YoucomRequestTimeoutError extends Error {
	constructor() {
		super("You.com MCP request timed out.");
		this.name = "YoucomRequestTimeoutError";
	}
}

export function hasApiKey() {
	return Boolean(process.env.YDC_API_KEY?.trim());
}

export function configuredServerUrl() {
	const override = process.env.YOUCOM_MCP_URL?.trim();
	if (override) return override;
	return hasApiKey() ? DEFAULT_AUTHENTICATED_URL : DEFAULT_KEYLESS_URL;
}

export function normalizeUrl(value: string | undefined) {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_KEYLESS_URL;
	return trimmed.replace(/\/+$/, "");
}

export async function withStatus<T>(
	ctx: Pick<ExtensionContext, "ui">,
	status: string,
	callback: () => Promise<T>,
) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function mergeSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
	if (!external) return internal;
	const controller = new AbortController();
	const abort = (reason: unknown) => controller.abort(reason);
	external.addEventListener("abort", () => abort(external.reason), { once: true });
	internal.addEventListener("abort", () => abort(internal.reason), { once: true });
	return controller.signal;
}

function boundedExcerpt(text: string) {
	return truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	}).content;
}

function parseJson(payload: string): unknown {
	try {
		return JSON.parse(payload) as unknown;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
