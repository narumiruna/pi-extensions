import assert from "node:assert/strict";
import type { LangfuseSpanProcessorParams } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { test, vi } from "vitest";
import { createProductionBackend } from "../src/runtime.js";
import type { ObservationType } from "../src/tracing.js";

const exporter = new InMemorySpanExporter();

// Keep the production predicate and real Langfuse processing; replace only network export.
vi.mock("@langfuse/otel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langfuse/otel")>();
  return {
    ...actual,
    LangfuseSpanProcessor: class extends actual.LangfuseSpanProcessor {
      constructor(params: LangfuseSpanProcessorParams) {
        super({ ...params, exporter, exportMode: "immediate", mediaUploadEnabled: false });
      }
    },
  };
});

test("production filter marks Langfuse app roots at start without exporting unrelated spans", async () => {
  let provider: NodeTracerProvider | undefined;
  const backend = await createProductionBackend(
    {
      publicKey: "pk-app-root",
      secretKey: "sk-app-root",
      baseUrl: "https://example.test",
      captureContent: true,
    },
    {
      createProvider: (processor) => {
        provider = new NodeTracerProvider({ spanProcessors: [processor] });
        return provider;
      },
    },
  );
  try {
    assert.ok(provider);
    for (const type of ["agent", "generation", "tool", "span"] satisfies ObservationType[]) {
      const root = backend.start(`root-${type}`, { input: "request", output: "response" }, { asType: type });
      const child = backend.start(`child-${type}`, {}, { asType: type, parent: root });
      const backdated = backend.start(
        `backdated-${type}`,
        {},
        { asType: type, parent: root, startTime: new Date(1_000) },
      );
      child.end();
      backdated.end();
      root.end();
    }

    // Default Langfuse smart filtering would also export GenAI and known LLM instrumentors.
    for (const [scope, attributes] of [
      ["unrelated", {}],
      ["unrelated-genai", { "gen_ai.operation.name": "chat" }],
      ["openinference.instrumentation.openai", {}],
    ] as const) {
      provider.getTracer(scope).startSpan(scope, { attributes }, ROOT_CONTEXT).end();
    }

    const external = provider.getTracer("unrelated").startSpan("external-parent", {}, ROOT_CONTEXT);
    const attached = startObservation("attached-root", {}, { parentSpanContext: external.spanContext() });
    const attachedChild = attached.startObservation("attached-child");
    attachedChild.end();
    attached.end();
    external.end();

    // An ended parent is no longer tracked as expected-exported; the SDK marks a new app root.
    const ended = backend.start("ended-parent", {}, { asType: "agent" });
    ended.end();
    backend.start("late-child", {}, { asType: "span", parent: ended }).end();
    await backend.forceFlush();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 16);
    for (const span of spans) {
      assert.equal(span.instrumentationScope.name, "langfuse-sdk");
      const isRoot =
        span.name.startsWith("root-") || ["attached-root", "ended-parent", "late-child"].includes(span.name);
      assert.equal(span.attributes[LangfuseOtelSpanAttributes.IS_APP_ROOT], isRoot ? true : undefined, span.name);
      if (span.name.startsWith("root-")) {
        assert.equal(span.attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT], "request");
        assert.equal(span.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT], "response");
      }
      if (span.name.startsWith("child-") || span.name.startsWith("backdated-")) {
        const type = span.name.slice(span.name.indexOf("-") + 1);
        const root = spans.find((candidate) => candidate.name === `root-${type}`);
        assert.equal(span.parentSpanContext?.spanId, root?.spanContext().spanId, span.name);
        assert.equal(span.spanContext().traceId, root?.spanContext().traceId, span.name);
      }
    }
    assert.equal(
      spans.find((span) => span.name === "attached-root")?.parentSpanContext?.spanId,
      external.spanContext().spanId,
    );
    assert.equal(trace.getSpan(ROOT_CONTEXT), undefined);
  } finally {
    await backend.shutdown();
    setLangfuseTracerProvider(null);
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v2")];
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v1")];
  }
});
