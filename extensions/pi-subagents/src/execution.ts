import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	discoverAgents,
	type AgentConfig,
	type AgentScope,
	type SubagentThinkingLevel,
} from "./agents.js";
import {
	buildFanInContext,
	getResultFinalOutput,
	mapWithConcurrencyLimit,
	runSingleAgent,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { SubagentParams } from "./params.js";
import { readSubagentSettings, resolveSubagentThinkingLevel } from "./settings.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
export const FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_KEY = "subagents";
const activeStatuses = new Map<string, string>();

export function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveDefaultSubagentTimeoutMs(): number {
	return parsePositiveInteger(process.env.PI_SUBAGENT_TIMEOUT_MS) ?? FALLBACK_TIMEOUT_MS;
}

export function assertSubagentDepthAllowed(): void {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const maxDepth = parsePositiveInteger(process.env.PI_SUBAGENT_MAX_DEPTH) ?? 1;
	if (depth >= maxDepth) {
		throw new Error(`Subagent recursion depth limit reached (${maxDepth})`);
	}
}

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

function startSubagentStatus(ctx: StatusContext, toolCallId: string, status: string) {
	let cleared = false;

	const update = (nextStatus: string) => {
		if (cleared) return;
		activeStatuses.set(toolCallId, nextStatus);
		publishSubagentStatus(ctx);
	};

	update(status);

	return {
		update,
		clear() {
			if (cleared) return;
			cleared = true;
			activeStatuses.delete(toolCallId);
			publishSubagentStatus(ctx);
		},
	};
}

function publishSubagentStatus(ctx: StatusContext) {
	const statuses = [...activeStatuses.values()];
	if (statuses.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const suffix = statuses.length > 1 ? ` +${statuses.length - 1}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${statuses[0]}${suffix}`);
}

function singleStatus(agent: string): string {
	return `${agent}`;
}

function chainStatus(step: number, total: number, agent?: string): string {
	return `chain ${step}/${total}${agent ? ` ${agent}` : ""}`;
}

function parallelStatus(done: number, total: number, running: number): string {
	return `parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}`;
}

function fanInStatus(agent: string): string {
	return `fan-in ${agent}`;
}

export async function executeSubagent(
	toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
			assertSubagentDepthAllowed();
			const agentScope: AgentScope = params.agentScope ?? "user";
			const config = readSubagentSettings();
			const discovery = discoverAgents(ctx.cwd, agentScope, config);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const resolveTimeoutMs = (agentName: string, localTimeoutMs?: number) =>
				localTimeoutMs ??
				params.timeoutMs ??
				agents.find((agent) => agent.name === agentName)?.timeoutMs ??
				resolveDefaultSubagentTimeoutMs();
			const resolveThinkingLevel = (agentName: string, localThinkingLevel?: SubagentThinkingLevel) =>
				resolveSubagentThinkingLevel(agents, agentName, params.thinkingLevel, localThinkingLevel);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[], aggregator?: SingleResult): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					aggregator,
				});

			if (modeCount !== 1 || (params.aggregator && !hasTasks)) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				const reason =
					modeCount !== 1
						? "Provide exactly one mode."
						: "Aggregator is only valid with parallel tasks.";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. ${reason}\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.aggregator) requestedAgentNames.add(params.aggregator.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					if (!ctx.isProjectTrusted()) {
						throw new Error("Project-local subagent definitions require a trusted project");
					}
					if (confirmProjectAgents && ctx.hasUI) {
						const names = projectAgentsRequested.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok) {
							return {
								content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
								details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							};
						}
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const status = startSubagentStatus(ctx, toolCallId, chainStatus(0, params.chain.length));

				try {
					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						status.update(chainStatus(i + 1, params.chain.length, step.agent));
						const taskWithContext = truncateUtf8(
							step.task.replace(/\{previous\}/g, previousOutput),
							DEFAULT_MAX_CONTEXT_BYTES,
						).text;

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									// Combine completed results with current streaming result
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							resolveThinkingLevel(step.agent, step.thinkingLevel),
							resolveTimeoutMs(step.agent, step.timeoutMs),
							chainUpdate,
							makeDetails("chain"),
						);
						results.push(result);

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg = result.errorMessage || result.stderr || getResultFinalOutput(result) || "(no output)";
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
								details: { ...makeDetails("chain")(results), isError: true },
								isError: true,
							};
						}
						previousOutput = getResultFinalOutput(result);
					}
					return {
						content: [{ type: "text", text: getResultFinalOutput(results[results.length - 1]) || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				} finally {
					status.clear();
				}
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const status = startSubagentStatus(ctx, toolCallId, parallelStatus(0, params.tasks.length, params.tasks.length));

				try {
					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1, // -1 = still running
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							thinkingLevel: resolveThinkingLevel(params.tasks[i].agent, params.tasks[i].thinkingLevel),
							finalOutput: "",
						};
					}

					let doneCount = 0;
					let runningCount = params.tasks.length;

					const emitParallelUpdate = () => {
						status.update(parallelStatus(doneCount, allResults.length, runningCount));
						if (onUpdate) {
							onUpdate({
								content: [
									{
										type: "text",
										text: `Parallel: ${doneCount}/${allResults.length} done, ${runningCount} running...`,
									},
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							resolveThinkingLevel(t.agent, t.thinkingLevel),
							resolveTimeoutMs(t.agent, t.timeoutMs),
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = { ...partial.details.results[0], exitCode: -1 };
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						doneCount += 1;
						runningCount -= 1;
						emitParallelUpdate();
						return result;
					}, signal, (task, index) => {
						const skipped: SingleResult = {
							...allResults[index],
							task: task.task,
							exitCode: 130,
							stopReason: "aborted",
							aborted: true,
							errorMessage: "Subagent was not started because the parent call was aborted",
						};
						allResults[index] = skipped;
						doneCount += 1;
						runningCount -= 1;
						emitParallelUpdate();
						return skipped;
					});

					let aggregatorResult: SingleResult | undefined;
					if (params.aggregator && !signal?.aborted) {
						const aggregator = params.aggregator;
						status.update(fanInStatus(aggregator.agent));
						const fanInContext = buildFanInContext(results);
						const aggregatorTask = truncateUtf8(
							aggregator.task.includes("{previous}")
								? aggregator.task.replace(/\{previous\}/g, fanInContext)
								: `${aggregator.task}\n\nParallel task outputs:\n\n${fanInContext}`,
							DEFAULT_MAX_CONTEXT_BYTES,
						).text;
						aggregatorResult = await runSingleAgent(
							ctx.cwd,
							agents,
							aggregator.agent,
							aggregatorTask,
							aggregator.cwd,
							undefined,
							signal,
							resolveThinkingLevel(aggregator.agent, aggregator.thinkingLevel),
							resolveTimeoutMs(aggregator.agent, aggregator.timeoutMs),
							(partial) => {
								status.update(fanInStatus(aggregator.agent));
								if (onUpdate && partial.details?.results[0]) {
									onUpdate({
										content: partial.content,
										details: makeDetails("parallel")(results, partial.details.results[0]),
									});
								}
							},
							makeDetails("parallel"),
						);
					}

					const successCount = results.filter((r) => r.exitCode === 0).length;
					const summaries = results.map((r) => {
						const output = getResultFinalOutput(r);
						const error = r.errorMessage || r.stderr.trim();
						const summaryText = output || error;
						const preview = summaryText.slice(0, 160) + (summaryText.length > 160 ? "..." : "");
						return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
					});
					const aggregatorOutput = aggregatorResult ? getResultFinalOutput(aggregatorResult) : "";
					const aggregatorError = aggregatorResult?.errorMessage || aggregatorResult?.stderr.trim() || "";
					return {
						content: [
							{
								type: "text",
								text: aggregatorResult
									? aggregatorOutput || aggregatorError || `(aggregator ${aggregatorResult.agent} produced no output)`
									: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
							},
						],
						details: {
							...makeDetails("parallel")(results, aggregatorResult),
							isError: aggregatorResult
								? aggregatorResult.exitCode !== 0 ||
									aggregatorResult.stopReason === "error" ||
									aggregatorResult.stopReason === "aborted"
								: false,
						},
						isError: aggregatorResult
							? aggregatorResult.exitCode !== 0 ||
								aggregatorResult.stopReason === "error" ||
								aggregatorResult.stopReason === "aborted"
							: undefined,
					};
				} finally {
					status.clear();
				}
			}

			if (params.agent && params.task) {
				const status = startSubagentStatus(ctx, toolCallId, singleStatus(params.agent));

				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						params.agent,
						params.task,
						params.cwd,
						undefined,
						signal,
						resolveThinkingLevel(params.agent, params.thinkingLevel),
						resolveTimeoutMs(params.agent, params.timeoutMs),
						onUpdate,
						makeDetails("single"),
					);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getResultFinalOutput(result) || "(no output)";
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: { ...makeDetails("single")([result]), isError: true },
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: getResultFinalOutput(result) || "(no output)" }],
						details: makeDetails("single")([result]),
					};
				} finally {
					status.clear();
				}
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
}
