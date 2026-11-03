import assert from "node:assert/strict";
import { fauxAssistantMessage, type Message, type Usage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { test } from "vitest";
import { durableAttributes, durableUsage } from "../src/durable-projection.js";
import { DurableRecorder } from "../src/durable-recorder.js";
import type { DurableCommit } from "../src/durable-state.js";
import { createProductionBackend } from "../src/runtime.js";
import type { TraceBackend } from "../src/tracing.js";
import { FakeBackend } from "./support.js";

const provenanceKey = "pi.usage.cost.total_from_provider";
const dataUri = "data:image/png;base64,PRIVATE_PAYLOAD";
const estimates = { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004 };
const buckets = { input: 0.01, output: 0.02, cache_read: 0.003, cache_write: 0.004 };
const zeroComponents = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const zeroBuckets = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
const tokens = { input: 5, output: 7, cacheRead: 11, cacheWrite: 13, totalTokens: 36 };
const usageDetails = { input: 5, output: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13, total: 36 };

interface CostCase {
  name: string;
  cost: unknown;
  expected: Record<string, number>;
  provenance?: boolean;
}
const cases: CostCase[] = [
  ...[undefined, false, true].flatMap((provenance): CostCase[] => [
    {
      name: `zero components and total, provenance ${String(provenance)}`,
      cost: { ...zeroComponents, total: 0, totalFromProvider: provenance },
      expected: zeroBuckets,
      provenance,
    },
    {
      name: `zero total with positive estimates, provenance ${String(provenance)}`,
      cost: { ...estimates, total: 0, totalFromProvider: provenance },
      expected: { ...buckets, total: 0 },
      provenance,
    },
    {
      name: `total differs from component estimates, provenance ${String(provenance)}`,
      cost: { ...estimates, total: 0.005, totalFromProvider: provenance },
      expected: { ...buckets, total: 0.005 },
      provenance,
    },
    ...[undefined, null, "0", -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
      (total): CostCase => ({
        name: `invalid total ${String(total)}, provenance ${String(provenance)}`,
        cost: { ...estimates, total, totalFromProvider: provenance },
        expected: buckets,
        provenance,
      }),
    ),
  ]),
  ...[null, "true", "false", 0, 1, [], {}, dataUri].map(
    (totalFromProvider): CostCase => ({
      name: `invalid provenance ${JSON.stringify(totalFromProvider)}`,
      cost: { ...estimates, total: 0, totalFromProvider },
      expected: { ...buckets, total: 0 },
    }),
  ),
  ...[undefined, null, "0", -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
    (component): CostCase => ({
      name: `invalid components ${String(component)}, provider zero`,
      cost: {
        input: component,
        output: component,
        cacheRead: component,
        cacheWrite: component,
        total: 0,
        totalFromProvider: true,
      },
      expected: { total: 0 },
      provenance: true,
    }),
  ),
  { name: "empty costs", cost: {}, expected: {} },
];

function messages(cost: unknown): [ReturnType<typeof fauxAssistantMessage>, Message] {
  const usage = Object.freeze({ ...tokens, cost: Object.freeze(cost) }) as Usage;
  const assistant = { ...fauxAssistantMessage(`assistant ${dataUri}`, { timestamp: 1 }), usage };
  const tool: Message = {
    role: "toolResult",
    toolCallId: "nested-call",
    toolName: "nested",
    content: [{ type: "text", text: `tool ${dataUri}` }],
    isError: false,
    timestamp: 1,
    usage,
  };
  return [Object.freeze(assistant), Object.freeze(tool)];
}

function expectedMetadata(provenance: boolean | undefined) {
  return provenance === undefined ? {} : { [provenanceKey]: provenance };
}

for (const role of ["assistant", "toolResult"] as const) {
  test.each(cases)(`durable ${role} projection: $name`, ({ cost, expected, provenance }) => {
    const message = messages(cost).find((candidate) => candidate.role === role);
    assert.ok(message);
    const projected = durableUsage(message);
    assert.deepEqual(projected.costDetails, expected);
    assert.deepEqual(projected.usageDetails, usageDetails);
    assert.deepEqual(projected.metadata ?? {}, expectedMetadata(provenance));
    assert.deepEqual(durableAttributes(projected), projected);
  });
}

test("durable projection does not infer usage or provenance from unrelated or missing usage", () => {
  for (const message of [
    { role: "user", content: "prompt", timestamp: 1 },
    { role: "assistant", usage: undefined },
    { role: "toolResult", usage: undefined },
  ]) {
    assert.deepEqual(durableUsage(message as Message), {});
  }
});

/** Exercise both completion merges, repeated publications, terminal tool delivery and repeated disposal. */
async function recordCosts(backend: TraceBackend, cost: unknown, captureContent: boolean): Promise<void> {
  const conversationId = 1 as ConversationId;
  const runTaskId = 3 as TaskId;
  const generationTaskId = 10 as TaskId;
  const toolTaskId = 20 as TaskId;
  const recorder = new DurableRecorder(backend, { conversationId, captureContent });
  try {
    const initial: DurableCommit = {
      submissions: [],
      entries: [],
      live: {
        run: { taskId: runTaskId, inputs: [1 as SubmissionId], afterRun: false },
        tools: [{ taskId: toolTaskId, callId: "nested-call", name: "nested", status: "running" }],
      },
      tasks: [
        { id: generationTaskId, kind: "pi.generation", phase: "request", terminal: false, failed: false },
        {
          id: toolTaskId,
          kind: "pi.tool",
          callId: "nested-call",
          arguments: { apiKey: "PRIVATE_CREDENTIAL", value: dataUri },
          terminal: false,
          failed: false,
        },
      ],
    };
    const entries: EntryRecord[] = messages(cost).map((message, index) => ({
      id: (index + 1) as EntryId,
      conversationId,
      kind: message.role,
      byTaskId: index === 0 ? generationTaskId : toolTaskId,
      model: [message],
    }));
    const completion: DurableCommit = {
      submissions: [],
      entries,
      tasks: [{ id: toolTaskId, kind: "pi.tool", callId: "nested-call", terminal: true, failed: false }],
    };
    const readEntry = async () => undefined;
    await recorder.commit(initial, readEntry);
    await recorder.commit(completion, readEntry);
    await recorder.commit(completion, readEntry);
    await recorder.commit({ submissions: [], entries: [], tasks: [], live: { tools: [] } }, readEntry);
    recorder.dispose();
    recorder.dispose();
    await recorder.commit(initial, readEntry);
    await recorder.commit(completion, readEntry);
  } finally {
    recorder.dispose();
  }
}

for (const captureContent of [false, true]) {
  test.each(cases)(`durable recorder capture=${captureContent}: $name`, async ({ cost, expected, provenance }) => {
    const backend = new FakeBackend();
    await recordCosts(backend, cost, captureContent);
    const generation = backend.observations.find((span) => span.name === "pi.durable.llm");
    const tool = backend.observations.find((span) => span.name === "pi.durable.tool");
    assert.ok(generation);
    assert.ok(tool);
    assert.deepEqual(generation.updates.at(-1)?.metadata, {
      ...expectedMetadata(provenance),
      "pi.durable.entry_id": 1,
      "pi.durable.task_id": 10,
      "pi.durable.stop_reason": "stop",
      "pi.durable.provider": messages(cost)[0].provider,
    });
    assert.deepEqual(tool.updates.at(-1)?.metadata, {
      ...expectedMetadata(provenance),
      "pi.durable.result_entry_id": 2,
      "pi.durable.result_missing": false,
    });
    for (const span of [generation, tool]) {
      assert.deepEqual(span.updates.at(-1)?.costDetails, expected);
      assert.deepEqual(span.updates.at(-1)?.usageDetails, usageDetails);
      assert.equal(span.parent?.traceId, generation.traceId);
      assert.equal(span.updates.length, 1);
      if (!captureContent) assert.equal(span.updates.at(-1)?.output, "[content capture disabled]");
    }
    assert.equal(backend.observations.length, 4);
    assert.ok(backend.observations.every((span) => span.endCalls === 1));
    const serialized = JSON.stringify(backend.observations);
    for (const secret of ["PRIVATE_PAYLOAD", "PRIVATE_CREDENTIAL", "data:image"])
      assert.ok(!serialized.includes(secret));
    if (captureContent) assert.ok(serialized.includes("[base64 data URI omitted]"));
  });
}

test("durable production exporter preserves provenance, completion metadata and numeric buckets", async () => {
  const exporter = new InMemorySpanExporter();
  const backend = await createProductionBackend(
    {
      publicKey: "pk-durable-cost",
      secretKey: "sk-durable-cost",
      baseUrl: "https://example.test",
      captureContent: true,
    },
    { createProcessor: () => new SimpleSpanProcessor(exporter) },
  );
  try {
    for (const { name, cost, expected, provenance } of cases) {
      exporter.reset();
      await recordCosts(backend, cost, true);
      await backend.forceFlush();
      const spans = exporter.getFinishedSpans();
      assert.equal(spans.length, 4, name);
      for (const observationName of ["pi.durable.llm", "pi.durable.tool"]) {
        const span = spans.find((candidate) => candidate.name === observationName);
        assert.ok(span, name);
        assert.deepEqual(JSON.parse(String(span.attributes["langfuse.observation.cost_details"])), expected, name);
        assert.deepEqual(JSON.parse(String(span.attributes["langfuse.observation.usage_details"])), usageDetails, name);
        assert.equal(
          span.attributes[`langfuse.observation.metadata.${provenanceKey}`],
          provenance === undefined ? undefined : JSON.stringify(provenance),
          name,
        );
        const entryKey = observationName === "pi.durable.llm" ? "entry_id" : "result_entry_id";
        assert.equal(
          span.attributes[`langfuse.observation.metadata.pi.durable.${entryKey}`],
          observationName === "pi.durable.llm" ? "1" : "2",
          name,
        );
      }
      const serialized = JSON.stringify(spans.map((span) => span.attributes));
      for (const secret of ["PRIVATE_PAYLOAD", "PRIVATE_CREDENTIAL", "data:image"])
        assert.ok(!serialized.includes(secret), name);
    }
  } finally {
    await backend.shutdown();
    setLangfuseTracerProvider(null);
  }
});
