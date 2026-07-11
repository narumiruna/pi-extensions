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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentConfigCommand } from "./config-ui.js";
import { SubagentParams } from "./params.js";
import { executeSubagent } from "./execution.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { SubagentDetails } from "./runner.js";
import { registerStatefulSubagents } from "./stateful.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof SubagentParams, SubagentDetails>({
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
			"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work needed for the main agent's next action.",
			"A single blocking subagent call should be used only when independent context, high-volume output isolation, or an external review is worth waiting for; otherwise do the task in the main agent.",
			"When subagent_spawn is available, use it only when detached delegation has a concrete parallel, isolation, or specialization benefit; otherwise keep the work in the main agent.",
			"After detached spawn, continue useful non-overlapping work when available, or call subagent_wait when coordination is the only useful next action; do not yield permanently while delegated work remains unresolved.",
			"Consume detached completion messages and synthesize their results before finishing; interrupt or close agents that are no longer needed.",
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

	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError) return { isError: true };
	});

	registerSubagentConfigCommand(pi);
	registerStatefulSubagents(pi);
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
