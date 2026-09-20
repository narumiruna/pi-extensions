import assert from "node:assert/strict";
import { context as otelContext, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { test } from "vitest";
import {
  createLangfuseRuntime,
  createProductionBackend,
  maskSecrets,
  resolveLangfuseRuntimeConfig,
} from "../src/runtime.js";
import { createLangfuseRuntimeFromBackend } from "../src/runtime-core.js";
import { TraceRecorder } from "../src/tracing.js";
import { FakeBackend } from "./support.js";

test("maskSecrets redacts Langfuse credentials in nested exported data", () => {
  assert.deepEqual(maskSecrets({ text: "keys sk-lf-secret and pk-lf-public" }, ["custom-secret"]), {
    text: "keys [LANGFUSE_KEY_REDACTED] and [LANGFUSE_KEY_REDACTED]",
  });
  assert.equal(maskSecrets("prefix custom-secret suffix", ["custom-secret"]), "prefix [LANGFUSE_KEY_REDACTED] suffix");
  assert.deepEqual(maskSecrets({ "key.custom-secret": "value custom-secret" }, ["custom-secret"]), {
    "key.[LANGFUSE_KEY_REDACTED]": "value [LANGFUSE_KEY_REDACTED]",
  });
});

test("public runtime settings prefer injected config, support standard environment, and allow env opt-out", () => {
  assert.deepEqual(
    resolveLangfuseRuntimeConfig({
      config: { publicKey: " explicit-pk ", baseUrl: "https://explicit.example/", release: "v2" },
      env: {
        LANGFUSE_PUBLIC_KEY: "env-pk",
        LANGFUSE_SECRET_KEY: "env-sk",
        LANGFUSE_BASE_URL: "https://env.example",
        LANGFUSE_TRACING_ENVIRONMENT: "test_env",
        LANGFUSE_RELEASE: "v1",
      },
    }),
    {
      publicKey: "explicit-pk",
      secretKey: "env-sk",
      baseUrl: "https://explicit.example",
      environment: "test_env",
      release: "v2",
    },
  );
  assert.throws(() => resolveLangfuseRuntimeConfig({ config: {}, env: false }), /publicKey is required/i);
  assert.throws(
    () =>
      resolveLangfuseRuntimeConfig({
        config: { publicKey: "pk", secretKey: "sk", baseUrl: "   " },
        env: false,
      }),
    /baseUrl must be a non-empty string/i,
  );
});

test("maskSecrets safely handles circular exporter data", () => {
  const circular: Record<string, unknown> = { secret: "sk-lf-nested" };
  circular.self = circular;

  assert.deepEqual(maskSecrets(circular, []), {
    secret: "[LANGFUSE_KEY_REDACTED]",
    self: "[circular]",
  });
});

test("legacy process runtime prevents an incompatible second provider", async () => {
  const legacyKey = Symbol.for("@narumitw/pi-langfuse/runtime/v1");
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  globals[legacyKey] = Promise.resolve({});
  try {
    await assert.rejects(
      createLangfuseRuntime({
        config: { publicKey: "pk-legacy", secretKey: "sk-legacy", baseUrl: "https://example.test" },
        env: false,
      }),
      /older Langfuse runtime is already loaded.*restart/i,
    );
  } finally {
    delete globals[legacyKey];
  }
});

test("v2 runtime reserves the legacy slot against reverse-order provider initialization", async () => {
  const runtimeKey = Symbol.for("@narumitw/pi-langfuse/runtime/v2");
  const legacyKey = Symbol.for("@narumitw/pi-langfuse/runtime/v1");
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const processor = new SimpleSpanProcessor(new InMemorySpanExporter());
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const config = {
    publicKey: "pk-reverse-order",
    secretKey: "sk-reverse-order",
    baseUrl: "https://example.test",
    captureContent: false,
  };

  let backend: Awaited<ReturnType<typeof createProductionBackend>> | undefined;
  try {
    backend = await createProductionBackend(config, {
      createProcessor: () => processor,
      createProvider: () => provider,
      selectProvider: () => undefined,
    });
    const legacySlot = (await globals[legacyKey]) as { shutdown?: boolean };

    assert.equal(legacySlot.shutdown, true);
    assert.equal(globals[legacyKey], globals[runtimeKey]);
  } finally {
    if (backend) await backend.shutdown().catch(() => undefined);
    delete globals[runtimeKey];
    delete globals[legacyKey];
  }
});

test("runtime flush serialization recovers after failure and shutdown remains idempotent", async () => {
  const backend = new FakeBackend();
  let fail = true;
  backend.forceFlush = async () => {
    backend.flushes += 1;
    if (fail) {
      fail = false;
      throw new Error("injected flush failure");
    }
  };
  const runtime = createLangfuseRuntimeFromBackend(backend);

  await assert.rejects(runtime.flush(), /injected flush failure/);
  await runtime.flush();
  await runtime.shutdown();
  await runtime.shutdown();

  assert.equal(backend.flushes, 3);
  assert.equal(backend.shutdowns, 1);
  assert.equal(runtime.closed, true);
  await assert.rejects(runtime.flush(), /closed|shutting down/i);
});

test("isolated runtime preserves the global provider and exports native observation hierarchy", async () => {
  const existingGlobalProvider = new NodeTracerProvider();
  assert.equal(trace.setGlobalTracerProvider(existingGlobalProvider), true);
  const globalProvider = trace.getTracerProvider();
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  let providers = 0;
  const config = {
    publicKey: "pk-runtime-test",
    secretKey: "sk-runtime-test",
    baseUrl: "https://example.test",
    captureContent: true,
  };
  await assert.rejects(
    createProductionBackend(config, {
      createProcessor: () => new SimpleSpanProcessor(new InMemorySpanExporter()),
      createProvider: () => {
        throw new Error("provider initialization failed");
      },
    }),
    /provider initialization failed/,
  );
  const backend = await createProductionBackend(config, {
    createProcessor: () => processor,
    createProvider: (spanProcessor) => {
      providers += 1;
      return new NodeTracerProvider({ spanProcessors: [spanProcessor] });
    },
  });
  assert.equal(await createProductionBackend(config), backend);
  const [runtime, concurrentRuntime] = await Promise.all([
    createLangfuseRuntime({ config, env: false }),
    createLangfuseRuntime({ config, env: false }),
  ]);
  assert.equal(concurrentRuntime, runtime);
  assert.equal(providers, 1);
  await assert.rejects(
    createLangfuseRuntime({ config: { ...config, release: "changed" }, env: false }),
    /configuration changed/i,
  );
  await assert.rejects(createProductionBackend({ ...config, release: "changed" }), /configuration changed/i);
  assert.equal(trace.getTracerProvider(), globalProvider);

  const recorder = new TraceRecorder(backend, {
    sessionId: "runtime-session",
    userId: "runtime-user",
    cwd: "/workspace",
    mode: "tui",
    captureContent: true,
    metadata: {
      nested: { value: "preserved" },
      items: ["a", "b"],
      "custom.data:text/plain;base64,c2VjcmV0": "redacted-key",
      [`credential.${config.publicKey}`]: { secret: config.secretKey },
    },
  });
  const ambient = trace.getTracer("ambient").startSpan("ambient");
  otelContext.with(trace.setSpan(otelContext.active(), ambient), () => {
    recorder.beginAgent({ prompt: "hello" });
  });
  ambient.end();
  recorder.beginAttempt({ reason: "post_compaction" });
  recorder.beginTurn(0);
  recorder.beginGeneration({
    startedAt: 500,
    payload: { messages: [{ role: "user", content: "hello" }] },
    payloadStage: "before_provider_request",
    model: { provider: "openai", id: "requested-model", api: "openai-responses" },
    thinkingLevel: "high",
  });
  recorder.recordProviderResponse(200, { "x-request-id": "request-1" });
  recorder.markGenerationFirstOutput(1_000);
  recorder.finishAssistant({
    role: "assistant",
    content: "world",
    model: "requested-model",
    responseModel: "response-model",
    responseId: "response-1",
    usage: {
      input: 2,
      output: 1,
      totalTokens: 3,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    },
    stopReason: "toolUse",
  });
  recorder.beginTool("call", "read", { path: "raw-file" });
  recorder.recordToolInput("call", { path: "executed-file" });
  recorder.finishTool("call", { content: "content" });
  recorder.beginCompaction({
    reason: "threshold",
    willRetry: false,
    tokensBefore: 100,
    messagesToSummarize: 2,
    turnPrefixMessages: 0,
    branchEntries: 5,
    isSplitTurn: false,
  });
  recorder.finishCompaction({
    reason: "threshold",
    willRetry: false,
    fromExtension: false,
    tokensBefore: 100,
  });
  recorder.finishTurn(0, {
    message: { role: "assistant", stopReason: "toolUse" },
    toolResultCount: 1,
  });
  recorder.finishAttempt({ role: "assistant", content: "world", stopReason: "stop" });
  recorder.settle();
  await backend.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.deepEqual(spans.map((span) => span.attributes["langfuse.observation.type"]).sort(), [
    "agent",
    "generation",
    "span",
    "span",
    "span",
    "tool",
  ]);
  for (const span of spans) assert.equal(span.attributes["langfuse.version"], "2");
  for (const span of spans) assert.equal(span.attributes["session.id"], "runtime-session");
  for (const span of spans) assert.equal(span.attributes["user.id"], "runtime-user");
  const agent = spans.find((span) => span.name === "pi.agent");
  const attempt = spans.find((span) => span.name === "pi.attempt");
  const turn = spans.find((span) => span.name === "pi.turn");
  const generation = spans.find((span) => span.name === "pi.llm");
  const tool = spans.find((span) => span.name === "pi.tool.read");
  const compaction = spans.find((span) => span.name === "pi.compaction");
  assert.equal(agent?.parentSpanContext, undefined);
  assert.equal(attempt?.parentSpanContext?.spanId, agent?.spanContext().spanId);
  assert.equal(turn?.parentSpanContext?.spanId, attempt?.spanContext().spanId);
  assert.equal(compaction?.parentSpanContext?.spanId, agent?.spanContext().spanId);
  for (const child of spans.filter((span) => ["pi.llm", "pi.tool.read"].includes(span.name))) {
    assert.equal(child.parentSpanContext?.spanId, turn?.spanContext().spanId);
  }
  assert.equal(generation?.attributes["langfuse.version"], "2");
  assert.deepEqual(generation?.startTime, [0, 500_000_000]);
  assert.equal(generation?.attributes["langfuse.observation.model.name"], "response-model");
  assert.equal(
    generation?.attributes["langfuse.observation.model.parameters"],
    JSON.stringify({ thinking_level: "high" }),
  );
  assert.equal(generation?.attributes["langfuse.observation.completion_start_time"], JSON.stringify(new Date(1_000)));
  assert.equal(
    generation?.attributes["langfuse.observation.cost_details"],
    JSON.stringify({ input: 0.01, output: 0.02, total: 0.03 }),
  );
  assert.equal(agent?.attributes["langfuse.observation.metadata.pi.cwd"], "/workspace");
  assert.equal(agent?.attributes["langfuse.trace.metadata.pi.cwd"], "/workspace");
  assert.equal(agent?.attributes["langfuse.observation.metadata.nested"], JSON.stringify({ value: "preserved" }));
  assert.equal(agent?.attributes["langfuse.trace.metadata.nested"], JSON.stringify({ value: "preserved" }));
  assert.equal(agent?.attributes["langfuse.observation.metadata.items"], JSON.stringify(["a", "b"]));
  assert.equal(agent?.attributes["langfuse.trace.metadata.items"], JSON.stringify(["a", "b"]));
  assert.equal(agent?.attributes["langfuse.observation.metadata.custom.[base64 data URI omitted]"], "redacted-key");
  assert.equal(agent?.attributes["langfuse.trace.metadata.custom.[base64 data URI omitted]"], "redacted-key");
  assert.equal(
    agent?.attributes["langfuse.observation.metadata.credential.[LANGFUSE_KEY_REDACTED]"],
    JSON.stringify({ secret: "[LANGFUSE_KEY_REDACTED]" }),
  );
  assert.equal(
    agent?.attributes["langfuse.trace.metadata.credential.[LANGFUSE_KEY_REDACTED]"],
    JSON.stringify({ secret: "[LANGFUSE_KEY_REDACTED]" }),
  );
  assert.equal(
    JSON.stringify(agent?.attributes ?? {}).includes("c2VjcmV0") ||
      JSON.stringify(agent?.attributes ?? {}).includes(config.publicKey) ||
      JSON.stringify(agent?.attributes ?? {}).includes(config.secretKey),
    false,
  );
  assert.equal(agent?.attributes["langfuse.observation.metadata.pi.trace.outcome"], "success");
  assert.equal(agent?.attributes["langfuse.trace.metadata.pi.trace.outcome"], "success");
  assert.equal(attempt?.attributes["langfuse.observation.metadata.pi.attempt.reason"], "post_compaction");
  assert.equal(attempt?.attributes["langfuse.observation.metadata.pi.attempt.outcome"], "success");
  assert.equal(tool?.attributes["langfuse.observation.input"], JSON.stringify({ path: "executed-file" }));
  assert.equal(tool?.attributes["langfuse.observation.metadata.pi.tool.call_id"], "call");
  assert.equal(tool?.attributes["langfuse.observation.metadata.pi.tool.name"], "read");
  assert.equal(compaction?.attributes["langfuse.observation.metadata.pi.compaction.messages_to_summarize"], "2");
  assert.equal(compaction?.attributes["langfuse.observation.metadata.pi.compaction.from_extension"], "false");

  const updatedSession = backend.start("updated-session", {}, { asType: "span" });
  updatedSession.update({ sessionId: "updated-session", userId: "updated-user" });
  updatedSession.end();
  await backend.forceFlush();
  const updatedSessionSpan = exporter.getFinishedSpans().find((span) => span.name === "updated-session");
  assert.equal(updatedSessionSpan?.attributes["session.id"], "updated-session");
  assert.equal(updatedSessionSpan?.attributes["user.id"], "updated-user");

  const withoutUser = backend.start("without-user", {}, { asType: "span" });
  withoutUser.end();
  await backend.forceFlush();
  const withoutUserSpan = exporter.getFinishedSpans().find((span) => span.name === "without-user");
  assert.equal("user.id" in (withoutUserSpan?.attributes ?? {}), false);

  await runtime.shutdown();
  await runtime.shutdown();
  await existingGlobalProvider.shutdown();
});
