import { randomUUID } from "node:crypto";

export type AgentLifecycleState =
	| "starting"
	| "running"
	| "idle"
	| "completed"
	| "interrupted"
	| "failed"
	| "closed";

export interface AgentTurn {
	task: string;
	output: string;
	startedAt: number;
	completedAt: number;
	exitCode: number;
	truncated?: boolean;
}

export interface ManagedAgent {
	id: string;
	agent: string;
	state: AgentLifecycleState;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	agentScope?: "user" | "project" | "both";
	currentTask?: string;
	history: AgentTurn[];
	error?: string;
	context?: string;
	contextTruncated?: boolean;
	policy?: { inherited: string[]; overridden: string[]; unsupported: string[] };
}

export interface TurnOutcome {
	output: string;
	exitCode: number;
	aborted?: boolean;
	truncated?: boolean;
	error?: string;
	policy?: ManagedAgent["policy"];
}

export type AgentTurnRunner = (agent: ManagedAgent, task: string, signal: AbortSignal) => Promise<TurnOutcome>;

export interface AgentRegistryOptions {
	maxAgents?: number;
	maxActiveTurns?: number;
	maxHistoryTurns?: number;
	idleTtlMs?: number;
	now?: () => number;
	onChange?: (agents: ManagedAgent[]) => void | Promise<void>;
}

export class AgentRegistry {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly running = new Map<string, Promise<ManagedAgent>>();
	private readonly queue: Array<{ agent: ManagedAgent; task: string; resolve: (agent: ManagedAgent) => void }> = [];
	private readonly maxAgents: number;
	private readonly maxActiveTurns: number;
	private readonly maxHistoryTurns: number;
	private readonly idleTtlMs: number;
	private readonly now: () => number;

	constructor(private readonly runner: AgentTurnRunner, private readonly options: AgentRegistryOptions = {}) {
		this.maxAgents = options.maxAgents ?? 16;
		this.maxActiveTurns = options.maxActiveTurns ?? 4;
		this.maxHistoryTurns = options.maxHistoryTurns ?? 20;
		this.idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
	}

	restore(records: readonly ManagedAgent[]): void {
		for (const record of records.slice(-this.maxAgents)) {
			if (!record.id || record.state === "closed") continue;
			this.agents.set(record.id, {
				...record,
				state: "idle",
				currentTask: undefined,
				history: record.history.slice(-this.maxHistoryTurns),
			});
		}
	}

	async spawn(input: {
		agent: string;
		task: string;
		cwd: string;
		agentScope?: "user" | "project" | "both";
		context?: string;
		contextTruncated?: boolean;
	}): Promise<ManagedAgent> {
		this.evictExpired();
		if (this.retainedCount() >= this.maxAgents) {
			throw new Error(`Subagent capacity reached (${this.maxAgents})`);
		}
		const now = this.now();
		const record: ManagedAgent = {
			id: `sa_${randomUUID()}`,
			agent: input.agent,
			state: "starting",
			createdAt: now,
			updatedAt: now,
			cwd: input.cwd,
			agentScope: input.agentScope,
			currentTask: input.task,
			history: [],
			context: input.context,
			contextTruncated: input.contextTruncated,
		};
		this.agents.set(record.id, record);
		await this.changed();
		this.startTurn(record, input.task);
		return this.copy(record);
	}

	async followUp(id: string, task: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (!["idle", "completed", "interrupted", "failed"].includes(agent.state)) {
			throw new Error(`Agent ${id} cannot accept follow-up while ${agent.state}`);
		}
		this.startTurn(agent, task);
		return this.copy(agent);
	}

	async wait(id: string, timeoutMs = 30_000): Promise<{ timedOut: boolean; agent: ManagedAgent }> {
		const agent = this.require(id);
		const running = this.running.get(id);
		if (!running) return { timedOut: false, agent: this.copy(agent) };
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
		});
		const result = await Promise.race([running, timeout]);
		if (timer) clearTimeout(timer);
		return result === "timeout"
			? { timedOut: true, agent: this.copy(this.require(id)) }
			: { timedOut: false, agent: this.copy(result) };
	}

	async interrupt(id: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (agent.state !== "running" && agent.state !== "starting") throw new Error(`Agent ${id} is not running`);
		if (agent.state === "starting") {
			const index = this.queue.findIndex((entry) => entry.agent.id === id);
			if (index >= 0) {
				const [entry] = this.queue.splice(index, 1);
				agent.state = "interrupted";
				agent.currentTask = undefined;
				agent.updatedAt = this.now();
				entry.resolve(agent);
				await this.changed();
				return this.copy(agent);
			}
		}
		this.controllers.get(id)?.abort();
		await this.running.get(id);
		return this.copy(this.require(id));
	}

	async close(id: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (agent.state === "closed") throw new Error(`Agent ${id} is already closed`);
		if (agent.state === "starting") {
			const index = this.queue.findIndex((entry) => entry.agent.id === id);
			if (index >= 0) {
				const [entry] = this.queue.splice(index, 1);
				entry.resolve(agent);
				this.running.delete(id);
			}
		}
		this.controllers.get(id)?.abort();
		await this.running.get(id)?.catch(() => undefined);
		agent.state = "closed";
		agent.updatedAt = this.now();
		agent.currentTask = undefined;
		await this.changed();
		return this.copy(agent);
	}

	async closeAll(): Promise<void> {
		const ids = [...this.agents.values()].filter((agent) => agent.state !== "closed").map((agent) => agent.id);
		await Promise.all(ids.map((id) => this.close(id).catch(() => undefined)));
	}

	async shutdown(): Promise<void> {
		for (const entry of this.queue.splice(0)) {
			entry.agent.state = "idle";
			entry.agent.currentTask = undefined;
			entry.resolve(entry.agent);
			this.running.delete(entry.agent.id);
		}
		for (const controller of this.controllers.values()) controller.abort();
		await Promise.all([...this.running.values()].map((turn) => turn.catch(() => undefined)));
		for (const agent of this.agents.values()) {
			if (agent.state !== "closed") {
				agent.state = "idle";
				agent.currentTask = undefined;
			}
		}
		await this.changed();
	}

	list(includeClosed = false): ManagedAgent[] {
		return [...this.agents.values()]
			.filter((agent) => includeClosed || agent.state !== "closed")
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((agent) => this.copy(agent));
	}

	get(id: string): ManagedAgent | undefined {
		const agent = this.agents.get(id);
		return agent ? this.copy(agent) : undefined;
	}

	async sweepExpired(): Promise<number> {
		const removed = this.evictExpired();
		if (removed > 0) await this.changed();
		return removed;
	}

	private startTurn(agent: ManagedAgent, task: string): void {
		agent.state = "starting";
		agent.currentTask = task;
		agent.updatedAt = this.now();
		let resolveQueued!: (agent: ManagedAgent) => void;
		const completion = new Promise<ManagedAgent>((resolve) => {
			resolveQueued = resolve;
		});
		this.running.set(agent.id, completion);
		this.queue.push({ agent, task, resolve: resolveQueued });
		void this.changed();
		this.pumpQueue();
	}

	private pumpQueue(): void {
		while (this.controllers.size < this.maxActiveTurns && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) return;
			this.runQueuedTurn(next.agent, next.task, next.resolve);
		}
	}

	private runQueuedTurn(agent: ManagedAgent, task: string, resolveQueued: (agent: ManagedAgent) => void): void {
		const controller = new AbortController();
		this.controllers.set(agent.id, controller);
		agent.state = "running";
		agent.updatedAt = this.now();
		const startedAt = this.now();
		void this.runner(this.copy(agent), task, controller.signal)
			.then(async (outcome) => {
				agent.history.push({
					task,
					output: outcome.output,
					startedAt,
					completedAt: this.now(),
					exitCode: outcome.exitCode,
					truncated: outcome.truncated,
				});
				agent.history = agent.history.slice(-this.maxHistoryTurns);
				agent.state = outcome.aborted ? "interrupted" : outcome.exitCode === 0 ? "completed" : "failed";
				agent.error = outcome.error;
				agent.policy = outcome.policy;
				return agent;
			})
			.catch((error) => {
				agent.state = controller.signal.aborted ? "interrupted" : "failed";
				agent.error = error instanceof Error ? error.message : String(error);
				return agent;
			})
			.finally(async () => {
				agent.currentTask = undefined;
				agent.updatedAt = this.now();
				this.controllers.delete(agent.id);
				this.running.delete(agent.id);
				resolveQueued(agent);
				this.pumpQueue();
				await this.changed();
			});
	}

	private require(id: string): ManagedAgent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown subagent: ${id}`);
		return agent;
	}

	private retainedCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state !== "closed").length;
	}

	private evictExpired(): number {
		const cutoff = this.now() - this.idleTtlMs;
		let removed = 0;
		for (const [id, agent] of this.agents) {
			if (!["running", "starting"].includes(agent.state) && agent.updatedAt < cutoff) {
				this.agents.delete(id);
				removed++;
			}
		}
		return removed;
	}

	private async changed(): Promise<void> {
		try {
			await this.options.onChange?.(this.list(true));
		} catch {
			// Persistence is best-effort; lifecycle operations must remain usable if storage fails.
		}
	}

	private copy(agent: ManagedAgent): ManagedAgent {
		return {
			...agent,
			history: agent.history.map((turn) => ({ ...turn })),
			policy: agent.policy
				? {
						inherited: [...agent.policy.inherited],
						overridden: [...agent.policy.overridden],
						unsupported: [...agent.policy.unsupported],
					}
				: undefined,
		};
	}
}
