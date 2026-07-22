import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { context as otelContext, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadLangfuseConfig, normalizeLangfuseConfig } from "../src/config.js";
import { createLangfuseExtension } from "../src/langfuse.js";
import { createProductionBackend, maskSecrets } from "../src/runtime.js";
import {
	MAX_CAPTURE_BYTES,
	type Observation,
	type ObservationAttributes,
	type ObservationType,
	sanitizeTraceValue,
	type TraceBackend,
	TraceRecorder,
} from "../src/tracing.js";

class FakeObservation implements Observation {
	readonly updates: ObservationAttributes[] = [];
	readonly traceUpdates: ObservationAttributes[] = [];
	ended = false;
	endTime: number | undefined;

	constructor(
		readonly name: string,
		readonly attributes: ObservationAttributes,
		readonly type: ObservationType,
		readonly parent?: Observation,
	) {}

	update(attributes: ObservationAttributes) {
		this.updates.push(attributes);
		return this;
	}

	updateTrace(attributes: ObservationAttributes) {
		this.traceUpdates.push(attributes);
		return this;
	}

	end(endTime?: number) {
		this.ended = true;
		this.endTime = endTime;
		return this;
	}
}

class FakeBackend implements TraceBackend {
	readonly observations: FakeObservation[] = [];
	flushes = 0;
	shutdowns = 0;

	start(
		name: string,
		attributes: ObservationAttributes,
		options: { asType: ObservationType; parent?: Observation },
	) {
		const observation = new FakeObservation(name, attributes, options.asType, options.parent);
		this.observations.push(observation);
		return observation;
	}

	async forceFlush() {
		this.flushes += 1;
	}

	async shutdown() {
		this.shutdowns += 1;
	}
}

test("loadLangfuseConfig reads pi-langfuse.json and enforces private permissions", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");
	await writeFile(
		path,
		JSON.stringify({
			publicKey: "pk-from-file",
			secretKey: "sk-from-file",
			baseUrl: "http://self-hosted.example/",
			environment: "test",
			release: "v1",
			captureContent: false,
		}),
		{ mode: 0o644 },
	);

	const result = await loadLangfuseConfig(path);

	assert.deepEqual(result, {
		ok: true,
		config: {
			publicKey: "pk-from-file",
			secretKey: "sk-from-file",
			baseUrl: "http://self-hosted.example",
			environment: "test",
			release: "v1",
			captureContent: false,
		},
		path,
		warnings: [`Restricted ${path} permissions to 0600.`],
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("loadLangfuseConfig reports missing and unsafe settings without environment fallbacks", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-missing-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");

	assert.deepEqual(await loadLangfuseConfig(path), {
		ok: false,
		path,
		warnings: [],
		reason: `Configuration file not found: ${path}`,
	});

	await writeFile(path, JSON.stringify({ publicKey: "$LANGFUSE_PUBLIC_KEY", secretKey: "sk" }));
	const invalid = await loadLangfuseConfig(path);
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.reason, /publicKey must be literal/i);
});

test("session start suggests the /langfuse setup action when the config file is missing", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/config/pi-langfuse.json",
			warnings: [],
			reason: "Configuration file not found: /config/pi-langfuse.json",
		}),
	})(mock.pi);
	const { ctx, notifications } = createMockContext();

	await mock.events.get("session_start")?.[0]?.({}, ctx);

	assert.match(notifications.at(-1)?.message ?? "", /run \/langfuse and choose set up langfuse/i);
});

test("TraceRecorder wraps one agent hierarchy in a conversation span", async () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});

	recorder.beginAgent({
		prompt: "Fix the test",
		model: { provider: "anthropic", id: "claude" },
	});
	recorder.beginGeneration();
	recorder.finishAssistant({
		role: "assistant",
		provider: "anthropic",
		model: "claude",
		content: [{ type: "text", text: "I will inspect it." }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { total: 0.01 },
		},
		stopReason: "toolUse",
	});
	recorder.beginTool("call-1", "read", { path: "test.ts" });
	recorder.finishTool("call-1", {
		content: [{ type: "text", text: "contents" }],
		isError: false,
	});
	recorder.settle();
	await recorder.flush();

	assert.equal(backend.observations.length, 4);
	const [conversation, agent, generation, tool] = backend.observations;
	assert.equal(conversation?.name, "pi.conversation");
	assert.equal(conversation?.type, "span");
	assert.equal(conversation?.parent, undefined);
	assert.deepEqual(conversation?.traceUpdates[0], {
		name: "pi.trace",
		sessionId: "session-1",
		input: { prompt: "Fix the test" },
		metadata: conversation?.attributes.metadata,
		tags: ["pi"],
	});
	assert.deepEqual(conversation?.attributes.input, { prompt: "Fix the test" });
	assert.deepEqual(conversation?.attributes.metadata, {
		"pi.cwd": "/workspace",
		"pi.mode": "tui",
		"pi.model": "claude",
		"pi.provider": "anthropic",
		"pi.session.id": "session-1",
	});
	assert.equal(agent?.name, "pi.agent");
	assert.equal(agent?.type, "agent");
	assert.equal(agent?.parent, conversation);
	assert.deepEqual(agent?.attributes, conversation?.attributes);
	assert.equal(generation?.name, "pi.llm");
	assert.equal(generation?.type, "generation");
	assert.equal(generation?.parent, agent);
	assert.equal(generation?.attributes.input, undefined);
	assert.deepEqual(generation?.updates.at(-1)?.usageDetails, {
		cache_creation_input_tokens: 1,
		cache_read_input_tokens: 2,
		input: 10,
		output: 5,
		total: 18,
	});
	assert.equal(generation?.ended, true);
	assert.equal(tool?.name, "pi.tool.read");
	assert.equal(tool?.type, "tool");
	assert.equal(tool?.parent, agent);
	assert.equal(tool?.ended, true);
	assert.equal(agent?.ended, true);
	assert.equal(conversation?.ended, true);
	assert.equal(backend.flushes, 1);
});

test("TraceRecorder only exports known non-zero costs with the Langfuse total bucket", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});

	recorder.beginAgent({ prompt: "test" });
	recorder.beginGeneration();
	recorder.finishAssistant({
		role: "assistant",
		content: "unpriced",
		usage: { cost: { total: 0 } },
	});
	recorder.beginGeneration();
	recorder.finishAssistant({
		role: "assistant",
		content: "priced",
		usage: { cost: { total: 0.01 } },
	});

	assert.equal(backend.observations[2]?.updates.at(-1)?.costDetails, undefined);
	assert.deepEqual(backend.observations[3]?.updates.at(-1)?.costDetails, { total: 0.01 });
});

test("TraceRecorder prefers the concrete response model and retains the requested alias", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "test" });
	recorder.beginGeneration();
	recorder.finishAssistant({
		role: "assistant",
		content: "done",
		provider: "openai",
		model: "requested-alias",
		responseModel: "concrete-model",
		stopReason: "stop",
	});

	assert.equal(backend.observations[2]?.updates.at(-1)?.model, "concrete-model");
	assert.deepEqual(backend.observations[2]?.updates.at(-1)?.metadata, {
		"pi.provider": "openai",
		"pi.requested_model": "requested-alias",
		"pi.stop_reason": "stop",
	});
});

test("TraceRecorder replaces all captured values when content capture is disabled", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "tui",
		captureContent: false,
	});
	recorder.beginAgent({ prompt: "private prompt" });
	recorder.beginGeneration();
	recorder.finishAssistant({ role: "assistant", content: "private response" });
	recorder.beginTool("call", "read", { path: "private path" });
	recorder.finishTool("call", { content: "private content", details: "private details" });
	recorder.settle();

	for (const observation of backend.observations) {
		if (observation.name === "pi.llm") assert.equal(observation.attributes.input, undefined);
		else assert.equal(observation.attributes.input, "[content capture disabled]");
		for (const update of observation.updates) {
			if (update.output !== undefined) {
				assert.equal(update.output, "[content capture disabled]");
			}
		}
	}
});

test("TraceRecorder closes interrupted observations and redacts image payloads", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "print",
		captureContent: true,
	});

	recorder.beginAgent({
		prompt: "Describe this",
		images: [{ type: "image", mimeType: "image/png", data: "base64-secret" }],
		model: { provider: "openai", id: "gpt" },
	});
	recorder.beginGeneration();
	recorder.beginGeneration();
	recorder.beginTool("call-1", "bash", { command: "exit 1" });
	recorder.finishTool("call-1", { content: "failed", isError: true });
	recorder.settle();

	const [conversation, agent, firstGeneration, secondGeneration, tool] = backend.observations;
	assert.deepEqual(conversation?.attributes.input, {
		images: [{ type: "image", mimeType: "image/png", data: "[base64 omitted]" }],
		prompt: "Describe this",
	});
	assert.deepEqual(agent?.attributes.input, conversation?.attributes.input);
	assert.equal(firstGeneration?.updates.at(-1)?.level, "ERROR");
	assert.match(String(firstGeneration?.updates.at(-1)?.statusMessage), /interrupted/i);
	assert.equal(firstGeneration?.ended, true);
	assert.equal(secondGeneration?.ended, true);
	assert.equal(tool?.updates.at(-1)?.level, "ERROR");
});

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

test("pi-langfuse registers lifecycle hooks and exports completed traces", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	const extension = createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-test",
				secretKey: "sk-test",
				baseUrl: "https://cloud.langfuse.com",
				captureContent: true,
			},
			path: "/config/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	});
	extension(mock.pi);

	assert.ok(mock.commands.has("langfuse"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"after_provider_response",
		"agent_end",
		"agent_settled",
		"before_agent_start",
		"before_provider_request",
		"message_end",
		"session_shutdown",
		"session_start",
		"tool_execution_end",
		"tool_execution_start",
		"tool_result",
		"turn_end",
		"turn_start",
	]);

	const { ctx } = createMockContext({
		cwd: "/workspace",
		mode: "tui",
		model: { provider: "anthropic", id: "claude" },
		isProjectTrusted: () => true,
		getSystemPrompt: () => "system",
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "Hello", images: [], systemPrompt: "system before modifiers" },
		ctx,
	);
	const finalPayload = {
		model: "claude",
		system: "system after modifiers",
		messages: [{ role: "user", content: "Hello after context filters" }],
	};
	await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);
	await mock.events.get("before_provider_request")?.[0]?.({ payload: finalPayload }, ctx);
	await mock.events.get("turn_end")?.[0]?.(
		{
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hi after message transforms" }],
				provider: "anthropic",
				model: "claude",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
			toolResults: [],
		},
		ctx,
	);
	await mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx);

	assert.equal(backend.observations.length, 4);
	assert.equal(backend.flushes, 0);
	const [conversation, agent, turn, generation] = backend.observations;
	assert.equal(conversation?.name, "pi.conversation");
	assert.equal(conversation?.type, "span");
	assert.equal(conversation?.ended, false);
	assert.equal(agent?.name, "pi.agent");
	assert.equal(agent?.parent, conversation);
	assert.equal(agent?.ended, false);
	assert.equal(turn?.name, "pi.turn");
	assert.equal(turn?.parent, agent);
	assert.equal(turn?.ended, true);
	assert.equal(generation?.parent, turn);
	assert.equal(generation?.ended, true);
	assert.deepEqual(turn?.attributes.metadata, { "pi.turn.index": 0 });
	assert.deepEqual(turn?.updates.at(-1)?.metadata, {
		"pi.turn.index": 0,
		"pi.turn.stop_reason": "stop",
		"pi.turn.tool_result_count": 0,
	});
	assert.equal(generation?.attributes.input, undefined);
	assert.deepEqual(generation?.updates.at(-1)?.output, [
		{ type: "text", text: "Hi after message transforms" },
	]);

	await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 2 }, ctx);
	await mock.events.get("before_provider_request")?.[0]?.(
		{ payload: { messages: [{ role: "user", content: "retry" }] } },
		ctx,
	);
	await mock.events.get("turn_end")?.[0]?.(
		{
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Recovered" }],
				provider: "anthropic",
				model: "claude",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
			toolResults: [],
		},
		ctx,
	);
	await mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx);

	assert.equal(backend.observations.length, 6);
	const continuationTurn = backend.observations[4];
	const continuationGeneration = backend.observations[5];
	assert.equal(continuationTurn?.name, "pi.turn");
	assert.equal(continuationTurn?.parent, agent);
	assert.equal(continuationTurn?.ended, true);
	assert.equal(continuationGeneration?.parent, continuationTurn);
	assert.equal(continuationGeneration?.ended, true);
	assert.equal(conversation?.ended, false);
	assert.equal(agent?.ended, false);

	await mock.events.get("agent_settled")?.[0]?.({}, ctx);

	assert.equal(
		backend.observations.every((observation) => observation.ended),
		true,
	);
	assert.deepEqual(conversation?.updates.at(-1)?.output, [{ type: "text", text: "Recovered" }]);
	assert.equal(backend.flushes, 0);
});

test("pi-langfuse reconciles the finalized assistant message from agent_end", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-test",
				secretKey: "sk-test",
				baseUrl: "https://cloud.langfuse.com",
				captureContent: true,
			},
			path: "/config/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx } = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "retry", images: [], systemPrompt: "system" },
		ctx,
	);
	await mock.events.get("before_provider_request")?.[0]?.({ payload: { model: "test" } }, ctx);
	const finalized = {
		role: "assistant",
		content: [{ type: "text", text: "retryable error added by a later transformer" }],
		provider: "test",
		model: "test",
		usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
		stopReason: "error",
		errorMessage: "retryable error added by a later transformer",
	};
	await mock.events.get("agent_end")?.[0]?.({ messages: [finalized] }, ctx);

	const [conversation, agent, generation] = backend.observations;
	assert.deepEqual(generation?.updates.at(-1)?.output, finalized.content);
	assert.equal(generation?.updates.at(-1)?.statusMessage, finalized.errorMessage);
	assert.equal(generation?.ended, true);
	assert.equal(conversation?.ended, false);
	assert.equal(agent?.ended, false);

	await mock.events.get("agent_settled")?.[0]?.({}, ctx);
	assert.equal(conversation?.ended, true);
	assert.equal(agent?.ended, true);
});

test("pi-langfuse traces normalized tool inputs and finalized tool outputs", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-test",
				secretKey: "sk-test",
				baseUrl: "https://cloud.langfuse.com",
				captureContent: true,
			},
			path: "/config/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx } = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "edit", images: [], systemPrompt: "system" },
		ctx,
	);
	await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);
	await mock.events.get("before_provider_request")?.[0]?.({ payload: { model: "test" } }, ctx);
	await mock.events.get("message_end")?.[0]?.(
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }],
				provider: "test",
				model: "test",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
			},
		},
		ctx,
	);
	const generation = backend.observations.at(-1);
	assert.equal(generation?.name, "pi.llm");
	assert.equal(generation?.ended, false);
	await mock.events.get("tool_execution_start")?.[0]?.(
		{
			toolCallId: "call-1",
			toolName: "edit",
			args: { path: "file.ts", oldText: "old", newText: "new" },
		},
		ctx,
	);
	await mock.events.get("tool_result")?.[0]?.(
		{
			toolCallId: "call-1",
			toolName: "edit",
			input: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] },
			content: [{ type: "text", text: "intermediate" }],
			details: { stage: "intermediate" },
			isError: false,
		},
		ctx,
	);
	await mock.events.get("tool_execution_end")?.[0]?.(
		{
			toolCallId: "call-1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "final" }],
				details: { stage: "final" },
			},
			isError: false,
		},
		ctx,
	);
	await mock.events.get("turn_end")?.[0]?.(
		{
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }],
				provider: "test",
				model: "test",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
			},
			toolResults: [],
		},
		ctx,
	);

	assert.equal(generation?.ended, true);
	assert.equal(typeof generation?.endTime, "number");
	const tool = backend.observations.at(-1);
	assert.equal(backend.observations[2]?.name, "pi.turn");
	assert.equal(tool?.parent, backend.observations[2]);
	assert.equal(tool?.attributes.input, undefined);
	assert.deepEqual(tool?.updates.find((update) => update.input !== undefined)?.input, {
		path: "file.ts",
		edits: [{ oldText: "old", newText: "new" }],
	});
	assert.deepEqual(tool?.updates.at(-1)?.output, {
		content: [{ type: "text", text: "final" }],
		details: { stage: "final" },
	});
});

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("sanitizeTraceValue globally bounds adversarial values in UTF-8 bytes", () => {
	const shared = { text: "repeated" };
	const circular: Record<string, unknown> = { label: "cycle" };
	circular.self = circular;
	const value = {
		manyKeys: Object.fromEntries(
			Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, "🪢".repeat(100)]),
		),
		nested: Array.from({ length: 300 }, () => ["界".repeat(1_000)]),
		sharedA: shared,
		sharedB: shared,
		circular,
	};

	const sanitized = sanitizeTraceValue(value);
	assert.ok(serializedBytes(sanitized) <= MAX_CAPTURE_BYTES);
	assert.match(JSON.stringify(sanitized), /truncated|omitted|circular/i);
	assert.deepEqual(sanitizeTraceValue({ first: shared, second: shared }), {
		first: { text: "repeated" },
		second: { text: "repeated" },
	});
	assert.match(JSON.stringify(sanitizeTraceValue(circular)), /circular/i);
	assert.deepEqual(
		sanitizeTraceValue({
			imageUrl: "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==",
			parameterizedImageUrl: "data:image/svg+xml;charset=utf-8;base64,cHJpdmF0ZS1pbWFnZQ==",
			embeddedDataUri:
				"example: data:application/octet-stream;base64,not-valid%%% should not be parsed",
		}),
		{
			imageUrl: "[base64 data URI omitted]",
			parameterizedImageUrl: "[base64 data URI omitted]",
			embeddedDataUri: "example: [base64 data URI omitted] should not be parsed",
		},
	);
});

test("sanitizeTraceValue bounds string work before redaction and UTF-8 sizing", () => {
	const originalByteLength = Buffer.byteLength;
	const originalReplace = RegExp.prototype[Symbol.replace];
	Buffer.byteLength = ((value: unknown, encoding?: BufferEncoding) => {
		if (typeof value === "string") {
			assert.ok(
				value.length <= MAX_CAPTURE_BYTES,
				"sanitizer scanned the complete oversized string",
			);
		}
		return Reflect.apply(originalByteLength, Buffer, [value, encoding]) as number;
	}) as typeof Buffer.byteLength;
	RegExp.prototype[Symbol.replace] = function (this: RegExp, value: string, replacement: unknown) {
		assert.ok(
			value.length <= MAX_CAPTURE_BYTES,
			"sanitizer redacted the complete oversized string",
		);
		return Reflect.apply(originalReplace, this, [value, replacement]) as string;
	} as (typeof RegExp.prototype)[typeof Symbol.replace];

	try {
		const sanitized = sanitizeTraceValue(
			`data:text/plain;base64,${"a".repeat(MAX_CAPTURE_BYTES * 4)}`,
		);
		assert.match(String(sanitized), /base64 data URI omitted|truncated/i);
	} finally {
		Buffer.byteLength = originalByteLength;
		RegExp.prototype[Symbol.replace] = originalReplace;
	}
});

test("sanitizeTraceValue stops enumerating object properties at the collection cap", () => {
	const value = Object.fromEntries(
		Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, `value-${index}`]),
	);
	const originalKeys = Object.keys;
	Object.keys = ((target: object) => {
		assert.notEqual(target, value, "sanitizer materialized every source key");
		return originalKeys(target);
	}) as typeof Object.keys;

	try {
		const sanitized = sanitizeTraceValue(value);
		assert.match(JSON.stringify(sanitized), /object entries omitted/i);
	} finally {
		Object.keys = originalKeys;
	}
});

test("sanitizeTraceValue bounds inherited enumerable property scans", () => {
	const prototype = Object.fromEntries(
		Array.from({ length: 1_000 }, (_, index) => [`inherited-${index}`, `value-${index}`]),
	);
	const value = Object.create(prototype) as Record<string, unknown>;
	const originalHasOwn = Object.hasOwn;
	let propertyChecks = 0;
	Object.hasOwn = ((target: object, key: PropertyKey) => {
		if (target === value) {
			propertyChecks += 1;
			assert.ok(propertyChecks <= 200, "sanitizer scanned beyond inherited property limits");
		}
		return originalHasOwn(target, key);
	}) as typeof Object.hasOwn;

	try {
		assert.deepEqual(sanitizeTraceValue(value), {
			$truncated: "additional object entries omitted",
		});
	} finally {
		Object.hasOwn = originalHasOwn;
	}
});

test("sanitizeTraceValue omits object keys larger than the remaining budget", () => {
	const oversizedKey = "k".repeat(MAX_CAPTURE_BYTES * 4);
	const sanitized = sanitizeTraceValue({ [oversizedKey]: "secret" });

	assert.deepEqual(sanitized, { $truncated: "additional object entries omitted" });
	assert.ok(serializedBytes(sanitized) <= MAX_CAPTURE_BYTES);
});

test("sanitizeTraceValue contains malformed object values", () => {
	const invalidDate = new Date(Number.NaN);
	const value = {
		before: "kept",
		invalidDate,
		get inaccessible() {
			throw new Error("getter failed");
		},
		source: {
			type: "base64",
			mediaType: "image/png",
			get data() {
				throw new Error("base64 getter failed");
			},
		},
		after: "also kept",
	};

	assert.deepEqual(sanitizeTraceValue(value), {
		before: "kept",
		invalidDate: "[invalid date]",
		inaccessible: "[unreadable property]",
		source: { type: "base64", mediaType: "image/png", data: "[base64 omitted]" },
		after: "also kept",
	});
});

test("TraceRecorder bounds oversized tool details as one captured output", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "test" });
	recorder.beginTool("call", "read", {
		paths: Array.from({ length: 500 }, () => "界".repeat(500)),
	});
	recorder.finishTool("call", {
		content: "🪢".repeat(100_000),
		details: Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`detail-${index}`, "value".repeat(500)]),
		),
	});

	const tool = backend.observations[2];
	assert.ok(serializedBytes(tool?.attributes.input) <= MAX_CAPTURE_BYTES);
	assert.ok(serializedBytes(tool?.updates.at(-1)?.output) <= MAX_CAPTURE_BYTES);
});

test("configuration covers malformed JSON, normalization, and captureContent false", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-invalid-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pi-langfuse.json");
	await writeFile(path, "{broken", { mode: 0o600 });
	const malformed = await loadLangfuseConfig(path);
	assert.equal(malformed.ok, false);
	if (!malformed.ok) assert.match(malformed.reason, /failed to read/i);

	assert.deepEqual(
		normalizeLangfuseConfig({ publicKey: " pk ", secretKey: " sk ", baseUrl: "https://x.test///" }),
		{
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://x.test",
				captureContent: true,
			},
		},
	);
	for (const baseUrl of [
		"ftp://x",
		"https://user:password@x.test",
		"https://x.test?token=private",
		"https://x.test#private",
	]) {
		assert.equal(
			normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", baseUrl }).ok,
			false,
			baseUrl,
		);
	}
	assert.deepEqual(
		normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", captureContent: false }),
		{
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://us.cloud.langfuse.com",
				captureContent: false,
			},
		},
	);

	await writeFile(path, JSON.stringify({ publicKey: "pk", secretKey: "sk" }), { mode: 0o600 });
	await chmod(path, 0o644);
	const repaired = await loadLangfuseConfig(path);
	assert.deepEqual(repaired.warnings, [`Restricted ${path} permissions to 0600.`]);
});

test("/langfuse shows enabled current-session state and context-aware next actions", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-private-value",
				secretKey: "sk-private-value",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const { ctx } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			selectCalls.push({ title, options });
			return undefined;
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const command = mock.commands.get("langfuse");

	await command?.handler("legacy arguments are ignored", ctx);

	assert.equal(command?.getArgumentCompletions, undefined);
	assert.match(selectCalls[0]?.title ?? "", /Current session:\n {2}Tracing: enabled/);
	assert.match(selectCalls[0]?.title ?? "", /Endpoint: https:\/\/example\.test/);
	assert.match(selectCalls[0]?.title ?? "", /Content capture: enabled/);
	assert.match(selectCalls[0]?.title ?? "", /Configuration: \/private\/pi-langfuse\.json/);
	assert.match(selectCalls[0]?.title ?? "", /this Pi agent directory.*restart each Pi process/i);
	assert.deepEqual(selectCalls[0]?.options, [
		"Flush completed traces for this session",
		"Update Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
	assert.doesNotMatch(selectCalls[0]?.title ?? "", /private-value/);
});

test("/langfuse routes the current-session flush action and waits for export", async () => {
	const backend = new FakeBackend();
	let releaseFlush: (() => void) | undefined;
	backend.forceFlush = () =>
		new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Flush completed traces for this session",
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	const flush = mock.commands.get("langfuse")?.handler("flush", ctx) as Promise<void>;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		notifications.some(({ message }) => /flushed/.test(message)),
		false,
	);
	releaseFlush?.();
	await flush;
	assert.match(notifications.at(-1)?.message ?? "", /flushed/i);
});

test("/langfuse does not apply a pending menu choice after the session changes", async () => {
	const firstBackend = new FakeBackend();
	const secondBackend = new FakeBackend();
	const backends = [firstBackend, secondBackend];
	let choose: ((choice: string) => void) | undefined;
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backends.shift() ?? secondBackend,
	})(mock.pi);
	const { ctx } = createMockContext({
		hasUI: true,
		select: async () =>
			new Promise<string>((resolve) => {
				choose = resolve;
			}),
	});
	const sessionStart = mock.events.get("session_start")?.[0];
	await sessionStart?.({}, ctx);
	const pending = mock.commands.get("langfuse")?.handler("", ctx) as Promise<void>;
	await new Promise((resolve) => setImmediate(resolve));

	await sessionStart?.({}, ctx);
	assert.ok(choose);
	choose("Flush completed traces for this session");
	await pending;

	assert.equal(firstBackend.flushes, 0);
	assert.equal(secondBackend.flushes, 0);
});

test("/langfuse redacts configured keys from flush failures", async () => {
	const backend = new FakeBackend();
	backend.forceFlush = async () => {
		throw new Error("flush exposed pk-private-ui and sk-private-ui");
	};
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-private-ui",
				secretKey: "sk-private-ui",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Flush completed traces for this session",
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("", ctx);

	const message = notifications.at(-1)?.message ?? "";
	assert.match(message, /flush exposed/);
	assert.match(message, /LANGFUSE_KEY_REDACTED/);
	assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/langfuse disabled state prioritizes agent-directory setup and routes privacy help", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/config/pi-langfuse.json",
			warnings: [],
			reason: "Configuration file not found: /config/pi-langfuse.json",
		}),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			selectCalls.push({ title, options });
			return "Show setup and privacy help";
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("status", ctx);

	assert.match(selectCalls[0]?.title ?? "", /Current session:\n {2}Tracing: disabled/);
	assert.match(selectCalls[0]?.title ?? "", /Configuration file not found/);
	assert.deepEqual(selectCalls[0]?.options, [
		"Set up Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
	assert.match(notifications.at(-1)?.message ?? "", /trace content may contain/i);
	assert.match(notifications.at(-1)?.message ?? "", /\/config\/pi-langfuse\.json/);
});

test("/langfuse interactively creates and updates a private agent-directory config", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-init-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "nested", "pi-langfuse.json");
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: (requestedPath = path) => loadLangfuseConfig(requestedPath),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const session = createMockContext({ hasUI: false });
	await mock.events.get("session_start")?.[0]?.({}, session.ctx);
	const command = mock.commands.get("langfuse");
	const notifications: Array<{ message: string; level?: string }> = [];
	const prompts: Array<{ title: string; placeholder?: string }> = [];
	const menuTitles: string[] = [];
	const answers = ["sk-new", "pk-new", ""];
	const selections = [
		"Set up Langfuse for this Pi agent directory (restart required)",
		"Update Langfuse for this Pi agent directory (restart required)",
	];
	const ctx = {
		hasUI: true,
		ui: {
			select: async (title: string) => {
				menuTitles.push(title);
				return selections.shift();
			},
			input: async (title: string, placeholder?: string) => {
				prompts.push({ title, placeholder });
				return answers.shift();
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	};

	await command?.handler("init", ctx);

	assert.deepEqual(
		prompts.slice(0, 3).map(({ title }) => title),
		[
			"Langfuse secret key (leave blank to keep existing):",
			"Langfuse public key (leave blank to keep existing):",
			"Langfuse base URL (leave blank for default https://us.cloud.langfuse.com):",
		],
	);
	assert.equal(prompts[2]?.placeholder, "https://us.cloud.langfuse.com");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		publicKey: "pk-new",
		secretKey: "sk-new",
		baseUrl: "https://us.cloud.langfuse.com",
		captureContent: true,
	});
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.match(
		notifications.at(-1)?.message ?? "",
		/this Pi agent directory.*restart each Pi process/i,
	);
	assert.equal(notifications.at(-1)?.level, "info");

	answers.push("", "", "https://self-hosted.example/");
	await command?.handler("anything", ctx);
	assert.match(menuTitles[1] ?? "", /State: tracing remains disabled until Pi restarts/i);
	assert.match(
		menuTitles[1] ?? "",
		/Pending: Saved; restart each Pi process to use it in subsequent sessions/i,
	);
	assert.doesNotMatch(menuTitles[1] ?? "", /Reason:|Configuration file not found/);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		publicKey: "pk-new",
		secretKey: "sk-new",
		baseUrl: "https://self-hosted.example",
		captureContent: true,
	});
});

test("/langfuse keeps an active session on its original connection after an update", async () => {
	const backend = new FakeBackend();
	const originalConfig = {
		publicKey: "pk-original",
		secretKey: "sk-original",
		baseUrl: "https://original.example",
		captureContent: true,
	};
	let backendCreations = 0;
	let savedConfig: unknown;
	const menuCalls: Array<{ title: string; options: string[] }> = [];
	const selections = ["Update Langfuse for this Pi agent directory (restart required)", undefined];
	const answers = ["sk-updated", "pk-updated", "https://updated.example"];
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: originalConfig,
			path: "/private/pi-langfuse.json",
			warnings: [],
		}),
		writeConfig: async (config) => {
			savedConfig = config;
			return config;
		},
		createBackend: async () => {
			backendCreations += 1;
			return backend;
		},
	})(mock.pi);
	const { ctx } = createMockContext({
		hasUI: true,
		select: async (title: string, options: string[]) => {
			menuCalls.push({ title, options });
			return selections.shift();
		},
		input: async () => answers.shift(),
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const command = mock.commands.get("langfuse");

	await command?.handler("", ctx);
	await command?.handler("", ctx);

	assert.deepEqual(savedConfig, {
		publicKey: "pk-updated",
		secretKey: "sk-updated",
		baseUrl: "https://updated.example",
		captureContent: true,
	});
	assert.equal(backendCreations, 1);
	assert.match(menuCalls[1]?.title ?? "", /Endpoint: https:\/\/original\.example/);
	assert.match(menuCalls[1]?.title ?? "", /Content capture: enabled/);
	assert.match(menuCalls[1]?.title ?? "", /Pending: Saved; restart each Pi process/i);
	assert.deepEqual(menuCalls[1]?.options, [
		"Flush completed traces for this session",
		"Update Langfuse for this Pi agent directory (restart required)",
		"Show setup and privacy help",
	]);
});

test("/langfuse redacts entered keys from configuration save failures", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/private/pi-langfuse.json",
			warnings: [],
			reason: "missing",
		}),
		writeConfig: async (config) => {
			throw new Error(`write exposed ${config.publicKey} and ${config.secretKey}`);
		},
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const answers = ["sk-private-ui", "pk-private-ui", "https://example.test"];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		select: async () => "Set up Langfuse for this Pi agent directory (restart required)",
		input: async () => answers.shift(),
	});
	await mock.events.get("session_start")?.[0]?.({}, ctx);

	await mock.commands.get("langfuse")?.handler("", ctx);

	const message = notifications.at(-1)?.message ?? "";
	assert.match(message, /write exposed/);
	assert.match(message, /LANGFUSE_KEY_REDACTED/);
	assert.doesNotMatch(message, /pk-private-ui|sk-private-ui/);
});

test("/langfuse ignores arguments but requires interactive UI", async () => {
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: false,
			path: "/config/pi-langfuse.json",
			warnings: [],
			reason: "missing",
		}),
		createBackend: async () => new FakeBackend(),
	})(mock.pi);
	const { ctx, notifications } = createMockContext({ hasUI: false });
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.commands.get("langfuse")?.handler("flush", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /requires interactive UI/i);
	assert.match(notifications.at(-1)?.message ?? "", /Current session tracing: disabled/i);
	assert.match(notifications.at(-1)?.message ?? "", /\/config\/pi-langfuse\.json/);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("agent_end leaves the conversation open and settled never starts a routine flush", async () => {
	const backend = new FakeBackend();
	backend.forceFlush = () => new Promise<void>(() => undefined);
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/config.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx } = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "hello", images: [], systemPrompt: "system" },
		ctx,
	);
	await Promise.race([
		mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx),
		new Promise((_, reject) => setTimeout(() => reject(new Error("agent_end blocked")), 50)),
	]);
	assert.equal(
		backend.observations.every((observation) => observation.ended),
		false,
	);

	await Promise.race([
		mock.events.get("agent_settled")?.[0]?.({}, ctx),
		new Promise((_, reject) => setTimeout(() => reject(new Error("agent_settled blocked")), 50)),
	]);
	assert.equal(
		backend.observations.every((observation) => observation.ended),
		true,
	);
	assert.equal(backend.flushes, 0);
});

test("session shutdown is idempotent and reports initialization failures", async () => {
	const backend = new FakeBackend();
	const mock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk",
				secretKey: "sk",
				baseUrl: "https://example.test",
				captureContent: false,
			},
			path: "/config.json",
			warnings: [],
		}),
		createBackend: async () => backend,
	})(mock.pi);
	const { ctx } = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	assert.equal(backend.shutdowns, 1);

	const failedMock = createMockPi();
	createLangfuseExtension({
		loadConfig: async () => ({
			ok: true,
			config: {
				publicKey: "pk-private-ui",
				secretKey: "sk-private-ui",
				baseUrl: "https://example.test",
				captureContent: true,
			},
			path: "/config.json",
			warnings: [],
		}),
		createBackend: async () => {
			throw new Error("backend unavailable for pk-private-ui and sk-private-ui");
		},
	})(failedMock.pi);
	const failed = createMockContext();
	await failedMock.events.get("session_start")?.[0]?.({}, failed.ctx);
	const failureMessage = failed.notifications.at(-1)?.message ?? "";
	assert.match(failureMessage, /backend unavailable/);
	assert.match(failureMessage, /LANGFUSE_KEY_REDACTED/);
	assert.doesNotMatch(failureMessage, /pk-private-ui|sk-private-ui/);
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
	recorder.beginTurn(0);
	recorder.beginGeneration();
	recorder.finishAssistant({ role: "assistant", content: "world", stopReason: "toolUse" });
	recorder.beginTool("call", "read", { path: "file" });
	recorder.finishTool("call", { content: "content" });
	recorder.finishTurn(0, {
		message: { role: "assistant", stopReason: "toolUse" },
		toolResultCount: 1,
	});
	recorder.settle();
	await recorder.flush();

	const spans = exporter.getFinishedSpans();
	assert.deepEqual(spans.map((span) => span.attributes["langfuse.observation.type"]).sort(), [
		"agent",
		"generation",
		"span",
		"span",
		"tool",
	]);
	const conversation = spans.find((span) => span.name === "pi.conversation");
	const agent = spans.find((span) => span.name === "pi.agent");
	const turn = spans.find((span) => span.name === "pi.turn");
	assert.equal(conversation?.parentSpanContext, undefined);
	assert.equal(agent?.parentSpanContext?.spanId, conversation?.spanContext().spanId);
	assert.equal(turn?.parentSpanContext?.spanId, agent?.spanContext().spanId);
	for (const child of spans.filter((span) => ["pi.llm", "pi.tool.read"].includes(span.name))) {
		assert.equal(child.parentSpanContext?.spanId, turn?.spanContext().spanId);
	}
	await backend.shutdown();
	await backend.shutdown();
	await existingGlobalProvider.shutdown();
});
