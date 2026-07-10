/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSubagentConfigCommand } from "./config-ui.js";
import { executeSubagent } from "./execution.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { THINKING_LEVELS } from "./agents.js";

const TimeoutMs = Type.Number({
	description:
		"Hard timeout in milliseconds for each subagent subprocess. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 1,
});

const ThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description: "Pi thinking level for the subagent process: off, minimal, low, medium, high, or xhigh.",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const AggregatorItem = Type.Object({
	agent: Type.String({ description: "Name of the fan-in agent to invoke after parallel tasks complete" }),
	task: Type.String({ description: "Fan-in task. Use {previous} to include all parallel outputs." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the aggregator process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	aggregator: Type.Optional(AggregatorItem),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel mode may include an aggregator fan-in step that receives all task outputs.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet:
			"Decide whether to spawn 0, 1, or multiple subagents for independent research, review, verification, or multi-step work in isolated Pi processes.",
		promptGuidelines: [
			"Use subagent only when delegation fits; the main agent should decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
			"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, or tasks requiring frequent user back-and-forth.",
			"Use one subagent for isolated research, broad command output, planning, or independent review/verification that benefits from a separate context.",
			"Use subagent parallel mode with 2-4 parallel read-only subagents when work has broad independent branches; prefer scout or reviewer for fan-out and add an aggregator when synthesis helps.",
			"Use more than 4 subagent tasks only when clearly justified by distinct independent branches, and stay within the existing hard max 8 parallel tasks.",
			"Do not use subagent parallel mode for write-heavy implementation touching the same files or shared state; serialize those changes in the main agent or one worker.",
			'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
			"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	});


	registerSubagentConfigCommand(pi);
}
export { formatTokens, formatUsageStats } from "./render.js";
export { buildPiArgs } from "./runner.js";
export {
	normalizeAgentSettings,
	normalizeSubagentSettings,
	resolveSubagentThinkingLevel,
	sameToolSet,
	uniqueToolNames,
} from "./settings.js";
export { parsePositiveInteger } from "./execution.js";
