import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadLangfuseConfig } from "../src/config.js";
import { createLangfuseExtension } from "../src/langfuse.js";
import { maskSecrets } from "../src/runtime.js";
import {
	type Observation,
	type ObservationAttributes,
	type TraceBackend,
	TraceRecorder,
} from "../src/tracing.js";

class FakeObservation implements Observation {
	readonly updates: ObservationAttributes[] = [];
	readonly traceUpdates: ObservationAttributes[] = [];
	ended = false;

	constructor(
		readonly name: string,
		readonly attributes: ObservationAttributes,
		readonly type: "span" | "generation",
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

	end() {
		this.ended = true;
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
		options: { asType: "span" | "generation"; parent?: Observation },
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
		warnings: [],
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

test("TraceRecorder builds one agent trace with child generations and tool spans", async () => {
	const backend = new FakeBackend();
	const recorder = new TraceRecorder(backend, {
		sessionId: "session-1",
		cwd: "/workspace",
		mode: "tui",
		captureContent: true,
	});

	recorder.beginAgent({
		prompt: "Fix the test",
		systemPrompt: "You are Pi",
		model: { provider: "anthropic", id: "claude" },
	});
	recorder.beginGeneration({ messages: [{ role: "user", content: "Fix the test" }] });
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
	const [root, generation, tool] = backend.observations;
	assert.equal(root?.name, "pi.agent");
	assert.equal(root?.type, "span");
	assert.deepEqual(root?.traceUpdates[0], {
		name: "pi.agent",
		sessionId: "session-1",
		input: { prompt: "Fix the test" },
		metadata: root?.attributes.metadata,
		tags: ["pi"],
	});
	assert.deepEqual(root?.attributes.input, { prompt: "Fix the test" });
	assert.deepEqual(root?.attributes.metadata, {
		"pi.cwd": "/workspace",
		"pi.mode": "tui",
		"pi.model": "claude",
		"pi.provider": "anthropic",
		"pi.session.id": "session-1",
	});
	assert.equal(generation?.name, "pi.llm");
	assert.equal(generation?.type, "generation");
	assert.equal(generation?.parent, root);
	assert.deepEqual(generation?.attributes.input, {
		messages: [{ role: "user", content: "Fix the test" }],
		systemPrompt: "You are Pi",
	});
	assert.deepEqual(generation?.updates.at(-1)?.usageDetails, {
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		completionTokens: 5,
		promptTokens: 10,
		totalTokens: 18,
	});
	assert.equal(generation?.ended, true);
	assert.equal(tool?.name, "pi.tool.read");
	assert.equal(tool?.parent, root);
	assert.equal(tool?.ended, true);
	assert.equal(root?.ended, true);
	assert.equal(backend.flushes, 1);
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
	recorder.beginGeneration({ messages: [] });
	recorder.beginGeneration({ messages: [] });
	recorder.beginTool("call-1", "bash", { command: "exit 1" });
	recorder.finishTool("call-1", { content: "failed", isError: true });
	recorder.settle();

	const [root, firstGeneration, secondGeneration, tool] = backend.observations;
	assert.deepEqual(root?.attributes.input, {
		images: [{ type: "image", mimeType: "image/png", data: "[base64 omitted]" }],
		prompt: "Describe this",
	});
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
		"before_agent_start",
		"context",
		"message_end",
		"session_shutdown",
		"session_start",
		"tool_execution_end",
		"tool_execution_start",
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
		{ prompt: "Hello", images: [], systemPrompt: "system" },
		ctx,
	);
	await mock.events.get("context")?.[0]?.({ messages: [{ role: "user", content: "Hello" }] }, ctx);
	await mock.events.get("message_end")?.[0]?.(
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				provider: "anthropic",
				model: "claude",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
		},
		ctx,
	);
	await mock.events.get("agent_end")?.[0]?.({}, ctx);

	assert.equal(backend.observations.length, 2);
	assert.equal(
		backend.observations.every((observation) => observation.ended),
		true,
	);
	assert.equal(backend.flushes, 1);

	await mock.events.get("context")?.[0]?.({ messages: [{ role: "user", content: "retry" }] }, ctx);
	await mock.events.get("message_end")?.[0]?.(
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Recovered" }],
				provider: "anthropic",
				model: "claude",
				usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
		},
		ctx,
	);
	await mock.events.get("agent_end")?.[0]?.({}, ctx);

	assert.equal(backend.observations.length, 4);
	assert.deepEqual(backend.observations[2]?.attributes.input, {
		prompt: "[automatic continuation]",
	});
	assert.equal(
		backend.observations.slice(2).every((observation) => observation.ended),
		true,
	);
	assert.equal(backend.flushes, 2);
});
