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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, type AgentSource, discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DEFAULT_TIMEOUT_MS = parsePositiveInteger(process.env.PI_SUBAGENT_TIMEOUT_MS) ?? 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const STATUS_KEY = "subagents";
const activeStatuses = new Map<string, string>();

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
	return `🧑‍🤝‍🧑 ${agent}`;
}

function chainStatus(step: number, total: number, agent?: string): string {
	return `🧑‍🤝‍🧑 chain ${step}/${total}${agent ? ` ${agent}` : ""}`;
}

function parallelStatus(done: number, total: number, running: number): string {
	return `🧑‍🤝‍🧑 parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}`;
}

function fanInStatus(agent: string): string {
	return `🧑‍🤝‍🧑 fan-in ${agent}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	finalOutput?: string;
	timedOut?: boolean;
	timeoutMs?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	aggregator?: SingleResult;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

function buildFanInContext(results: SingleResult[]): string {
	return results
		.map((result, index) => {
			const status = result.exitCode === 0 ? "completed" : result.exitCode === -1 ? "running" : "failed";
			const output = getResultFinalOutput(result);
			const error = result.errorMessage || result.stderr.trim();
			return [
				`## Result ${index + 1}: ${result.agent} (${status})`,
				`Task: ${result.task}`,
				output ? `Output:\n${output}` : error ? `Error:\n${error}` : "Output: (no output)",
			].join("\n\n");
		})
		.join("\n\n---\n\n");
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function terminateProcess(proc: ReturnType<typeof spawn>) {
	if (proc.killed) return;
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, "SIGTERM");
		} catch {
			proc.kill("SIGTERM");
		}
	} else {
		proc.kill("SIGTERM");
	}

	setTimeout(() => {
		if (proc.killed) return;
		if (process.platform !== "win32" && proc.pid) {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				proc.kill("SIGKILL");
			}
		} else {
			proc.kill("SIGKILL");
		}
	}, KILL_GRACE_MS).unref();
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			finalOutput: "",
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		timeoutMs,
	};

	const emitUpdate = () => {
		currentResult.finalOutput = getFinalOutput(currentResult.messages);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: currentResult.finalOutput || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let timedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			let settled = false;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(code);
			};
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const timeout = setTimeout(() => {
				timedOut = true;
				currentResult.timedOut = true;
				currentResult.stopReason = "timeout";
				currentResult.errorMessage = `Subagent timed out after ${timeoutMs}ms`;
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}Subagent timed out after ${timeoutMs}ms.`;
				emitUpdate();
				terminateProcess(proc);
			}, timeoutMs);
			timeout.unref();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(timedOut ? 124 : (code ?? 0));
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}${error.message}`;
				finish(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					currentResult.stopReason = "aborted";
					currentResult.errorMessage = "Subagent was aborted";
					terminateProcess(proc);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.finalOutput = getFinalOutput(currentResult.messages);
		if (wasAborted && !timedOut) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TimeoutMs = Type.Number({
	description:
		"Hard timeout in milliseconds for each subagent subprocess. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 1,
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
});

const AggregatorItem = Type.Object({
	agent: Type.String({ description: "Name of the fan-in agent to invoke after parallel tasks complete" }),
	task: Type.String({ description: "Fan-in task. Use {previous} to include all parallel outputs." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the aggregator process" })),
	timeoutMs: Type.Optional(TimeoutMs),
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
			"Delegate independent research, review, verification, or multi-step work to isolated Pi subagents.",
		promptGuidelines: [
			"Use subagent for independent read-only research, broad codebase reconnaissance, high-volume command output, multi-domain parallel investigation, or an independent reviewer after implementation.",
			"Use subagent parallel mode when work splits into independent tasks; prefer read-only agents such as scout or reviewer for fan-out and serialize write-heavy implementation that touches the same files.",
			"Do not use subagent for simple answers, quick targeted edits, latency-sensitive one-step work, or tasks requiring frequent user back-and-forth.",
			'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
			"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const defaultTimeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.aggregator) requestedAgentNames.add(params.aggregator.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
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
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

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
							step.timeoutMs ?? defaultTimeoutMs,
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
								details: makeDetails("chain")(results),
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
							t.timeoutMs ?? defaultTimeoutMs,
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
					});

					let aggregatorResult: SingleResult | undefined;
					if (params.aggregator) {
						const aggregator = params.aggregator;
						status.update(fanInStatus(aggregator.agent));
						const fanInContext = buildFanInContext(results);
						const aggregatorTask = aggregator.task.includes("{previous}")
							? aggregator.task.replace(/\{previous\}/g, fanInContext)
							: `${aggregator.task}\n\nParallel task outputs:\n\n${fanInContext}`;
						aggregatorResult = await runSingleAgent(
							ctx.cwd,
							agents,
							aggregator.agent,
							aggregatorTask,
							aggregator.cwd,
							undefined,
							signal,
							aggregator.timeoutMs ?? defaultTimeoutMs,
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
						details: makeDetails("parallel")(results, aggregatorResult),
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
						params.timeoutMs ?? defaultTimeoutMs,
						onUpdate,
						makeDetails("single"),
					);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getResultFinalOutput(result) || "(no output)";
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
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
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				if (args.aggregator) {
					const preview =
						args.aggregator.task.length > 40 ? `${args.aggregator.task.slice(0, 40)}...` : args.aggregator.task;
					text += `\n  ${theme.fg("muted", "fan-in → ")}${theme.fg("accent", args.aggregator.agent)}${theme.fg(
						"dim",
						` ${preview}`,
					)}`;
				}
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getResultFinalOutput(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getResultFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const aggregator = details.aggregator;
				const aggregatorRunning = aggregator?.exitCode === -1;
				const aggregatorFailed = aggregator ? aggregator.exitCode > 0 || aggregator.stopReason === "error" : false;
				const isRunning = running > 0 || aggregatorRunning;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0 || aggregatorFailed
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? aggregatorRunning
						? `${successCount + failCount}/${details.results.length} done, fan-in running`
						: `${successCount + failCount}/${details.results.length} done, ${running} running`
					: aggregator
						? `${successCount}/${details.results.length} tasks + fan-in`
						: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getResultFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					if (aggregator) {
						const rIcon = aggregator.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(aggregator.messages);
						const finalOutput = getResultFinalOutput(aggregator);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── fan-in → ") + theme.fg("accent", aggregator.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", aggregator.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const fanInUsage = formatUsageStats(aggregator.usage, aggregator.model);
						if (fanInUsage) container.addChild(new Text(theme.fg("dim", fanInUsage), 0, 0));
					}

					const usageResults = aggregator ? [...details.results, aggregator] : details.results;
					const usageStr = formatUsageStats(aggregateUsage(usageResults));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (aggregator) {
					const rIcon =
						aggregator.exitCode === -1
							? theme.fg("warning", "⏳")
							: aggregator.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(aggregator.messages);
					text += `\n\n${theme.fg("muted", "─── fan-in → ")}${theme.fg("accent", aggregator.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", aggregator.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageResults = aggregator ? [...details.results, aggregator] : details.results;
					const usageStr = formatUsageStats(aggregateUsage(usageResults));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
