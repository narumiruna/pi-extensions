import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { discoverAgents } from "./agents.js";
import { resolveTimeoutMs, runChild } from "./process.js";
import { type RuntimeDependencies, SubagentRuntime } from "./runtime.js";
import type { AgentDefinition, ChildResult } from "./types.js";

const MAX_TASK_BYTES = 50 * 1024;
const MAX_INSPECTED_AGENTS = 32;
const MAX_INSPECT_DESCRIPTION_BYTES = 240;

const StartParameters = Type.Object({
	agent: Type.String({ description: "Configured subagent name." }),
	task: Type.String({
		description: "Self-contained task, constraints, and expected result. Maximum 50 KiB.",
		maxLength: MAX_TASK_BYTES,
	}),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
});

type ExecutionArguments = Static<typeof StartParameters>;

const InspectParameters = Type.Object({});

const CancelParameters = Type.Object({
	jobId: Type.String({ description: "Job ID returned by subagent-v3-start." }),
});

const WaitParameters = Type.Object({
	jobId: Type.String({ description: "Job to wait for." }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
});

type WaitArguments = Static<typeof WaitParameters>;

const ConsultParameters = Type.Object({
	agent: Type.String({ description: "Configured subagent name." }),
	task: Type.String({
		description: "Self-contained research or review question. Maximum 50 KiB.",
		maxLength: MAX_TASK_BYTES,
	}),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
});

export interface SubagentToolsDependencies extends RuntimeDependencies {
	runConsultChild?: typeof runChild;
}

export interface RegisteredSubagentTools {
	shutdown(): Promise<void>;
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	dependencies: SubagentToolsDependencies = {},
): RegisteredSubagentTools {
	const runtime = new SubagentRuntime(pi, dependencies);
	const activeConsultControllers = new Set<AbortController>();
	const activeConsultWork = new Set<Promise<unknown>>();
	let generation = 0;

	pi.registerTool({
		name: "subagent-v3-start",
		label: "Subagent v3 · Start",
		description:
			"Start one bounded background subagent job and return its jobId immediately. The job has no follow-up turns and publishes one asynchronous completion when terminal. Optionally provide a timeout in seconds.",
		promptSnippet: "Start one bounded background subagent job",
		parameters: StartParameters,
		prepareArguments: prepareExecutionArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			throwIfAborted(signal, "Subagent start was cancelled");
			assertNotNested();
			const task = validateTask(params.task, "subagent-v3-start");
			const agent = requireAgent(ctx.cwd, ctx.isProjectTrusted(), params.agent);
			resolveTimeoutMs(params.timeout);
			const result = runtime.start({
				agent,
				task,
				cwd: ctx.cwd,
				timeout: params.timeout,
				projectTrusted: ctx.isProjectTrusted(),
			});
			return toolResult(result);
		},
	});

	pi.registerTool({
		name: "subagent-v3-inspect",
		label: "Subagent v3 · Inspect",
		description:
			"Return one bounded snapshot of available agents and retained jobs without exposing task text, complete child output, prompts, context, credentials, or environment variables.",
		promptSnippet: "Inspect available subagents and retained jobs",
		parameters: InspectParameters,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			throwIfAborted(signal, "Subagent inspection was cancelled");
			const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const listedAgents = discovery.agents.slice(0, MAX_INSPECTED_AGENTS).map((agent) => ({
				name: agent.name,
				description: boundedSummary(agent.description, MAX_INSPECT_DESCRIPTION_BYTES),
				source: agent.source,
			}));
			const jobs = runtime.inspectJobs();
			const result = {
				agents: listedAgents,
				jobs: jobs.jobs,
				omitted: {
					agents: discovery.omitted + Math.max(0, discovery.agents.length - MAX_INSPECTED_AGENTS),
					jobs: jobs.omitted,
				},
			};
			return toolResult(result);
		},
	});

	pi.registerTool({
		name: "subagent-v3-cancel",
		label: "Subagent v3 · Cancel",
		description:
			"Idempotently cancel one queued or running job and release its process, timer, session, and temporary resources. Terminal jobs remain unchanged.",
		promptSnippet: "Cancel one active subagent job",
		parameters: CancelParameters,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal, "Subagent cancellation was cancelled");
			return toolResult(await runtime.cancel(requiredString(params.jobId, "jobId")));
		},
	});

	pi.registerTool({
		name: "subagent-v3-wait",
		label: "Subagent v3 · Wait",
		description:
			"Wait for one job to become terminal. A wait timeout or caller cancellation stops only this wait and never cancels the job.",
		promptSnippet: "Wait for one subagent job to become terminal",
		parameters: WaitParameters,
		prepareArguments: prepareWaitArguments,
		async execute(_toolCallId, params, signal) {
			const timeoutMs = resolveTimeoutMs(params.timeout);
			const result = await runtime.wait(requiredString(params.jobId, "jobId"), timeoutMs, signal);
			return toolResult(result);
		},
	});

	pi.registerTool({
		name: "subagent-v3-consult",
		label: "Subagent v3 · Consult",
		description:
			"Run one synchronous ephemeral consultation with only enforced read-only Pi tools. Shell commands, writes, extensions, detached lifecycle tools, and session persistence are unavailable. Optionally provide a timeout in seconds.",
		promptSnippet: "Run one synchronous read-only subagent consultation",
		parameters: ConsultParameters,
		prepareArguments: prepareExecutionArguments,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			throwIfAborted(signal, "Subagent consultation was cancelled");
			assertNotNested();
			const ownerGeneration = generation;
			const task = validateTask(params.task, "subagent-v3-consult");
			const agent = requireAgent(ctx.cwd, ctx.isProjectTrusted(), params.agent);
			resolveTimeoutMs(params.timeout);
			const lifecycleController = new AbortController();
			activeConsultControllers.add(lifecycleController);
			const effectiveSignal = signal
				? AbortSignal.any([signal, lifecycleController.signal])
				: lifecycleController.signal;
			onUpdate?.({
				content: [{ type: "text", text: "Read-only subagent consultation starting." }],
				details: { agent: agent.name, state: "running" },
			});
			const executeConsult = dependencies.runConsultChild ?? runChild;
			const work = executeConsult({
				agent,
				task,
				cwd: ctx.cwd,
				timeout: params.timeout,
				projectTrusted: ctx.isProjectTrusted(),
				readOnly: true,
				signal: effectiveSignal,
			});
			activeConsultWork.add(work);
			let result: ChildResult;
			try {
				result = await work;
			} finally {
				activeConsultControllers.delete(lifecycleController);
				activeConsultWork.delete(work);
			}
			if (ownerGeneration !== generation || lifecycleController.signal.aborted) {
				throw abortError("Subagent consultation owner was replaced");
			}
			if (signal?.aborted) throw abortError("Subagent consultation was cancelled");
			return toolResult({
				agent: agent.name,
				state: result.state,
				...(result.result ? { result: result.result } : {}),
				...(result.error ? { error: result.error } : {}),
				limitations: result.limitations,
			});
		},
	});

	return {
		async shutdown() {
			generation++;
			for (const controller of activeConsultControllers) {
				controller.abort(new DOMException("Subagent session shut down", "AbortError"));
			}
			await Promise.allSettled([runtime.shutdown(), ...activeConsultWork]);
		},
	};
}

function requireAgent(cwd: string, projectTrusted: boolean, name: string): AgentDefinition {
	const normalized = requiredString(name, "agent");
	const discovery = discoverAgents(cwd, projectTrusted);
	const agent = discovery.agents.find((candidate) => candidate.name === normalized);
	if (agent) return agent;
	const available = discovery.agents
		.slice(0, MAX_INSPECTED_AGENTS)
		.map((candidate) => candidate.name)
		.join(", ");
	throw new Error(
		`Unknown subagent: ${safeText(normalized, 128)}. Available: ${available || "none"}.`,
	);
}

function validateTask(value: string, toolName: string): string {
	const task = requiredString(value, "task");
	if (task.includes("\0")) throw new Error(`${toolName} task must not contain NUL bytes.`);
	if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
		throw new Error(`${toolName} task must be at most ${MAX_TASK_BYTES} UTF-8 bytes.`);
	}
	return task;
}

function prepareExecutionArguments(args: unknown): ExecutionArguments {
	return prepareTimeoutArguments(args) as ExecutionArguments;
}

function prepareWaitArguments(args: unknown): WaitArguments {
	return prepareTimeoutArguments(args) as WaitArguments;
}

function prepareTimeoutArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return args as Record<string, unknown>;
	if (!Object.hasOwn(args, "timeoutMs")) return args as Record<string, unknown>;
	const { timeoutMs, ...prepared } = args as Record<string, unknown>;
	if (prepared.timeout === undefined && typeof timeoutMs === "number") {
		return { ...prepared, timeout: timeoutMs / 1000 };
	}
	return prepared;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${field} is required.`);
	return value.trim();
}

function assertNotNested(): void {
	if ((Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) > 0) {
		throw new Error("Nested subagents are not supported by pi-subagents-v3.");
	}
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted) throw abortError(message);
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function safeText(value: string, maxBytes: number): string {
	const sanitized = [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
			const isBidirectionalControl =
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069);
			return isControl || isBidirectionalControl ? "�" : character;
		})
		.join("");
	return boundedSummary(sanitized, maxBytes);
}

function boundedSummary(value: string, maxBytes: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	const bytes = Buffer.from(normalized, "utf8");
	if (bytes.length <= maxBytes) return normalized;
	return `${bytes
		.subarray(0, Math.max(0, maxBytes - 3))
		.toString("utf8")
		.replace(/�+$/gu, "")}…`;
}

function toolResult<T>(value: T): {
	content: Array<{ type: "text"; text: string }>;
	details: T;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}
