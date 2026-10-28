import assert from "node:assert/strict";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { test } from "vitest";
import { createProductionBackend } from "../src/runtime.js";
import { TraceRecorder } from "../src/tracing.js";

test("trace IO preserves legacy serialization, receiver scope, and sanitized recorder content", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const backend = await createProductionBackend(
    {
      publicKey: "pk-trace-io",
      secretKey: "sk-trace-io",
      baseUrl: "https://example.test",
      captureContent: true,
    },
    { createProcessor: () => processor },
  );
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cases: { name: string; value: unknown; expected: string | undefined }[] = [
      { name: "undefined", value: undefined, expected: undefined },
      { name: "null", value: null, expected: undefined },
      { name: "empty string", value: "", expected: "" },
      { name: "string", value: 'raw "text"', expected: 'raw "text"' },
      { name: "zero", value: 0, expected: "0" },
      { name: "false", value: false, expected: "false" },
      { name: "non-finite number", value: Number.NaN, expected: "null" },
      { name: "object", value: { text: "hello", count: 2 }, expected: '{"text":"hello","count":2}' },
      { name: "array", value: [null, false, "hello"], expected: '[null,false,"hello"]' },
      { name: "date", value: new Date(0), expected: '"1970-01-01T00:00:00.000Z"' },
      { name: "custom JSON", value: { toJSON: () => "custom" }, expected: '"custom"' },
      { name: "JSON omission", value: { toJSON: () => undefined }, expected: undefined },
      { name: "function", value: () => "ignored", expected: undefined },
      { name: "symbol", value: Symbol("ignored"), expected: undefined },
      { name: "bigint", value: 1n, expected: "<failed to serialize>" },
      { name: "circular", value: circular, expected: "<failed to serialize>" },
      {
        name: "throwing JSON",
        value: {
          toJSON: () => {
            throw new Error("cannot serialize");
          },
        },
        expected: "<failed to serialize>",
      },
    ];
    for (const { name, value } of cases) {
      const observation = backend.start(
        name,
        { input: "observation input", output: "observation output" },
        { asType: "span" },
      );
      assert.equal(observation.updateTrace?.({ input: value, output: value }), observation);
      observation.end();
    }

    const root = backend.start("root", { input: "root input", output: "root output" }, { asType: "agent" });
    root.updateTrace?.({ input: "trace input", output: "trace output" });
    // Null, undefined, and JSON-omitted values must not clear earlier trace values.
    root.updateTrace?.({ input: null, output: undefined });
    root.updateTrace?.({ input: Symbol("omitted"), output: () => undefined });
    root.updateTrace?.({ name: "trace name", metadata: { source: "scope test" } });
    const child = backend.start(
      "child",
      { input: "child input", output: "child output" },
      { asType: "tool", parent: root },
    );
    child.updateTrace?.({ input: { child: true } });
    child.updateTrace?.({ output: false });
    child.end();
    root.end();

    const recorder = new TraceRecorder(backend, {
      sessionId: "trace-io-session",
      cwd: "/workspace",
      mode: "tui",
      captureContent: true,
    });
    recorder.beginAgent({ prompt: "embedded data:text/plain;base64,c2VjcmV0" });
    recorder.finishAttempt({
      role: "assistant",
      content: "output data:text/plain;base64,c2VjcmV0",
      stopReason: "stop",
    });
    recorder.settle();
    await backend.forceFlush();

    const spans = exporter.getFinishedSpans();
    for (const { name, expected } of cases) {
      const span = spans.find((candidate) => candidate.name === name);
      assert.ok(span, name);
      for (const field of ["input", "output"]) {
        assert.equal(span.attributes[`langfuse.trace.${field}`], expected, `${name}: trace ${field}`);
        assert.equal(`langfuse.trace.${field}` in span.attributes, expected !== undefined, `${name}: omitted ${field}`);
        assert.equal(
          span.attributes[`langfuse.observation.${field}`],
          `observation ${field}`,
          `${name}: observation ${field}`,
        );
      }
    }
    const rootSpan = spans.find((span) => span.name === "root");
    const childSpan = spans.find((span) => span.name === "child");
    assert.equal(rootSpan?.attributes["langfuse.trace.metadata.source"], JSON.stringify("scope test"));
    assert.equal(rootSpan?.attributes["langfuse.trace.input"], "trace input");
    assert.equal(rootSpan?.attributes["langfuse.trace.output"], "trace output");
    assert.equal(rootSpan?.attributes["langfuse.observation.input"], "root input");
    assert.equal(rootSpan?.attributes["langfuse.observation.output"], "root output");
    assert.equal(childSpan?.attributes["langfuse.trace.input"], '{"child":true}');
    assert.equal(childSpan?.attributes["langfuse.trace.output"], "false");
    assert.equal(childSpan?.attributes["langfuse.observation.input"], "child input");
    assert.equal(childSpan?.attributes["langfuse.observation.output"], "child output");
    assert.equal(childSpan?.parentSpanContext?.spanId, rootSpan?.spanContext().spanId);
    const agent = spans.find((span) => span.name === "pi.agent");
    assert.ok(agent);
    assert.match(String(agent.attributes["langfuse.trace.input"]), /\[base64 data URI omitted\]/);
    assert.match(String(agent.attributes["langfuse.trace.output"]), /\[base64 data URI omitted\]/);
    assert.equal(JSON.stringify(agent.attributes).includes("c2VjcmV0"), false);
  } finally {
    await backend.shutdown();
    setLangfuseTracerProvider(null);
  }
});
