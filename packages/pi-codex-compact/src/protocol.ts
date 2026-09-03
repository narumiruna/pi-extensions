export const MAX_SSE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPACT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export class CodexCompactionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexCompactionProtocolError";
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isCompactionItem(value: unknown): value is JsonObject {
	return (
		isObject(value) &&
		value.type === "compaction" &&
		typeof value.encrypted_content === "string" &&
		value.encrypted_content.length > 0
	);
}

export function validateCompactionItem(
	value: unknown,
	maxBytes = MAX_COMPACTION_ITEM_BYTES,
): JsonObject {
	if (!isCompactionItem(value)) {
		throw new CodexCompactionProtocolError(
			"Remote response did not contain a valid compaction item",
		);
	}
	if (byteLength(value) > maxBytes) {
		throw new CodexCompactionProtocolError("Remote compaction item exceeded the size limit");
	}
	return structuredClone(value);
}

export interface CollectedCompaction {
	item: JsonObject;
	completedResponse?: JsonObject;
}

export interface CollectedCompactResponse {
	item: JsonObject;
	output: JsonObject[];
	response: JsonObject;
}

function compactionItemsFromEvent(event: JsonObject): unknown[] {
	const items: unknown[] = [];
	if (event.type === "response.output_item.done" && isObject(event.item)) {
		items.push(event.item);
	}
	if (event.type === "response.completed" && isObject(event.response)) {
		const output = event.response.output;
		if (Array.isArray(output)) items.push(...output);
	}
	return items.filter((item) => isObject(item) && item.type === "compaction");
}

export async function collectCompactionSse(
	stream: ReadableStream<Uint8Array>,
	options: {
		signal?: AbortSignal;
		maxBytes?: number;
		maxItemBytes?: number;
	} = {},
): Promise<CollectedCompaction> {
	const maxBytes = options.maxBytes ?? MAX_SSE_BYTES;
	const reader = stream.getReader();
	const onAbort = () => {
		void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const decoder = new TextDecoder();
	let bytes = 0;
	let pending = "";
	let dataLines: string[] = [];
	let completedResponse: JsonObject | undefined;
	const items = new Map<string, JsonObject>();

	const checkAbort = () => {
		if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
	};
	const dispatch = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		if (data === "[DONE]") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new CodexCompactionProtocolError("Remote compaction returned malformed SSE JSON");
		}
		if (!isObject(parsed)) return;
		if (parsed.type === "response.completed") {
			completedResponse = isObject(parsed.response) ? parsed.response : {};
		}
		for (const candidate of compactionItemsFromEvent(parsed)) {
			const item = validateCompactionItem(candidate, options.maxItemBytes);
			items.set(JSON.stringify(item), item);
		}
	};
	const processLine = (line: string) => {
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		if (line === "data") dataLines.push("");
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	};

	try {
		while (true) {
			checkAbort();
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				throw new CodexCompactionProtocolError("Remote compaction stream exceeded the size limit");
			}
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const rawLine = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
				newline = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending.length > 0) processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
		dispatch();
		checkAbort();
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}

	if (!completedResponse) {
		throw new CodexCompactionProtocolError(
			"Remote compaction stream ended without response.completed",
		);
	}
	if (items.size !== 1) {
		throw new CodexCompactionProtocolError(
			`Remote compaction returned ${items.size} distinct compaction items; expected exactly one`,
		);
	}
	return { item: [...items.values()][0], completedResponse };
}

function isRetainedCompactContent(value: unknown): value is JsonObject {
	if (!isObject(value)) return false;
	if (value.type === "input_text") return typeof value.text === "string";
	if (value.type !== "input_image") return false;
	if (
		value.detail !== undefined &&
		value.detail !== null &&
		value.detail !== "auto" &&
		value.detail !== "low" &&
		value.detail !== "high" &&
		value.detail !== "original"
	) {
		return false;
	}
	if (
		(value.file_id !== undefined && value.file_id !== null && typeof value.file_id !== "string") ||
		(value.image_url !== undefined &&
			value.image_url !== null &&
			typeof value.image_url !== "string")
	) {
		return false;
	}
	return (
		(typeof value.file_id === "string" && value.file_id.length > 0) ||
		(typeof value.image_url === "string" && value.image_url.length > 0)
	);
}

function isRetainedCompactMessage(value: unknown): value is JsonObject {
	return (
		isObject(value) &&
		value.role === "user" &&
		(value.type === undefined || value.type === "message") &&
		Array.isArray(value.content) &&
		value.content.length > 0 &&
		value.content.every(isRetainedCompactContent)
	);
}

export function validateCompactedResponse(
	value: unknown,
	options: { maxBytes?: number; maxItemBytes?: number } = {},
): CollectedCompactResponse {
	if (!isObject(value) || !Array.isArray(value.output)) {
		throw new CodexCompactionProtocolError("Responses Compact returned an invalid response object");
	}
	const maxBytes = options.maxBytes ?? MAX_COMPACT_JSON_BYTES;
	const maxItemBytes = options.maxItemBytes ?? MAX_COMPACTION_ITEM_BYTES;
	if (byteLength(value) > maxBytes) {
		throw new CodexCompactionProtocolError("Responses Compact response exceeded the size limit");
	}
	if (value.output.length === 0) {
		throw new CodexCompactionProtocolError("Responses Compact returned no output items");
	}
	const output = value.output.map((item) => {
		if (!isObject(item)) {
			throw new CodexCompactionProtocolError("Responses Compact returned a non-object output item");
		}
		if (byteLength(item) > maxItemBytes) {
			throw new CodexCompactionProtocolError(
				"Responses Compact output item exceeded the size limit",
			);
		}
		return structuredClone(item);
	});
	const compactionItems = output.filter((item) => item.type === "compaction");
	if (compactionItems.length !== 1 || output.at(-1)?.type !== "compaction") {
		throw new CodexCompactionProtocolError(
			"Responses Compact must return retained messages followed by one compaction item",
		);
	}
	for (const item of output.slice(0, -1)) {
		if (!isRetainedCompactMessage(item)) {
			throw new CodexCompactionProtocolError(
				"Responses Compact returned an unsupported retained output item",
			);
		}
	}
	const item = validateCompactionItem(output.at(-1), maxItemBytes);
	return { item, output: [...output.slice(0, -1), item], response: structuredClone(value) };
}

export async function collectCompactResponse(
	response: Response,
	options: { signal?: AbortSignal; maxBytes?: number; maxItemBytes?: number } = {},
): Promise<CollectedCompactResponse> {
	const maxBytes = options.maxBytes ?? MAX_COMPACT_JSON_BYTES;
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new CodexCompactionProtocolError("Responses Compact response exceeded the size limit");
	}
	if (!response.body) {
		throw new CodexCompactionProtocolError("Responses Compact response did not contain a body");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	const onAbort = () => {
		void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				throw new CodexCompactionProtocolError(
					"Responses Compact response exceeded the size limit",
				);
			}
			chunks.push(value);
		}
		if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new CodexCompactionProtocolError("Responses Compact returned malformed JSON");
	}
	return validateCompactedResponse(parsed, options);
}

function markerTextFromItem(item: unknown): string | undefined {
	if (!isObject(item) || item.role !== "user" || !Array.isArray(item.content)) return undefined;
	if (item.content.length !== 1) return undefined;
	const content = item.content[0];
	if (!isObject(content) || content.type !== "input_text" || typeof content.text !== "string") {
		return undefined;
	}
	return content.text;
}

export function rewriteCheckpointMarker(
	payload: unknown,
	marker: string,
	replacementHistory: readonly unknown[],
): JsonObject {
	if (!isObject(payload) || !Array.isArray(payload.input)) {
		throw new CodexCompactionProtocolError("Codex Responses payload is missing an input array");
	}
	const matches = payload.input
		.map((item, index) => (markerTextFromItem(item) === marker ? index : -1))
		.filter((index) => index >= 0);
	if (matches.length !== 1) {
		throw new CodexCompactionProtocolError(
			`Provider payload contained ${matches.length} checkpoint markers; expected exactly one`,
		);
	}
	const index = matches[0];
	return {
		...payload,
		input: [
			...payload.input.slice(0, index),
			...structuredClone(replacementHistory),
			...payload.input.slice(index + 1),
		],
	};
}

export function appendCompactionTrigger(payload: unknown): JsonObject {
	if (!isObject(payload) || !Array.isArray(payload.input)) {
		throw new CodexCompactionProtocolError("Codex Responses payload is missing an input array");
	}
	if (payload.input.some((item) => isObject(item) && item.type === "compaction_trigger")) {
		throw new CodexCompactionProtocolError(
			"Provider payload already contains a compaction trigger",
		);
	}
	return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

export function expandRemoteCompactionPayload(
	payload: unknown,
	checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
	if (checkpoint) {
		return rewriteCheckpointMarker(payload, checkpoint.marker, checkpoint.replacementHistory);
	}
	if (!isObject(payload) || !Array.isArray(payload.input)) {
		throw new CodexCompactionProtocolError("Responses payload is missing an input array");
	}
	return structuredClone(payload);
}

export function prepareRemoteCompactionPayload(
	payload: unknown,
	checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
	return appendCompactionTrigger(expandRemoteCompactionPayload(payload, checkpoint));
}

export function hasCheckpointMarker(payload: unknown, marker: string): boolean {
	return (
		isObject(payload) &&
		Array.isArray(payload.input) &&
		payload.input.some((item) => markerTextFromItem(item) === marker)
	);
}
