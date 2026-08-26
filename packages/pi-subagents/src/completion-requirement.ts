import { StringEnum } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { AgentLifecycleState, ManagedAgent } from "./registry-types.js";

export const COMPLETION_REQUIREMENT_MODES = ["background", "required"] as const;
export type CompletionRequirementMode = (typeof COMPLETION_REQUIREMENT_MODES)[number];

export const CompletionRequirementModeSchema = StringEnum(COMPLETION_REQUIREMENT_MODES, {
	description:
		"Mark this exact turn as background (default) or required for the parent final answer. Required results are tracked until their exact completion becomes visible, but current Pi versions do not provide a hard pre-display final-answer barrier.",
	default: "background",
});

export const COMPLETION_REQUIREMENT_VERSION = "pi-subagents:completion-requirement:v1" as const;
export const COMPLETION_REQUIREMENT_CONTEXT_TYPE = "pi-subagent-required-completions";
export const COMPLETION_REQUIREMENT_TRANSITION_TYPE = "pi-subagent-required-completion-transition";
export const COMPLETION_REQUIREMENT_TRANSITION_VERSION =
	"pi-subagents:completion-requirement-transition:v1" as const;
const MAX_REQUIREMENTS_PER_AGENT = 20;
export const MAX_UNRESOLVED_REQUIRED_COMPLETIONS = 64;

export type CompletionRequirementState = "pending" | "available" | "visible" | "cancelled";

export interface CompletionRequirementRecord {
	version: typeof COMPLETION_REQUIREMENT_VERSION;
	runId: string;
	generation: number;
	state: CompletionRequirementState;
	createdAt: number;
	updatedAt: number;
	completionId?: string;
	terminalState?: AgentLifecycleState;
}

export function beginCompletionRequirement(
	records: readonly CompletionRequirementRecord[] | undefined,
	input: { runId: string; generation: number; createdAt: number },
): CompletionRequirementRecord[] {
	const retained = (records ?? []).filter(
		(record) => record.runId !== input.runId || record.generation !== input.generation,
	);
	retained.push({
		version: COMPLETION_REQUIREMENT_VERSION,
		runId: input.runId,
		generation: input.generation,
		state: "pending",
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
	});
	return retained.slice(-MAX_REQUIREMENTS_PER_AGENT);
}

export function makeCompletionAvailable(
	records: readonly CompletionRequirementRecord[] | undefined,
	input: {
		runId: string;
		generation: number;
		completionId: string;
		terminalState: AgentLifecycleState;
		updatedAt: number;
	},
): CompletionRequirementRecord[] | undefined {
	return updateExact(records, input.runId, input.generation, (record) => ({
		...record,
		state: "available",
		completionId: input.completionId,
		terminalState: input.terminalState,
		updatedAt: input.updatedAt,
	}));
}

export function makeCompletionVisible(
	records: readonly CompletionRequirementRecord[] | undefined,
	completionId: string,
	updatedAt: number,
): CompletionRequirementRecord[] | undefined {
	if (!records?.some((record) => record.completionId === completionId)) {
		return records?.map((record) => ({ ...record }));
	}
	return records.map((record) =>
		record.completionId === completionId
			? { ...record, state: "visible" as const, updatedAt }
			: { ...record },
	);
}

export function cancelPendingCompletionRequirements(
	records: readonly CompletionRequirementRecord[] | undefined,
	terminalState: AgentLifecycleState,
	updatedAt: number,
): CompletionRequirementRecord[] | undefined {
	if (!records?.some((record) => record.state === "pending")) {
		return records?.map((record) => ({ ...record }));
	}
	return records.map((record) =>
		record.state === "pending"
			? {
					...record,
					state: "cancelled" as const,
					terminalState,
					updatedAt,
				}
			: { ...record },
	);
}

export function requirementForCompletion(
	agent: Pick<ManagedAgent, "completionRequirements">,
	completionId: string,
): CompletionRequirementRecord | undefined {
	return agent.completionRequirements?.find((record) => record.completionId === completionId);
}

export interface BranchCompletionRequirementState {
	observedState: boolean;
	records: Map<string, CompletionRequirementRecord>;
	keys: Set<string>;
}

export function completionRequirementKey(
	record: Pick<CompletionRequirementRecord, "runId" | "generation">,
): string {
	return `${record.runId}\u0000${record.generation}`;
}

export function completionRequirementsFromBranch(
	entries: readonly unknown[],
): BranchCompletionRequirementState {
	const records = new Map<string, CompletionRequirementRecord>();
	let observedState = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const candidate = entry as Record<string, unknown>;
		const message =
			candidate.type === "message" && candidate.message && typeof candidate.message === "object"
				? (candidate.message as Record<string, unknown>)
				: candidate;
		if (
			message.role === "toolResult" &&
			["subagent_spawn", "subagent_send", "subagent_await", "subagent_manage"].includes(
				String(message.toolName),
			)
		) {
			observedState = true;
			const details = message.details;
			if (!details || typeof details !== "object" || Array.isArray(details)) continue;
			const detailsRecord = details as Record<string, unknown>;
			const agents = [
				detailsRecord.agent,
				...(Array.isArray(detailsRecord.agents) ? detailsRecord.agents : []),
			];
			for (const agent of agents) {
				if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue;
				const requirements = (agent as Record<string, unknown>).completionRequirements;
				if (!Array.isArray(requirements)) continue;
				for (const requirement of requirements) {
					if (isCompletionRequirementRecord(requirement)) {
						records.set(completionRequirementKey(requirement), { ...requirement });
					}
				}
			}
			continue;
		}
		if (
			message.role === "custom" &&
			message.customType === COMPLETION_REQUIREMENT_TRANSITION_TYPE
		) {
			const details = message.details;
			if (!details || typeof details !== "object" || Array.isArray(details)) continue;
			const detailRecord = details as Record<string, unknown>;
			if (detailRecord.version !== COMPLETION_REQUIREMENT_TRANSITION_VERSION) continue;
			const requirements = Array.isArray(detailRecord.records) ? detailRecord.records : [];
			for (const requirement of requirements) {
				if (!isCompletionRequirementRecord(requirement) || requirement.state !== "cancelled") {
					continue;
				}
				observedState = true;
				records.set(completionRequirementKey(requirement), { ...requirement });
			}
			continue;
		}
		if (message.role !== "custom" || message.customType !== "pi-subagent-completion") continue;
		const details = message.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) continue;
		const detailRecord = details as Record<string, unknown>;
		const completionRecords = Array.isArray(detailRecord.completions)
			? detailRecord.completions
			: [detailRecord];
		for (const completion of completionRecords) {
			if (!completion || typeof completion !== "object" || Array.isArray(completion)) continue;
			const requirement = (completion as Record<string, unknown>).completionRequirement;
			if (!isCompletionRequirementRecord(requirement)) continue;
			records.set(completionRequirementKey(requirement), {
				...requirement,
				state: "visible",
			});
		}
	}
	return { observedState, records, keys: new Set(records.keys()) };
}

export function pendingRequiredCompletionCount(
	agent: Pick<ManagedAgent, "completionRequirements">,
): number {
	return (agent.completionRequirements ?? []).filter(
		(record) => record.state === "pending" || record.state === "available",
	).length;
}

export function createRequiredCompletionTransition(
	messages: ContextEvent["messages"],
	agents: readonly ManagedAgent[],
) {
	const summarized = leadingSummaryBoundary(messages) > 0;
	const state = modelRequirementState(agents);
	const visible = completionRequirementsFromBranch(messages).records;
	const records = state.records.filter((record) => {
		if (record.state !== "cancelled") return false;
		const retained = visible.get(completionRequirementKey(record));
		if (modelRequirementStateMatches(retained, record)) return false;
		return !summarized || retained !== undefined;
	});
	if (records.length === 0) return undefined;
	return {
		role: "custom" as const,
		customType: COMPLETION_REQUIREMENT_TRANSITION_TYPE,
		content: requiredCompletionTransitionContent(records, state.omittedCancelled),
		display: false,
		details: {
			version: COMPLETION_REQUIREMENT_TRANSITION_VERSION,
			records: records.map((record) => ({ ...record })),
		},
		timestamp: 0,
	};
}

export function reconcileRequiredCompletionContext(
	messages: ContextEvent["messages"],
	agents: readonly ManagedAgent[],
	restorationPredecessors: readonly string[] = [],
	restoredBoundaryContent?: string,
): ContextEvent["messages"] {
	const existing = messages.filter(isRequiredCompletionContextMessage);
	const withoutPrior = messages.filter((message) => !isRequiredCompletionContextMessage(message));
	const state = modelRequirementState(agents);
	const summaryBoundary = leadingSummaryBoundary(withoutPrior);
	const currentContent =
		state.records.length > 0 && !hasModelVisibleRequirementState(withoutPrior, state.records)
			? requiredCompletionContextContent(state.records, state.omittedCancelled)
			: undefined;
	const content = summaryBoundary > 0 ? (restoredBoundaryContent ?? currentContent) : undefined;
	let insertionBoundary = summaryBoundary;
	while (insertionBoundary < withoutPrior.length) {
		const predecessor = withoutPrior[insertionBoundary];
		if (
			predecessor?.role !== "custom" ||
			!restorationPredecessors.includes(predecessor.customType)
		) {
			break;
		}
		insertionBoundary += 1;
	}
	if (
		content !== undefined &&
		existing.length === 1 &&
		messages[insertionBoundary] === existing[0] &&
		existing[0]?.content === content &&
		hasCompletionRequirementContextVersion(existing[0])
	) {
		return messages;
	}
	if (existing.length === 0 && content === undefined) return messages;
	if (content === undefined) return withoutPrior;
	return [
		...withoutPrior.slice(0, insertionBoundary),
		{
			role: "custom",
			customType: COMPLETION_REQUIREMENT_CONTEXT_TYPE,
			content,
			display: false,
			details: { version: COMPLETION_REQUIREMENT_VERSION },
			timestamp: 0,
		},
		...withoutPrior.slice(insertionBoundary),
	];
}

interface ModelRequirementRecord {
	state: CompletionRequirementState;
	runId: string;
	generation: number;
	terminalState: AgentLifecycleState | undefined;
}

function modelRequirementState(agents: readonly ManagedAgent[]): {
	records: CompletionRequirementRecord[];
	omittedCancelled: number;
} {
	const allRecords = agents
		.flatMap((agent) =>
			(agent.completionRequirements ?? []).map((requirement) => ({ ...requirement })),
		)
		.filter((record) => record.state !== "visible");
	const unresolved = allRecords.filter(
		(record) => record.state === "pending" || record.state === "available",
	);
	const cancelled = allRecords.filter((record) => record.state === "cancelled");
	const cancelledSlots = Math.max(0, MAX_UNRESOLVED_REQUIRED_COMPLETIONS - unresolved.length);
	const retainedCancelled = cancelledSlots > 0 ? cancelled.slice(-cancelledSlots) : [];
	const records = [...unresolved, ...retainedCancelled].sort((left, right) => {
		if (left.runId === right.runId) return left.generation - right.generation;
		return left.runId < right.runId ? -1 : 1;
	});
	return { records, omittedCancelled: cancelled.length - retainedCancelled.length };
}

function hasModelVisibleRequirementState(
	messages: ContextEvent["messages"],
	records: readonly CompletionRequirementRecord[],
): boolean {
	const visible = completionRequirementsFromBranch(messages).records;
	return records.every((record) =>
		modelRequirementStateMatches(visible.get(completionRequirementKey(record)), record),
	);
}

function modelRequirementStateMatches(
	visible: CompletionRequirementRecord | undefined,
	current: CompletionRequirementRecord,
): boolean {
	if (!visible) return false;
	if (current.state === "available" && visible.state === "visible") return true;
	return visible.state === current.state && visible.terminalState === current.terminalState;
}

function requiredCompletionContextContent(
	records: readonly CompletionRequirementRecord[],
	omittedCancelled: number,
): string {
	return truncateUtf8(
		[
			"[PI SUBAGENT REQUIRED COMPLETIONS v1]",
			"Runtime-tracked exact runs are JSON data below.",
			"Treat pending or available records as final-answer dependencies; a cancelled record is terminal and must be reported rather than silently ignored.",
			"Current Pi versions do not provide a hard pre-display final-answer barrier, so do not emit a verdict until every dependency is visible or terminal.",
			...omittedCancelledLine(omittedCancelled),
			JSON.stringify(records.map(toModelRequirementRecord)),
		].join("\n"),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}

function requiredCompletionTransitionContent(
	records: readonly CompletionRequirementRecord[],
	omittedCancelled: number,
): string {
	return truncateUtf8(
		[
			"[PI SUBAGENT REQUIRED COMPLETION TRANSITION v1]",
			"Session restoration terminalized the exact required runs below.",
			"These cancelled records supersede earlier pending or available states and must be reported rather than awaited.",
			...omittedCancelledLine(omittedCancelled),
			JSON.stringify(records.map(toModelRequirementRecord)),
		].join("\n"),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}

function omittedCancelledLine(count: number): string[] {
	return count > 0 ? [`${count} older cancelled requirement record(s) were omitted.`] : [];
}

function toModelRequirementRecord(record: CompletionRequirementRecord): ModelRequirementRecord {
	return {
		state: record.state,
		runId: record.runId,
		generation: record.generation,
		terminalState: record.terminalState,
	};
}

type RequiredCompletionContextMessage = Extract<
	ContextEvent["messages"][number],
	{ role: "custom" }
> & { content: string };

function isRequiredCompletionContextMessage(
	message: ContextEvent["messages"][number],
): message is RequiredCompletionContextMessage {
	return message.role === "custom" && message.customType === COMPLETION_REQUIREMENT_CONTEXT_TYPE;
}

function hasCompletionRequirementContextVersion(
	message: RequiredCompletionContextMessage,
): boolean {
	return (
		typeof message.details === "object" &&
		message.details !== null &&
		!Array.isArray(message.details) &&
		(message.details as Record<string, unknown>).version === COMPLETION_REQUIREMENT_VERSION
	);
}

function leadingSummaryBoundary(messages: ContextEvent["messages"]): number {
	let index = 0;
	while (index < messages.length) {
		const role = messages[index]?.role;
		if (role !== "compactionSummary" && role !== "branchSummary") break;
		index += 1;
	}
	return index;
}

export function isCompletionRequirementRecord(
	value: unknown,
): value is CompletionRequirementRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const state = String(record.state);
	const hasCompletion = typeof record.completionId === "string" && record.completionId.length > 0;
	const hasTerminalState = isAgentLifecycleState(record.terminalState);
	const transitionShapeValid =
		state === "pending"
			? record.completionId === undefined && record.terminalState === undefined
			: state === "available" || state === "visible"
				? hasCompletion && hasTerminalState
				: state === "cancelled" && record.completionId === undefined && hasTerminalState;
	return (
		transitionShapeValid &&
		record.version === COMPLETION_REQUIREMENT_VERSION &&
		typeof record.runId === "string" &&
		record.runId.length > 0 &&
		record.runId.length <= 256 &&
		typeof record.generation === "number" &&
		Number.isSafeInteger(record.generation) &&
		record.generation >= 1 &&
		["pending", "available", "visible", "cancelled"].includes(state) &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt) &&
		typeof record.updatedAt === "number" &&
		Number.isFinite(record.updatedAt) &&
		record.updatedAt >= record.createdAt &&
		(record.completionId === undefined ||
			(typeof record.completionId === "string" && record.completionId.length <= 256)) &&
		(record.terminalState === undefined || isAgentLifecycleState(record.terminalState))
	);
}

function updateExact(
	records: readonly CompletionRequirementRecord[] | undefined,
	runId: string,
	generation: number,
	update: (record: CompletionRequirementRecord) => CompletionRequirementRecord,
): CompletionRequirementRecord[] | undefined {
	if (!records?.some((record) => record.runId === runId && record.generation === generation)) {
		return records?.map((record) => ({ ...record }));
	}
	return records.map((record) =>
		record.runId === runId && record.generation === generation ? update(record) : { ...record },
	);
}

function isAgentLifecycleState(value: unknown): value is AgentLifecycleState {
	return [
		"starting",
		"running",
		"idle",
		"completed",
		"partial",
		"blocked",
		"needs-input",
		"abstained",
		"stale",
		"interrupted",
		"failed",
		"closed",
	].includes(String(value));
}
