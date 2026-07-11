import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import type { ManagedAgent, TurnOutcome } from "./registry.js";
import { getResultFinalOutput, runSingleAgent, type SubagentDetails } from "./runner.js";
import { readSubagentSettings, resolveSubagentThinkingLevel } from "./settings.js";
import {
	buildStatefulTurnPrompt,
	resolveStatefulTurnTimeout,
} from "./stateful-prompt.js";
import type { SubagentTransport } from "./transport.js";

export class SubprocessTransport implements SubagentTransport {
	readonly kind = "subprocess" as const;

	constructor(private readonly ctx: ExtensionContext) {}

	async runTurn(record: ManagedAgent, task: string, signal: AbortSignal): Promise<TurnOutcome> {
		const settings = readSubagentSettings();
		const discovery = discoverAgents(record.cwd, record.agentScope ?? "user", settings);
		const agent = discovery.agents.find((candidate) => candidate.name === record.agent);
		const boundedTask = buildStatefulTurnPrompt(record, task);
		const makeDetails = (results: SubagentDetails["results"]): SubagentDetails => ({
			mode: "single",
			agentScope: record.agentScope ?? "user",
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});
		const single = await runSingleAgent(
			record.cwd,
			discovery.agents,
			record.agent,
			boundedTask.text,
			undefined,
			undefined,
			signal,
			resolveSubagentThinkingLevel(discovery.agents, record.agent),
			resolveStatefulTurnTimeout(agent),
			undefined,
			makeDetails,
		);
		return {
			output: getResultFinalOutput(single),
			exitCode: single.exitCode,
			aborted: single.aborted,
			truncated: single.truncated || boundedTask.truncated,
			error: single.errorMessage || single.stderr || undefined,
			policy: single.policy,
		};
	}
}
