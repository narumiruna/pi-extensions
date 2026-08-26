import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild as defaultRunChild } from "./process.js";
import {
	type AgentDefinition,
	type ChildRequest,
	type ChildResult,
	type JobSummary,
	type SubagentJobState,
	TERMINAL_JOB_STATES,
} from "./types.js";

const MAX_ACTIVE_JOBS = 8;
const MAX_RETAINED_TERMINAL_JOBS = 32;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const COMPLETION_MESSAGE_TYPE = "pi-subagents-v3-completion";

interface InternalJob extends JobSummary {
	controller: AbortController;
	terminal: Promise<void>;
	resolveTerminal: () => void;
	task?: Promise<void>;
	result?: string;
	error?: string;
	limitations: string[];
	deliverySent: boolean;
	generation: number;
}

export interface RuntimeDependencies {
	runChild?: (request: ChildRequest) => Promise<ChildResult>;
	now?: () => number;
}

export class SubagentRuntime {
	private readonly jobs = new Map<string, InternalJob>();
	private readonly runChild: (request: ChildRequest) => Promise<ChildResult>;
	private readonly now: () => number;
	private counter = 0;
	private generation = 0;
	private deliveryEnabled = true;
	private omittedJobs = 0;

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: RuntimeDependencies = {},
	) {
		this.runChild = dependencies.runChild ?? defaultRunChild;
		this.now = dependencies.now ?? Date.now;
	}

	start(input: {
		agent: AgentDefinition;
		task: string;
		cwd: string;
		timeout?: number;
		projectTrusted: boolean;
	}): { jobId: string; agent: string; state: "queued"; timeout?: number } {
		this.prune();
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.state)).length;
		if (active >= MAX_ACTIVE_JOBS) {
			throw new Error(`Active subagent job limit reached (${MAX_ACTIVE_JOBS}).`);
		}
		const jobId = `job_${this.now().toString(36)}_${(++this.counter).toString(36)}`;
		let resolveTerminal!: () => void;
		const terminal = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const controller = new AbortController();
		const job: InternalJob = {
			jobId,
			agent: input.agent.name,
			state: "queued",
			createdAt: this.now(),
			...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
			controller,
			terminal,
			resolveTerminal,
			limitations: [],
			deliverySent: false,
			generation: this.generation,
		};
		this.jobs.set(jobId, job);
		job.task = Promise.resolve().then(async () => {
			if (job.state !== "queued" || job.generation !== this.generation) return;
			job.state = "running";
			job.startedAt = this.now();
			let child: ChildResult;
			try {
				child = await this.runChild({
					agent: input.agent,
					task: input.task,
					cwd: input.cwd,
					timeout: input.timeout,
					projectTrusted: input.projectTrusted,
					readOnly: false,
					signal: controller.signal,
				});
			} catch (error) {
				child = {
					state: controller.signal.aborted ? "cancelled" : "failed",
					error: error instanceof Error ? error.message : String(error),
					limitations: [],
					truncated: false,
				};
			}
			if (job.state !== "running" || job.generation !== this.generation) return;
			this.finish(job, child, true);
		});
		return {
			jobId,
			agent: job.agent,
			state: "queued",
			...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
		};
	}

	inspectJobs(): { jobs: JobSummary[]; omitted: number } {
		this.prune();
		return {
			jobs: [...this.jobs.values()]
				.sort((left, right) => left.createdAt - right.createdAt)
				.map((job) => this.summary(job)),
			omitted: this.omittedJobs,
		};
	}

	async cancel(jobId: string): Promise<{ jobId: string; state: SubagentJobState }> {
		const job = this.requireJob(jobId);
		if (!isTerminal(job.state)) {
			this.finish(
				job,
				{
					state: "cancelled",
					error: "Subagent execution was cancelled.",
					limitations: [],
					truncated: false,
				},
				true,
			);
			job.controller.abort(new DOMException("Subagent job cancelled", "AbortError"));
		}
		await job.task;
		return { jobId, state: job.state };
	}

	async wait(
		jobId: string,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<{
		jobId: string;
		state: SubagentJobState;
		timedOut: boolean;
		result?: string;
		error?: string;
		limitations?: string[];
	}> {
		const job = this.requireJob(jobId);
		if (isTerminal(job.state)) return this.waitResult(job, false);
		if (signal?.aborted) throw abortError("Subagent wait was cancelled");
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const outcome = await Promise.race([
			job.terminal.then(() => "terminal" as const),
			...(timeoutMs !== undefined
				? [
						new Promise<"timeout">((resolve) => {
							timeout = setTimeout(() => resolve("timeout"), timeoutMs);
							timeout.unref();
						}),
					]
				: []),
			...(signal
				? [
						new Promise<"aborted">((resolve) => {
							onAbort = () => resolve("aborted");
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]
				: []),
		]);
		if (timeout) clearTimeout(timeout);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		if (outcome === "aborted") throw abortError("Subagent wait was cancelled");
		return this.waitResult(job, outcome === "timeout");
	}

	async shutdown(): Promise<void> {
		this.deliveryEnabled = false;
		this.generation++;
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.state));
		for (const job of active) {
			this.finish(
				job,
				{
					state: "cancelled",
					error: "Subagent session shut down.",
					limitations: [],
					truncated: false,
				},
				false,
			);
			job.controller.abort(new DOMException("Subagent session shut down", "AbortError"));
		}
		await Promise.allSettled(active.map((job) => job.task));
	}

	private finish(job: InternalJob, child: ChildResult, deliver: boolean): void {
		if (isTerminal(job.state)) return;
		job.state = child.state;
		job.finishedAt = this.now();
		job.result = child.result;
		job.error = child.error;
		job.limitations = [...child.limitations];
		job.resolveTerminal();
		if (deliver) this.deliver(job);
		this.prune();
	}

	private deliver(job: InternalJob): void {
		if (!this.deliveryEnabled || job.deliverySent || job.generation !== this.generation) return;
		job.deliverySent = true;
		const payload = this.waitResult(job, false);
		try {
			this.pi.sendMessage(
				{
					customType: COMPLETION_MESSAGE_TYPE,
					content: `Subagent job completion:\n${JSON.stringify(payload)}`,
					display: true,
					details: payload,
				},
				{ deliverAs: "steer" },
			);
		} catch {
			// Completion remains available through wait and inspect.
		}
	}

	private waitResult(job: InternalJob, timedOut: boolean) {
		return {
			jobId: job.jobId,
			state: job.state,
			timedOut,
			...(!timedOut && job.result ? { result: job.result } : {}),
			...(!timedOut && job.error ? { error: job.error } : {}),
			...(!timedOut && job.limitations.length > 0 ? { limitations: [...job.limitations] } : {}),
		};
	}

	private summary(job: InternalJob): JobSummary {
		return {
			jobId: job.jobId,
			agent: job.agent,
			state: job.state,
			createdAt: job.createdAt,
			...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
			...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
			...(job.timeout !== undefined ? { timeout: job.timeout } : {}),
			...(job.resultSummary !== undefined ? { resultSummary: job.resultSummary } : {}),
			...(job.errorSummary !== undefined ? { errorSummary: job.errorSummary } : {}),
		};
	}

	private requireJob(jobId: string): InternalJob {
		this.prune();
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown or expired subagent job: ${jobId}`);
		return job;
	}

	private prune(): void {
		const now = this.now();
		const expired = [...this.jobs.values()].filter(
			(job) =>
				isTerminal(job.state) && (job.finishedAt ?? job.createdAt) < now - TERMINAL_RETENTION_MS,
		);
		for (const job of expired) {
			if (this.jobs.delete(job.jobId)) this.omittedJobs++;
		}
		const terminal = [...this.jobs.values()]
			.filter((job) => isTerminal(job.state))
			.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
		for (const job of terminal.slice(
			0,
			Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_JOBS),
		)) {
			if (this.jobs.delete(job.jobId)) this.omittedJobs++;
		}
	}
}

function isTerminal(state: SubagentJobState): boolean {
	return TERMINAL_JOB_STATES.has(state);
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
