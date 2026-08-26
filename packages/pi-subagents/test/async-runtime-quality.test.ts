import assert from "node:assert/strict";
import { test } from "vitest";
import {
	beginCompletionRequirement,
	completionRequirementKey,
	completionRequirementsFromBranch,
	reconcileRequiredCompletionContext,
} from "../src/completion-requirement.js";
import { AgentRegistry, type TurnOutcome } from "../src/registry.js";
import { TURN_TERMINATION_VERSION } from "../src/timeout-checkpoint.js";

function finalizedLimitOutcome(
	output: string,
	finalizationStatus: "completed" | "failed" | "timed_out" = "completed",
): TurnOutcome {
	return {
		output,
		exitCode: 124,
		error: "Subagent exceeded its tool-call limit",
		termination: {
			version: TURN_TERMINATION_VERSION,
			reason: "tool_call_limit",
			limit: 2,
			checkpoint: {
				version: "pi-subagents:checkpoint:v1",
				task: "inspect",
				assistantNotes: [],
				completedTools: [],
				changedFiles: [],
				sideEffectsMayHaveOccurred: false,
				truncated: false,
			},
			finalization: {
				attempted: true,
				status: finalizationStatus,
				durationMs: 10,
			},
		},
	};
}

test("required completion tracks an exact run through availability and visibility", async () => {
	const registry = new AgentRegistry({
		kind: "fake",
		runTurn: async () => ({ output: "evidence", exitCode: 0 }),
	});
	const spawned = await registry.spawn({
		agent: "explorer",
		task: "inspect",
		cwd: process.cwd(),
		completionRequirement: "required",
	});
	const pending = registry.get(spawned.id)?.completionRequirements?.[0];
	assert.equal(pending?.state, "pending");
	assert.equal(pending?.runId, spawned.currentRunId);
	assert.equal(pending?.generation, spawned.currentTurnGeneration);

	const settled = await registry.wait(spawned.id, 1_000);
	assert.equal(settled.timedOut, false);
	const available = settled.agent.completionRequirements?.[0];
	assert.equal(available?.state, "available");
	assert.equal(available?.terminalState, "completed");
	assert.ok(available?.completionId);
	assert.equal(registry.getInspection(spawned.id)?.pendingRequiredCompletionCount, 1);

	await registry.markCompletionDelivered(available.completionId, Date.now());
	await registry.markCompletionDelivered(available.completionId, Date.now() + 1);
	const visible = registry.get(spawned.id)?.completionRequirements?.[0];
	assert.equal(visible?.state, "visible");
	assert.equal(registry.getInspection(spawned.id)?.pendingRequiredCompletionCount, 0);

	const followUp = await registry.followUp(spawned.id, "inspect again", {
		completionRequirement: "required",
	});
	assert.notEqual(followUp.currentRunId, available.runId);
	assert.equal(followUp.completionRequirements?.at(-1)?.generation, 2);
	await registry.wait(spawned.id, 1_000);
});

test("branch reconstruction keeps exact required runs and drops forked-away runs", () => {
	const requirement = beginCompletionRequirement(undefined, {
		runId: "run:required",
		generation: 1,
		createdAt: 10,
	})[0];
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "subagent_spawn",
				details: { agent: { completionRequirements: [requirement] } },
			},
		},
	];
	const restored = completionRequirementsFromBranch(branch);
	assert.equal(restored.observedState, true);
	assert.deepEqual([...restored.keys], [completionRequirementKey(requirement)]);
	assert.equal(restored.records.get(completionRequirementKey(requirement))?.state, "pending");
	const visibleRequirement = {
		...requirement,
		state: "available" as const,
		completionId: "completion:required",
		terminalState: "completed" as const,
		updatedAt: 11,
	};
	const visibleBranch = completionRequirementsFromBranch([
		...branch,
		{
			type: "message",
			message: {
				role: "custom",
				customType: "pi-subagent-completion",
				details: { completionRequirement: visibleRequirement },
			},
		},
	]);
	assert.equal(visibleBranch.records.get(completionRequirementKey(requirement))?.state, "visible");

	const registry = new AgentRegistry({
		kind: "fake",
		runTurn: async () => ({ output: "unused", exitCode: 0 }),
	});
	registry.restore([
		{
			id: "sa_restored",
			taskName: "restored",
			taskPath: "/root/restored",
			agent: "explorer",
			rootId: "sa_restored",
			depth: 0,
			children: [],
			state: "completed",
			createdAt: 1,
			updatedAt: 2,
			cwd: process.cwd(),
			turnGeneration: 1,
			pendingCompletions: [],
			completionRequirements: [requirement],
			history: [],
			mailbox: [],
		},
	]);
	assert.equal(
		registry.get("sa_restored")?.completionRequirements?.[0]?.state,
		"cancelled",
		"restoring a non-running owner must terminalize a stale pending requirement",
	);
	registry.reconcileCompletionRequirements(restored.records, true);
	assert.equal(registry.get("sa_restored")?.completionRequirements?.[0]?.state, "cancelled");
	assert.equal(
		registry.get("sa_restored")?.completionRequirements?.[0]?.terminalState,
		"interrupted",
		"forking before completion must not inherit a future branch's visible success",
	);
	registry.reconcileCompletionRequirements(new Map(), true);
	assert.deepEqual(registry.get("sa_restored")?.completionRequirements, []);
});

test("required completion capacity fails before an unrepresentable dependency is accepted", async () => {
	const registry = new AgentRegistry(
		{ kind: "fake", runTurn: async () => ({ output: "done", exitCode: 0 }) },
		{ maxAgents: 65 },
	);
	for (let index = 0; index < 64; index++) {
		const spawned = await registry.spawn({
			agent: "explorer",
			taskName: `required_${index}`,
			task: "inspect",
			cwd: process.cwd(),
			completionRequirement: "required",
		});
		await registry.wait(spawned.id, 1_000);
	}
	await assert.rejects(
		() =>
			registry.spawn({
				agent: "explorer",
				taskName: "required_overflow",
				task: "inspect",
				cwd: process.cwd(),
				completionRequirement: "required",
			}),
		/required subagent completion capacity reached/i,
	);
	assert.equal(registry.list().length, 64);
});

test("required completion context is canonical, bounded, and omits visible records", () => {
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
	assert.deepEqual(
		reconcileRequiredCompletionContext([], [{ ...agent, completionRequirements: [] }]),
		[],
		"background agents must not create a final-answer dependency block",
	);
	const ordinary = [{ role: "user", content: "continue" }] as never;
	assert.equal(
		reconcileRequiredCompletionContext(ordinary, [agent]),
		ordinary,
		"an unsummarized context must keep its persisted tool handoff instead of moving a block",
	);
	const summary = [
		{ role: "compactionSummary", summary: "Earlier work", tokensBefore: 100, timestamp: 0 },
	] as never;
	const first = reconcileRequiredCompletionContext(summary, [agent]);
	assert.equal(first.length, 2);
	const firstContent = String((first[1] as { content?: unknown } | undefined)?.content ?? "");
	assert.match(firstContent, /PI SUBAGENT REQUIRED COMPLETIONS/);
	assert.match(firstContent, /run:required/);
	assert.equal(
		reconcileRequiredCompletionContext(first, [agent]),
		first,
		"the canonical summary fallback must be idempotent",
	);

	const visiblePending = [
		...summary,
		{
			role: "toolResult",
			toolCallId: "spawn-call",
			toolName: "subagent_spawn",
			content: [{ type: "text", text: "spawned" }],
			details: { agent: { completionRequirements: [requirement] } },
			isError: false,
			timestamp: 0,
		},
	] as never;
	assert.equal(reconcileRequiredCompletionContext(visiblePending, [agent]), visiblePending);

	const available = {
		...requirement,
		state: "available" as const,
		completionId: "completion:required",
		terminalState: "completed" as const,
		updatedAt: 11,
	};
	agent.completionRequirements = [available];
	const availableContext = reconcileRequiredCompletionContext(summary, [agent]);
	assert.match(String((availableContext[1] as { content?: unknown }).content), /available/);
	const visibleCompletion = [
		...summary,
		{
			role: "custom",
			customType: "pi-subagent-completion",
			content: "completed",
			display: true,
			details: { completionRequirement: available },
			timestamp: 0,
		},
	] as never;
	assert.equal(reconcileRequiredCompletionContext(visibleCompletion, [agent]), visibleCompletion);

	const cancelled = Array.from({ length: 70 }, (_, index) => ({
		...requirement,
		runId: `run:cancelled:${index.toString().padStart(2, "0")}`,
		state: "cancelled" as const,
		terminalState: "interrupted" as const,
		updatedAt: 11 + index,
	}));
	agent.completionRequirements = cancelled;
	const bounded = reconcileRequiredCompletionContext(summary, [agent]);
	const boundedContent = String((bounded[1] as { content?: unknown }).content);
	assert.match(boundedContent, /6 older cancelled requirement record\(s\) were omitted/);
	assert.equal((boundedContent.match(/run:cancelled:/gu) ?? []).length, 64);

	agent.completionRequirements = [{ ...available, state: "visible" }];
	assert.deepEqual(reconcileRequiredCompletionContext(first, [agent]), summary);
});

test("successful budget finalization produces partial evidence, not success or failure", async () => {
	const registry = new AgentRegistry({
		kind: "fake",
		runTurn: async () => finalizedLimitOutcome("bounded partial evidence"),
	});
	const spawned = await registry.spawn({
		agent: "explorer",
		task: "inspect",
		cwd: process.cwd(),
		maxToolCalls: 2,
	});
	const settled = await registry.wait(spawned.id, 1_000);
	assert.equal(settled.agent.state, "partial");
	assert.equal(settled.agent.outcome?.status, "partial");
	assert.equal(settled.agent.outcome?.reasonCode, "tool_call_limit");
	assert.equal(settled.agent.termination?.finalization.status, "completed");
	assert.equal(settled.agent.telemetry?.budgetSource?.toolCallLimit, "explicit");
});

test("empty, failed, timed-out, and transport finalization paths remain failed", async () => {
	for (const outcome of [
		finalizedLimitOutcome(""),
		finalizedLimitOutcome("checkpoint only", "failed"),
		finalizedLimitOutcome("checkpoint only", "timed_out"),
	]) {
		const registry = new AgentRegistry({ kind: "fake", runTurn: async () => outcome });
		const spawned = await registry.spawn({
			agent: "explorer",
			task: "inspect",
			cwd: process.cwd(),
		});
		const settled = await registry.wait(spawned.id, 1_000);
		assert.equal(settled.agent.state, "failed");
		assert.notEqual(settled.agent.outcome?.status, "partial");
	}

	const transportFailure = new AgentRegistry({
		kind: "fake",
		runTurn: async () => {
			throw new Error("transport failed");
		},
	});
	const spawned = await transportFailure.spawn({
		agent: "explorer",
		task: "inspect",
		cwd: process.cwd(),
	});
	const settled = await transportFailure.wait(spawned.id, 1_000);
	assert.equal(settled.agent.state, "failed");
	assert.equal(settled.agent.outcome?.reasonCode, "transport-error");
});

test("malformed structured finalization remains contract-invalid", async () => {
	const registry = new AgentRegistry({
		kind: "fake",
		runTurn: async () => finalizedLimitOutcome("not-json"),
	});
	const spawned = await registry.spawn({
		agent: "explorer",
		task: "inspect",
		cwd: process.cwd(),
		resultFormat: "structured-v2",
	});
	const settled = await registry.wait(spawned.id, 1_000);
	assert.equal(settled.agent.state, "failed");
	assert.equal(settled.agent.outcome?.status, "contract-invalid");
	assert.equal(settled.agent.outcome?.reasonCode, "malformed-structured-result");
});
