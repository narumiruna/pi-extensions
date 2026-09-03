import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	appendCompactionTrigger,
	CodexCompactionProtocolError,
	collectCompactionSse,
	collectCompactResponse,
	expandRemoteCompactionPayload,
	prepareRemoteCompactionPayload,
	rewriteCheckpointMarker,
	validateCompactedResponse,
} from "../src/protocol.js";

const encoder = new TextEncoder();

function fragmentedStream(text: string, chunkSize = 1): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	return new ReadableStream({
		start(controller) {
			for (let index = 0; index < bytes.length; index += chunkSize) {
				controller.enqueue(bytes.slice(index, index + chunkSize));
			}
			controller.close();
		},
	});
}

function validSse(item = { type: "compaction", encrypted_content: "opaque" }): string {
	return [
		": keepalive\r\n",
		`data: ${JSON.stringify({ type: "response.output_item.done", item })}\r\n\r\n`,
		`data: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\r\n\r\n`,
	].join("");
}

test("collects one compaction from fragmented CRLF SSE and deduplicates completed output", async () => {
	const result = await collectCompactionSse(fragmentedStream(validSse()));
	assert.deepEqual(result.item, { type: "compaction", encrypted_content: "opaque" });
	assert.ok(result.completedResponse);
});

test("joins multiline data fields and ignores unrelated output items", async () => {
	const message = { type: "message", role: "assistant", content: [] };
	const item = { type: "compaction", encrypted_content: "opaque" };
	const outputItem = JSON.stringify({ type: "response.output_item.done", item });
	const stream = fragmentedStream(
		[
			`data: ${JSON.stringify({ type: "response.output_item.done", item: message })}\n\n`,
			`data: ${outputItem}\n\n`,
			`data: {"type":"response.completed",\ndata: "response":{"output":[${JSON.stringify(message)},${JSON.stringify(item)}]}}\n\n`,
		].join(""),
		3,
	);
	const result = await collectCompactionSse(stream);
	assert.equal(result.item.encrypted_content, "opaque");
});

describe("rejects incomplete, missing, duplicate, malformed, empty, oversized, and aborted streams", () => {
	test("missing completion", async () => {
		await assert.rejects(
			collectCompactionSse(
				fragmentedStream(
					'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"x"}}\n\n',
				),
			),
			/without response.completed/,
		);
	});
	test("missing item", async () => {
		await assert.rejects(
			collectCompactionSse(
				fragmentedStream('data: {"type":"response.completed","response":{"output":[]}}\n\n'),
			),
			/returned 0 distinct/,
		);
	});
	test("duplicate items", async () => {
		const text = [
			'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"a"}}\n\n',
			'data: {"type":"response.completed","response":{"output":[{"type":"compaction","encrypted_content":"b"}]}}\n\n',
		].join("");
		await assert.rejects(collectCompactionSse(fragmentedStream(text)), /returned 2 distinct/);
	});
	test("malformed JSON", async () => {
		await assert.rejects(
			collectCompactionSse(fragmentedStream("data: {nope}\n\n")),
			/malformed SSE/,
		);
	});
	test("empty content", async () => {
		await assert.rejects(
			collectCompactionSse(
				fragmentedStream(validSse({ type: "compaction", encrypted_content: "" })),
			),
			/valid compaction/,
		);
	});
	test("oversized item", async () => {
		await assert.rejects(
			collectCompactionSse(fragmentedStream(validSse()), { maxItemBytes: 10 }),
			/size limit/,
		);
	});
	test("oversized stream", async () => {
		await assert.rejects(
			collectCompactionSse(fragmentedStream(validSse()), { maxBytes: 10 }),
			/stream exceeded/,
		);
	});
	test("abort", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			collectCompactionSse(fragmentedStream(validSse()), { signal: controller.signal }),
			/aborted/i,
		);
	});
	test("abort while waiting for the next chunk", async () => {
		const controller = new AbortController();
		const pending = collectCompactionSse(new ReadableStream<Uint8Array>({}), {
			signal: controller.signal,
		});
		queueMicrotask(() => controller.abort());
		await assert.rejects(pending, /aborted/i);
	});
});

test("rewrites exactly one marker and appends exactly one final trigger", () => {
	const marker = "checkpoint";
	const payload = {
		model: "gpt",
		input: [
			{ role: "user", content: [{ type: "input_text", text: marker }] },
			{ role: "user", content: [{ type: "input_text", text: "later" }] },
		],
	};
	const replacement = [
		{ role: "user", content: [{ type: "input_text", text: "old" }] },
		{ type: "compaction", encrypted_content: "opaque" },
	];
	const prepared = prepareRemoteCompactionPayload(payload, {
		marker,
		replacementHistory: replacement,
	});
	assert.deepEqual(prepared.input, [
		...replacement,
		payload.input[1],
		{ type: "compaction_trigger" },
	]);
	assert.equal(payload.input.length, 2, "does not mutate caller payload");
});

test("validates bounded unary compact output and response streaming", async () => {
	const value = {
		id: "resp_compact",
		object: "response.compaction",
		output: [
			{ role: "user", content: [{ type: "input_text", text: "retained" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		],
		usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
	};
	const validated = validateCompactedResponse(value);
	assert.equal(validated.item.encrypted_content, "opaque");
	assert.equal(validated.output.length, 2);
	const collected = await collectCompactResponse(Response.json(value));
	assert.deepEqual(collected.output, validated.output);
});

test("rejects unsafe, malformed, oversized, and aborted unary compact responses", async () => {
	const item = { type: "compaction", encrypted_content: "opaque" };
	assert.throws(() => validateCompactedResponse({ output: [] }), /no output/);
	assert.throws(() => validateCompactedResponse({ output: [item, item] }), /followed by one/);
	assert.throws(
		() => validateCompactedResponse({ output: [{ role: "developer", content: [] }, item] }),
		/unsupported retained/,
	);
	assert.throws(
		() => validateCompactedResponse({ output: [{ type: "compaction_trigger" }, item] }),
		/unsupported retained/,
	);
	assert.throws(
		() =>
			validateCompactedResponse({
				output: [{ role: "user", content: [{ type: "input_file", file_data: "opaque" }] }, item],
			}),
		/unsupported retained/,
	);
	assert.throws(
		() => validateCompactedResponse({ output: [item] }, { maxBytes: 10 }),
		/response exceeded/,
	);
	await assert.rejects(
		collectCompactResponse(new Response("{invalid", { status: 200 })),
		/malformed JSON/,
	);
	await assert.rejects(
		collectCompactResponse(
			new Response(JSON.stringify({ output: [item] }), {
				headers: { "content-length": "9000000" },
			}),
		),
		/response exceeded/,
	);
	await assert.rejects(
		collectCompactResponse(Response.json({ output: [item] }), { maxBytes: 10 }),
		/response exceeded/,
	);
	await assert.rejects(
		collectCompactResponse(Response.json({ output: [item] }), { maxItemBytes: 10 }),
		/output item exceeded/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		collectCompactResponse(Response.json({ output: [item] }), { signal: controller.signal }),
		/aborted/i,
	);
});

test("expands checkpoint payloads without mutating or adding a trigger", () => {
	const payload = {
		model: "gpt",
		input: [{ role: "user", content: [{ type: "input_text", text: "checkpoint" }] }],
	};
	const expanded = expandRemoteCompactionPayload(payload, {
		marker: "checkpoint",
		replacementHistory: [{ type: "compaction", encrypted_content: "prior" }],
	});
	assert.deepEqual(expanded.input, [{ type: "compaction", encrypted_content: "prior" }]);
	assert.deepEqual(payload.input, [
		{ role: "user", content: [{ type: "input_text", text: "checkpoint" }] },
	]);
});

test("payload validators reject malformed inputs, missing/duplicate markers, and duplicate triggers", () => {
	assert.throws(() => appendCompactionTrigger({}), CodexCompactionProtocolError);
	assert.throws(() => rewriteCheckpointMarker({ input: [] }, "x", []), /0 checkpoint markers/);
	const markerItem = { role: "user", content: [{ type: "input_text", text: "x" }] };
	assert.throws(
		() => rewriteCheckpointMarker({ input: [markerItem, markerItem] }, "x", []),
		/2 checkpoint markers/,
	);
	assert.throws(
		() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }),
		/already contains/,
	);
});
