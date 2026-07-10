import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(import.meta.dirname, "../src/goal.ts");

async function createHarness(responses, fauxOptions = {}, prepareSession) {
	const root = await mkdtemp(join(tmpdir(), "pi-goal-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const faux = createFauxCore({
		api: `pi-goal-faux-${crypto.randomUUID()}`,
		provider: `pi-goal-faux-${crypto.randomUUID()}`,
		...fauxOptions,
	});
	const provider = faux.getModel().provider;
	modelRegistry.registerProvider(provider, {
		api: faux.api,
		apiKey: "runtime-smoke",
		baseUrl: "http://localhost",
		streamSimple: faux.streamSimple,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	});
	const model = modelRegistry.find(provider, faux.getModel().id);
	assert.ok(model, "expected registered faux model");
	faux.setResponses(responses);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const lifecycleEvents = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [extensionPath],
		extensionFactories: [
			{
				name: "runtime-smoke-observer",
				factory: (pi) => {
					pi.on("session_start", () => lifecycleEvents.push("session_start"));
					pi.on("session_before_compact", () => lifecycleEvents.push("session_before_compact"));
					pi.on("session_compact", (_event, ctx) =>
						lifecycleEvents.push(
							`session_compact:idle=${ctx.isIdle()}:pending=${ctx.hasPendingMessages()}`,
						),
					);
					pi.on("agent_settled", () => lifecycleEvents.push("agent_settled"));
				},
			},
		],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	prepareSession?.(sessionManager);
	const result = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		resourceLoader,
		sessionManager,
		settingsManager,
		noTools: "builtin",
	});
	assert.deepEqual(result.extensionsResult.errors, []);
	await result.session.bindExtensions({});
	return {
		extensions: result.extensionsResult.extensions.map((extension) => ({
			path: extension.path,
			handlers: [...extension.handlers.keys()],
		})),
		faux,
		lifecycleEvents,
		session: result.session,
		async cleanup() {
			result.session.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function completionResponse(context) {
	const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/.exec(context.systemPrompt ?? "")?.[1];
	assert.ok(goalId, "expected goal id in continuation system prompt");
	return fauxAssistantMessage(
		fauxToolCall("goal_complete", {
			goal_id: goalId,
			summary: "Runtime smoke completed and verified.",
		}),
	);
}

function userMessageText(message) {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function persistedGoalStatus(session) {
	const entry = session.sessionManager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
		.at(-1);
	return entry?.data?.goal?.status ?? null;
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function normalContinuationScenario() {
	const harness = await createHarness([
		fauxAssistantMessage("First pass stopped without completion."),
		completionResponse,
	]);
	const events = [];
	const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
	try {
		await harness.session.prompt("/goal runtime continuation smoke");
		await waitFor(() => harness.faux.state.callCount === 2, "settled continuation");
		await harness.session.agent.waitForIdle();
		assert.equal(events.filter((type) => type === "agent_settled").length, 2);
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(
			harness.session.messages
				.map(userMessageText)
				.some((text) => text.includes("pi-goal-continuation:")),
		);
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

async function queuedInputScenario() {
	const observedPrompts = [];
	const harness = await createHarness(
		[
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return fauxAssistantMessage("x".repeat(120));
			},
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return fauxAssistantMessage("Queued request handled.");
			},
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return completionResponse(context);
			},
		],
		{ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
	);
	try {
		await harness.session.prompt("/goal queued work smoke");
		await waitFor(() => harness.session.isStreaming, "initial turn streaming");
		await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
		await waitFor(() => harness.faux.state.callCount === 3, "continuation after queued input");
		await harness.session.agent.waitForIdle();
		const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
		const continuationIndex = observedPrompts.findIndex((text) =>
			text.includes("pi-goal-continuation:"),
		);
		assert.ok(queuedIndex >= 0, "expected queued work to reach the model");
		assert.ok(continuationIndex > queuedIndex, "continuation must yield to queued work");
	} finally {
		await harness.cleanup();
	}
}

async function pauseScenario() {
	const harness = await createHarness([fauxAssistantMessage("x".repeat(200))], {
		tokensPerSecond: 100,
		tokenSize: { min: 1, max: 1 },
	});
	try {
		await harness.session.prompt("/goal interrupt runtime smoke");
		await waitFor(() => harness.session.isStreaming, "goal turn streaming");
		await harness.session.prompt("/goal pause");
		await waitFor(() => !harness.session.isStreaming, "goal turn abort");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(harness.faux.state.callCount, 1);
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(
			harness.session.messages
				.map(userMessageText)
				.filter((text) => text.includes("pi-goal-continuation:")).length,
			0,
		);
	} finally {
		await harness.cleanup();
	}
}

async function manualCompactionScenario() {
	const now = Date.now();
	const harness = await createHarness(
		[fauxAssistantMessage("Compacted prior work."), completionResponse],
		{},
		(sessionManager) => {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `Old request ${"x".repeat(100_000)}` }],
				timestamp: now - 4_000,
			});
			sessionManager.appendMessage(fauxAssistantMessage(`Old result ${"y".repeat(100_000)}`));
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Recent request" }],
				timestamp: now - 2_000,
			});
			sessionManager.appendMessage(fauxAssistantMessage("Recent result"));
			sessionManager.appendCustomEntry("goal-state", {
				goal: {
					id: crypto.randomUUID(),
					text: "finish after manual compaction",
					status: "active",
					startedAt: now - 1_000,
					updatedAt: now - 1_000,
					iteration: 1,
					tokensUsed: 0,
					timeUsedSeconds: 1,
					baselineTokens: 0,
				},
			});
		},
	);
	const events = [];
	const unsubscribe = harness.session.subscribe((event) => events.push(event));
	try {
		await harness.session.compact("Summarize for the runtime smoke test.");
		await waitFor(
			() => harness.faux.state.callCount === 2,
			`manual-compaction continuation (${JSON.stringify({
				callCount: harness.faux.state.callCount,
				goalStatus: persistedGoalStatus(harness.session),
				isIdle: harness.session.isIdle,
				events: events.map((event) => event.type),
				extensions: harness.extensions,
				lifecycleEvents: harness.lifecycleEvents,
			})})`,
		);
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(
			harness.session.messages
				.map(userMessageText)
				.some((text) => text.includes("pi-goal-continuation:")),
		);
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

await normalContinuationScenario();
await queuedInputScenario();
await pauseScenario();
await manualCompactionScenario();
console.log("pi-goal runtime smoke: normal, queued input, pause, and manual compaction passed");
