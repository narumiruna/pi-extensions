import type { AgentCandidate, AgentEvidence } from "./agent-candidate.js";

export interface AgentAcceptance {
  key: string;
  candidate: AgentCandidate;
  /** Retry-only cache publication after the full merge/application preflight passes. */
  commitCandidate?: () => Promise<void>;
}
/** Internal control flow: the operation lock must unwind before any provider call. */
export class AgentResolutionRequired extends Error {
  constructor(
    readonly key: string,
    readonly evidence: AgentEvidence,
    readonly validate: (signal?: AbortSignal) => Promise<void>,
  ) {
    super("Agent resolution requires an unlocked inference phase.");
    this.name = "AgentResolutionRequired";
  }
}
