export type TriggerSource = "interactive" | "rpc" | "extension" | "unknown";
export type RunOutcome = "success" | "recovered_success" | "error" | "aborted" | "length" | "interrupted";
export type GenerationOutcome = "pending" | "stop" | "tool_use" | "error" | "aborted" | "length" | "interrupted";
export type ProviderErrorCategory =
  | "dns"
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "tls"
  | "network_other"
  | "provider_other";

export interface ModelIdentity {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

export interface ProviderResponseRecord {
  ordinal: number;
  occurredAtMs: number;
  status: number;
}

export interface GenerationRecord {
  id: string;
  ordinal: number;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  stopReason?: string;
  outcome: GenerationOutcome;
  responses: ProviderResponseRecord[];
}

export interface ToolCallRecord {
  id: string;
  ordinal: number;
  name: string;
  provider?: string;
  model?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  isError: boolean;
  completionState: "running" | "finished" | "interrupted";
}

export interface SkillActivationRecord {
  id: string;
  name: string;
  initiatedBy: "user" | "model";
  occurredAtMs: number;
  provider?: string;
  model?: string;
}

export interface ProviderErrorRecord {
  id: string;
  generationId?: string;
  occurredAtMs: number;
  provider?: string;
  model?: string;
  category: ProviderErrorCategory;
  recovered: boolean;
  terminal: boolean;
}

export interface SettledRun {
  id: string;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  triggerSource: TriggerSource;
  initialProvider?: string;
  initialModel?: string;
  outcome: RunOutcome;
  attemptCount: number;
  generations: GenerationRecord[];
  tools: ToolCallRecord[];
  skills: SkillActivationRecord[];
  providerErrors: ProviderErrorRecord[];
  toolErrorCount: number;
  providerErrorCount: number;
  recoveredErrorCount: number;
}
