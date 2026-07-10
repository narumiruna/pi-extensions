import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	AgentConfig,
	AgentScope,
	AgentSource,
	SubagentThinkingLevel,
} from "./agents.js";

const KILL_GRACE_MS = 5000;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	finalOutput?: string;
	timedOut?: boolean;
	timeoutMs?: number;
}

export interface SubagentDetails {
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

export function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

export function buildFanInContext(results: SingleResult[]): string {
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

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

export function buildPiArgs(options: {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools?: string[];
	systemPromptPath?: string;
	task: string;
}): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (Array.isArray(options.tools)) {
		if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
		else args.push("--no-tools");
	}
	if (options.systemPromptPath) args.push("--append-system-prompt", options.systemPromptPath);
	args.push(`Task: ${options.task}`);
	return args;
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

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: SubagentThinkingLevel | undefined,
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
			thinkingLevel,
			step,
			finalOutput: "",
		};
	}

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
		model: agent.model ?? undefined,
		thinkingLevel,
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
		}

		const args = buildPiArgs({
			model: agent.model,
			thinkingLevel,
			tools: agent.tools,
			systemPromptPath: tmpPromptPath ?? undefined,
			task,
		});
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

