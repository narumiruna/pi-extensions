import assert from "node:assert/strict";
import {
	type ContextEvent,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	beginCompletionRequirement,
	COMPLETION_REQUIREMENT_CONTEXT_TYPE,
	COMPLETION_REQUIREMENT_TRANSITION_TYPE,
	completionRequirementKey,
	completionRequirementsFromBranch,
	createRequiredCompletionTransition,
	reconcileRequiredCompletionContext,
} from "../src/completion-requirement.js";
import { AgentRegistry } from "../src/registry.js";
import {
	createSubagentSessionGuidance,
	reconcileSubagentSessionGuidance,
	registerSubagentSessionGuidance,
	SUBAGENT_GUIDANCE_CONTEXT_TYPE,
	SUBAGENT_GUIDANCE_VERSION,
	SUBAGENT_RESTORED_BOUNDARY_ENTRY_TYPE,
	type SubagentSessionGuidanceSnapshot,
} from "../src/session-guidance-contract.js";
import { resolveStatefulLimits } from "../src/stateful-limits.js";
import subagents from "../src/subagents.js";
import { record } from "./registry-test-helpers.js";
import { installSubagentsTestEnvironment } from "./subagents-test-helpers.js";

const restoreTestEnvironment = installSubagentsTestEnvironment();
afterAll(restoreTestEnvironment);

function sessionManagerFor(branch: SessionEntry[]) {
	return {
		getSessionId: () => "cache-contract-session",
		getSessionName: () => undefined,
		getBranch: () => branch,
		getEntries: () => branch,
	};
}

function appendPersistedEntries(
	mock: ReturnType<typeof createMockPi>,
	branch: SessionEntry[],
	parentId: string | null,
): void {
	for (const [index, entry] of mock.entries.entries()) {
		const id = `persisted-boundary-${branch.length}-${index}`;
		branch.push({
			type: "custom",
			id,
			parentId,
			timestamp: new Date(index + 1).toISOString(),
			customType: entry.customType,
			data: structuredClone(entry.data),
		} as SessionEntry);
		parentId = id;
	}
}

function userMessage(text: string): ContextEvent["messages"][number] {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function assistantMessage(text: string): ContextEvent["messages"][number] {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "cache-contract",
		model: "cache-contract",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

async function emit(
	mock: ReturnType<typeof createMockPi>,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
}

async function applyPromptBoundary(
	mock: ReturnType<typeof createMockPi>,
	messages: ContextEvent["messages"],
	ctx: ExtensionContext,
): Promise<ContextEvent["messages"]> {
	let current = messages;
	for (const handler of mock.events.get("before_agent_start") ?? []) {
		const result = (await handler(
			{ prompt: "continue", systemPrompt: "stable base system prompt" },
			ctx,
		)) as { message?: ContextEvent["messages"][number] } | undefined;
		if (result?.message) current = [...current, result.message];
	}
	return applyContextHooks(mock, current, ctx);
}

async function applyContextHooks(
	mock: ReturnType<typeof createMockPi>,
	messages: ContextEvent["messages"],
	ctx: ExtensionContext,
): Promise<ContextEvent["messages"]> {
	let current = messages;
	for (const handler of mock.events.get("context") ?? []) {
		const result = (await handler({ messages: current }, ctx)) as
			| { messages?: ContextEvent["messages"] }
			| undefined;
		current = result?.messages ?? current;
	}
	return current;
}

function normalizedRequest(
	mock: ReturnType<typeof createMockPi>,
	messages: ContextEvent["messages"],
) {
	const activeToolNames = mock.rawPi.getActiveTools();
	const toolsByName = new Map(mock.tools.map((tool) => [String(tool.name), tool]));
	const tools = activeToolNames.map((name) => toolsByName.get(name));
	return {
		effectiveSystemGuidance: tools.flatMap((tool) => [
			...(typeof tool?.promptSnippet === "string" ? [tool.promptSnippet] : []),
			...(Array.isArray(tool?.promptGuidelines) ? tool.promptGuidelines : []),
		]),
		activeToolNames,
		toolDefinitions: tools.map((tool, index) => ({
			name: tool?.name ?? activeToolNames[index],
			description: tool?.description,
			parameters: tool?.parameters,
			constrainedSampling: tool?.constrainedSampling,
		})),
		messages: convertToLlm(messages),
	};
}

function guidanceSnapshot(): SubagentSessionGuidanceSnapshot {
	return {
		blockingEnabled: true,
		statefulEnabled: true,
		completionDelivery: "next-turn",
		blockingMaxParallelTasks: 8,
		statefulLimits: resolveStatefulLimits(),
		consultationCwdPolicy: "anywhere",
		delegationCwdPolicy: "trusted-targets",
		consultResourcePolicy: "project-context",
		agentCatalog: "Available agent definitions\n- explorer [source: built-in]",
	};
}

test("ordinary subagent requests keep system guidance and provider tool definitions stable", async () => {
	const branch: SessionEntry[] = [];
	const mock = createMockPi();
	subagents(mock.pi);
	mock.rawPi.setActiveTools(mock.tools.map((tool) => String(tool.name)));
	const context = createMockContext({ sessionManager: sessionManagerFor(branch) });
	const registrationsBeforeStart = mock.tools.length;
	await emit(mock, "session_start", { reason: "new" }, context.ctx);
	assert.equal(mock.tools.length, registrationsBeforeStart);

	const firstMessages = await applyPromptBoundary(mock, [userMessage("first")], context.ctx);
	const guidance = firstMessages.find(
		(message) => message.role === "custom" && message.customType === SUBAGENT_GUIDANCE_CONTEXT_TYPE,
	);
	assert.ok(guidance);
	branch.push({
		type: "message",
		id: "guidance",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: guidance,
	} as SessionEntry);
	const first = normalizedRequest(mock, firstMessages);

	const secondMessages = await applyPromptBoundary(
		mock,
		[...firstMessages, assistantMessage("working"), userMessage("second")],
		context.ctx,
	);
	const second = normalizedRequest(mock, secondMessages);
	assert.deepEqual(second.effectiveSystemGuidance, first.effectiveSystemGuidance);
	assert.deepEqual(second.activeToolNames, first.activeToolNames);
	assert.deepEqual(second.toolDefinitions, first.toolDefinitions);
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.equal(new Set(second.activeToolNames).size, second.activeToolNames.length);

	await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
});

test("session guidance persists once, appends live changes, and rejects stale sessions", async () => {
	let snapshot = guidanceSnapshot();
	const branch: SessionEntry[] = [];
	const mock = createMockPi();
	const controller = registerSubagentSessionGuidance(
		mock.pi,
		() => snapshot,
		() => [],
	);
	const firstContext = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(mock, "session_start", { reason: "new" }, firstContext.ctx);
	const before = mock.events.get("before_agent_start")?.[0];
	const first = (await before?.({ prompt: "continue", systemPrompt: "base" }, firstContext.ctx)) as
		| { message?: ContextEvent["messages"][number] }
		| undefined;
	assert.equal(
		first?.message?.role === "custom" ? first.message.customType : undefined,
		SUBAGENT_GUIDANCE_CONTEXT_TYPE,
	);
	if (!first?.message) assert.fail("expected initial guidance contract");
	branch.push({
		type: "message",
		id: "guidance",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: first.message,
	} as SessionEntry);
	assert.equal(
		await before?.({ prompt: "continue", systemPrompt: "base" }, firstContext.ctx),
		undefined,
	);

	snapshot = { ...snapshot, completionDelivery: "auto-resume" };
	controller.publish();
	controller.publish();
	assert.equal(mock.sentMessages.length, 1);
	assert.deepEqual(mock.sentMessages[0]?.options, {
		deliverAs: "nextTurn",
		triggerTurn: false,
	});
	assert.match(
		String((mock.sentMessages[0]?.message as { content?: unknown } | undefined)?.content),
		/"completionDelivery":"auto-resume"/u,
	);
	snapshot = { ...snapshot, completionDelivery: "next-turn" };
	controller.publish();
	assert.equal(mock.sentMessages.length, 2, "a rapid revert must append a superseding contract");

	const replacement = createMockContext();
	await emit(mock, "session_start", { reason: "fork" }, replacement.ctx);
	await emit(mock, "session_shutdown", { reason: "replace" }, firstContext.ctx);
	snapshot = { ...snapshot, blockingMaxParallelTasks: 3 };
	controller.publish();
	assert.equal(mock.sentMessages.length, 3, "stale shutdown must not clear the replacement owner");
	await emit(mock, "session_shutdown", { reason: "quit" }, replacement.ctx);
	controller.publish();
	assert.equal(mock.sentMessages.length, 3);

	const resumedMock = createMockPi();
	registerSubagentSessionGuidance(
		resumedMock.pi,
		() => guidanceSnapshot(),
		() => [],
	);
	const resumed = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(resumedMock, "session_start", { reason: "resume" }, resumed.ctx);
	assert.equal(
		await resumedMock.events.get("before_agent_start")?.[0]?.(
			{ prompt: "continue", systemPrompt: "base" },
			resumed.ctx,
		),
		undefined,
		"resume and reload must reuse an equivalent retained contract",
	);

	const retryMock = createMockPi();
	const retryController = registerSubagentSessionGuidance(
		retryMock.pi,
		() => guidanceSnapshot(),
		() => [],
	);
	const retryContext = createMockContext();
	await emit(retryMock, "session_start", { reason: "new" }, retryContext.ctx);
	retryMock.rawPi.sendMessage = () => {
		throw new Error("insertion unavailable");
	};
	retryController.publish();
	const retried = (await retryMock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "continue", systemPrompt: "base" },
		retryContext.ctx,
	)) as { message?: { customType?: string } } | undefined;
	assert.equal(retried?.message?.customType, SUBAGENT_GUIDANCE_CONTEXT_TYPE);
});

test("live policy changes retain compacted guidance at its prior provider boundary", async () => {
	let snapshot = guidanceSnapshot();
	const mock = createMockPi();
	const controller = registerSubagentSessionGuidance(
		mock.pi,
		() => snapshot,
		() => [],
	);
	const summaryBranch = [
		{
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Earlier work was compacted.",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
		},
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: "compaction",
			timestamp: new Date(0).toISOString(),
			fromId: "branch-start",
			summary: "Retained branch state.",
		},
	] as SessionEntry[];
	const firstContext = createMockContext({ sessionManager: sessionManagerFor(summaryBranch) });
	await emit(mock, "session_start", { reason: "resume" }, firstContext.ctx);
	const summaries: ContextEvent["messages"] = [
		{
			role: "compactionSummary",
			summary: "Earlier work was compacted.",
			tokensBefore: 100,
			timestamp: 0,
		},
		{
			role: "branchSummary",
			summary: "Retained branch state.",
			fromId: "branch-start",
			timestamp: 0,
		},
	];
	const firstRaw = [...summaries, userMessage("continue")];
	const firstMessages = await applyContextHooks(mock, firstRaw, firstContext.ctx);
	const restored = firstMessages[2];
	if (restored?.role !== "custom") assert.fail("expected restored session guidance");
	assert.equal(restored.customType, SUBAGENT_GUIDANCE_CONTEXT_TYPE);
	assert.match(String(restored.content), /"completionDelivery":"next-turn"/u);
	const first = normalizedRequest(mock, firstMessages);

	snapshot = { ...snapshot, completionDelivery: "auto-resume" };
	controller.publish();
	const appended = mock.sentMessages.at(-1)?.message as
		| ContextEvent["messages"][number]
		| undefined;
	if (!appended) assert.fail("expected an appended live-policy contract");
	const secondRaw = [
		...firstRaw,
		assistantMessage("working"),
		userMessage("continue again"),
		appended,
	];
	const secondMessages = await applyContextHooks(mock, secondRaw, firstContext.ctx);
	assert.deepEqual(secondMessages[2], restored);
	assert.equal(secondMessages.at(-1), appended);
	assert.match(
		String(appended.role === "custom" ? appended.content : ""),
		/"completionDelivery":"auto-resume"/u,
	);
	const second = normalizedRequest(mock, secondMessages);
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.equal(await applyContextHooks(mock, secondMessages, firstContext.ctx), secondMessages);

	snapshot = { ...snapshot, blockingMaxParallelTasks: 7 };
	mock.rawPi.sendMessage = () => {
		throw new Error("insertion unavailable");
	};
	controller.publish();
	const retried = (await mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "continue", systemPrompt: "base" },
		firstContext.ctx,
	)) as { message?: { content?: unknown } } | undefined;
	assert.match(
		String(retried?.message?.content),
		/"blockingMaxParallelTasks":7/u,
		"a failed live append must retry after an established compacted boundary",
	);

	const nextSummaryEpoch = summaries.map((message, index) =>
		index === 0 && message.role === "compactionSummary"
			? { ...message, summary: "Later work was compacted." }
			: message,
	);
	const nextEpochMessages = await applyContextHooks(
		mock,
		[...nextSummaryEpoch, userMessage("continue after another compaction")],
		firstContext.ctx,
	);
	assert.match(
		String(nextEpochMessages[2]?.role === "custom" ? nextEpochMessages[2].content : ""),
		/"completionDelivery":"auto-resume"/u,
		"a new summary epoch must restore the current contract rather than the prior epoch's contract",
	);

	const replacement = createMockContext({ sessionManager: sessionManagerFor([]) });
	await emit(mock, "session_start", { reason: "fork" }, replacement.ctx);
	await emit(mock, "session_shutdown", { reason: "replace" }, firstContext.ctx);
	const replacementMessages = await applyContextHooks(mock, firstRaw, replacement.ctx);
	assert.match(
		String(replacementMessages[2]?.role === "custom" ? replacementMessages[2].content : ""),
		/"completionDelivery":"auto-resume"/u,
		"a replacement session must not inherit the prior session's restored contract",
	);
	assert.equal(await applyContextHooks(mock, firstRaw, firstContext.ctx), firstRaw);
	await emit(mock, "session_shutdown", { reason: "quit" }, replacement.ctx);
});

test("reloaded settings append after persisted compacted guidance", async () => {
	let snapshot = guidanceSnapshot();
	const branch = [
		{
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Earlier work was compacted.",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
		},
	] as SessionEntry[];
	const summary: ContextEvent["messages"] = [
		{
			role: "compactionSummary",
			summary: "Earlier work was compacted.",
			tokensBefore: 100,
			timestamp: 0,
		},
	];
	const priorSnapshot = snapshot;
	const firstMock = createMockPi();
	registerSubagentSessionGuidance(
		firstMock.pi,
		() => snapshot,
		() => [],
	);
	const context = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(firstMock, "session_start", { reason: "resume" }, context.ctx);
	const baseline = await applyContextHooks(
		firstMock,
		[...summary, userMessage("continue")],
		context.ctx,
	);
	assert.equal(firstMock.entries.length, 1);
	assert.equal(firstMock.entries[0]?.customType, SUBAGENT_RESTORED_BOUNDARY_ENTRY_TYPE);
	appendPersistedEntries(firstMock, branch, "compaction");
	await emit(firstMock, "session_shutdown", { reason: "reload" }, context.ctx);

	snapshot = { ...snapshot, completionDelivery: "auto-resume" };
	const reloadedMock = createMockPi();
	registerSubagentSessionGuidance(
		reloadedMock.pi,
		() => snapshot,
		() => [],
	);
	await emit(reloadedMock, "session_start", { reason: "reload" }, context.ctx);
	const transition = (await reloadedMock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "continue", systemPrompt: "base" },
		context.ctx,
	)) as { message?: ContextEvent["messages"][number] } | undefined;
	const appended = transition?.message;
	if (!appended) assert.fail("expected the refreshed policy to append after reload");
	const resumed = await applyContextHooks(
		reloadedMock,
		[...summary, userMessage("continue"), appended],
		context.ctx,
	);
	assert.deepEqual(
		convertToLlm(resumed).slice(0, convertToLlm(baseline).length),
		convertToLlm(baseline),
	);
	assert.equal(resumed.at(-1), appended);
	assert.match(
		String(resumed[1]?.role === "custom" ? resumed[1].content : ""),
		/"completionDelivery":"next-turn"/u,
	);
	assert.match(
		String(appended.role === "custom" ? appended.content : ""),
		/"completionDelivery":"auto-resume"/u,
	);
	assert.deepEqual(
		baseline,
		reconcileSubagentSessionGuidance([...summary, userMessage("continue")], priorSnapshot),
	);
	assert.equal(reloadedMock.entries.length, 0, "reload must reuse persisted boundary metadata");
	await emit(reloadedMock, "session_shutdown", { reason: "quit" }, context.ctx);
});

test("restored requirement context remains fixed after completion becomes visible", async () => {
	const requirement = beginCompletionRequirement(undefined, {
		runId: "run:completed-after-restoration",
		generation: 1,
		createdAt: 10,
	})[0];
	const agent = record({ completionRequirements: [requirement] });
	const agents = [agent];
	const branch = [
		{
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Earlier work was compacted.",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
		},
	] as SessionEntry[];
	const mock = createMockPi();
	registerSubagentSessionGuidance(mock.pi, guidanceSnapshot, () => agents);
	const context = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(mock, "session_start", { reason: "resume" }, context.ctx);
	const summary: ContextEvent["messages"] = [
		{
			role: "compactionSummary",
			summary: "Earlier work was compacted.",
			tokensBefore: 100,
			timestamp: 0,
		},
	];
	const firstRaw = [...summary, userMessage("continue")];
	const firstMessages = await applyContextHooks(mock, firstRaw, context.ctx);
	const restored = firstMessages.find(
		(message) =>
			message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_CONTEXT_TYPE,
	);
	assert.ok(restored);

	const available = {
		...requirement,
		state: "available" as const,
		completionId: "completion:restored",
		terminalState: "completed" as const,
		updatedAt: 20,
	};
	agent.completionRequirements = [{ ...available, state: "visible" }];
	const completion: ContextEvent["messages"][number] = {
		role: "custom",
		customType: "pi-subagent-completion",
		content: "completed",
		display: true,
		details: { completionRequirement: available },
		timestamp: 0,
	};
	const secondMessages = await applyContextHooks(
		mock,
		[...firstRaw, assistantMessage("working"), completion],
		context.ctx,
	);
	const first = convertToLlm(firstMessages);
	const second = convertToLlm(secondMessages);
	assert.deepEqual(second.slice(0, first.length), first);
	assert.deepEqual(
		secondMessages.find(
			(message) =>
				message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_CONTEXT_TYPE,
		),
		restored,
	);
	assert.equal(secondMessages.at(-1), completion);

	assert.equal(
		mock.entries.filter((entry) => entry.customType === SUBAGENT_RESTORED_BOUNDARY_ENTRY_TYPE)
			.length,
		2,
		"guidance and requirement boundary metadata must be persisted",
	);
	appendPersistedEntries(mock, branch, "compaction");
	const reloadedMock = createMockPi();
	registerSubagentSessionGuidance(reloadedMock.pi, guidanceSnapshot, () => agents);
	const replacement = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(reloadedMock, "session_start", { reason: "reload" }, replacement.ctx);
	const replacementMessages = await applyContextHooks(
		reloadedMock,
		[...firstRaw, completion],
		replacement.ctx,
	);
	assert.deepEqual(
		replacementMessages.find(
			(message) =>
				message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_CONTEXT_TYPE,
		),
		restored,
		"reload must retain the requirement boundary after completion becomes visible",
	);
	assert.equal(reloadedMock.entries.length, 0);

	const siblingGuidance = createSubagentSessionGuidance(guidanceSnapshot());
	branch.splice(
		0,
		branch.length,
		{
			type: "compaction",
			id: "sibling-compaction",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Earlier work was compacted.",
			firstKeptEntryId: "sibling-guidance",
			tokensBefore: 100,
		} as SessionEntry,
		{
			type: "message",
			id: "sibling-guidance",
			parentId: "sibling-compaction",
			timestamp: new Date(1).toISOString(),
			message: siblingGuidance,
		} as SessionEntry,
		{
			type: "message",
			id: "sibling-completion",
			parentId: "sibling-guidance",
			timestamp: new Date(2).toISOString(),
			message: completion,
		} as SessionEntry,
	);
	await emit(reloadedMock, "session_tree", {}, replacement.ctx);
	const siblingMessages = [...summary, siblingGuidance, completion];
	assert.equal(
		await applyContextHooks(reloadedMock, siblingMessages, replacement.ctx),
		siblingMessages,
		"sibling navigation must not inherit restored boundaries from another branch",
	);
	await emit(mock, "session_shutdown", { reason: "reload" }, context.ctx);
	await emit(reloadedMock, "session_shutdown", { reason: "quit" }, replacement.ctx);
});

test("uncompacted resume appends a restored requirement cancellation once", async () => {
	const requirement = beginCompletionRequirement(undefined, {
		runId: "run:restored",
		generation: 1,
		createdAt: 10,
	})[0];
	const registry = new AgentRegistry(
		{ kind: "fake", runTurn: async () => ({ output: "unused", exitCode: 0 }) },
		{ now: () => 20 },
	);
	registry.restore([
		record({
			state: "running",
			completionRequirements: [requirement],
		}),
	]);
	const cancelled = registry.list()[0]?.completionRequirements?.[0];
	assert.equal(cancelled?.state, "cancelled");
	assert.equal(cancelled?.terminalState, "interrupted");

	const guidance = createSubagentSessionGuidance(guidanceSnapshot());
	const pendingResult: ContextEvent["messages"][number] = {
		role: "toolResult",
		toolCallId: "spawn-restored",
		toolName: "subagent_spawn",
		content: [{ type: "text", text: "spawned required child" }],
		details: { agent: { completionRequirements: [requirement] } },
		isError: false,
		timestamp: 0,
	};
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "guidance",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: guidance,
		} as SessionEntry,
		{
			type: "message",
			id: "spawn",
			parentId: "guidance",
			timestamp: new Date(1).toISOString(),
			message: pendingResult,
		} as SessionEntry,
	];
	const mock = createMockPi();
	registerSubagentSessionGuidance(mock.pi, guidanceSnapshot, () => registry.list());
	const context = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(mock, "session_start", { reason: "resume" }, context.ctx);

	const firstMessages = await applyPromptBoundary(
		mock,
		[guidance, pendingResult, userMessage("continue resumed work")],
		context.ctx,
	);
	const transitions = firstMessages.filter(
		(message) =>
			message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_TRANSITION_TYPE,
	);
	assert.equal(transitions.length, 1);
	const transition = transitions[0];
	if (transition?.role !== "custom") assert.fail("expected restored cancellation transition");
	assert.equal(firstMessages.at(-1), transition);
	assert.match(String(transition.content), /cancelled.*run:restored.*interrupted/su);
	assert.equal(
		completionRequirementsFromBranch(transitions).records.get(completionRequirementKey(requirement))
			?.state,
		"cancelled",
	);
	const staleTransition = {
		...transition,
		details: { ...(transition.details as object), version: "stale-version" },
	};
	assert.deepEqual(completionRequirementsFromBranch([staleTransition]), {
		observedState: false,
		records: new Map(),
		keys: new Set(),
	});
	branch.push({
		type: "message",
		id: "transition",
		parentId: "spawn",
		timestamp: new Date(2).toISOString(),
		message: transition,
	} as SessionEntry);
	const secondMessages = await applyPromptBoundary(
		mock,
		[...firstMessages, assistantMessage("acknowledged"), userMessage("continue again")],
		context.ctx,
	);
	assert.equal(
		secondMessages.filter(
			(message) =>
				message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_TRANSITION_TYPE,
		).length,
		1,
		"the retained transition must suppress duplicate publication",
	);
	const first = convertToLlm(firstMessages);
	const second = convertToLlm(secondMessages);
	assert.deepEqual(second.slice(0, first.length), first);

	await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
});

test("compacted resume appends cancellation after a retained pending handoff", async () => {
	const requirement = beginCompletionRequirement(undefined, {
		runId: "run:retained-after-summary",
		generation: 1,
		createdAt: 10,
	})[0];
	const registry = new AgentRegistry(
		{ kind: "fake", runTurn: async () => ({ output: "unused", exitCode: 0 }) },
		{ now: () => 20 },
	);
	registry.restore([
		record({
			state: "running",
			completionRequirements: [requirement],
		}),
	]);
	const cancelled = registry.list()[0];
	assert.equal(cancelled?.completionRequirements?.[0]?.state, "cancelled");

	const pendingResult: ContextEvent["messages"][number] = {
		role: "toolResult",
		toolCallId: "spawn-retained",
		toolName: "subagent_spawn",
		content: [{ type: "text", text: "spawned required child" }],
		details: { agent: { completionRequirements: [requirement] } },
		isError: false,
		timestamp: 0,
	};
	const branch = [
		{
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Earlier work was compacted.",
			firstKeptEntryId: "spawn",
			tokensBefore: 100,
		},
		{
			type: "message",
			id: "spawn",
			parentId: "compaction",
			timestamp: new Date(1).toISOString(),
			message: pendingResult,
		},
	] as SessionEntry[];
	const summary: ContextEvent["messages"] = [
		{
			role: "compactionSummary",
			summary: "Earlier work was compacted.",
			tokensBefore: 100,
			timestamp: 0,
		},
	];
	assert.equal(
		createRequiredCompletionTransition(summary, registry.list()),
		undefined,
		"a missing handoff must use summary-boundary restoration instead of a tail transition",
	);

	const mock = createMockPi();
	registerSubagentSessionGuidance(mock.pi, guidanceSnapshot, () => registry.list());
	const context = createMockContext({ sessionManager: sessionManagerFor(branch) });
	await emit(mock, "session_start", { reason: "resume" }, context.ctx);
	const firstMessages = await applyPromptBoundary(
		mock,
		[...summary, pendingResult, userMessage("continue resumed work")],
		context.ctx,
	);
	const transitionIndex = firstMessages.findIndex(
		(message) =>
			message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_TRANSITION_TYPE,
	);
	const handoffIndex = firstMessages.indexOf(pendingResult);
	assert.ok(transitionIndex > handoffIndex);
	assert.equal(transitionIndex, firstMessages.length - 1);
	assert.equal(
		firstMessages.some(
			(message) =>
				message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_CONTEXT_TYPE,
		),
		false,
		"the tail cancellation supersedes the retained handoff without an earlier fallback",
	);

	await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
});

test("compaction restores guidance and required completion at deterministic boundaries", () => {
	const snapshot = guidanceSnapshot();
	const requirement = beginCompletionRequirement(undefined, {
		runId: "run:required",
		generation: 1,
		createdAt: 10,
	})[0];
	const agent = {
		id: "sa_required",
		taskName: "required",
		taskPath: "/root/required",
		agent: "explorer",
		rootId: "sa_required",
		depth: 0,
		children: [],
		state: "running" as const,
		createdAt: 1,
		updatedAt: 2,
		cwd: process.cwd(),
		completionRequirements: [requirement],
		history: [],
		mailbox: [],
	};
	const summaries: ContextEvent["messages"] = [
		{
			role: "compactionSummary",
			summary: "Earlier work was compacted.",
			tokensBefore: 100,
			timestamp: 0,
		},
		{
			role: "branchSummary",
			summary: "Retained branch state.",
			fromId: "branch-start",
			timestamp: 0,
		},
	];
	const restore = (messages: ContextEvent["messages"]) =>
		reconcileRequiredCompletionContext(
			reconcileSubagentSessionGuidance(messages, snapshot),
			[agent],
			[SUBAGENT_GUIDANCE_CONTEXT_TYPE],
		);
	const firstMessages = restore([...summaries, userMessage("continue")]);
	assert.equal(
		firstMessages[2]?.role === "custom" ? firstMessages[2].customType : undefined,
		SUBAGENT_GUIDANCE_CONTEXT_TYPE,
	);
	assert.equal(
		firstMessages[3]?.role === "custom" ? firstMessages[3].customType : undefined,
		COMPLETION_REQUIREMENT_CONTEXT_TYPE,
	);
	assert.equal(restore(firstMessages), firstMessages);
	const staleVersion = firstMessages.map((message, index) =>
		index === 2 && message.role === "custom"
			? { ...message, details: { version: "pi-subagents:session-guidance:v0" } }
			: message,
	);
	const repairedVersion = restore(staleVersion);
	assert.deepEqual(repairedVersion[2]?.role === "custom" ? repairedVersion[2].details : undefined, {
		version: SUBAGENT_GUIDANCE_VERSION,
	});

	const first = convertToLlm(firstMessages);
	const secondMessages = restore([
		...summaries,
		userMessage("continue"),
		assistantMessage("working"),
		userMessage("continue again"),
	]);
	const second = convertToLlm(secondMessages);
	assert.deepEqual(second.slice(0, first.length), first);

	const changed = createSubagentSessionGuidance({
		...snapshot,
		completionDelivery: "auto-resume",
	});
	const transitioned = [...secondMessages, changed];
	assert.deepEqual(
		convertToLlm(transitioned).slice(0, second.length),
		second,
		"a settings transition appends instead of rewriting the earlier prefix",
	);
});
