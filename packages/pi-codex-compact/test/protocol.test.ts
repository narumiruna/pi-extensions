import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  appendCompactionTrigger,
  CodexCompactionProtocolError,
  collectCompactionSse,
  collectCompactResponse,
  expandRemoteCompactionPayload,
  type JsonObject,
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

function validSse(
  item: JsonObject = { type: "compaction", encrypted_content: "opaque" },
  completedItem: JsonObject = item,
): string {
  return [
    ": keepalive\r\n",
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [completedItem] } })}\r\n\r\n`,
  ].join("");
}

test("collects one compaction from fragmented CRLF SSE and deduplicates completed output", async () => {
  const result = await collectCompactionSse(fragmentedStream(validSse()));
  assert.deepEqual(result.item, { type: "compaction", encrypted_content: "opaque" });
  assert.ok(result.completedResponse);
});

const reportedItem = { id: "cmp_test", type: "compaction", encrypted_content: "test" };
const reorderedItem = { encrypted_content: "test", id: "cmp_test", type: "compaction" };

test.each([
  { name: "top-level keys", item: reportedItem, repeated: reorderedItem },
  {
    name: "items without IDs",
    item: { type: "compaction", encrypted_content: "test" },
    repeated: { encrypted_content: "test", type: "compaction" },
  },
  {
    name: "nested object keys",
    item: { ...reportedItem, metadata: { z: null, a: { number: 1, flag: true, text: "value" } } },
    repeated: { ...reorderedItem, metadata: { a: { text: "value", flag: true, number: 1 }, z: null } },
  },
  {
    name: "object keys inside arrays",
    item: { ...reportedItem, metadata: [{ b: 2, a: 1 }, null, "text", false, 0] },
    repeated: { ...reorderedItem, metadata: [{ a: 1, b: 2 }, null, "text", false, 0] },
  },
  {
    name: "special property names",
    item: {
      ...reportedItem,
      metadata: JSON.parse('{"__proto__":{"z":2,"a":1},"constructor":"data","toJSON":"data","10":true,"2":null}'),
    },
    repeated: {
      ...reorderedItem,
      metadata: JSON.parse('{"2":null,"10":true,"toJSON":"data","constructor":"data","__proto__":{"a":1,"z":2}}'),
    },
  },
])("deduplicates reordered $name without changing returned JSON", async ({ item, repeated }) => {
  assert.notEqual(JSON.stringify(item), JSON.stringify(repeated));
  const result = await collectCompactionSse(fragmentedStream(validSse(item, repeated), 3));
  assert.equal(JSON.stringify(result.item), JSON.stringify(repeated));
  assert.equal(JSON.stringify(result.completedResponse), JSON.stringify({ output: [repeated] }));
});

test.each([
  { name: "repeated item-done events", done: [reportedItem, reorderedItem], output: [] },
  { name: "completed output only", done: [], output: [reportedItem, reorderedItem] },
])("deduplicates reordered compaction items from $name", async ({ done, output }) => {
  const events = [
    ...done.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { output } },
  ];
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const result = await collectCompactionSse(fragmentedStream(text, 3));
  assert.equal(JSON.stringify(result.item), JSON.stringify(reorderedItem));
  assert.deepEqual(result.completedResponse, { output });
});

test.each([
  {
    name: "encrypted content with the same ID",
    item: reportedItem,
    repeated: { ...reorderedItem, encrypted_content: "different" },
  },
  { name: "ID with the same encrypted content", item: reportedItem, repeated: { ...reorderedItem, id: "cmp_other" } },
  { name: "missing ID", item: reportedItem, repeated: { type: "compaction", encrypted_content: "test" } },
  { name: "added field", item: reportedItem, repeated: { ...reorderedItem, metadata: null } },
  {
    name: "nested value",
    item: { ...reportedItem, metadata: { a: 1, b: 2 } },
    repeated: { ...reorderedItem, metadata: { b: 3, a: 1 } },
  },
  {
    name: "nested key",
    item: { ...reportedItem, metadata: { a: 1 } },
    repeated: { ...reorderedItem, metadata: { b: 1 } },
  },
  {
    name: "primitive type",
    item: { ...reportedItem, metadata: 1 },
    repeated: { ...reorderedItem, metadata: "1" },
  },
  {
    name: "null versus absent field",
    item: { ...reportedItem, metadata: { a: null } },
    repeated: { ...reorderedItem, metadata: {} },
  },
  {
    name: "array order",
    item: { ...reportedItem, metadata: [1, 2] },
    repeated: { ...reorderedItem, metadata: [2, 1] },
  },
  {
    name: "array length",
    item: { ...reportedItem, metadata: [1] },
    repeated: { ...reorderedItem, metadata: [1, 1] },
  },
  {
    name: "special property value",
    item: { ...reportedItem, metadata: JSON.parse('{"__proto__":{"value":1}}') },
    repeated: { ...reorderedItem, metadata: JSON.parse('{"__proto__":{"value":2}}') },
  },
])("rejects distinct compaction items: $name", async ({ item, repeated }) => {
  await assert.rejects(collectCompactionSse(fragmentedStream(validSse(item, repeated), 3)), {
    name: "CodexCompactionProtocolError",
    message: "Remote compaction returned 2 distinct compaction items; expected exactly one",
  });
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
      collectCompactionSse(fragmentedStream('data: {"type":"response.completed","response":{"output":[]}}\n\n')),
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
    await assert.rejects(collectCompactionSse(fragmentedStream("data: {nope}\n\n")), /malformed SSE/);
  });
  test("empty content", async () => {
    await assert.rejects(
      collectCompactionSse(fragmentedStream(validSse({ type: "compaction", encrypted_content: "" }))),
      /valid compaction/,
    );
  });
  test("oversized item", async () => {
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { maxItemBytes: 10 }), /size limit/);
  });
  test("oversized stream", async () => {
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { maxBytes: 10 }), /stream exceeded/);
  });
  test("abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { signal: controller.signal }), /aborted/i);
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
  assert.deepEqual(prepared.input, [...replacement, payload.input[1], { type: "compaction_trigger" }]);
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
  for (const retained of [
    { role: "user", content: [] },
    { role: "user", content: [{ type: "input_text" }] },
    { role: "user", content: [{ type: "input_text", text: 42 }] },
    { role: "user", content: [{ type: "input_image", detail: "auto" }] },
    { role: "user", content: [{ type: "input_image", image_url: 42 }] },
    { role: "user", content: [{ type: "input_image", image_url: "image", detail: "huge" }] },
    { role: "user", content: [{ type: "input_file", file_data: "opaque" }] },
  ]) {
    assert.throws(() => validateCompactedResponse({ output: [retained, item] }), /unsupported retained/);
  }
  assert.doesNotThrow(() =>
    validateCompactedResponse({
      output: [
        {
          role: "user",
          type: "message",
          content: [{ type: "input_image", file_id: "file_fixture", detail: "auto" }],
        },
        item,
      ],
    }),
  );
  assert.throws(() => validateCompactedResponse({ output: [item] }, { maxBytes: 10 }), /response exceeded/);
  await assert.rejects(collectCompactResponse(new Response("{invalid", { status: 200 })), /malformed JSON/);
  let oversizedBodyCancelled = false;
  await assert.rejects(
    collectCompactResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel(reason) {
            oversizedBodyCancelled = reason instanceof CodexCompactionProtocolError;
          },
        }),
        { headers: { "content-length": "9000000" } },
      ),
    ),
    /response exceeded/,
  );
  assert.equal(oversizedBodyCancelled, true);
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
  assert.deepEqual(payload.input, [{ role: "user", content: [{ type: "input_text", text: "checkpoint" }] }]);
});

test("payload validators reject malformed inputs, missing/duplicate markers, and duplicate triggers", () => {
  assert.throws(() => appendCompactionTrigger({}), CodexCompactionProtocolError);
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, "x", []), /0 checkpoint markers/);
  const markerItem = { role: "user", content: [{ type: "input_text", text: "x" }] };
  assert.throws(() => rewriteCheckpointMarker({ input: [markerItem, markerItem] }, "x", []), /2 checkpoint markers/);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }), /already contains/);
});
