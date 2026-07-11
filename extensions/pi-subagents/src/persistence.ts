import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
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
		const safeOwner = createHash("sha256").update(owner).digest("hex").slice(0, 24);
		const stateDir = options.stateDir ?? path.join(getAgentDir(), "pi-subagents-state");
		this.filePath = path.join(stateDir, `${safeOwner}.json`);
		this.retentionMs = (options.retentionDays ?? 30) * 24 * 60 * 60 * 1000;
		this.maxStoredAgents = options.maxStoredAgents ?? 50;
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
		const records = agents
			.filter((agent) => agent.state !== "closed" && agent.updatedAt >= cutoff)
			.slice(-this.maxStoredAgents)
			.map(sanitizeAgent);
		const state: StoredState = { version: STATE_VERSION, updatedAt: Date.now(), agents: records };
		let content = `${JSON.stringify(state, null, "\t")}\n`;
		while (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES && state.agents.length > 0) {
			state.agents.shift();
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

function sanitizeAgent(agent: ManagedAgent): ManagedAgent {
	return {
		...agent,
		rootId: agent.rootId ?? agent.id,
		depth: agent.depth ?? 0,
		children: [...(agent.children ?? [])],
		mailbox: (agent.mailbox ?? []).map((message) => ({
			...message,
			content: redactPrivateText(message.content),
		})),
		state: "idle",
		currentTask: undefined,
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
			typeof record.updatedAt === "number" &&
			Array.isArray(record.history)
		);
	});
}
