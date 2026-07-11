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
import {
	appendBounded,
	DEFAULT_MAX_CONTEXT_BYTES,
	DEFAULT_MAX_MESSAGES,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_MAX_STDERR_BYTES,
	truncateUtf8,
} from "./limits.js";
import { JsonLineDecoder } from "./protocol.js";

export const KILL_GRACE_MS = 5000;

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
	aborted?: boolean;
	truncated?: boolean;
	malformedEvents?: number;
	policy?: {
		inherited: string[];
		overridden: string[];
		unsupported: string[];
	};
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	aggregator?: SingleResult;
	isError?: boolean;
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

function boundMessageText(message: Message, maxBytes: number): { message: Message; bytes: number; truncated: boolean } {
	const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
	if (serializedBytes <= maxBytes) return { message, bytes: serializedBytes, truncated: false };
	if (!Array.isArray(message.content)) return { message, bytes: Math.min(serializedBytes, maxBytes), truncated: true };
	let remaining = maxBytes;
	const content = message.content
		.filter((part) => part.type === "text")
		.map((part) => {
			const bounded = truncateUtf8(part.text, remaining);
			remaining = Math.max(0, remaining - Buffer.byteLength(bounded.text, "utf8"));
			return { ...part, text: bounded.text };
		});
	const boundedMessage = { ...message, content } as Message;
	return {
		message: boundedMessage,
		bytes: Math.min(Buffer.byteLength(JSON.stringify(boundedMessage), "utf8"), maxBytes),
		truncated: true,
	};
}

export function buildFanInContext(results: SingleResult[], maxBytes = DEFAULT_MAX_CONTEXT_BYTES): string {
	const text = results
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
	return truncateUtf8(text, maxBytes).text;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	signal?: AbortSignal,
	onSkipped?: (item: TIn, index: number) => TOut,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			if (signal?.aborted && onSkipped) {
				results[current] = onSkipped(items[current], current);
				continue;
			}
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

function signalProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// Fall back to signaling the immediate child when process-group signaling is unavailable.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// The process may already have exited.
	}
}

export function terminateProcess(proc: ReturnType<typeof spawn>, graceMs = KILL_GRACE_MS): () => void {
	let closed = proc.exitCode !== null || proc.signalCode !== null;
	const onClose = () => {
		closed = true;
	};
	proc.once("close", onClose);
	if (!closed) signalProcess(proc, "SIGTERM");
	const escalation = setTimeout(() => {
		if (!closed) signalProcess(proc, "SIGKILL");
	}, graceMs);
	escalation.unref();
	return () => {
		clearTimeout(escalation);
		proc.off("close", onClose);
	};
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
	invocationOverride?: { command: string; argsPrefix?: string[] },
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
		const effectiveCwd = cwd ?? defaultCwd;
		try {
			if (!fs.statSync(effectiveCwd).isDirectory()) throw new Error("not a directory");
		} catch (error) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			const reason = error instanceof Error ? error.message : String(error);
			currentResult.errorMessage = `Invalid subagent cwd: ${effectiveCwd} (${reason})`;
			currentResult.stderr = currentResult.errorMessage;
			return currentResult;
		}

		if (signal?.aborted) {
			currentResult.exitCode = 130;
			currentResult.aborted = true;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted before start";
			return currentResult;
		}

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
			const invocation = invocationOverride
				? {
						command: invocationOverride.command,
						args: [...(invocationOverride.argsPrefix ?? []), ...args],
					}
				: getPiInvocation(args);
			let settled = false;
			let cleanupTermination: (() => void) | undefined;
			let timeout: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				cleanupTermination?.();
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};
			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: effectiveCwd,
					detached: process.platform !== "win32",
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						PI_SUBAGENT_DEPTH: String(
							(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1,
						),
					},
				});
			} catch (error) {
				currentResult.errorMessage = error instanceof Error ? error.message : String(error);
				currentResult.stderr = currentResult.errorMessage;
				finish(1);
				return;
			}

			let capturedMessageBytes = 0;
			const addMessage = (msg: Message) => {
				if (currentResult.messages.length >= DEFAULT_MAX_MESSAGES) {
					currentResult.truncated = true;
					return;
				}
				const remaining = Math.max(0, DEFAULT_MAX_OUTPUT_BYTES - capturedMessageBytes);
				const boundedMessage = boundMessageText(msg, remaining);
				capturedMessageBytes += boundedMessage.bytes;
				currentResult.truncated ||= boundedMessage.truncated;
				currentResult.messages.push(boundedMessage.message);
			};
			const processEvent = (raw: unknown) => {
				if (!raw || typeof raw !== "object") return;
				const event = raw as { type?: string; message?: Message };
				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					addMessage(msg);
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
				} else if (event.type === "tool_result_end" && event.message) {
					addMessage(event.message);
					emitUpdate();
				}
			};
			const decoder = new JsonLineDecoder({
				onValue: processEvent,
				onMalformed: () => {
					currentResult.malformedEvents = (currentResult.malformedEvents ?? 0) + 1;
				},
				onOversized: () => {
					currentResult.truncated = true;
				},
			});

			timeout = setTimeout(() => {
				timedOut = true;
				currentResult.timedOut = true;
				currentResult.stopReason = "timeout";
				currentResult.errorMessage = `Subagent timed out after ${timeoutMs}ms`;
				const bounded = appendBounded(
					currentResult.stderr,
					`\nSubagent timed out after ${timeoutMs}ms.`,
					DEFAULT_MAX_STDERR_BYTES,
				);
				currentResult.stderr = bounded.text;
				currentResult.truncated ||= bounded.truncated;
				emitUpdate();
				cleanupTermination = terminateProcess(proc);
			}, timeoutMs);
			timeout.unref();

			proc.stdout?.on("data", (data) => decoder.push(data));
			proc.stderr?.on("data", (data) => {
				const bounded = appendBounded(currentResult.stderr, data.toString(), DEFAULT_MAX_STDERR_BYTES);
				currentResult.stderr = bounded.text;
				currentResult.truncated ||= bounded.truncated;
			});
			proc.on("close", (code) => {
				decoder.finish();
				finish(timedOut ? 124 : wasAborted ? 130 : (code ?? 0));
			});
			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				const bounded = appendBounded(
					currentResult.stderr,
					`${currentResult.stderr ? "\n" : ""}${error.message}`,
					DEFAULT_MAX_STDERR_BYTES,
				);
				currentResult.stderr = bounded.text;
				currentResult.truncated ||= bounded.truncated;
				finish(1);
			});

			if (signal) {
				abortHandler = () => {
					if (timedOut || settled) return;
					wasAborted = true;
					currentResult.aborted = true;
					currentResult.stopReason = "aborted";
					currentResult.errorMessage = "Subagent was aborted";
					cleanupTermination = terminateProcess(proc);
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		const final = truncateUtf8(getFinalOutput(currentResult.messages), DEFAULT_MAX_OUTPUT_BYTES);
		currentResult.finalOutput = final.text;
		currentResult.truncated ||= final.truncated;
		currentResult.policy = {
			inherited: ["environment"],
			overridden: [
				"cwd",
				...(agent.model ? ["model"] : []),
				...(thinkingLevel ? ["thinkingLevel"] : []),
				...(agent.tools ? ["tools"] : []),
			],
			unsupported: ["approvalPolicy", "sandboxProfile", "providerHeaders"],
		};
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
