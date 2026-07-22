import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CAPTURE_BYTES, TraceRecorder } from "../src/tracing.js";
import { FakeBackend, serializedBytes } from "./support.js";

test("TraceRecorder uses the agent as the root trace observation", async () => {
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
		git: {
			branch: "feature/langfuse-context",
			commit: "0123456789ab",
			detached: false,
		},
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

	assert.equal(backend.observations.length, 3);
	const [agent, generation, tool] = backend.observations;
	assert.equal(agent?.name, "pi.agent");
	assert.equal(agent?.type, "agent");
	assert.equal(agent?.parent, undefined);
	assert.deepEqual(agent?.traceUpdates[0], {
		name: "pi.trace",
		sessionId: "session-1",
		version: "2",
		input: { prompt: "Fix the test" },
		metadata: agent?.attributes.metadata,
		tags: ["pi", "branch:feature/langfuse-context"],
	});
	assert.deepEqual(agent?.attributes.input, { prompt: "Fix the test" });
	assert.deepEqual(agent?.attributes.metadata, {
		"pi.cwd": "/workspace",
		"pi.git.branch": "feature/langfuse-context",
		"pi.git.commit": "0123456789ab",
		"pi.git.detached": false,
		"pi.mode": "tui",
		"pi.model": "claude",
		"pi.provider": "anthropic",
		"pi.session.id": "session-1",
		"pi.trace.schema_version": 2,
	});
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

	assert.equal(backend.observations[1]?.updates.at(-1)?.costDetails, undefined);
	assert.deepEqual(backend.observations[2]?.updates.at(-1)?.costDetails, { total: 0.01 });
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

	assert.equal(backend.observations[1]?.updates.at(-1)?.model, "concrete-model");
	assert.deepEqual(backend.observations[1]?.updates.at(-1)?.metadata, {
		"pi.provider": "openai",
		"pi.requested_model": "requested-alias",
		"pi.response.model": "concrete-model",
		"pi.response.provider": "openai",
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
	recorder.beginAgent({
		prompt: "private prompt",
		git: { commit: "abcdef012345", detached: true },
	});
	recorder.beginGeneration();
	recorder.finishAssistant({ role: "assistant", content: "private response" });
	recorder.beginTool("call", "read", { path: "private path" });
	recorder.finishTool("call", { content: "private content", details: "private details" });
	recorder.settle();

	for (const observation of backend.observations) {
		if (observation.name === "pi.llm") assert.equal(observation.attributes.input, undefined);
		else assert.equal(observation.attributes.input, "[content capture disabled]");
		if (observation.name === "pi.agent") {
			assert.equal(observation.attributes.metadata?.["pi.git.commit"], "abcdef012345");
			assert.equal(observation.attributes.metadata?.["pi.git.detached"], true);
		}
		for (const update of observation.updates) {
			if (update.output !== undefined) {
				assert.equal(update.output, "[content capture disabled]");
			}
		}
	}
	assert.deepEqual(backend.observations[0]?.traceUpdates[0]?.tags, ["pi", "git:detached"]);
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

	const [agent, firstGeneration, secondGeneration, tool] = backend.observations;
	assert.deepEqual(agent?.attributes.input, {
		images: [{ type: "image", mimeType: "image/png", data: "[base64 omitted]" }],
		prompt: "Describe this",
	});
	assert.equal(firstGeneration?.updates.at(-1)?.level, "ERROR");
	assert.match(String(firstGeneration?.updates.at(-1)?.statusMessage), /interrupted/i);
	assert.equal(firstGeneration?.ended, true);
	assert.equal(secondGeneration?.ended, true);
	assert.equal(tool?.updates.at(-1)?.level, "ERROR");
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

	const tool = backend.observations[1];
	assert.ok(serializedBytes(tool?.attributes.input) <= MAX_CAPTURE_BYTES);
	assert.ok(serializedBytes(tool?.updates.at(-1)?.output) <= MAX_CAPTURE_BYTES);
});

test("TraceRecorder keeps retries in one trace with indexed attempt spans and root aggregates", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({
		prompt: "recover",
		snapshot: {
			leafId: "start-leaf",
			contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
		},
	});
	recorder.beginAttempt();
	recorder.beginTurn(0);
	recorder.beginGeneration({ payload: { attempt: 1 }, payloadStage: "before_provider_request" });
	recorder.finishAssistant({
		role: "assistant",
		content: "retry",
		stopReason: "error",
		errorMessage: "temporary model failure",
	});
	recorder.finishTurn(0, {
		message: { role: "assistant", stopReason: "error", errorMessage: "temporary model failure" },
		toolResultCount: 0,
	});
	recorder.finishAttempt({
		role: "assistant",
		content: "retry",
		stopReason: "error",
		errorMessage: "temporary model failure",
	});

	recorder.beginAttempt({ reason: "post_compaction" });
	recorder.beginTurn(0);
	recorder.beginGeneration({ payload: { attempt: 2 }, payloadStage: "before_provider_request" });
	recorder.finishAssistant({ role: "assistant", content: "done", stopReason: "stop" });
	recorder.finishTurn(0, {
		message: { role: "assistant", stopReason: "stop" },
		toolResultCount: 0,
	});
	recorder.finishAttempt({ role: "assistant", content: "done", stopReason: "stop" });
	recorder.settle({
		leafId: "end-leaf",
		contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
	});

	const agent = backend.observations.find(({ name }) => name === "pi.agent");
	const attempts = backend.observations.filter(({ name }) => name === "pi.attempt");
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0]?.parent, agent);
	assert.equal(attempts[1]?.parent, agent);
	assert.equal(attempts[0]?.attributes.metadata?.["pi.attempt.index"], 0);
	assert.equal(attempts[1]?.attributes.metadata?.["pi.attempt.index"], 1);
	assert.equal(attempts[1]?.attributes.metadata?.["pi.attempt.reason"], "post_compaction");
	assert.equal(attempts[0]?.updates.at(-1)?.level, "ERROR");
	assert.equal(attempts[0]?.updates.at(-1)?.metadata?.["pi.attempt.outcome"], "error");
	assert.equal(attempts[0]?.updates.at(-1)?.metadata?.["pi.attempt.stop_reason"], "error");
	assert.equal(attempts[1]?.updates.at(-1)?.level, undefined);
	assert.equal(attempts[1]?.updates.at(-1)?.metadata?.["pi.attempt.outcome"], "success");
	assert.equal(attempts[1]?.updates.at(-1)?.metadata?.["pi.attempt.stop_reason"], "stop");
	assert.equal(agent?.attributes.version, "2");
	const finalMetadata = agent?.updates.at(-1)?.metadata;
	assert.equal(finalMetadata?.["pi.trace.outcome"], "recovered_success");
	assert.equal(finalMetadata?.["pi.trace.attempt_count"], 2);
	assert.equal(finalMetadata?.["pi.trace.turn_count"], 2);
	assert.equal(finalMetadata?.["pi.trace.generation_count"], 2);
	assert.equal(finalMetadata?.["pi.trace.tool_count"], 0);
	assert.equal(finalMetadata?.["pi.trace.tool_error_count"], 0);
	assert.equal(finalMetadata?.["pi.trace.compaction_count"], 0);
	assert.equal(finalMetadata?.["pi.trace.recovered_error_count"], 1);
	assert.equal(finalMetadata?.["pi.trace.stop_reason"], "stop");
	assert.equal(finalMetadata?.["pi.trace.start_leaf_id"], "start-leaf");
	assert.equal(finalMetadata?.["pi.trace.end_leaf_id"], "end-leaf");
	assert.equal(finalMetadata?.["pi.trace.start_context_tokens"], 100);
	assert.equal(finalMetadata?.["pi.trace.end_context_tokens"], 250);
	assert.equal(finalMetadata?.["pi.trace.start_context_window"], 1_000);
	assert.equal(finalMetadata?.["pi.trace.end_context_window"], 1_000);
	assert.equal(finalMetadata?.["pi.trace.start_context_percent"], 10);
	assert.equal(finalMetadata?.["pi.trace.end_context_percent"], 25);
	assert.deepEqual(agent?.traceUpdates.at(-1)?.metadata, finalMetadata);
	assert.equal(agent?.endCalls, 1);
	assert.equal(
		backend.observations.every(({ endCalls }) => endCalls === 1),
		true,
	);
});

test("TraceRecorder exports recovered HTTP diagnostics and native generation detail", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "test" });
	recorder.beginAttempt();
	recorder.beginTurn(0);
	recorder.beginGeneration({
		payload: {
			messages: [{ role: "user", content: "hello", textSignature: "opaque" }],
		},
		payloadStage: "before_provider_request",
		model: { provider: "openai", id: "requested-alias", api: "openai-responses" },
		thinkingLevel: "high",
	});
	recorder.recordProviderResponse(429, {
		authorization: "secret",
		"retry-after": "1",
		"x-request-id": "request-1",
	});
	recorder.recordProviderResponse(200, {
		"set-cookie": "private",
		"x-ratelimit-remaining-requests": "99",
		"x-request-id": "request-2",
	});
	recorder.markGenerationFirstOutput(1_250);
	recorder.markGenerationFirstOutput(2_000);
	recorder.finishAssistant({
		role: "assistant",
		content: [{ type: "text", text: "done", textSignature: "opaque-response" }],
		provider: "openai",
		api: "openai-responses",
		model: "requested-alias",
		responseModel: "concrete-model",
		responseId: "response-1",
		usage: {
			input: 10,
			output: 8,
			cacheRead: 3,
			cacheWrite: 2,
			cacheWrite1h: 1,
			reasoning: 4,
			totalTokens: 23,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.037,
			},
		},
		stopReason: "stop",
	});
	const generation = backend.observations.find(({ name }) => name === "pi.llm");
	assert.deepEqual(generation?.attributes.input, {
		messages: [{ role: "user", content: "hello" }],
	});
	assert.deepEqual(generation?.attributes.modelParameters, { thinking_level: "high" });
	assert.equal(generation?.updates.at(-1)?.completionStartTime?.getTime(), 1_250);
	assert.equal(generation?.updates.at(-1)?.model, "concrete-model");
	assert.deepEqual(generation?.updates.at(-1)?.output, [{ type: "text", text: "done" }]);
	assert.deepEqual(generation?.updates.at(-1)?.usageDetails, {
		cache_creation_input_tokens: 2,
		cache_read_input_tokens: 3,
		input: 10,
		output: 8,
		total: 23,
	});
	assert.deepEqual(generation?.updates.at(-1)?.costDetails, {
		cache_read: 0.003,
		cache_write: 0.004,
		input: 0.01,
		output: 0.02,
		total: 0.037,
	});
	const metadata = generation?.updates.at(-1)?.metadata;
	assert.equal(metadata?.["pi.request.payload_stage"], "before_provider_request");
	assert.equal(metadata?.["pi.request.provider"], "openai");
	assert.equal(metadata?.["pi.request.model"], "requested-alias");
	assert.equal(metadata?.["pi.request.api"], "openai-responses");
	assert.equal(metadata?.["pi.request.thinking_level"], "high");
	assert.equal(metadata?.["pi.response.provider"], "openai");
	assert.equal(metadata?.["pi.response.api"], "openai-responses");
	assert.equal(metadata?.["pi.response.model"], "concrete-model");
	assert.equal(metadata?.["pi.response.id"], "response-1");
	assert.deepEqual(metadata?.["http.response.status_codes"], [429, 200]);
	assert.equal(metadata?.["http.response.status_code"], 200);
	assert.equal(metadata?.["http.response.attempt_count"], 2);
	assert.equal(metadata?.["http.response.retry_count"], 1);
	assert.deepEqual(metadata?.["http.response.headers"], {
		"retry-after": "1",
		"x-ratelimit-remaining-requests": "99",
		"x-request-id": "request-2",
	});
	assert.equal(metadata?.["pi.usage.reasoning_tokens"], 4);
	assert.equal(metadata?.["pi.usage.cache_write_1h_tokens"], 1);
	assert.equal(
		generation?.updates.some(({ level }) => level === "ERROR"),
		false,
	);
	recorder.finishTurn(0, {
		message: { role: "assistant", stopReason: "stop" },
		toolResultCount: 0,
	});
	recorder.finishAttempt({ role: "assistant", content: "done", stopReason: "stop" });
	recorder.settle();
	assert.equal(
		backend.observations[0]?.updates.at(-1)?.metadata?.["pi.trace.outcome"],
		"recovered_success",
	);
	assert.equal(
		backend.observations[0]?.updates.at(-1)?.metadata?.["pi.trace.recovered_error_count"],
		1,
	);
});

test("TraceRecorder records final tool args, progress timing, and bounded compaction structure", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "test" });
	recorder.beginAttempt();
	recorder.beginTool("call", "read", { path: "final.ts" }, 1_000);
	recorder.recordToolProgress("call", 1_025);
	recorder.recordToolProgress("call", 1_050);
	recorder.finishTool("call", { content: "done", isError: true });
	recorder.beginCompaction({
		reason: "overflow",
		willRetry: true,
		tokensBefore: 12_000,
		messagesToSummarize: 8,
		turnPrefixMessages: 2,
		branchEntries: 20,
		isSplitTurn: true,
	});
	recorder.finishCompaction({
		reason: "overflow",
		willRetry: true,
		fromExtension: false,
		tokensBefore: 12_000,
		details: { readFiles: ["secret-a", "secret-b"], modifiedFiles: ["secret-c"] },
		usage: {
			input: 5,
			output: 3,
			cost: { total: 0.01 },
		},
	});

	const tool = backend.observations.find(({ name }) => name === "pi.tool.read");
	assert.deepEqual(tool?.attributes.input, { path: "final.ts" });
	assert.equal(tool?.attributes.metadata?.["pi.tool.call_id"], "call");
	assert.equal(tool?.attributes.metadata?.["pi.tool.name"], "read");
	assert.equal(tool?.updates.at(-1)?.metadata?.["pi.tool.progress_update_count"], 2);
	assert.equal(tool?.updates.at(-1)?.metadata?.["pi.tool.time_to_first_progress_ms"], 25);
	const compaction = backend.observations.find(({ name }) => name === "pi.compaction");
	assert.equal(
		compaction?.parent,
		backend.observations.find(({ name }) => name === "pi.agent"),
	);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.reason"], "overflow");
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.will_retry"], true);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.tokens_before"], 12_000);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.messages_to_summarize"], 8);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.turn_prefix_messages"], 2);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.branch_entries"], 20);
	assert.equal(compaction?.attributes.metadata?.["pi.compaction.is_split_turn"], true);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.from_extension"], false);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.read_file_count"], 2);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.modified_file_count"], 1);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.usage.input"], 5);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.usage.output"], 3);
	assert.equal(compaction?.updates.at(-1)?.metadata?.["pi.compaction.cost.total"], 0.01);
	assert.equal(JSON.stringify(compaction).includes("secret-a"), false);
	assert.equal(compaction?.ended, true);

	recorder.finishAttempt({ role: "assistant", content: "done", stopReason: "stop" });
	recorder.settle();
	const rootMetadata = backend.observations[0]?.updates.at(-1)?.metadata;
	assert.equal(rootMetadata?.["pi.trace.outcome"], "error");
	assert.equal(rootMetadata?.["pi.trace.attempt_count"], 1);
	assert.equal(rootMetadata?.["pi.trace.tool_count"], 1);
	assert.equal(rootMetadata?.["pi.trace.tool_error_count"], 1);
	assert.equal(rootMetadata?.["pi.trace.compaction_count"], 1);
});

test("TraceRecorder reports a tool failure recovered by a later generation", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "recover tool" });
	recorder.beginAttempt();
	recorder.beginTool("call-1", "read", { path: "missing-1" });
	recorder.beginTool("call-2", "read", { path: "missing-2" });
	recorder.finishTool("call-1", { content: "missing", isError: true });
	recorder.finishTool("call-2", { content: "missing", isError: true });
	recorder.beginGeneration({ payload: { messages: [] } });
	recorder.finishAssistant({ role: "assistant", content: "handled", stopReason: "stop" });
	recorder.finishAttempt({ role: "assistant", content: "handled", stopReason: "stop" });
	recorder.settle();

	const metadata = backend.observations[0]?.updates.at(-1)?.metadata;
	assert.equal(metadata?.["pi.trace.outcome"], "recovered_success");
	assert.equal(metadata?.["pi.trace.tool_error_count"], 2);
	assert.equal(metadata?.["pi.trace.recovered_error_count"], 2);
});

test("TraceRecorder classifies terminal, repeated-success, and no-response generations", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "test" });

	recorder.beginGeneration({ payload: { path: "terminal" } });
	recorder.recordProviderResponse(500, { "x-request-id": "terminal" });
	recorder.finishAssistant({
		role: "assistant",
		content: "failed",
		stopReason: "error",
		errorMessage: "terminal failure",
	});

	recorder.beginGeneration({ payload: { path: "repeated-success" } });
	recorder.recordProviderResponse(200);
	recorder.recordProviderResponse(200);
	recorder.finishAssistant({ role: "assistant", content: "done", stopReason: "stop" });

	recorder.beginGeneration({ payload: { path: "no-response" } });
	recorder.finishAssistant({ role: "assistant", content: "local result", stopReason: "stop" });

	const generations = backend.observations.filter(({ name }) => name === "pi.llm");
	assert.equal(generations[0]?.updates.at(-1)?.level, "ERROR");
	assert.equal(generations[0]?.updates.at(-1)?.metadata?.["http.response.status_code"], 500);
	assert.equal(generations[1]?.updates.at(-1)?.level, undefined);
	assert.equal(generations[1]?.updates.at(-1)?.metadata?.["http.response.retry_count"], 1);
	assert.equal(generations[2]?.updates.at(-1)?.metadata?.["http.response.status_code"], undefined);
});

test("TraceRecorder distinguishes final error, aborted, length, and interrupted roots", () => {
	for (const [stopReason, expectedOutcome, expectedLevel] of [
		["error", "error", "ERROR"],
		["aborted", "aborted", "WARNING"],
		["length", "length", "WARNING"],
	] as const) {
		const backend = new FakeBackend();
		const recorder = new TraceRecorder(backend, {
			sessionId: "session",
			cwd: "/workspace",
			mode: "tui",
			captureContent: true,
		});
		recorder.beginAgent({ prompt: stopReason });
		recorder.beginAttempt();
		recorder.finishAttempt({
			role: "assistant",
			content: stopReason,
			stopReason,
			...(stopReason === "error" ? { errorMessage: "failed" } : {}),
		});
		recorder.settle();
		const root = backend.observations[0];
		assert.equal(root?.updates.at(-1)?.metadata?.["pi.trace.outcome"], expectedOutcome);
		assert.equal(root?.updates.at(-1)?.level, expectedLevel);
	}

	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "interrupted" });
	recorder.beginAttempt();
	recorder.interrupt("session replaced");
	assert.equal(
		backend.observations[0]?.updates.at(-1)?.metadata?.["pi.trace.outcome"],
		"interrupted",
	);
	assert.equal(backend.observations[0]?.updates.at(-1)?.level, "WARNING");
});

test("TraceRecorder closes duplicate, parallel, no-progress, and abrupt tools once", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});
	recorder.beginAgent({ prompt: "tools" });
	recorder.beginTool("duplicate", "read", { path: "first" }, 10);
	recorder.beginTool("duplicate", "write", { path: "second" }, 20);
	recorder.beginTool("parallel", "bash", { command: "true" }, 20);
	recorder.finishTool("duplicate", { content: "second completed first" });
	recorder.finishTool("duplicate", { content: "first completed second" });
	recorder.finishTool("parallel", { content: "done" });
	recorder.beginTool("abrupt", "write", { path: "x" }, 30);
	recorder.settle();

	const tools = backend.observations.filter(({ type }) => type === "tool");
	assert.equal(tools.length, 4);
	assert.equal(
		tools.every(({ endCalls }) => endCalls === 1),
		true,
	);
	assert.equal(tools[0]?.updates.at(-1)?.level, "ERROR");
	assert.equal(tools[1]?.updates.at(-1)?.level, "ERROR");
	assert.equal(JSON.stringify(tools.slice(0, 2)).includes("completed"), false);
	assert.equal(tools[2]?.updates.at(-1)?.metadata?.["pi.tool.progress_update_count"], 0);
	assert.equal(
		tools[2]?.updates.at(-1)?.metadata?.["pi.tool.time_to_first_progress_ms"],
		undefined,
	);
	assert.equal(tools[3]?.updates.at(-1)?.level, "WARNING");
});

test("TraceRecorder omits generation request content when capture is disabled", () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session",
		cwd: "/workspace",
		mode: "tui",
		captureContent: false,
	});
	recorder.beginAgent({ prompt: "private" });
	recorder.beginGeneration({
		payload: { messages: [{ content: "private wire snapshot" }] },
		payloadStage: "before_provider_request",
		model: { provider: "openai", id: "model", api: "openai-responses" },
	});
	assert.equal(
		backend.observations.find(({ name }) => name === "pi.llm")?.attributes.input,
		"[content capture disabled]",
	);
});
