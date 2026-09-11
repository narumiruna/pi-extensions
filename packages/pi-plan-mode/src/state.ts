import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planFromCompletionDetails,
} from "./completion-tool.js";
import {
	type ImplementationModelOverride,
	isPendingImplementationModelIdentifier,
} from "./implementation-models.js";
import {
	IMPLEMENTATION_PLAN_RETENTIONS,
	type ImplementationPlanRetention,
	PLAN_MODE_THINKING_LEVELS,
	type PlanModeFixedThinkingLevel,
} from "./settings.js";

export type { ImplementationModelOverride } from "./implementation-models.js";
export {
	isPendingImplementationModelIdentifier,
	MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH,
} from "./implementation-models.js";

export type PlanCompletionSource = typeof PLAN_MODE_COMPLETE_TOOL_NAME | "legacy_proposed_plan";

export interface ActiveImplementationPlan {
	id: string;
	plan: string;
	source: PlanCompletionSource;
	startedAt: number;
	retention?: ImplementationPlanRetention;
}

export interface SavedPlan {
	plan: string;
	source: PlanCompletionSource;
}

export interface ImplementationRuntimeSelection {
	model?: ImplementationModelOverride;
	thinkingLevel?: PlanModeFixedThinkingLevel;
}

export interface PendingImplementationRuntime extends ImplementationRuntimeSelection {
	version: 1;
}

export interface PlanModeWorkflowToolPolicy {
	kind: "automatic" | "explicit";
	desiredNames?: string[];
	allowedNames: string[];
	resolved: boolean;
}

export interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	latestPlanSource?: PlanCompletionSource;
	awaitingAction: boolean;
	savedPlan?: SavedPlan;
	activeImplementation?: ActiveImplementationPlan;
	pendingImplementationRuntime?: PendingImplementationRuntime;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
	workflowToolPolicy?: PlanModeWorkflowToolPolicy;
	previousThinkingLevel?: PlanModeFixedThinkingLevel;
	appliedThinkingLevel?: PlanModeFixedThinkingLevel;
	manualThinkingLevel?: PlanModeFixedThinkingLevel;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
};

export function restorePlanModeState(entries: unknown[], stateEntryType: string): PlanModeState {
	const branch = entries as SessionEntry[];
	let stateEntryIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === stateEntryType) {
			stateEntryIndex = index;
			break;
		}
	}
	const entry = branch[stateEntryIndex];
	if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

	const enabled = entry.data.enabled === true;
	const persistedSource = enabled ? planCompletionSource(entry.data.latestPlanSource) : undefined;
	const persistedPlan = enabled ? normalizePersistedPlan(entry.data.latestPlan) : undefined;
	const recoveredPlan =
		enabled && !persistedPlan ? latestCompletionPlan(branch.slice(stateEntryIndex + 1)) : undefined;
	const latestPlan = persistedPlan ?? recoveredPlan;
	const activeImplementation = enabled
		? undefined
		: normalizeActiveImplementation(entry.data.activeImplementation);
	const savedPlan =
		enabled || activeImplementation ? undefined : normalizeSavedPlan(entry.data.savedPlan);
	const pendingImplementationRuntime = enabled
		? undefined
		: normalizePendingImplementationRuntime(entry.data.pendingImplementationRuntime);
	return {
		enabled,
		latestPlan,
		latestPlanSource: enabled
			? ((persistedPlan ? persistedSource : undefined) ??
				(recoveredPlan ? PLAN_MODE_COMPLETE_TOOL_NAME : undefined))
			: undefined,
		awaitingAction: enabled && latestPlan !== undefined,
		savedPlan,
		activeImplementation,
		pendingImplementationRuntime,
		selectedToolNames: stringArray(entry.data.selectedToolNames),
		selectedToolKeys: stringArray(entry.data.selectedToolKeys),
		workflowToolPolicy: enabled
			? normalizeWorkflowToolPolicy(entry.data.workflowToolPolicy)
			: undefined,
		previousThinkingLevel: enabled
			? fixedThinkingLevel(entry.data.previousThinkingLevel)
			: undefined,
		appliedThinkingLevel: enabled ? fixedThinkingLevel(entry.data.appliedThinkingLevel) : undefined,
		manualThinkingLevel: enabled ? fixedThinkingLevel(entry.data.manualThinkingLevel) : undefined,
	};
}

function normalizeWorkflowToolPolicy(value: unknown): PlanModeWorkflowToolPolicy | undefined {
	if (value === undefined) return undefined;
	const denied: PlanModeWorkflowToolPolicy = {
		kind: "automatic",
		allowedNames: [],
		resolved: true,
	};
	if (!isRecord(value)) return denied;
	const kind = value.kind === "automatic" || value.kind === "explicit" ? value.kind : undefined;
	const allowedNames = stringArray(value.allowedNames);
	if (!kind || !allowedNames || typeof value.resolved !== "boolean") return denied;
	if (kind === "automatic") {
		return { kind, allowedNames, resolved: value.resolved };
	}
	const desiredNames = stringArray(value.desiredNames);
	if (!desiredNames) return denied;
	return { kind, desiredNames, allowedNames, resolved: value.resolved };
}

function normalizeSavedPlan(value: unknown): SavedPlan | undefined {
	if (!isRecord(value)) return undefined;
	const source = planCompletionSource(value.source);
	const normalized = normalizePlanModeCompletion({ plan: value.plan });
	if (!source || !normalized.ok) return undefined;
	return { plan: normalized.plan, source };
}

function normalizePendingImplementationRuntime(
	value: unknown,
): PendingImplementationRuntime | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		Object.keys(value).some(
			(key) => key !== "version" && key !== "model" && key !== "thinkingLevel",
		)
	) {
		return undefined;
	}
	let model: ImplementationModelOverride | undefined;
	if (value.model !== undefined) {
		if (
			!isRecord(value.model) ||
			Object.keys(value.model).some((key) => key !== "provider" && key !== "modelId")
		) {
			return undefined;
		}
		if (
			!isPendingImplementationModelIdentifier(value.model.provider) ||
			!isPendingImplementationModelIdentifier(value.model.modelId)
		) {
			return undefined;
		}
		model = { provider: value.model.provider, modelId: value.model.modelId };
	}
	const thinkingLevel =
		value.thinkingLevel === undefined ? undefined : fixedThinkingLevel(value.thinkingLevel);
	if (value.thinkingLevel !== undefined && !thinkingLevel) return undefined;
	if (!model && !thinkingLevel) return undefined;
	return {
		version: 1,
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function normalizeActiveImplementation(value: unknown): ActiveImplementationPlan | undefined {
	if (!isRecord(value)) return undefined;
	const id =
		typeof value.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.id)
			? value.id
			: undefined;
	const source = planCompletionSource(value.source);
	const normalized = normalizePlanModeCompletion({ plan: value.plan });
	const startedAt =
		typeof value.startedAt === "number" &&
		Number.isSafeInteger(value.startedAt) &&
		value.startedAt >= 0
			? value.startedAt
			: undefined;
	if (!id || !source || !normalized.ok || startedAt === undefined) return undefined;
	const retention = IMPLEMENTATION_PLAN_RETENTIONS.includes(
		value.retention as ImplementationPlanRetention,
	)
		? (value.retention as ImplementationPlanRetention)
		: "keep";
	return { id, plan: normalized.plan, source, startedAt, retention };
}

function normalizePersistedPlan(value: unknown) {
	const normalized = normalizePlanModeCompletion({ plan: value });
	return normalized.ok ? normalized.plan : undefined;
}

function latestCompletionPlan(entries: SessionEntry[]) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.toolName !== PLAN_MODE_COMPLETE_TOOL_NAME) {
			continue;
		}
		const plan = planFromCompletionDetails(message.details);
		if (plan) return plan;
	}
	return undefined;
}

function planCompletionSource(value: unknown): PlanCompletionSource | undefined {
	return value === PLAN_MODE_COMPLETE_TOOL_NAME || value === "legacy_proposed_plan"
		? value
		: undefined;
}

function fixedThinkingLevel(value: unknown): PlanModeFixedThinkingLevel | undefined {
	return typeof value === "string" &&
		value !== "inherit" &&
		PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])
		? (value as PlanModeFixedThinkingLevel)
		: undefined;
}

function stringArray(value: unknown) {
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
		? Array.from(new Set(value))
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
