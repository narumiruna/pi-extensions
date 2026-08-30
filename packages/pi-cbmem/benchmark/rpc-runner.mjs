import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import {
	buildPrompt,
	CBMEM_READ_ONLY_TOOLS,
	READ_ONLY_TOOLS,
	scoreTrial,
	sha256,
} from "./core.mjs";

const STDERR_LIMIT = 16 * 1024;

export async function runPiTrial({ arm, evidencePacket, options, repetition, signal, task }) {
	signal?.throwIfAborted();
	const cacheNonce =
		options.cacheMode === "cold" ? `${options.suite.id}:${task.id}:${repetition}` : undefined;
	const args = buildPiArguments({ arm, cacheNonce, options, task });
	const processStarted = performance.now();
	const rpc = new RpcProcess(options.pi, args, {
		cwd: options.repo,
		env: process.env,
	});
	const onAbort = () => rpc.kill(abortReason(signal));
	signal?.addEventListener("abort", onAbort, { once: true });
	let timeout;
	try {
		const execution = executeTrial({
			arm,
			evidencePacket,
			processStarted,
			rpc,
			task,
		});
		const deadline = new Promise((_, reject) => {
			timeout = setTimeout(() => {
				const error = new Error(`trial exceeded ${options.timeoutMs}ms`);
				rpc.kill(error);
				reject(error);
			}, options.timeoutMs);
		});
		return await Promise.race([execution, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		await rpc.close();
	}
}

export function buildPiArguments({ arm, cacheNonce, options, task }) {
	const activeTools =
		task.kind === "exact-payload" && arm === "baseline"
			? []
			: arm === "baseline"
				? READ_ONLY_TOOLS
				: [...READ_ONLY_TOOLS, ...CBMEM_READ_ONLY_TOOLS];
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"-ne",
		"-ns",
		"-np",
		"--no-themes",
		"-nc",
		"-na",
		"--model",
		options.model ?? "<required-for-live>",
		"--thinking",
		options.thinking,
	];
	if (activeTools.length === 0) args.push("--no-tools");
	else args.push("--tools", activeTools.join(","));
	if (arm === "cbmem") args.push("-e", options.extension);
	if (cacheNonce) {
		args.push("--append-system-prompt", `Benchmark cold-cache nonce: ${cacheNonce}`);
	}
	return args;
}

async function executeTrial({ arm, evidencePacket, processStarted, rpc, task }) {
	await rpc.send({ type: "set_auto_compaction", enabled: false });
	await rpc.send({ type: "set_auto_retry", enabled: false });
	const commandsResponse = await rpc.send({ type: "get_commands" });
	const startupMs = performance.now() - processStarted;
	const packageProvenance =
		arm === "cbmem"
			? await readPackageProvenance(commandsResponse.data?.commands ?? [])
			: undefined;
	if (arm === "cbmem" && !packageProvenance) {
		throw new Error("treatment did not expose the codebase-memory package skill");
	}

	const prompt = buildPrompt({ arm, task, evidencePacket });
	rpc.beginPrompt(task);
	const promptStarted = performance.now();
	const promptResponse = await rpc.send({ type: "prompt", message: prompt });
	if (!promptResponse.success)
		throw new Error(`prompt rejected: ${promptResponse.error ?? "unknown"}`);
	await rpc.waitForSettled();
	const settledAt = performance.now();
	const statsResponse = await rpc.send({ type: "get_session_stats" });
	const processWallMs = settledAt - processStarted;
	const agentWallMs = settledAt - promptStarted;
	const captured = rpc.capture();
	const usage = normalizeUsage(statsResponse.data?.tokens, statsResponse.data?.cost);
	const score = scoreTrial({
		arm,
		task,
		responseText: captured.responseText,
		toolCalls: captured.toolCalls,
		toolResults: captured.toolResults,
		evidencePacket,
	});
	if (captured.extensionErrors.length > 0) {
		score.success = false;
		score.errors.push("Pi reported an extension error");
	}
	return {
		arm,
		taskId: task.id,
		kind: task.kind,
		score,
		metrics: {
			startupMs: round(startupMs),
			agentWallMs: round(agentWallMs),
			processWallMs: round(processWallMs),
			nonToolResidualMsApprox: round(
				Math.max(0, agentWallMs - captured.toolDurationsMs.reduce((sum, value) => sum + value, 0)),
			),
			toolDurationSumMs: round(captured.toolDurationsMs.reduce((sum, value) => sum + value, 0)),
			timeToFirstToolMs: captured.timeToFirstToolMs,
			timeToEvidenceCompleteMs: captured.timeToEvidenceCompleteMs,
			turns: captured.turns,
			providerRequests: captured.assistantUsages.length,
			toolCalls: captured.toolCalls.length,
			toolResultBytes: captured.toolResults.reduce(
				(total, result) => total + Buffer.byteLength(result.text, "utf8"),
				0,
			),
			usage,
			requestUsage: captured.assistantUsages.map(normalizeAssistantUsage),
		},
		method: {
			piArguments: redactArguments(rpc.args),
			toolCalls: captured.toolCalls,
			toolResults: captured.toolResults.map(({ text, ...result }) => ({
				...result,
				bytes: Buffer.byteLength(text, "utf8"),
				sha256: sha256(text),
			})),
			extensionErrors: captured.extensionErrors,
		},
		response: {
			bytes: Buffer.byteLength(captured.responseText, "utf8"),
			sha256: sha256(captured.responseText),
		},
		...(packageProvenance ? { package: packageProvenance } : {}),
	};
}

class RpcProcess {
	constructor(command, args, options) {
		this.args = args;
		this.child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
		this.commandId = 0;
		this.pending = new Map();
		this.stderr = "";
		this.failed = undefined;
		this.settledResolve = undefined;
		this.settledReject = undefined;
		this.settledPromise = new Promise((resolve, reject) => {
			this.settledResolve = resolve;
			this.settledReject = reject;
		});
		this.settledPromise.catch(() => undefined);
		this.promptStarted = undefined;
		this.task = undefined;
		this.toolStarts = new Map();
		this.toolCalls = [];
		this.toolResults = [];
		this.toolDurationsMs = [];
		this.assistantUsages = [];
		this.responseText = "";
		this.turns = 0;
		this.timeToFirstToolMs = undefined;
		this.timeToEvidenceCompleteMs = undefined;
		this.extensionErrors = [];
		this.evidenceText = "";
		this.closed = false;

		attachJsonlReader(this.child.stdout, (line) => this.onLine(line));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = boundedTail(this.stderr + chunk.toString("utf8"), STDERR_LIMIT);
		});
		this.exitPromise = new Promise((resolve) => {
			this.child.once("exit", (code, exitSignal) => {
				if (!this.closed && this.promptStarted !== undefined && !this.failed) {
					this.fail(
						new Error(
							`Pi exited before agent_settled (code=${code}, signal=${exitSignal ?? "none"})`,
						),
					);
				}
				resolve({ code, signal: exitSignal });
			});
		});
		this.child.stdin.on("error", () => {
			// Command callbacks and child events report protocol/process failures.
		});
		this.child.once("error", (error) => this.fail(error));
	}

	beginPrompt(task) {
		this.task = task;
		this.promptStarted = performance.now();
	}

	send(command) {
		if (this.failed) return Promise.reject(this.failed);
		const id = `benchmark-${++this.commandId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	waitForSettled() {
		return this.settledPromise;
	}

	capture() {
		return {
			assistantUsages: structuredClone(this.assistantUsages),
			extensionErrors: structuredClone(this.extensionErrors),
			responseText: this.responseText,
			timeToEvidenceCompleteMs: this.timeToEvidenceCompleteMs,
			timeToFirstToolMs: this.timeToFirstToolMs,
			toolCalls: structuredClone(this.toolCalls),
			toolDurationsMs: [...this.toolDurationsMs],
			toolResults: structuredClone(this.toolResults),
			turns: this.turns,
		};
	}

	onLine(line) {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch (error) {
			this.fail(new Error(`Pi emitted invalid RPC JSON: ${error}`));
			return;
		}
		if (message.type === "response" && message.id) {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.success) waiter.resolve(message);
			else waiter.reject(new Error(`${message.command} failed: ${message.error ?? "unknown"}`));
			return;
		}
		this.onEvent(message);
	}

	onEvent(event) {
		const elapsed =
			this.promptStarted === undefined ? undefined : performance.now() - this.promptStarted;
		if (event.type === "tool_execution_start") {
			this.toolStarts.set(event.toolCallId, performance.now());
			this.toolCalls.push({ name: event.toolName, args: event.args });
			if (this.timeToFirstToolMs === undefined && elapsed !== undefined) {
				this.timeToFirstToolMs = round(elapsed);
			}
		} else if (event.type === "tool_execution_end") {
			const started = this.toolStarts.get(event.toolCallId);
			if (started !== undefined) this.toolDurationsMs.push(performance.now() - started);
			const text = resultText(event.result);
			this.toolResults.push({ name: event.toolName, isError: event.isError, text });
			this.evidenceText += `\n${text}`;
			if (
				this.timeToEvidenceCompleteMs === undefined &&
				this.task?.facts.every((fact) => this.evidenceText.includes(fact.expected)) &&
				elapsed !== undefined
			) {
				this.timeToEvidenceCompleteMs = round(elapsed);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			this.responseText = assistantText(event.message);
			if (event.message.usage) this.assistantUsages.push(event.message.usage);
		} else if (event.type === "turn_end") this.turns += 1;
		else if (event.type === "extension_error") this.extensionErrors.push(event);
		else if (event.type === "agent_settled") this.settledResolve();
	}

	fail(error) {
		if (this.failed) return;
		this.failed = error instanceof Error ? error : new Error(String(error));
		for (const waiter of this.pending.values()) waiter.reject(this.failed);
		this.pending.clear();
		this.settledReject(this.failed);
	}

	kill(error) {
		this.fail(error);
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
		setTimeout(() => {
			if (this.child.exitCode === null && this.child.signalCode === null)
				this.child.kill("SIGKILL");
		}, 1_000).unref();
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
		let cleanupTimer;
		const cleanupDeadline = new Promise((resolve) => {
			cleanupTimer = setTimeout(() => {
				if (this.child.exitCode === null && this.child.signalCode === null)
					this.child.kill("SIGKILL");
				resolve(undefined);
			}, 5_000);
		});
		await Promise.race([this.exitPromise, cleanupDeadline]);
		if (cleanupTimer) clearTimeout(cleanupTimer);
		const exit = await this.exitPromise;
		if (!this.failed && exit.code !== 0) {
			throw new Error(
				`Pi exited with code ${exit.code} (signal=${exit.signal ?? "none"}): ${this.stderr.trim()}`,
			);
		}
	}
}

async function readPackageProvenance(commands) {
	const skill = commands.find((command) => command.name === "skill:codebase-memory");
	const skillPath = skill?.path ?? skill?.sourceInfo?.path;
	if (!skillPath) return undefined;
	let current = path.dirname(skillPath);
	while (true) {
		const manifestPath = path.join(current, "package.json");
		try {
			const text = await readFile(manifestPath, "utf8");
			const manifest = JSON.parse(text);
			if (manifest.name === "@narumitw/pi-cbmem") {
				return {
					name: manifest.name,
					version: manifest.version,
					manifestSha256: createHash("sha256").update(text).digest("hex"),
				};
			}
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function normalizeAssistantUsage(usage) {
	return normalizeUsage(usage, usage?.cost?.total);
}

function normalizeUsage(tokens, cost) {
	const input = finite(tokens?.input);
	const output = finite(tokens?.output);
	const cacheRead = finite(tokens?.cacheRead);
	const cacheWrite = finite(tokens?.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		providerTokens: input + output + cacheRead + cacheWrite,
		costUsd: finite(cost),
	};
}

function assistantText(message) {
	return (message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function resultText(result) {
	return (result?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function attachJsonlReader(stream, onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	stream.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		while (true) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});
	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
	});
}

function redactArguments(args) {
	return args.map((argument) =>
		argument.startsWith("Benchmark cold-cache nonce:")
			? "Benchmark cold-cache nonce: <redacted>"
			: argument,
	);
}

function boundedTail(value, maxBytes) {
	const buffer = Buffer.from(value, "utf8");
	return buffer.length <= maxBytes
		? value
		: buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function abortReason(signal) {
	return signal?.reason instanceof Error
		? signal.reason
		: new DOMException("benchmark trial aborted", "AbortError");
}

function round(value) {
	return Number(value.toFixed(3));
}
