import { randomUUID } from "node:crypto";
import {
	type AgentTurnRunner,
	normalizeTransport,
	type SubagentTransport,
} from "./transport.js";

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

export interface AgentMailboxMessage {
	id: string;
	senderId: string;
	recipientId: string;
	content: string;
	createdAt: number;
	readAt?: number;
	deduplicationKey?: string;
}

export interface ManagedAgent {
	id: string;
	agent: string;
	parentId?: string;
	rootId: string;
	depth: number;
	children: string[];
	state: AgentLifecycleState;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	agentScope?: "user" | "project" | "both";
	currentTask?: string;
	history: AgentTurn[];
	error?: string;
	context?: string;
	contextSourceIds?: string[];
	contextTruncated?: boolean;
	policy?: { inherited: string[]; overridden: string[]; unsupported: string[] };
	mailbox: AgentMailboxMessage[];
}

export interface TurnOutcome {
	output: string;
	exitCode: number;
	aborted?: boolean;
	truncated?: boolean;
	error?: string;
	policy?: ManagedAgent["policy"];
}

export interface AgentRegistryOptions {
	maxAgents?: number;
	maxActiveTurns?: number;
	maxHistoryTurns?: number;
	maxDepth?: number;
	maxChildrenPerAgent?: number;
	maxMailboxMessages?: number;
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
	private readonly maxDepth: number;
	private readonly maxChildrenPerAgent: number;
	private readonly maxMailboxMessages: number;
	private readonly idleTtlMs: number;
	private readonly transport: SubagentTransport;
	private readonly now: () => number;

	constructor(transport: SubagentTransport | AgentTurnRunner, private readonly options: AgentRegistryOptions = {}) {
		this.transport = normalizeTransport(transport);
		this.maxAgents = options.maxAgents ?? 16;
		this.maxActiveTurns = options.maxActiveTurns ?? 4;
		this.maxHistoryTurns = options.maxHistoryTurns ?? 20;
		this.maxDepth = options.maxDepth ?? 3;
		this.maxChildrenPerAgent = options.maxChildrenPerAgent ?? 8;
		this.maxMailboxMessages = options.maxMailboxMessages ?? 100;
		this.idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
	}

	restore(records: readonly ManagedAgent[]): void {
		const candidates = new Map(
			records
				.slice(-this.maxAgents)
				.filter((record) => record.id && record.state !== "closed")
				.map((record) => [record.id, record]),
		);
		for (const record of candidates.values()) {
			if (record.parentId && !candidates.has(record.parentId)) continue;
			if (record.parentId === record.id) continue;
			const seen = new Set([record.id]);
			let parentId = record.parentId;
			let rootId = record.id;
			let cyclic = false;
			while (parentId) {
				if (seen.has(parentId)) {
					cyclic = true;
					break;
				}
				seen.add(parentId);
				rootId = parentId;
				parentId = candidates.get(parentId)?.parentId;
			}
			const depth = seen.size - 1;
			if (cyclic || depth > this.maxDepth) continue;
			this.agents.set(record.id, {
				...record,
				state: "idle",
				rootId,
				depth,
				currentTask: undefined,
				children: [],
				mailbox: (record.mailbox ?? []).slice(-this.maxMailboxMessages),
				history: record.history.slice(-this.maxHistoryTurns),
			});
		}
		for (const agent of this.agents.values()) {
			if (!agent.parentId) continue;
			const parent = this.agents.get(agent.parentId);
			if (parent && !parent.children.includes(agent.id)) parent.children.push(agent.id);
		}
	}

	async spawn(input: {
		agent: string;
		task: string;
		cwd: string;
		agentScope?: "user" | "project" | "both";
		parentId?: string;
		context?: string;
		contextSourceIds?: string[];
		contextTruncated?: boolean;
	}): Promise<ManagedAgent> {
		this.evictExpired();
		if (this.retainedCount() >= this.maxAgents) {
			throw new Error(`Subagent capacity reached (${this.maxAgents})`);
		}
		const parent = input.parentId ? this.require(input.parentId) : undefined;
		if (parent && parent.children.length >= this.maxChildrenPerAgent) {
			throw new Error(`Agent ${parent.id} child capacity reached (${this.maxChildrenPerAgent})`);
		}
		const depth = parent ? parent.depth + 1 : 0;
		if (depth > this.maxDepth) throw new Error(`Subagent depth limit reached (${this.maxDepth})`);
		const now = this.now();
		const id = `sa_${randomUUID()}`;
		const record: ManagedAgent = {
			id,
			agent: input.agent,
			parentId: parent?.id,
			rootId: parent?.rootId ?? id,
			depth,
			children: [],
			state: "starting",
			createdAt: now,
			updatedAt: now,
			cwd: input.cwd,
			agentScope: input.agentScope,
			currentTask: input.task,
			history: [],
			mailbox: [],
			context: input.context,
			contextSourceIds: input.contextSourceIds,
			contextTruncated: input.contextTruncated,
		};
		this.agents.set(record.id, record);
		if (parent) parent.children.push(record.id);
		await this.changed();
		this.startTurn(record, input.task);
		return this.copy(record);
	}

	async followUp(id: string, task: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (!["idle", "completed", "interrupted", "failed"].includes(agent.state)) {
			throw new Error(`Agent ${id} cannot accept follow-up while ${agent.state}`);
		}
		const readAt = this.now();
		for (const message of agent.mailbox) {
			if (!message.readAt) message.readAt = readAt;
		}
		this.startTurn(agent, task);
		return this.copy(agent);
	}

	async sendMessage(
		recipientId: string,
		content: string,
		senderId = "root",
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage> {
		const recipient = this.require(recipientId);
		if (deduplicationKey) {
			const existing = recipient.mailbox.find(
				(message) => message.deduplicationKey === deduplicationKey && message.senderId === senderId,
			);
			if (existing) return { ...existing };
		}
		const message: AgentMailboxMessage = {
			id: `msg_${randomUUID()}`,
			senderId,
			recipientId,
			content,
			createdAt: this.now(),
			deduplicationKey,
		};
		recipient.mailbox.push(message);
		recipient.mailbox = recipient.mailbox.slice(-this.maxMailboxMessages);
		recipient.updatedAt = this.now();
		await this.changed();
		return { ...message };
	}

	async readMessages(id: string, acknowledge = true): Promise<AgentMailboxMessage[]> {
		const agent = this.require(id);
		const unread = agent.mailbox.filter((message) => !message.readAt);
		if (acknowledge && unread.length > 0) {
			const readAt = this.now();
			for (const message of unread) message.readAt = readAt;
			await this.changed();
		}
		return unread.map((message) => ({ ...message }));
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

	async interruptTree(id: string): Promise<ManagedAgent[]> {
		const results: ManagedAgent[] = [];
		for (const target of this.descendants(id).reverse()) {
			const agent = this.require(target);
			if (agent.state === "running" || agent.state === "starting") {
				results.push(await this.interrupt(target));
			}
		}
		return results;
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

	async closeTree(id: string): Promise<ManagedAgent[]> {
		const results: ManagedAgent[] = [];
		for (const target of this.descendants(id).reverse()) {
			const agent = this.require(target);
			if (agent.state !== "closed") results.push(await this.close(target));
		}
		return results;
	}

	async close(id: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (agent.state === "closed") throw new Error(`Agent ${id} is already closed`);
		if (agent.children.some((childId) => this.agents.get(childId)?.state !== "closed")) {
			throw new Error(`Agent ${id} has active descendants; close the subtree instead`);
		}
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
		if (agent.parentId) {
			const parent = this.agents.get(agent.parentId);
			if (parent) parent.children = parent.children.filter((childId) => childId !== id);
		}
		agent.currentTask = undefined;
		await this.changed();
		return this.copy(agent);
	}

	async closeAll(): Promise<void> {
		const roots = [...this.agents.values()]
			.filter((agent) => agent.state !== "closed" && !agent.parentId)
			.map((agent) => agent.id);
		for (const id of roots) await this.closeTree(id);
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
		await this.transport.shutdown?.();
		await this.changed();
	}

	list(includeClosed = false, rootId?: string): ManagedAgent[] {
		return [...this.agents.values()]
			.filter((agent) => !rootId || agent.rootId === rootId)
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
		const completionKey = `completion:${agent.id}:${randomUUID()}`;
		void this.transport.runTurn(this.copy(agent), task, controller.signal)
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
				if (agent.parentId) {
					const parent = this.agents.get(agent.parentId);
					if (parent) {
						if (!parent.mailbox.some((message) => message.deduplicationKey === completionKey)) {
							parent.mailbox.push({
								id: `msg_${randomUUID()}`,
								senderId: agent.id,
								recipientId: parent.id,
								content: outcome.output || outcome.error || `${agent.id} ${agent.state}`,
								createdAt: this.now(),
								deduplicationKey: completionKey,
							});
							parent.mailbox = parent.mailbox.slice(-this.maxMailboxMessages);
						}
					}
				}
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

	private descendants(id: string): string[] {
		const root = this.require(id);
		const result: string[] = [];
		const visit = (agent: ManagedAgent) => {
			result.push(agent.id);
			for (const childId of agent.children) {
				const child = this.agents.get(childId);
				if (child) visit(child);
			}
		};
		visit(root);
		return result;
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
			children: [...agent.children],
			contextSourceIds: [...(agent.contextSourceIds ?? [])],
			history: agent.history.map((turn) => ({ ...turn })),
			mailbox: agent.mailbox.map((message) => ({ ...message })),
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
