import assert from "node:assert/strict";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { test } from "vitest";
import { durableUsage } from "../src/durable-projection.js";
import { createProductionBackend } from "../src/runtime.js";
import { type TraceBackend, TraceRecorder } from "../src/tracing.js";
import { FakeBackend } from "./support.js";

type Cost = Partial<Usage["cost"]>;
interface CostCase {
  name: string;
  cost?: Cost;
  expected: Record<string, number>;
  provenance?: boolean;
}

const estimates = { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004 };
const buckets = { input: 0.01, output: 0.02, cache_read: 0.003, cache_write: 0.004 };
const zeroComponents = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const cases: CostCase[] = [
  { name: "missing costs", expected: {} },
  { name: "empty costs", cost: {}, expected: {} },
  { name: "unknown zero", cost: { ...zeroComponents, total: 0 }, expected: {} },
  {
    name: "estimated zero",
    cost: { ...zeroComponents, total: 0, totalFromProvider: false },
    expected: {},
    provenance: false,
  },
  { name: "unknown zero with positive components", cost: { ...estimates, total: 0 }, expected: buckets },
  {
    name: "estimated zero with positive components",
    cost: { ...estimates, total: 0, totalFromProvider: false },
    expected: buckets,
    provenance: false,
  },
  {
    name: "confirmed provider zero",
    cost: { ...zeroComponents, total: 0, totalFromProvider: true },
    expected: { total: 0 },
    provenance: true,
  },
  {
    name: "confirmed provider zero with positive estimates",
    cost: { ...estimates, total: 0, totalFromProvider: true },
    expected: { ...buckets, total: 0 },
    provenance: true,
  },
  {
    name: "positive billed total that differs from estimates",
    cost: { ...estimates, total: 0.005, totalFromProvider: true },
    expected: { ...buckets, total: 0.005 },
    provenance: true,
  },
  {
    name: "positive estimated total",
    cost: { ...estimates, total: 0.037, totalFromProvider: false },
    expected: { ...buckets, total: 0.037 },
    provenance: false,
  },
  { name: "positive total without provenance", cost: { ...zeroComponents, total: 0.01 }, expected: { total: 0.01 } },
  ...[undefined, false, true].flatMap((provenance) =>
    [undefined, null, "0", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01].map(
      (total): CostCase => ({
        name: `invalid total ${String(total)} with provenance ${String(provenance)}`,
        cost: { ...estimates, total, totalFromProvider: provenance } as unknown as Cost,
        expected: buckets,
        provenance,
      }),
    ),
  ),
  ...[null, "0.01", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01].map(
    (value): CostCase => ({
      name: `invalid components ${String(value)} with valid provider zero`,
      cost: {
        input: value,
        output: value,
        cacheRead: value,
        cacheWrite: value,
        total: 0,
        totalFromProvider: true,
      } as unknown as Cost,
      expected: { total: 0 },
      provenance: true,
    }),
  ),
  ...[null, "true", "false", 0, 1, [], {}, "data:image/png;base64,PRIVATE_PAYLOAD"].map(
    (totalFromProvider): CostCase => ({
      name: `invalid provenance ${String(totalFromProvider)}`,
      cost: { ...estimates, total: 0, totalFromProvider } as unknown as Cost,
      expected: buckets,
    }),
  ),
];

function recordCosts(backend: TraceBackend, cost: Cost | undefined): void {
  if (cost) Object.freeze(cost);
  const recorder = new TraceRecorder(backend, {
    sessionId: "cost-session",
    cwd: "/workspace",
    mode: "json",
    captureContent: false,
  });
  recorder.beginAgent({ prompt: "test costs" });
  recorder.beginGeneration();
  recorder.finishAssistant({ role: "assistant", usage: { cost } });
  recorder.beginCompaction({
    reason: "threshold",
    willRetry: false,
    messagesToSummarize: 1,
    turnPrefixMessages: 0,
    branchEntries: 1,
    isSplitTurn: false,
  });
  recorder.finishCompaction({ reason: "threshold", willRetry: false, fromExtension: false, usage: { cost } });
  recorder.settle();
}

function compactionCosts(costs: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(costs).map(([key, value]) => [`pi.compaction.cost.${key}`, value]));
}

test.each(cases)("live generation payload: $name", ({ cost, expected, provenance }) => {
  const backend = new FakeBackend();
  recordCosts(backend, cost);
  const generation = backend.observations.find(({ name }) => name === "pi.llm");
  assert.ok(generation);
  assert.deepEqual(generation.updates.at(-1)?.costDetails, Object.keys(expected).length > 0 ? expected : undefined);
  assert.deepEqual(
    generation.updates.at(-1)?.metadata,
    provenance === undefined ? {} : { "pi.usage.cost.total_from_provider": provenance },
  );
  assert.equal(generation.endCalls, 1);
});

test.each(cases)("compaction payload: $name", ({ cost, expected, provenance }) => {
  const backend = new FakeBackend();
  recordCosts(backend, cost);
  const compaction = backend.observations.find(({ name }) => name === "pi.compaction");
  assert.ok(compaction);
  assert.deepEqual(compaction.updates.at(-1)?.metadata, {
    "pi.compaction.reason": "threshold",
    "pi.compaction.will_retry": false,
    "pi.compaction.from_extension": false,
    ...compactionCosts(expected),
    ...(provenance === undefined ? {} : { "pi.compaction.cost.total_from_provider": provenance }),
  });
  assert.equal(compaction.endCalls, 1);
});

for (const provenance of [undefined, false, true]) {
  test.each([zeroComponents, estimates])(
    `durable projection preserves zero totals with provenance ${String(provenance)} and components %j`,
    (components) => {
      const message = fauxAssistantMessage("done");
      message.usage.cost = { ...components, total: 0, totalFromProvider: provenance };
      Object.freeze(message.usage.cost);
      assert.deepEqual(durableUsage(message).costDetails, {
        input: components.input,
        output: components.output,
        cache_read: components.cacheRead,
        cache_write: components.cacheWrite,
        total: 0,
      });
    },
  );
}

test("production observations serialize cost totals and provenance without server-side recalculation", async () => {
  const exporter = new InMemorySpanExporter();
  const backend = await createProductionBackend(
    { publicKey: "pk-cost-test", secretKey: "sk-cost-test", baseUrl: "https://example.test", captureContent: false },
    { createProcessor: () => new SimpleSpanProcessor(exporter) },
  );
  try {
    for (const { name, cost, expected, provenance } of cases) {
      exporter.reset();
      recordCosts(backend, cost);
      await backend.forceFlush();
      const spans = exporter.getFinishedSpans();
      const generation = spans.find((span) => span.name === "pi.llm");
      const compaction = spans.find((span) => span.name === "pi.compaction");
      assert.ok(generation, name);
      assert.ok(compaction, name);
      const serializedCosts = generation.attributes["langfuse.observation.cost_details"];
      assert.deepEqual(
        serializedCosts === undefined ? undefined : JSON.parse(String(serializedCosts)),
        Object.keys(expected).length > 0 ? expected : undefined,
        name,
      );
      const serializedProvenance = provenance === undefined ? undefined : JSON.stringify(provenance);
      assert.equal(
        generation.attributes["langfuse.observation.metadata.pi.usage.cost.total_from_provider"],
        serializedProvenance,
        name,
      );
      const metadataPrefix = "langfuse.observation.metadata.pi.compaction.cost.";
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(compaction.attributes)
            .filter(([key]) => key.startsWith(metadataPrefix))
            .map(([key, value]) => [key.slice(metadataPrefix.length), JSON.parse(String(value))]),
        ),
        { ...expected, ...(provenance === undefined ? {} : { total_from_provider: provenance }) },
        name,
      );
    }
  } finally {
    await backend.shutdown();
    setLangfuseTracerProvider(null);
  }
});
