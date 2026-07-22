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
import { executeSubagent } from "./execution.js";
import { SubagentParams } from "./params.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { SubagentDetails } from "./runner.js";
import { consumeSubagentSettingsNotice, readSubagentSettings } from "./settings.js";
import { registerStatefulSubagents } from "./stateful.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof SubagentParams, SubagentDetails>({
		name: "subagent",
		label: "Blocking Subagent",
		description: [
			"Run specialized subagents as a blocking operation with isolated contexts.",
			"The call blocks the main agent until every worker and optional aggregator finishes, so queued steering waits.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel mode may include an aggregator fan-in step that receives all task outputs.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, pass agentScope: "both" (or "project") as a top-level argument for that call.',
		].join(" "),
		promptSnippet:
			"Run blocking isolated subagents only when their outputs are required before the main agent can continue.",
		promptGuidelines: [
			"Use subagent only when delegation fits; the main agent should decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
			"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work the main agent can perform directly.",
			"Use the blocking subagent tool only when delegated outputs are required before the main agent's next action and waiting is intentional; the main agent cannot process queued steering until the call returns.",
			"Use a blocking subagent single, parallel, chain, or fan-in call only when synchronous context or output isolation is worth making the main agent unavailable while it runs.",
			"If a blocking parallel subagent call is genuinely required, keep tasks independent, stay within the hard max 8, and avoid write-heavy implementation touching the same files or shared state.",
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
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError)
			return { isError: true };
	});

	pi.on("session_start", (_event, ctx) => {
		let notice = consumeSubagentSettingsNotice();
		if (!notice) {
			readSubagentSettings();
			notice = consumeSubagentSettingsNotice();
		}
		if (notice) ctx.ui.notify(notice, "warning");
	});

	const statefulRuntime = registerStatefulSubagents(pi);
	registerSubagentConfigCommand(pi, statefulRuntime);
}
export { parsePositiveInteger } from "./execution.js";
export { formatTokens, formatUsageStats } from "./render.js";
export { buildPiArgs } from "./runner.js";
export {
	inspectCompletionDeliverySettings,
	normalizeAgentSettings,
	normalizeSubagentSettings,
	readSubagentSettings,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	subagentSettingsFilePath,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
} from "./settings.js";
