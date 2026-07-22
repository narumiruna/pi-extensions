import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createLangfuseExtension, resolveGitMetadata } from "../src/langfuse.js";
import { FakeBackend } from "./support.js";

test("resolveGitMetadata captures branch and commit with bounded non-shell commands", async () => {
	const calls: Array<{ command: string; args: string[]; cwd?: string; timeout?: number }> = [];
	const metadata = await resolveGitMetadata(async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd, timeout: options?.timeout });
		if (args[0] === "symbolic-ref") {
			return {
				stdout: "feature/langfuse-context\n",
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		return { stdout: "0123456789ab\n", stderr: "", code: 0, killed: false };
	}, "/workspace");

	assert.deepEqual(metadata, {
		branch: "feature/langfuse-context",
		commit: "0123456789ab",
		detached: false,
	});
	assert.deepEqual(calls, [
		{
			command: "git",
			args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
			cwd: "/workspace",
			timeout: 1_000,
		},
		{
			command: "git",
			args: ["rev-parse", "--verify", "--short=12", "HEAD"],
			cwd: "/workspace",
			timeout: 1_000,
		},
	]);
});

test("resolveGitMetadata handles detached HEADs and omits unavailable repositories", async () => {
	const detached = await resolveGitMetadata(async (_command, args) => {
		if (args[0] === "symbolic-ref") {
			return { stdout: "", stderr: "", code: 1, killed: false };
		}
		return { stdout: "abcdef012345\n", stderr: "", code: 0, killed: false };
	}, "/detached");
	assert.deepEqual(detached, { commit: "abcdef012345", detached: true });

	const unavailable = await resolveGitMetadata(async () => {
		return { stdout: "", stderr: "not a repository", code: 128, killed: false };
	}, "/outside");
	assert.equal(unavailable, undefined);

	const failed = await resolveGitMetadata(async () => {
		throw new Error("git is unavailable");
	}, "/missing-git");
	assert.equal(failed, undefined);
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
		resolveGitMetadata: async (cwd) => {
			assert.equal(cwd, "/workspace");
			return {
				branch: "feature/lifecycle",
				commit: "fedcba987654",
				detached: false,
			};
		},
	});
	extension(mock.pi);

	assert.ok(mock.commands.has("langfuse"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"after_provider_response",
		"agent_end",
		"agent_settled",
		"agent_start",
		"before_agent_start",
		"before_provider_request",
		"message_end",
		"message_update",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"session_start",
		"tool_call",
		"tool_execution_end",
		"tool_execution_start",
		"tool_execution_update",
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
	await mock.events.get("agent_start")?.[0]?.({}, ctx);
	const finalPayload = {
		model: "claude",
		system: "system after modifiers",
		messages: [{ role: "user", content: "Hello after context filters" }],
	};
	await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);
	await mock.events.get("before_provider_request")?.[0]?.({ payload: finalPayload }, ctx);
	await mock.events.get("after_provider_response")?.[0]?.(
		{ status: 429, headers: { authorization: "secret", "retry-after": "1" } },
		ctx,
	);
	await mock.events.get("after_provider_response")?.[0]?.(
		{ status: 200, headers: { "x-request-id": "request-1" } },
		ctx,
	);
	await mock.events.get("message_update")?.[0]?.(
		{ assistantMessageEvent: { type: "text_delta", delta: "H" }, message: { role: "assistant" } },
		ctx,
	);
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

	assert.equal(backend.observations.length, 5);
	assert.equal(backend.flushes, 0);
	const [conversation, agent, attempt, turn, generation] = backend.observations;
	assert.equal(conversation?.name, "pi.conversation");
	assert.equal(conversation?.type, "span");
	assert.equal(conversation?.ended, false);
	assert.equal(conversation?.attributes.metadata?.["pi.git.branch"], "feature/lifecycle");
	assert.equal(conversation?.attributes.metadata?.["pi.git.commit"], "fedcba987654");
	assert.equal(conversation?.attributes.metadata?.["pi.git.detached"], false);
	assert.deepEqual(conversation?.traceUpdates[0]?.tags, ["pi", "branch:feature/lifecycle"]);
	assert.equal(agent?.name, "pi.agent");
	assert.equal(agent?.parent, conversation);
	assert.equal(agent?.ended, false);
	assert.equal(attempt?.name, "pi.attempt");
	assert.equal(attempt?.parent, agent);
	assert.equal(attempt?.ended, true);
	assert.equal(turn?.name, "pi.turn");
	assert.equal(turn?.parent, attempt);
	assert.equal(turn?.ended, true);
	assert.equal(generation?.parent, turn);
	assert.equal(generation?.ended, true);
	assert.deepEqual(turn?.attributes.metadata, { "pi.turn.index": 0 });
	assert.deepEqual(turn?.updates.at(-1)?.metadata, {
		"pi.turn.index": 0,
		"pi.turn.stop_reason": "stop",
		"pi.turn.tool_result_count": 0,
	});
	assert.deepEqual(generation?.attributes.input, finalPayload);
	assert.deepEqual(generation?.updates.at(-1)?.output, [
		{ type: "text", text: "Hi after message transforms" },
	]);
	assert.ok(generation?.updates.at(-1)?.completionStartTime instanceof Date);
	assert.deepEqual(
		generation?.updates.at(-1)?.metadata?.["http.response.status_codes"],
		[429, 200],
	);
	assert.deepEqual(generation?.updates.at(-1)?.metadata?.["http.response.headers"], {
		"retry-after": "1",
		"x-request-id": "request-1",
	});
	assert.equal(
		generation?.updates.some(({ level }) => level === "ERROR"),
		false,
	);

	await mock.events.get("agent_start")?.[0]?.({}, ctx);
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

	assert.equal(backend.observations.length, 8);
	const continuationAttempt = backend.observations[5];
	const continuationTurn = backend.observations[6];
	const continuationGeneration = backend.observations[7];
	assert.equal(continuationAttempt?.name, "pi.attempt");
	assert.equal(continuationAttempt?.parent, agent);
	assert.equal(continuationAttempt?.ended, true);
	assert.equal(continuationTurn?.name, "pi.turn");
	assert.equal(continuationTurn?.parent, continuationAttempt);
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
	await mock.events.get("agent_start")?.[0]?.({}, ctx);
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
	const preparedInput = {
		path: "file.ts",
		edits: [{ oldText: "old", newText: "new" }],
	};
	await mock.events.get("tool_call")?.[0]?.(
		{ toolCallId: "call-1", toolName: "edit", input: preparedInput },
		ctx,
	);
	preparedInput.path = "mutated-file.ts";
	await mock.events.get("tool_execution_update")?.[0]?.(
		{
			toolCallId: "call-1",
			toolName: "edit",
			args: { path: "file.ts", oldText: "old", newText: "new" },
			partialResult: { content: [{ type: "text", text: "private partial output" }] },
		},
		ctx,
	);
	await mock.events.get("tool_result")?.[0]?.(
		{
			toolCallId: "call-1",
			toolName: "edit",
			input: preparedInput,
			content: [{ type: "text", text: "final" }],
			details: { stage: "final" },
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
	assert.equal(backend.observations[3]?.name, "pi.turn");
	assert.equal(tool?.parent, backend.observations[3]);
	assert.deepEqual(tool?.attributes.input, {
		path: "file.ts",
		oldText: "old",
		newText: "new",
	});
	assert.deepEqual(
		tool?.updates.filter((update) => update.input !== undefined).map((update) => update.input),
		[
			{ path: "file.ts", edits: [{ oldText: "old", newText: "new" }] },
			{ path: "mutated-file.ts", edits: [{ oldText: "old", newText: "new" }] },
		],
	);
	assert.equal(JSON.stringify(tool).includes("private partial output"), false);
	assert.equal(tool?.updates.at(-1)?.metadata?.["pi.tool.progress_update_count"], 1);
	assert.deepEqual(tool?.updates.at(-1)?.output, {
		content: [{ type: "text", text: "final" }],
		details: { stage: "final" },
	});
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

test("pi-langfuse records active compactions without summaries and closes incomplete work", async () => {
	const backend = new FakeBackend();
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
	const beforeEvent = {
		reason: "threshold",
		willRetry: false,
		preparation: {
			tokensBefore: 20_000,
			messagesToSummarize: [{ role: "user", content: "private history" }],
			turnPrefixMessages: [],
			isSplitTurn: false,
		},
		branchEntries: [{ id: "one" }, { id: "two" }],
	};
	await mock.events.get("session_before_compact")?.[0]?.(beforeEvent, ctx);
	assert.equal(backend.observations.length, 0);

	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "compact", images: [], systemPrompt: "system" },
		ctx,
	);
	await mock.events.get("agent_start")?.[0]?.({}, ctx);
	await mock.events.get("session_before_compact")?.[0]?.(beforeEvent, ctx);
	await mock.events.get("session_compact")?.[0]?.(
		{
			reason: "threshold",
			willRetry: false,
			fromExtension: true,
			compactionEntry: {
				tokensBefore: 20_000,
				summary: "private compaction summary",
				details: { readFiles: ["a"], modifiedFiles: ["b"] },
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			},
		},
		ctx,
	);
	const completed = backend.observations.find(({ name }) => name === "pi.compaction");
	assert.equal(completed?.updates.at(-1)?.metadata?.["pi.compaction.from_extension"], true);
	assert.equal(JSON.stringify(completed).includes("private compaction summary"), false);

	await mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx);
	await mock.events.get("session_before_compact")?.[0]?.(
		{ ...beforeEvent, reason: "overflow", willRetry: true },
		ctx,
	);
	await mock.events.get("session_compact")?.[0]?.(
		{
			reason: "overflow",
			willRetry: true,
			fromExtension: false,
			compactionEntry: { tokensBefore: 20_000, summary: "private retry summary" },
		},
		ctx,
	);
	await mock.events.get("agent_start")?.[0]?.({}, ctx);
	const retryAttempt = backend.observations.filter(({ name }) => name === "pi.attempt").at(-1);
	assert.equal(retryAttempt?.attributes.metadata?.["pi.attempt.reason"], "post_compaction");

	await mock.events.get("session_before_compact")?.[0]?.({ ...beforeEvent, reason: "manual" }, ctx);
	await mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, ctx);
	const incomplete = backend.observations.filter(({ name }) => name === "pi.compaction").at(-1);
	assert.equal(incomplete?.updates.at(-1)?.level, "WARNING");
	assert.equal(incomplete?.endCalls, 1);
});

test("reload and session replacement close every active observation once before flushing", async () => {
	for (const reason of ["reload", "new", "resume", "fork"] as const) {
		const backend = new FakeBackend();
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
			{ prompt: reason, images: [], systemPrompt: "system" },
			ctx,
		);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);
		await mock.events.get("before_provider_request")?.[0]?.({ payload: { model: "test" } }, ctx);
		await mock.events.get("tool_execution_start")?.[0]?.(
			{ toolCallId: reason, toolName: "read", args: { path: "file" } },
			ctx,
		);
		await mock.events.get("session_before_compact")?.[0]?.(
			{
				reason: "manual",
				willRetry: false,
				preparation: {
					tokensBefore: 1,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
				},
				branchEntries: [],
			},
			ctx,
		);

		await mock.events.get("session_shutdown")?.[0]?.({ reason }, ctx);
		assert.equal(
			backend.observations.every(({ endCalls }) => endCalls === 1),
			true,
			reason,
		);
		assert.equal(
			backend.observations.find(({ name }) => name === "pi.llm")?.updates.at(-1)?.level,
			"WARNING",
			reason,
		);
		assert.equal(backend.flushes, 1, reason);
		assert.equal(backend.shutdowns, 0, reason);
	}
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
	await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "quit", images: [], systemPrompt: "system" },
		ctx,
	);
	await mock.events.get("agent_start")?.[0]?.({}, ctx);
	await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);
	await mock.events.get("before_provider_request")?.[0]?.({ payload: { model: "test" } }, ctx);
	await mock.events.get("tool_execution_start")?.[0]?.(
		{ toolCallId: "open", toolName: "read", args: { path: "file" } },
		ctx,
	);
	await mock.events.get("session_before_compact")?.[0]?.(
		{
			reason: "manual",
			willRetry: false,
			preparation: {
				tokensBefore: 1,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
			},
			branchEntries: [],
		},
		ctx,
	);
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	assert.equal(backend.shutdowns, 1);
	assert.equal(
		backend.observations.find(({ name }) => name === "pi.llm")?.updates.at(-1)?.level,
		"WARNING",
	);
	assert.equal(
		backend.observations.every(({ endCalls }) => endCalls === 1),
		true,
	);

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
