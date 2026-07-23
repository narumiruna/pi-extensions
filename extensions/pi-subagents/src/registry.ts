import { randomUUID } from "node:crypto";
import type { SubagentThinkingLevel } from "./agents.js";
import { DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";
import { type AgentTurnRunner, normalizeTransport, type SubagentTransport } from "./transport.js";

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
	thinkingLevel?: SubagentThinkingLevel;
	currentTask?: string;
	history: AgentTurn[];
	error?: string;
	context?: string;
	contextSourceIds?: string[];
	contextTruncated?: boolean;
	policy?: { inherited: string[]; overridden: string[]; unsupported: string[] };
	mailbox: AgentMailboxMessage[];
	currentMailboxMessageIds?: string[];
}

export interface TurnOutcome {
	output: string;
	exitCode: number;
	aborted?: boolean;
	truncated?: boolean;
	error?: string;
	policy?: ManagedAgent["policy"];
}

export interface AgentTurnCompletion {
	agent: ManagedAgent;
	task: string;
	output: string;
	error?: string;
}

export interface AgentRegistryOptions {
	maxAgents?: number;
	maxActiveTurns?: number;
	maxHistoryTurns?: number;
	maxDepth?: number;
	maxChildrenPerAgent?: number;
	maxMailboxMessages?: number;
	maxMailboxMessageBytes?: number;
	maxTaskBytes?: number;
	maxTurnOutputBytes?: number;
	idleTtlMs?: number;
	now?: () => number;
	onChange?: (agents: ManagedAgent[]) => void | Promise<void>;
	onTurnComplete?: (completion: AgentTurnCompletion) => void | Promise<void>;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function waitAbortError(): Error {
	const error = new Error("Subagent wait was aborted");
	error.name = "AbortError";
	return error;
}

export class AgentRegistry {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly running = new Map<string, Promise<ManagedAgent>>();
	private readonly queue: Array<{
		agent: ManagedAgent;
		task: string;
		resolve: (agent: ManagedAgent) => void;
	}> = [];
	private changeQueue: Promise<void> = Promise.resolve();
	private readonly maxAgents: number;
	private readonly maxActiveTurns: number;
	private readonly maxHistoryTurns: number;
	private readonly maxDepth: number;
	private readonly maxChildrenPerAgent: number;
	private readonly maxMailboxMessages: number;
	private readonly maxMailboxMessageBytes: number;
	private readonly maxTaskBytes: number;
	private readonly maxTurnOutputBytes: number;
	private readonly idleTtlMs: number;
	private readonly transport: SubagentTransport;
	private readonly now: () => number;

	constructor(
		transport: SubagentTransport | AgentTurnRunner,
		private readonly options: AgentRegistryOptions = {},
	) {
		this.transport = normalizeTransport(transport);
		this.maxAgents = positiveInteger(options.maxAgents ?? 16, "maxAgents");
		this.maxActiveTurns = positiveInteger(options.maxActiveTurns ?? 4, "maxActiveTurns");
		this.maxHistoryTurns = positiveInteger(options.maxHistoryTurns ?? 20, "maxHistoryTurns");
		this.maxDepth = nonNegativeInteger(options.maxDepth ?? 3, "maxDepth");
		this.maxChildrenPerAgent = positiveInteger(
			options.maxChildrenPerAgent ?? 8,
			"maxChildrenPerAgent",
		);
		this.maxMailboxMessages = positiveInteger(
			options.maxMailboxMessages ?? 100,
			"maxMailboxMessages",
		);
		this.maxMailboxMessageBytes = positiveInteger(
			options.maxMailboxMessageBytes ?? 16 * 1024,
			"maxMailboxMessageBytes",
		);
		this.maxTaskBytes = positiveInteger(
			options.maxTaskBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
			"maxTaskBytes",
		);
		this.maxTurnOutputBytes = positiveInteger(
			options.maxTurnOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
			"maxTurnOutputBytes",
		);
		this.idleTtlMs = positiveInteger(options.idleTtlMs ?? 60 * 60 * 1000, "idleTtlMs");
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
				currentMailboxMessageIds: undefined,
				children: [],
				contextSourceIds: [...(record.contextSourceIds ?? [])],
				mailbox: (record.mailbox ?? [])
					.slice(-this.maxMailboxMessages)
					.map((message) => ({ ...message, recipientId: record.id })),
				history: record.history.slice(-this.maxHistoryTurns).map((turn) => ({ ...turn })),
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
		thinkingLevel?: SubagentThinkingLevel;
		parentId?: string;
		context?: string;
		contextSourceIds?: string[];
		contextTruncated?: boolean;
	}): Promise<ManagedAgent> {
		if (!input.task.trim()) throw new Error("Subagent tasks cannot be empty");
		const task = truncateUtf8(input.task, this.maxTaskBytes).text;
		const expired = this.evictExpired();
		let expiryReleaseError: unknown;
		try {
			await this.releaseAgents(expired);
		} catch (error) {
			expiryReleaseError = error;
		}
		if (expired.length > 0) await this.changed();
		if (expiryReleaseError) throw expiryReleaseError;
		if (this.retainedCount() >= this.maxAgents) {
			throw new Error(`Subagent capacity reached (${this.maxAgents})`);
		}
		const parent = input.parentId ? this.require(input.parentId) : undefined;
		if (parent?.state === "closed") throw new Error(`Cannot spawn under closed agent ${parent.id}`);
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
			thinkingLevel: input.thinkingLevel,
			currentTask: task,
			history: [],
			mailbox: [],
			context: input.context,
			contextSourceIds: input.contextSourceIds,
			contextTruncated: input.contextTruncated,
		};
		this.agents.set(record.id, record);
		if (parent) {
			parent.children.push(record.id);
			parent.updatedAt = now;
		}
		await this.changed();
		this.startTurn(record, task);
		return this.copy(record);
	}

	async followUp(id: string, task: string): Promise<ManagedAgent> {
		if (!task.trim()) throw new Error("Subagent tasks cannot be empty");
		const boundedTask = truncateUtf8(task, this.maxTaskBytes).text;
		const agent = this.require(id);
		if (!["idle", "completed", "interrupted", "failed"].includes(agent.state)) {
			throw new Error(`Agent ${id} cannot accept follow-up while ${agent.state}`);
		}
		const unread = agent.mailbox.filter((message) => !message.readAt);
		const readAt = this.now();
		for (const message of unread) message.readAt = readAt;
		agent.currentMailboxMessageIds = unread.map((message) => message.id);
		this.startTurn(agent, boundedTask);
		return this.copy(agent);
	}

	async sendMessage(
		recipientId: string,
		content: string,
		senderId = "root",
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage> {
		if (!content.trim()) throw new Error("Subagent mailbox messages cannot be empty");
		if (deduplicationKey && deduplicationKey.length > 256) {
			throw new Error("Subagent mailbox deduplication keys cannot exceed 256 characters");
		}
		const recipient = this.require(recipientId);
		if (recipient.state === "closed")
			throw new Error(`Cannot message closed agent ${recipient.id}`);
		if (senderId !== "root") {
			const sender = this.require(senderId);
			if (sender.state === "closed")
				throw new Error(`Closed agent ${sender.id} cannot send messages`);
			if (sender.rootId !== recipient.rootId) {
				throw new Error("Subagent mailbox messages cannot cross agent trees");
			}
		}
		const message = this.enqueueMessage(recipient, content, senderId, deduplicationKey);
		await this.changed();
		return { ...message };
	}

	async readMessages(
		id: string,
		acknowledge = true,
		limit = this.maxMailboxMessages,
	): Promise<AgentMailboxMessage[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("Subagent mailbox read limit must be a positive safe integer");
		}
		const agent = this.require(id);
		const unread = agent.mailbox.filter((message) => !message.readAt).slice(0, limit);
		if (acknowledge && unread.length > 0) {
			const readAt = this.now();
			for (const message of unread) message.readAt = readAt;
			await this.changed();
		}
		return unread.map((message) => ({ ...message }));
	}

	async wait(
		id: string,
		timeoutMs = 30_000,
		signal?: AbortSignal,
	): Promise<{ timedOut: boolean; agent: ManagedAgent }> {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
			throw new Error("Subagent wait timeout must be a positive finite number");
		}
		if (signal?.aborted) throw waitAbortError();
		const agent = this.require(id);
		const running = this.running.get(id);
		if (!running) return { timedOut: false, agent: this.copy(agent) };
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
		});
		const aborted = new Promise<"aborted">((resolve) => {
			onAbort = () => resolve("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const result = await Promise.race([running, timeout, aborted]);
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (result === "aborted") throw waitAbortError();
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
		if (agent.state !== "running" && agent.state !== "starting")
			throw new Error(`Agent ${id} is not running`);
		if (agent.state === "starting") {
			const index = this.queue.findIndex((entry) => entry.agent.id === id);
			if (index >= 0) {
				const [entry] = this.queue.splice(index, 1);
				agent.state = "interrupted";
				agent.currentTask = undefined;
				agent.currentMailboxMessageIds = undefined;
				agent.updatedAt = this.now();
				const completion: AgentTurnCompletion = {
					agent: this.copy(agent),
					task: entry.task,
					output: "",
					error: "Interrupted before execution",
				};
				entry.resolve(agent);
				this.running.delete(id);
				await this.notifyTurnComplete(completion);
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
		const failures: unknown[] = [];
		for (const target of this.descendants(id).reverse()) {
			const agent = this.require(target);
			if (agent.state === "closed") continue;
			try {
				results.push(await this.close(target));
			} catch (error) {
				failures.push(error);
				const closed = this.get(target);
				if (closed?.state === "closed") results.push(closed);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to release ${failures.length} subagent(s)`);
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
		agent.currentMailboxMessageIds = undefined;
		let releaseError: unknown;
		try {
			await this.transport.release?.(this.copy(agent));
		} catch (error) {
			releaseError = error;
		}
		this.pruneClosedAgents();
		await this.changed();
		if (releaseError) throw releaseError;
		return this.copy(agent);
	}

	async closeAll(): Promise<void> {
		const roots = [...this.agents.values()]
			.filter((agent) => agent.state !== "closed" && !agent.parentId)
			.map((agent) => agent.id);
		const results = await Promise.allSettled(roots.map((id) => this.closeTree(id)));
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to close ${failures.length} subagent tree(s)`);
		}
	}

	async shutdown(): Promise<void> {
		for (const entry of this.queue.splice(0)) {
			entry.agent.state = "idle";
			entry.agent.currentTask = undefined;
			entry.agent.currentMailboxMessageIds = undefined;
			entry.resolve(entry.agent);
			this.running.delete(entry.agent.id);
		}
		for (const controller of this.controllers.values()) controller.abort();
		await Promise.all([...this.running.values()].map((turn) => turn.catch(() => undefined)));
		for (const agent of this.agents.values()) {
			if (agent.state !== "closed") {
				agent.state = "idle";
				agent.currentTask = undefined;
				agent.currentMailboxMessageIds = undefined;
			}
		}
		let shutdownError: unknown;
		try {
			await this.transport.shutdown?.();
		} catch (error) {
			shutdownError = error;
		}
		await this.changed();
		if (shutdownError) throw shutdownError;
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
		let releaseError: unknown;
		try {
			await this.releaseAgents(removed);
		} catch (error) {
			releaseError = error;
		}
		if (removed.length > 0) await this.changed();
		if (releaseError) throw releaseError;
		return removed.length;
	}

	private startTurn(agent: ManagedAgent, task: string): void {
		agent.state = "starting";
		agent.error = undefined;
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

	private runQueuedTurn(
		agent: ManagedAgent,
		task: string,
		resolveQueued: (agent: ManagedAgent) => void,
	): void {
		const controller = new AbortController();
		this.controllers.set(agent.id, controller);
		agent.state = "running";
		agent.updatedAt = this.now();
		const startedAt = this.now();
		const completionKey = `completion:${agent.id}:${randomUUID()}`;
		let completionContent = "";
		let completionOutput = "";
		let completionError: string | undefined;
		void this.transport
			.runTurn(this.copy(agent), task, controller.signal)
			.then(async (outcome) => {
				const output = truncateUtf8(outcome.output, this.maxTurnOutputBytes).text;
				const error = outcome.error
					? truncateUtf8(outcome.error, this.maxTurnOutputBytes).text
					: undefined;
				agent.history.push({
					task,
					output,
					startedAt,
					completedAt: this.now(),
					exitCode: outcome.exitCode,
					truncated: outcome.truncated,
				});
				agent.history = agent.history.slice(-this.maxHistoryTurns);
				agent.state = outcome.aborted
					? "interrupted"
					: outcome.exitCode === 0
						? "completed"
						: "failed";
				agent.error = error;
				agent.policy = outcome.policy;
				completionOutput = output;
				completionError = error;
				completionContent = output || error || `${agent.id} ${agent.state}`;
				return agent;
			})
			.catch((error) => {
				agent.state = controller.signal.aborted ? "interrupted" : "failed";
				agent.error = truncateUtf8(
					error instanceof Error ? error.message : String(error),
					this.maxTurnOutputBytes,
				).text;
				agent.history.push({
					task,
					output: "",
					startedAt,
					completedAt: this.now(),
					exitCode: controller.signal.aborted ? 130 : 1,
				});
				agent.history = agent.history.slice(-this.maxHistoryTurns);
				completionError = agent.error;
				completionContent = agent.error;
				return agent;
			})
			.finally(async () => {
				const turnCompletion: AgentTurnCompletion = {
					agent: this.copy(agent),
					task,
					output: completionOutput,
					error: completionError,
				};
				if (agent.parentId) {
					const parent = this.agents.get(agent.parentId);
					if (parent && parent.state !== "closed") {
						this.enqueueMessage(parent, completionContent, agent.id, completionKey);
					}
				}
				agent.currentTask = undefined;
				agent.currentMailboxMessageIds = undefined;
				agent.updatedAt = this.now();
				this.controllers.delete(agent.id);
				this.running.delete(agent.id);
				resolveQueued(agent);
				this.pumpQueue();
				await this.notifyTurnComplete(turnCompletion);
				await this.changed();
			});
	}

	private enqueueMessage(
		recipient: ManagedAgent,
		content: string,
		senderId: string,
		deduplicationKey?: string,
	): AgentMailboxMessage {
		if (deduplicationKey) {
			const existing = recipient.mailbox.find(
				(message) => message.deduplicationKey === deduplicationKey && message.senderId === senderId,
			);
			if (existing) return existing;
		}
		const bounded = truncateUtf8(content, this.maxMailboxMessageBytes);
		const message: AgentMailboxMessage = {
			id: `msg_${randomUUID()}`,
			senderId,
			recipientId: recipient.id,
			content: bounded.text,
			createdAt: this.now(),
			deduplicationKey,
		};
		recipient.mailbox.push(message);
		recipient.mailbox = recipient.mailbox.slice(-this.maxMailboxMessages);
		recipient.updatedAt = this.now();
		return message;
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

	private evictExpired(): ManagedAgent[] {
		const cutoff = this.now() - this.idleTtlMs;
		const protectedIds = new Set<string>();
		for (const agent of this.agents.values()) {
			if (agent.state !== "running" && agent.state !== "starting") continue;
			let current: ManagedAgent | undefined = agent;
			while (current) {
				protectedIds.add(current.id);
				current = current.parentId ? this.agents.get(current.parentId) : undefined;
			}
		}
		const removed: ManagedAgent[] = [];
		const candidates = [...this.agents.values()].sort((left, right) => right.depth - left.depth);
		for (const agent of candidates) {
			if (protectedIds.has(agent.id) || agent.updatedAt >= cutoff) continue;
			if (agent.children.some((childId) => this.agents.get(childId)?.state !== "closed")) continue;
			this.agents.delete(agent.id);
			if (agent.parentId) {
				const parent = this.agents.get(agent.parentId);
				if (parent) parent.children = parent.children.filter((childId) => childId !== agent.id);
			}
			removed.push(this.copy(agent));
		}
		return removed;
	}

	private async releaseAgents(agents: readonly ManagedAgent[]): Promise<void> {
		if (!this.transport.release || agents.length === 0) return;
		const results = await Promise.allSettled(
			agents.map((agent) => this.transport.release?.(agent)),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to release ${failures.length} subagent transport session(s)`,
			);
		}
	}

	private pruneClosedAgents(): void {
		const closed = [...this.agents.values()]
			.filter((agent) => agent.state === "closed")
			.sort((left, right) => right.updatedAt - left.updatedAt);
		for (const agent of closed.slice(this.maxAgents)) this.agents.delete(agent.id);
	}

	private async notifyTurnComplete(completion: AgentTurnCompletion): Promise<void> {
		try {
			await this.options.onTurnComplete?.(completion);
		} catch {
			// Completion notifications are best-effort and must not destabilize agent lifecycle.
		}
	}

	private changed(): Promise<void> {
		const snapshot = this.list(true);
		const next = this.changeQueue.then(async () => {
			try {
				await this.options.onChange?.(snapshot);
			} catch {
				// Persistence is best-effort; lifecycle operations must remain usable if storage fails.
			}
		});
		this.changeQueue = next;
		return next;
	}

	private copy(agent: ManagedAgent): ManagedAgent {
		return {
			...agent,
			children: [...agent.children],
			contextSourceIds: [...(agent.contextSourceIds ?? [])],
			currentMailboxMessageIds: agent.currentMailboxMessageIds
				? [...agent.currentMailboxMessageIds]
				: undefined,
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
