import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { trace } from "@opentelemetry/api";
import { parse } from "protobufjs";
import { test, vi } from "vitest";
import { createLangfuseRuntime, createOtelRuntime } from "../src/runtime-api.js";
import { getLangfuseRuntimeInternal } from "../src/runtime-core.js";
import { TraceRecorder } from "../src/tracing.js";

// Decode the fields used by the test with their OTLP protobuf field numbers.
const traceRequest = parse(`
  syntax = "proto3";
  message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
  message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
  message Resource { repeated KeyValue attributes = 1; }
  message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
  message InstrumentationScope { string name = 1; }
  message Span {
    bytes trace_id = 1;
    bytes span_id = 2;
    bytes parent_span_id = 4;
    string name = 5;
    int32 kind = 6;
    repeated KeyValue attributes = 9;
    Status status = 15;
  }
  message Status { int32 code = 3; }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message AnyValue { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; }
`).root.lookupType("ExportTraceServiceRequest");

type Attributes = { key: string; value: { stringValue?: string; intValue?: number } }[];
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: Attributes;
  status?: { code?: number };
}
interface WireRequest {
  resourceSpans: {
    resource: { attributes: Attributes };
    scopeSpans: { scope: { name: string }; spans: WireSpan[] }[];
  }[];
}

const runtimeSlots = ["v1", "v2"].map((version) => Symbol.for(`@narumitw/pi-langfuse/runtime/${version}`));

function spanAttributes(span: WireSpan): Record<string, string | number | undefined> {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue]));
}

test("generic OTLP sends protobuf to the exact endpoint and ignores ambient exporter credentials", async () => {
  const requests: { method?: string; url?: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
  });
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:2/other");
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20other-token");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-ambient-key=other-token");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_COMPRESSION", "gzip");
  vi.stubEnv("OTEL_SERVICE_NAME", "other-service");
  let runtime: Awaited<ReturnType<typeof createOtelRuntime>> | undefined;
  try {
    await assert.rejects(
      createOtelRuntime({
        endpoint: "http://receiver.example/v1/traces",
        headers: { "x-api-key": "dummy-token" },
      }),
      /OTLP headers require HTTPS/u,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/custom/trace-path`;
    const headers = { Authorization: "Bearer private-test-token", "X-Api-Key": "my-test-key" };
    const globalProvider = trace.getTracerProvider();
    runtime = await createOtelRuntime({ endpoint, headers, serviceName: "pi-test" });
    assert.equal(trace.getTracerProvider(), globalProvider);
    assert.equal(
      await createOtelRuntime({
        endpoint,
        headers: { "x-api-key": "my-test-key", authorization: headers.Authorization },
        serviceName: "pi-test",
      }),
      runtime,
    );
    await assert.rejects(createOtelRuntime({ endpoint, headers: {} }), /configuration changed.*restart/u);
    await assert.rejects(
      createLangfuseRuntime({ config: { publicKey: "pk", secretKey: "sk" }, env: false }),
      /configuration changed.*restart/u,
    );
    const backend = getLangfuseRuntimeInternal(runtime).backend;
    for (const captureContent of [true, false]) {
      const recorder = new TraceRecorder(backend, {
        sessionId: `session-${captureContent}`,
        userId: "test-user",
        cwd: "/workspace",
        mode: "rpc",
        captureContent,
        metadata: { "private-test-token": { nested: "my-test-key" } },
      });
      recorder.beginAgent({ prompt: "prompt-marker private-test-token my-test-key" });
      recorder.beginAttempt();
      recorder.beginTurn(0);
      recorder.beginTool("call-1", "read", { path: "tool-input-marker" });
      recorder.finishTool("call-1", { content: "tool-output-marker", isError: true });
      recorder.beginGeneration({ model: { id: "test-model" }, payload: { content: "request-marker" } });
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider-error-marker",
        content: "response-marker",
        model: "test-model",
        usage: { input: 9, output: 2, totalTokens: 11 },
      };
      recorder.finishAssistant(message);
      recorder.finishTurn(0, { message, toolResultCount: 1 });
      recorder.finishAttempt(message);
      recorder.settle();
      if (captureContent) await runtime.flush();
    }
    await runtime.shutdown();
    assert.equal(requests.length, 2);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/custom/trace-path");
      assert.equal(request.headers["content-type"], "application/x-protobuf");
      assert.equal(request.headers["content-encoding"], undefined);
      assert.equal(request.headers.authorization, headers.Authorization);
      assert.equal(request.headers["x-api-key"], headers["X-Api-Key"]);
      assert.equal(request.headers["x-ambient-key"], undefined);
      assert.equal(request.headers["x-langfuse-ingestion-version"], undefined);
      const wire = traceRequest.toObject(traceRequest.decode(request.body), {
        bytes: String,
        longs: Number,
      }) as WireRequest;
      const [resourceSpans] = wire.resourceSpans;
      assert.equal(
        resourceSpans?.resource.attributes.find(({ key }) => key === "service.name")?.value.stringValue,
        "pi-test",
      );
      const scopeSpans = resourceSpans?.scopeSpans[0];
      assert.equal(scopeSpans?.scope.name, "@narumitw/pi-otel");
      const spans = scopeSpans?.spans ?? [];
      const [agent, attempt, turn, generation, tool] = [
        "pi.agent",
        "pi.attempt",
        "pi.turn",
        "pi.llm",
        "pi.tool.read",
      ].map((name) => spans.find((span) => span.name === name));
      assert.ok(agent && attempt && turn && generation && tool);
      assert.equal(spans.length, 5);
      assert.ok(agent.traceId);
      for (const [child, parent] of [
        [attempt, agent],
        [turn, attempt],
        [generation, turn],
        [tool, turn],
      ] as const) {
        assert.equal(child.traceId, agent.traceId);
        assert.equal(child.parentSpanId, parent.spanId);
      }
      const attributes = spanAttributes(generation);
      assert.equal(generation.kind, 3); // SPAN_KIND_CLIENT on the OTLP wire.
      assert.equal(attributes["pi.observation.model.name"], "test-model");
      assert.deepEqual(JSON.parse(String(attributes["pi.observation.usage_details"])), {
        input: 9,
        output: 2,
        total: 11,
      });
      assert.equal(spanAttributes(turn)["pi.observation.metadata.pi.turn.tool_result_count"], 1);
      assert.equal(tool.status?.code, 2); // STATUS_CODE_ERROR.
      for (const span of [agent, attempt, turn, generation]) {
        assert.equal(span.status?.code, 2, span.name);
        assert.equal(
          spanAttributes(span)["pi.observation.status_message"],
          index === 0 ? "provider-error-marker" : "The Pi operation failed.",
          span.name,
        );
      }
      const json = JSON.stringify(wire);
      assert.doesNotMatch(json, /private-test-token|my-test-key|langfuse\.observation/u);
      for (const marker of [
        "prompt-marker",
        "request-marker",
        "response-marker",
        "tool-input-marker",
        "tool-output-marker",
        "provider-error-marker",
      ]) {
        assert.equal(json.includes(marker), index === 0, marker);
      }
    }
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      for (const key of runtimeSlots) Reflect.deleteProperty(globalThis, key);
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
