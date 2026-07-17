import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { THINKING_LEVELS } from "./agents.js";

const TimeoutMs = Type.Number({
	description:
		"Hard timeout in milliseconds for each subagent subprocess. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 1,
});

const ThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description: "Pi thinking level for the subagent process: off, minimal, low, medium, high, or xhigh.",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const AggregatorItem = Type.Object({
	agent: Type.String({ description: "Name of the fan-in agent to invoke after parallel tasks complete" }),
	task: Type.String({ description: "Fan-in task. Use {previous} to include all parallel outputs." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the aggregator process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Per-invocation custom agent scope. Default: "user". Use "project" for project-local agents or "both" for user and project agents; this is a tool argument, not a pi-subagents.json setting.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	aggregator: Type.Optional(AggregatorItem),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: Type.Optional(TimeoutMs),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

export type SubagentParams = Static<typeof SubagentParams>;
