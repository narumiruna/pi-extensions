import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "./agents.js";
import { redactPrivateText } from "./context.js";
import type { ManagedAgent } from "./registry.js";

const STATE_VERSION = 2;
const MAX_STATE_BYTES = 1024 * 1024;

interface StoredState {
	version: 2;
	updatedAt: number;
	agents: ManagedAgent[];
}

export interface PersistenceOptions {
	retentionDays?: number;
	maxStoredAgents?: number;
	stateDir?: string;
}

export class AgentPersistence {
	readonly filePath: string;
	private readonly retentionMs: number;
	private readonly maxStoredAgents: number;

	constructor(owner: string, options: PersistenceOptions = {}) {
		const retentionDays = options.retentionDays ?? 30;
		if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
			throw new Error("Subagent retentionDays must be a positive finite number");
		}
		const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
		if (!Number.isFinite(retentionMs)) {
			throw new Error("Subagent retentionDays is too large");
		}
		const maxStoredAgents = options.maxStoredAgents ?? 50;
		if (!Number.isSafeInteger(maxStoredAgents) || maxStoredAgents < 1) {
			throw new Error("Subagent maxStoredAgents must be a positive safe integer");
		}
		const safeOwner = createHash("sha256").update(owner).digest("hex").slice(0, 24);
		const stateDir = options.stateDir ?? path.join(getAgentDir(), "pi-subagents-state");
		this.filePath = path.join(stateDir, `${safeOwner}.json`);
		this.retentionMs = retentionMs;
		this.maxStoredAgents = maxStoredAgents;
	}

	load(): ManagedAgent[] {
		if (!fs.existsSync(this.filePath)) return [];
		try {
			const stat = fs.statSync(this.filePath);
			if (stat.size > MAX_STATE_BYTES) throw new Error("state exceeds size limit");
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
			if (!isStoredState(parsed)) throw new Error("unsupported or malformed state");
			const cutoff = Date.now() - this.retentionMs;
			return parsed.agents
				.filter((agent) => agent.updatedAt >= cutoff && agent.state !== "closed")
				.slice(-this.maxStoredAgents)
				.map(sanitizeAgent);
		} catch {
			this.quarantine();
			return [];
		}
	}

	async save(agents: readonly ManagedAgent[]): Promise<void> {
		const cutoff = Date.now() - this.retentionMs;
		const eligible = agents.filter(
			(agent) => agent.state !== "closed" && agent.updatedAt >= cutoff,
		);
		const records = selectAgentsForPersistence(eligible, this.maxStoredAgents).map(sanitizeAgent);
		const state: StoredState = { version: STATE_VERSION, updatedAt: Date.now(), agents: records };
		let content = `${JSON.stringify(state, null, "\t")}\n`;
		while (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES && state.agents.length > 0) {
			const oldestRootId = state.agents[0].rootId;
			state.agents = state.agents.filter((agent) => agent.rootId !== oldestRootId);
			content = `${JSON.stringify(state, null, "\t")}\n`;
		}
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		await withFileMutationQueue(this.filePath, async () => {
			const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.promises.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
			await fs.promises.rename(tempPath, this.filePath);
		});
	}

	async delete(): Promise<void> {
		await withFileMutationQueue(this.filePath, async () => {
			await fs.promises.rm(this.filePath, { force: true });
		});
	}

	private quarantine(): void {
		try {
			fs.renameSync(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
		} catch {
			// A concurrent process may already have moved or removed it.
		}
	}
}

function selectAgentsForPersistence(
	agents: readonly ManagedAgent[],
	maxAgents: number,
): ManagedAgent[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const selected = new Map<string, ManagedAgent>();
	const newestFirst = [...agents].sort((left, right) => right.updatedAt - left.updatedAt);
	for (const agent of newestFirst) {
		const chain: ManagedAgent[] = [];
		let current: ManagedAgent | undefined = agent;
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			chain.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		if (current || (agent.parentId && chain[0].parentId)) continue;
		const missing = chain.filter((candidate) => !selected.has(candidate.id));
		if (selected.size + missing.length > maxAgents) continue;
		for (const candidate of missing) selected.set(candidate.id, candidate);
	}
	return agents.filter((agent) => selected.has(agent.id));
}

function sanitizeAgent(agent: ManagedAgent): ManagedAgent {
	return {
		...agent,
		rootId: agent.rootId ?? agent.id,
		depth: agent.depth ?? 0,
		children: [...(agent.children ?? [])],
		mailbox: (agent.mailbox ?? []).map((message) => ({
			...message,
			recipientId: agent.id,
			content: redactPrivateText(message.content),
		})),
		state: "idle",
		currentTask: undefined,
		currentMailboxMessageIds: undefined,
		context: agent.context ? redactPrivateText(agent.context) : undefined,
		error: agent.error ? redactPrivateText(agent.error) : undefined,
		history: agent.history.map((turn) => ({
			...turn,
			task: redactPrivateText(turn.task),
			output: redactPrivateText(turn.output),
		})),
	};
}

function isStoredState(value: unknown): value is StoredState {
	if (!value || typeof value !== "object") return false;
	const state = value as { version?: unknown; agents?: unknown };
	if ((state.version !== 1 && state.version !== STATE_VERSION) || !Array.isArray(state.agents)) {
		return false;
	}
	return state.agents.every((agent) => {
		if (!agent || typeof agent !== "object") return false;
		const record = agent as Partial<ManagedAgent>;
		return (
			typeof record.id === "string" &&
			typeof record.agent === "string" &&
			typeof record.cwd === "string" &&
			typeof record.createdAt === "number" &&
			Number.isFinite(record.createdAt) &&
			typeof record.updatedAt === "number" &&
			Number.isFinite(record.updatedAt) &&
			(record.parentId === undefined || typeof record.parentId === "string") &&
			(record.thinkingLevel === undefined || isThinkingLevel(record.thinkingLevel)) &&
			(record.children === undefined ||
				(Array.isArray(record.children) &&
					record.children.every((id) => typeof id === "string"))) &&
			Array.isArray(record.history) &&
			record.history.every(isAgentTurn) &&
			(record.mailbox === undefined ||
				(Array.isArray(record.mailbox) && record.mailbox.every(isMailboxMessage)))
		);
	});
}

function isAgentTurn(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const turn = value as Record<string, unknown>;
	return (
		typeof turn.task === "string" &&
		typeof turn.output === "string" &&
		typeof turn.startedAt === "number" &&
		Number.isFinite(turn.startedAt) &&
		typeof turn.completedAt === "number" &&
		Number.isFinite(turn.completedAt) &&
		typeof turn.exitCode === "number" &&
		Number.isFinite(turn.exitCode)
	);
}

function isMailboxMessage(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		typeof message.senderId === "string" &&
		typeof message.recipientId === "string" &&
		typeof message.content === "string" &&
		typeof message.createdAt === "number" &&
		Number.isFinite(message.createdAt) &&
		(message.readAt === undefined ||
			(typeof message.readAt === "number" && Number.isFinite(message.readAt))) &&
		(message.deduplicationKey === undefined || typeof message.deduplicationKey === "string")
	);
}
