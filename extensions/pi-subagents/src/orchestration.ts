import { randomUUID } from "node:crypto";

export type OrchestrationRecoveryTicket = {
	generation: number;
	revision: number;
	nonce: string;
	prompt: string;
};

type DelegatedAgent = {
	live: boolean;
	resultAvailable: boolean;
	observedInTurn: boolean;
};

export const ORCHESTRATION_MARKER_PREFIX = "pi-subagent-orchestration:";

const RECOVERY_PROMPT = [
	"Delegated subagents still need root coordination.",
	"Do not yield permanently while current delegated work is unresolved.",
	"Continue useful non-overlapping local work, or call subagent_wait when no useful local continuation remains.",
	"Consume available subagent results and synthesize them before finishing.",
	"Interrupt or close agents that are no longer needed; do not wait forever or spawn more agents unnecessarily.",
].join(" ");

/** Ephemeral root-turn coordination state. Never persisted across sessions. */
export class RootOrchestrationState {
	private generation = 0;
	private revision = 0;
	private turnOpen = false;
	private agents = new Map<string, DelegatedAgent>();
	private pending: OrchestrationRecoveryTicket | undefined;
	private deliveredRevision: number | undefined;

	reset(): void {
		this.generation += 1;
		this.revision = 0;
		this.turnOpen = false;
		this.agents.clear();
		this.pending = undefined;
		this.deliveredRevision = undefined;
	}

	beginTurn(): void {
		this.turnOpen = true;
		if (this.pending) this.deliveredRevision = this.pending.revision;
		this.observeAvailable();
		// New root work supersedes an intent that has not been delivered yet. The
		// turn gets a chance to coordinate before agent_end evaluates it again.
		this.pending = undefined;
	}

	spawn(agentId: string): void {
		this.agents.set(agentId, {
			live: true,
			resultAvailable: false,
			observedInTurn: false,
		});
		this.bumpRevision();
	}

	complete(agentId: string): void {
		const existing = this.agents.get(agentId);
		if (!existing) return;
		this.agents.set(agentId, {
			live: false,
			resultAvailable: true,
			observedInTurn: false,
		});
		this.bumpRevision();
		if (!this.turnOpen) this.ensureRecovery();
	}

	resolve(agentId: string): void {
		if (!this.agents.delete(agentId)) return;
		this.bumpRevision();
	}

	observe(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (agent && !agent.live && agent.resultAvailable) agent.observedInTurn = true;
	}

	observeAvailable(): void {
		for (const agent of this.agents.values()) {
			if (!agent.live && agent.resultAvailable) agent.observedInTurn = true;
		}
	}

	endTurn(): OrchestrationRecoveryTicket | undefined {
		if (this.turnOpen) {
			for (const [id, agent] of this.agents) {
				if (!agent.live && agent.resultAvailable && agent.observedInTurn) {
					this.agents.delete(id);
				}
			}
			this.turnOpen = false;
		}
		return this.ensureRecovery();
	}

	pendingTicket(): OrchestrationRecoveryTicket | undefined {
		return this.pending;
	}

	isCurrent(ticket: OrchestrationRecoveryTicket): boolean {
		return (
			ticket.generation === this.generation &&
			ticket.revision === this.revision &&
			ticket.nonce === this.pending?.nonce &&
			this.hasUnresolved()
		);
	}

	markDelivered(ticket: OrchestrationRecoveryTicket): void {
		if (!this.isCurrent(ticket)) return;
		this.pending = undefined;
		this.deliveredRevision = ticket.revision;
	}

	supersedePending(): OrchestrationRecoveryTicket | undefined {
		const ticket = this.pending;
		if (!ticket) return undefined;
		this.pending = undefined;
		this.deliveredRevision = ticket.revision;
		return ticket;
	}

	hasUnresolved(): boolean {
		return this.agents.size > 0;
	}

	liveAgentIds(): string[] {
		return [...this.agents]
			.filter(([, agent]) => agent.live)
			.map(([id]) => id)
			.sort();
	}

	private ensureRecovery(): OrchestrationRecoveryTicket | undefined {
		if (!this.hasUnresolved()) {
			this.pending = undefined;
			return undefined;
		}
		if (this.deliveredRevision === this.revision) return undefined;
		if (this.pending?.revision === this.revision && this.pending.generation === this.generation) {
			return this.pending;
		}
		const nonce = randomUUID();
		this.pending = {
			generation: this.generation,
			revision: this.revision,
			nonce,
			prompt: `${RECOVERY_PROMPT}\n<!-- ${ORCHESTRATION_MARKER_PREFIX}${nonce} -->`,
		};
		return this.pending;
	}

	private bumpRevision(): void {
		this.revision += 1;
		this.pending = undefined;
		this.deliveredRevision = undefined;
	}
}
