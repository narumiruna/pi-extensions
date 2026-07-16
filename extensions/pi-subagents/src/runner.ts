import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope, AgentSource, SubagentThinkingLevel } from "./agents.js";
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
export type RecentActivityItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

const MAX_RECENT_ACTIVITY_ITEMS = 10;
const MAX_RECENT_ACTIVITY_BYTES = 8 * 1024;
const MAX_RECENT_ACTIVITY_ARGUMENT_BYTES = 1024;

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	actualProvider?: string;
	actualModel?: string;
	recentActivity?: RecentActivityItem[];
	recentActivityTotal?: number;
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
			const text = msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

export function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

export function isResultError(result: SingleResult): boolean {
	return (
		(result.exitCode !== 0 && result.exitCode !== -1) ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

export function formatResultFailure(result: SingleResult): string {
	const error = result.errorMessage || result.stderr.trim();
	const output = getResultFinalOutput(result);
	const combined =
		error && output ? `${error}\n\nPartial output:\n${output}` : error || output || "(no output)";
	return truncateUtf8(combined, DEFAULT_MAX_CONTEXT_BYTES).text;
}

function boundMessageText(
	message: Message,
	maxBytes: number,
): { message?: Message; bytes: number; truncated: boolean } {
	const originalBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
	if (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && originalBytes <= maxBytes) {
		return { message, bytes: originalBytes, truncated: false };
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { bytes: 0, truncated: true };

	const content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	> = [];
	const bounded = () => ({ ...message, content }) as Message;
	const fits = () => Buffer.byteLength(JSON.stringify(bounded()), "utf8") <= maxBytes;
	const addText = (text: string, prepend = false) => {
		if (!text.trim()) return;
		const part = { type: "text" as const, text: "" };
		if (prepend) content.unshift(part);
		else content.push(part);
		if (!fits()) {
			content.splice(content.indexOf(part), 1);
			return;
		}
		let low = 0;
		let high = Buffer.byteLength(text, "utf8");
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			part.text = truncateUtf8(text, middle).text;
			if (fits()) low = middle;
			else high = middle - 1;
		}
		part.text = truncateUtf8(text, low).text;
		if (!part.text.trim()) content.splice(content.indexOf(part), 1);
	};
	const addToolCall = (part: Extract<Message["content"][number], { type: "toolCall" }>) => {
		const toolCall = {
			type: "toolCall" as const,
			id: part.id,
			name: part.name,
			arguments: part.arguments,
		};
		content.unshift(toolCall);
		if (fits()) return;
		const arguments_: Record<string, unknown> = {};
		for (const key of ["command", "path", "file_path", "pattern", "url"]) {
			const value = part.arguments[key];
			if (typeof value === "string") arguments_[key] = truncateUtf8(value, 256).text;
		}
		toolCall.arguments = arguments_;
		if (fits()) return;
		toolCall.arguments = {};
		if (!fits()) content.shift();
	};

	if (message.role === "assistant") {
		for (let index = message.content.length - 1; index >= 0; index--) {
			const part = message.content[index];
			if (part.type === "text") addText(part.text, true);
			else if (part.type === "toolCall") addToolCall(part);
		}
	} else {
		for (const part of message.content) {
			if (typeof part === "object" && part && part.type === "text") addText(part.text);
		}
	}

	if (content.length === 0) return { bytes: 0, truncated: true };
	const result = bounded();
	const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
	return { message: result, bytes, truncated: true };
}
function compactRecentActivityArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_RECENT_ACTIVITY_ARGUMENT_BYTES)
		return args;
	const compact: Record<string, unknown> = {};
	for (const key of ["command", "path", "file_path", "pattern", "url", "selector"]) {
		const value = args[key];
		if (typeof value === "string") compact[key] = truncateUtf8(value, 256).text;
		else if (typeof value === "number" || typeof value === "boolean") compact[key] = value;
	}
	return compact;
}

function appendRecentActivity(result: SingleResult, message: Message): void {
	if (message.role !== "assistant") return;
	const append = (item: RecentActivityItem) => {
		result.recentActivity ??= [];
		result.recentActivityTotal = (result.recentActivityTotal ?? 0) + 1;
		result.recentActivity.push(item);
		if (result.recentActivity.length > MAX_RECENT_ACTIVITY_ITEMS) {
			result.recentActivity.splice(0, result.recentActivity.length - MAX_RECENT_ACTIVITY_ITEMS);
		}
		while (
			Buffer.byteLength(JSON.stringify(result.recentActivity), "utf8") > MAX_RECENT_ACTIVITY_BYTES
		) {
			result.recentActivity.shift();
		}
	};
	for (const part of message.content) {
		if (part.type === "text" && part.text.trim()) {
			append({ type: "text", text: truncateUtf8(part.text, 1024).text });
		} else if (part.type === "toolCall") {
			append({
				type: "toolCall",
				name: part.name,
				args: compactRecentActivityArguments(part.arguments),
			});
		}
	}
}

export function buildFanInContext(
	results: SingleResult[],
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
): string {
	const text = results
		.map((result, index) => {
			const failed = isResultError(result);
			const status = result.exitCode === -1 ? "running" : failed ? "failed" : "completed";
			const output = getResultFinalOutput(result);
			const error = result.errorMessage || result.stderr.trim();
			const resultText = failed
				? `${error ? "Error" : output ? "Partial output" : "Error"}:\n${formatResultFailure(result)}`
				: output
					? `Output:\n${output}`
					: "Output: (no output)";
			return [
				`## Result ${index + 1}: ${result.agent} (${status})`,
				`Task: ${result.task}`,
				resultText,
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

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
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

export function terminateProcess(
	proc: ReturnType<typeof spawn>,
	graceMs = KILL_GRACE_MS,
): () => void {
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
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			thinkingLevel,
			step,
			finalOutput: "",
		};
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	let latestAssistantOutput = "";
	let terminalAssistantOutput: string | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: agent.model ?? undefined,
		thinkingLevel,
		step,
		timeoutMs,
	};
	const selectedAssistantOutput = () =>
		terminalAssistantOutput !== undefined
			? terminalAssistantOutput
			: latestAssistantOutput || getFinalOutput(currentResult.messages);
	const setErrorMessage = (message: string) => {
		const bounded = truncateUtf8(message, DEFAULT_MAX_STDERR_BYTES);
		currentResult.errorMessage = bounded.text;
		currentResult.truncated ||= bounded.truncated;
		return bounded.text;
	};

	const emitUpdate = () => {
		const latest = truncateUtf8(selectedAssistantOutput(), DEFAULT_MAX_OUTPUT_BYTES);
		currentResult.finalOutput = latest.text;
		currentResult.truncated ||= latest.truncated;
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
			currentResult.stderr = setErrorMessage(`Invalid subagent cwd: ${effectiveCwd} (${reason})`);
			return currentResult;
		}

		if (signal?.aborted) {
			currentResult.exitCode = 130;
			currentResult.aborted = true;
			currentResult.stopReason = "aborted";
			setErrorMessage("Subagent was aborted before start");
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
				currentResult.stderr = setErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
				finish(1);
				return;
			}

			const addMessage = (msg: Message) => {
				const boundedMessage = boundMessageText(msg, DEFAULT_MAX_OUTPUT_BYTES - 2);
				currentResult.truncated ||= boundedMessage.truncated;
				if (!boundedMessage.message) return;
				while (
					currentResult.messages.length >= DEFAULT_MAX_MESSAGES ||
					Buffer.byteLength(
						JSON.stringify([...currentResult.messages, boundedMessage.message]),
						"utf8",
					) > DEFAULT_MAX_OUTPUT_BYTES
				) {
					const removed = currentResult.messages.shift();
					if (!removed) break;
					currentResult.truncated = true;
				}
				if (
					Buffer.byteLength(
						JSON.stringify([...currentResult.messages, boundedMessage.message]),
						"utf8",
					) > DEFAULT_MAX_OUTPUT_BYTES
				) {
					currentResult.truncated = true;
					return;
				}
				currentResult.messages.push(boundedMessage.message);
			};
			const processEvent = (raw: unknown) => {
				if (!raw || typeof raw !== "object") return;
				const event = raw as { type?: string; message?: Message };
				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					if (msg.role === "assistant") {
						const output = truncateUtf8(getFinalOutput([msg]), DEFAULT_MAX_OUTPUT_BYTES);
						currentResult.truncated ||= output.truncated;
						if (output.text) latestAssistantOutput = output.text;
						if (msg.stopReason === "stop" || msg.stopReason === "length") {
							terminalAssistantOutput = output.text;
						}
					}
					appendRecentActivity(currentResult, msg);
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
						if (msg.provider) currentResult.actualProvider = msg.provider;
						if (msg.responseModel ?? msg.model)
							currentResult.actualModel = msg.responseModel ?? msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) setErrorMessage(msg.errorMessage);
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
				setErrorMessage(`Subagent timed out after ${timeoutMs}ms`);
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
				const bounded = appendBounded(
					currentResult.stderr,
					data.toString(),
					DEFAULT_MAX_STDERR_BYTES,
				);
				currentResult.stderr = bounded.text;
				currentResult.truncated ||= bounded.truncated;
			});
			proc.on("close", (code) => {
				decoder.finish();
				finish(timedOut ? 124 : wasAborted ? 130 : (code ?? 0));
			});
			proc.on("error", (error) => {
				const message = setErrorMessage(error.message);
				const bounded = appendBounded(
					currentResult.stderr,
					`${currentResult.stderr ? "\n" : ""}${message}`,
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
					setErrorMessage("Subagent was aborted");
					cleanupTermination = terminateProcess(proc);
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		const final = truncateUtf8(selectedAssistantOutput(), DEFAULT_MAX_OUTPUT_BYTES);
		currentResult.finalOutput = final.text;
		currentResult.truncated ||= final.truncated;
		if (
			currentResult.exitCode === 0 &&
			currentResult.stopReason !== "error" &&
			(currentResult.stopReason === "toolUse" || !currentResult.finalOutput.trim())
		) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			setErrorMessage("Subagent completed without final text");
		}
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
