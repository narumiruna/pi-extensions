import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { StackContextManager, TracerProvider } from "@opentelemetry/sdk-trace";
import { test, vi } from "vitest";
import { createProductionBackend } from "../src/runtime.js";
import type { ObservationType, TraceBackend } from "../src/tracing.js";

interface WireSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { boolValue?: boolean; stringValue?: string; arrayValue?: unknown } }[];
}

interface WireTrace {
  resourceSpans: { scopeSpans: { scope: { name: string }; spans: WireSpan[] }[] }[];
}

test.each([
  { override: undefined, encoding: "gzip" },
  { override: " NONE ", encoding: undefined },
])("production OTLP flush and shutdown export only Pi spans ($encoding)", async ({ override, encoding }) => {
  vi.stubEnv("LANGFUSE_OTEL_COMPRESSION", override);
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_COMPRESSION", override ? "gzip" : undefined);
  vi.stubEnv("OTEL_EXPORTER_OTLP_COMPRESSION", undefined);
  const requests: { method?: string; url?: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  let backend: TraceBackend | undefined;
  const secretKey = 'sk-test"with\\escapes';
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let provider: TracerProvider | undefined;
    backend = await createProductionBackend(
      {
        publicKey: "pk-app-root",
        secretKey,
        baseUrl: `http://127.0.0.1:${address.port}/self-hosted/`,
        captureContent: true,
        environment: "test-env",
        release: "test-release",
      },
      {
        createProvider: (processor) => {
          provider = new TracerProvider({ spanProcessors: [processor] });
          return provider;
        },
      },
    );
    assert.ok(provider);
    const external = provider.getTracer("unrelated").startSpan("external-parent", {}, ROOT_CONTEXT);
    assert.equal(context.setGlobalContextManager(new StackContextManager().enable()), true);
    const attached = context.with(trace.setSpan(ROOT_CONTEXT, external), () =>
      backend?.start("attached-root", {}, { asType: "span" }),
    );
    attached?.end();
    external.end();
    // Neither GenAI attributes nor known LLM instrumentation are enough to export other spans.
    provider
      .getTracer("openinference.instrumentation.openai")
      .startSpan("unrelated-genai", { attributes: { "gen_ai.operation.name": "chat" } }, ROOT_CONTEXT)
      .end();

    for (const type of ["agent", "generation", "tool", "span"] satisfies ObservationType[]) {
      const root = backend.start(
        `root-${type}`,
        { input: { [secretKey]: secretKey }, output: "response", sessionId: "test-session", userId: "test-user" },
        { asType: type },
      );
      root.updateTrace?.({ name: "trace name", input: "trace request", tags: ["test-tag"] });
      const child = backend.start(`child-${type}`, {}, { asType: type, parent: root, startTime: new Date(1_000) });
      child.end(2_000);
      root.end();
      backend.start(`late-${type}`, {}, { asType: type, parent: root }).end();
    }

    await backend.forceFlush();
    assert.equal(requests.length, 1);
    backend.start("shutdown-span", {}, { asType: "agent" }).end();
    await backend.shutdown();
    assert.equal(requests.length, 2);

    const batches = requests.map(({ method, url, headers, body }) => {
      assert.equal(method, "POST");
      assert.equal(url, "/self-hosted/api/public/otel/v1/traces");
      assert.equal(headers.authorization, `Basic ${Buffer.from(`pk-app-root:${secretKey}`).toString("base64")}`);
      assert.equal(headers["x-langfuse-ingestion-version"], "4");
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers["content-encoding"], encoding);
      const json = (encoding === "gzip" ? gunzipSync(body) : body).toString();
      const payload = JSON.parse(json) as WireTrace;
      return payload.resourceSpans
        .flatMap((resource) => resource.scopeSpans)
        .flatMap(({ scope, spans }) => {
          assert.equal(scope.name, "@narumitw/pi-langfuse");
          return spans;
        });
    });
    const [flushed, drained] = batches;
    assert.equal(flushed?.length, 13);
    assert.deepEqual(
      drained?.map((span) => span.name),
      ["shutdown-span"],
    );

    const attributes = (span: WireSpan) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));
    for (const span of flushed ?? []) {
      const { name } = span;
      const attrs = attributes(span);
      assert.equal(attrs["langfuse.environment"]?.stringValue, "test-env");
      assert.equal(attrs["langfuse.release"]?.stringValue, "test-release");
      assert.equal(attrs["langfuse.internal.is_app_root"]?.boolValue, name.startsWith("child-") ? undefined : true);
      if (name === "attached-root") {
        assert.equal(span.parentSpanId, external.spanContext().spanId);
        assert.equal(span.traceId, external.spanContext().traceId);
        continue;
      }
      const type = name.slice(name.indexOf("-") + 1);
      assert.equal(attrs["langfuse.observation.type"]?.stringValue, type);
      if (name.startsWith("root-")) {
        assert.equal(
          attrs["langfuse.observation.input"]?.stringValue,
          '{"[LANGFUSE_KEY_REDACTED]":"[LANGFUSE_KEY_REDACTED]"}',
        );
        assert.equal(attrs["langfuse.observation.output"]?.stringValue, "response");
        assert.equal(attrs["langfuse.trace.name"]?.stringValue, "trace name");
        assert.equal(attrs["langfuse.trace.input"]?.stringValue, "trace request");
        assert.deepEqual(attrs["langfuse.trace.tags"]?.arrayValue, { values: [{ stringValue: "test-tag" }] });
        assert.equal(attrs["session.id"]?.stringValue, "test-session");
        assert.equal(attrs["user.id"]?.stringValue, "test-user");
      } else {
        const root = flushed?.find((candidate) => candidate.name === `root-${type}`);
        assert.equal(span.parentSpanId, root?.spanId);
        assert.equal(span.traceId, root?.traceId);
      }
      if (name.startsWith("child-")) {
        assert.equal(span.startTimeUnixNano, "1000000000");
        assert.equal(span.endTimeUnixNano, "2000000000");
      }
    }
  } finally {
    try {
      await backend?.shutdown();
    } finally {
      context.disable();
      vi.unstubAllEnvs();
      delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v2")];
      delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v1")];
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
