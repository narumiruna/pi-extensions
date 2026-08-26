export const JOB_STATES = [
	"queued",
	"running",
	"completed",
	"partial",
	"failed",
	"timed_out",
	"cancelled",
] as const;

export type SubagentJobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = new Set<SubagentJobState>([
	"completed",
	"partial",
	"failed",
	"timed_out",
	"cancelled",
]);

export type AgentSource = "built-in" | "user" | "project";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDefinition {
	name: string;
	description: string;
	source: AgentSource;
	filePath: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentDiscovery {
	agents: AgentDefinition[];
	omitted: number;
}

export interface ChildResult {
	state: Extract<SubagentJobState, "completed" | "partial" | "failed" | "timed_out" | "cancelled">;
	result?: string;
	error?: string;
	limitations: string[];
	truncated: boolean;
}

export interface ChildRequest {
	agent: AgentDefinition;
	task: string;
	cwd: string;
	timeout?: number;
	projectTrusted: boolean;
	readOnly: boolean;
	signal: AbortSignal;
}

export interface JobSummary {
	jobId: string;
	agent: string;
	state: SubagentJobState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	timeout?: number;
	resultSummary?: string;
	errorSummary?: string;
}
