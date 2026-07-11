import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
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

const extensionPath = resolve(import.meta.dirname, "../src/goals.ts");

async function createHarness(responses, fauxOptions = {}, prepareSession) {
	const root = await mkdtemp(join(tmpdir(), "pi-goals-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const faux = createFauxCore({
		api: `pi-goals-faux-${crypto.randomUUID()}`,
		provider: `pi-goals-faux-${crypto.randomUUID()}`,
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
	const registrations = { commands: [], tools: [] };
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [extensionPath],
		extensionFactories: [
			{
				name: "runtime-smoke-observer",
				factory: (pi) => {
					pi.registerTool({
						name: "budget_probe",
						label: "Budget Probe",
						description: "No-op tool for lifecycle smoke coverage",
						parameters: Type.Object({}),
						async execute() {
							lifecycleEvents.push("budget_probe_execute");
							return { content: [{ type: "text", text: "probe complete" }] };
						},
					});
					pi.on("session_start", () => {
						lifecycleEvents.push("session_start");
						registrations.commands = pi.getCommands().map((command) => command.name);
						registrations.tools = pi.getAllTools().map((tool) => tool.name);
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") lifecycleEvents.push("assistant_message_end");
					});
					pi.on("tool_execution_end", () => lifecycleEvents.push("tool_execution_end"));
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
		registrations,
		session: result.session,
		async cleanup() {
			result.session.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true });
		},
	};
}

function completionResponse(context) {
	const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/.exec(context.systemPrompt ?? "")?.[1];
	assert.ok(goalId, "expected goal id in continuation system prompt");
	return fauxAssistantMessage(
		fauxToolCall("goals_complete", {
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

function persistedGoalState(session) {
	return session.sessionManager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "goals-state")
		.at(-1)?.data;
}

function persistedGoalStatus(session) {
	return persistedGoalState(session)?.goals?.[0]?.status ?? null;
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
		assert.ok(harness.registrations.commands.includes("goals"));
		assert.equal(harness.registrations.commands.includes("goal"), false);
		assert.ok(harness.registrations.tools.includes("goals_complete"));
		assert.ok(harness.registrations.tools.includes("goals_blocked"));
		assert.equal(harness.registrations.tools.includes("goal_complete"), false);
		assert.equal(harness.registrations.tools.includes("goal_blocked"), false);
		await harness.session.prompt("/goals runtime continuation smoke");
		await waitFor(() => harness.faux.state.callCount === 2, "settled continuation");
		await harness.session.agent.waitForIdle();
		assert.equal(events.filter((type) => type === "agent_settled").length, 2);
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(
			harness.session.messages
				.map(userMessageText)
				.some((text) => text.includes("pi-goals-continuation:")),
		);
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

async function goalQueueScenario() {
	const harness = await createHarness(
		[fauxAssistantMessage("x".repeat(120)), completionResponse, completionResponse],
		{ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
	);
	try {
		await harness.session.prompt("/goals first runtime queue goal");
		await waitFor(() => harness.session.isStreaming, "first queue goal streaming");
		await harness.session.prompt("/goals push second runtime queue goal");
		await waitFor(() => harness.faux.state.callCount === 3, "sequential queue completion");
		await harness.session.agent.waitForIdle();
		assert.deepEqual(persistedGoalState(harness.session)?.goals, []);
		const prompts = harness.session.messages.map(userMessageText).filter(Boolean);
		assert.ok(prompts.some((text) => text.includes("first runtime queue goal")));
		assert.ok(prompts.some((text) => text.includes("second runtime queue goal")));
	} finally {
		await harness.cleanup();
	}
}

async function busyUnshiftScenario() {
	const harness = await createHarness(
		[fauxAssistantMessage("x".repeat(120)), completionResponse, completionResponse],
		{ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
	);
	try {
		await harness.session.prompt("/goals original runtime goal");
		await waitFor(() => harness.session.isStreaming, "original goal streaming");
		await harness.session.prompt("/goals unshift urgent runtime goal");
		await waitFor(
			() => persistedGoalState(harness.session)?.goals?.length === 0,
			"urgent goal and restored original",
		);
		await harness.session.agent.waitForIdle();
		assert.deepEqual(persistedGoalState(harness.session)?.goals, []);
		assert.equal(harness.faux.state.callCount, 3);
		const prompts = harness.session.messages.map(userMessageText).filter(Boolean);
		assert.ok(prompts.some((text) => text.includes("urgent runtime goal")));
		assert.ok(prompts.some((text) => text.includes("original runtime goal")));
	} finally {
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
		await harness.session.prompt("/goals queued work smoke");
		await waitFor(() => harness.session.isStreaming, "initial turn streaming");
		await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
		await waitFor(() => harness.faux.state.callCount === 3, "continuation after queued input");
		await harness.session.agent.waitForIdle();
		const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
		const continuationIndex = observedPrompts.findIndex((text) =>
			text.includes("pi-goals-continuation:"),
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
		await harness.session.prompt("/goals interrupt runtime smoke");
		await waitFor(() => harness.session.isStreaming, "goal turn streaming");
		await harness.session.prompt("/goals pause");
		await waitFor(() => !harness.session.isStreaming, "goal turn abort");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(harness.faux.state.callCount, 1);
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(
			harness.session.messages
				.map(userMessageText)
				.filter((text) => text.includes("pi-goals-continuation:")).length,
			0,
		);
	} finally {
		await harness.cleanup();
	}
}

async function budgetBoundaryScenario() {
	const harness = await createHarness([
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		(context) => {
			const wrapUp = context.messages.find(
				(message) => message.role === "custom" && message.customType === "goals-budget-wrap-up",
			);
			assert.match(String(wrapUp?.content), /stop substantive work/i);
			return fauxAssistantMessage("Budget-limited progress summary.");
		},
	]);
	try {
		await harness.session.prompt("/goals --tokens 1 budget boundary runtime smoke");
		await waitFor(() => harness.faux.state.callCount === 2, "budget wrap-up response");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
		assert.equal(
			harness.lifecycleEvents.filter((event) => event === "tool_execution_end").length,
			1,
		);
		assert.ok(
			harness.lifecycleEvents.indexOf("assistant_message_end") <
				harness.lifecycleEvents.indexOf("tool_execution_end"),
			"assistant message must finalize before tool_execution_end",
		);
	} finally {
		await harness.cleanup();
	}
}

async function budgetViolationScenario() {
	const harness = await createHarness([
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		(_context, options) => {
			assert.equal(options?.signal?.aborted, true);
			return fauxAssistantMessage("This aborted response must not start more work.");
		},
	]);
	try {
		await harness.session.prompt("/goals --tokens 1 reject wrap-up tools at runtime");
		await harness.session.agent.waitForIdle();
		assert.equal(harness.faux.state.callCount, 3);
		assert.equal(
			harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length,
			1,
		);
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
	} finally {
		await harness.cleanup();
	}
}

async function budgetAgentEndFallbackScenario() {
	const harness = await createHarness([fauxAssistantMessage("No-tool budget response.")]);
	try {
		await harness.session.prompt("/goals --tokens 1 no-tool budget runtime smoke");
		await harness.session.agent.waitForIdle();
		assert.equal(harness.faux.state.callCount, 1);
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
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
			sessionManager.appendCustomEntry("goals-state", {
				goals: [
					{
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
				],
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
				.some((text) => text.includes("pi-goals-continuation:")),
		);
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

await normalContinuationScenario();
await goalQueueScenario();
await busyUnshiftScenario();
await queuedInputScenario();
await pauseScenario();
await budgetBoundaryScenario();
await budgetViolationScenario();
await budgetAgentEndFallbackScenario();
await manualCompactionScenario();
console.log(
	"pi-goals runtime smoke: normal continuation, sequential and urgent goals, queued input, pause, bounded budget behavior, and manual compaction passed",
);
