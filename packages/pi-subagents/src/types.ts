import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const JOB_STATES = ["queued", "running", "completed", "partial", "failed", "timed_out", "cancelled"] as const;

export type SubagentJobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = new Set<SubagentJobState>([
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
]);

export const CHILD_CORE_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export interface ChildResult {
  state: Extract<SubagentJobState, "completed" | "partial" | "failed" | "timed_out" | "cancelled">;
  result?: string;
  error?: string;
  limitations: string[];
  truncated: boolean;
}

export interface BrokerCredentials {
  host: "127.0.0.1";
  port: number;
  token: string;
}

export interface ChildControl {
  send(message: string, signal?: AbortSignal): Promise<void>;
}

export interface ChildRequest {
  task: string;
  tools: string[];
  model: string;
  thinkingLevel: SubagentThinkingLevel;
  cwd: string;
  timeout?: number;
  projectTrusted: boolean;
  communication: BrokerCredentials;
  signal: AbortSignal;
  onControl?: (control: ChildControl) => void;
}

export interface JobSummary {
  jobId: string;
  state: SubagentJobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeout?: number;
  resultSummary?: string;
  errorSummary?: string;
}
