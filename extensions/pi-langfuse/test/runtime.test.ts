import assert from "node:assert/strict";
import test from "node:test";
import { context as otelContext, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createProductionBackend, maskSecrets } from "../src/runtime.js";
import { TraceRecorder } from "../src/tracing.js";

test("maskSecrets redacts Langfuse credentials in nested exported data", () => {
	assert.deepEqual(maskSecrets({ text: "keys sk-lf-secret and pk-lf-public" }, ["custom-secret"]), {
		text: "keys [LANGFUSE_KEY_REDACTED] and [LANGFUSE_KEY_REDACTED]",
	});
	assert.equal(
		maskSecrets("prefix custom-secret suffix", ["custom-secret"]),
		"prefix [LANGFUSE_KEY_REDACTED] suffix",
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
	assert.equal(providers, 1);
	await assert.rejects(
		createProductionBackend({ ...config, release: "changed" }),
		/configuration changed/i,
	);
	assert.equal(trace.getTracerProvider(), globalProvider);

	const recorder = new TraceRecorder(backend, {
		sessionId: "runtime-session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	const ambient = trace.getTracer("ambient").startSpan("ambient");
	otelContext.with(trace.setSpan(otelContext.active(), ambient), () => {
		recorder.beginAgent({ prompt: "hello" });
	});
	ambient.end();
	recorder.beginAttempt({ reason: "post_compaction" });
	recorder.beginTurn(0);
	recorder.beginGeneration({
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
	recorder.beginTool("call", "read", { path: "file" });
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
	await recorder.flush();

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
	assert.equal(generation?.attributes["langfuse.observation.model.name"], "response-model");
	assert.equal(
		generation?.attributes["langfuse.observation.model.parameters"],
		JSON.stringify({ thinking_level: "high" }),
	);
	assert.equal(
		generation?.attributes["langfuse.observation.completion_start_time"],
		JSON.stringify(new Date(1_000)),
	);
	assert.equal(
		generation?.attributes["langfuse.observation.cost_details"],
		JSON.stringify({ input: 0.01, output: 0.02, total: 0.03 }),
	);
	assert.equal(agent?.attributes["langfuse.observation.metadata.pi.cwd"], "/workspace");
	assert.equal(agent?.attributes["langfuse.trace.metadata.pi.cwd"], "/workspace");
	assert.equal(agent?.attributes["langfuse.observation.metadata.pi.trace.outcome"], "success");
	assert.equal(agent?.attributes["langfuse.trace.metadata.pi.trace.outcome"], "success");
	assert.equal(
		attempt?.attributes["langfuse.observation.metadata.pi.attempt.reason"],
		"post_compaction",
	);
	assert.equal(attempt?.attributes["langfuse.observation.metadata.pi.attempt.outcome"], "success");
	assert.equal(tool?.attributes["langfuse.observation.metadata.pi.tool.call_id"], "call");
	assert.equal(tool?.attributes["langfuse.observation.metadata.pi.tool.name"], "read");
	assert.equal(
		compaction?.attributes["langfuse.observation.metadata.pi.compaction.messages_to_summarize"],
		"2",
	);
	assert.equal(
		compaction?.attributes["langfuse.observation.metadata.pi.compaction.from_extension"],
		"false",
	);
	await backend.shutdown();
	await backend.shutdown();
	await existingGlobalProvider.shutdown();
});
