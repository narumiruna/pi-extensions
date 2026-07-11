import {
	isNonNegativeFiniteNumber,
	nonNegativeFiniteNumber,
	normalizeTokenBudget,
} from "./accounting.js";
import type { GoalStatus } from "./prompts.js";

const GOALS_STATE_ENTRY_TYPE = "goals-state";

export interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	activeStartedAt?: number;
}

export interface PendingUnshiftState {
	objective: string;
	tokenBudget: number | undefined;
}

export interface GoalStateEntryData {
	goal?: ActiveGoal | null;
	goals?: ActiveGoal[];
	pendingUnshift?: PendingUnshiftState;
}

interface SessionContext {
	sessionManager?: {
		getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
		getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
	};
}

export function loadPendingUnshiftFromSession(
	ctx: SessionContext,
): PendingUnshiftState | undefined {
	const pending = lastGoalStateEntry(ctx)?.pendingUnshift;
	if (!pending || typeof pending !== "object") return undefined;
	if (
		typeof pending.objective !== "string" ||
		!pending.objective.trim() ||
		pending.objective.length > 4_000
	) {
		return undefined;
	}
	return {
		objective: pending.objective,
		tokenBudget: normalizeTokenBudget(pending.tokenBudget),
	};
}

export function loadGoalsFromSession(ctx: SessionContext): ActiveGoal[] {
	const data = lastGoalStateEntry(ctx);
	if (Array.isArray(data?.goals)) {
		if (!data.goals.every(isGoal)) return [];
		return data.goals
			.filter((goal) => goal.status !== "complete")
			.map((goal, index) => {
				const normalized = normalizeLoadedGoal(goal);
				return index > 0 && normalized.status === "active"
					? { ...normalized, status: "queued", activeStartedAt: undefined }
					: normalized;
			});
	}
	if (!isGoal(data?.goal) || data.goal.status === "complete") return [];
	return [normalizeLoadedGoal(data.goal)];
}

function lastGoalStateEntry(ctx: SessionContext) {
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	const entry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOALS_STATE_ENTRY_TYPE)
		.pop();
	return entry?.data as GoalStateEntryData | undefined;
}

export function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
	const now = Date.now();
	return {
		...goal,
		startedAt: isNonNegativeFiniteNumber(goal.startedAt) ? goal.startedAt : now,
		updatedAt: isNonNegativeFiniteNumber(goal.updatedAt) ? goal.updatedAt : now,
		iteration: Math.max(0, Math.floor(nonNegativeFiniteNumber(goal.iteration))),
		tokenBudget: normalizeTokenBudget(goal.tokenBudget),
		tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
		timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
		baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
		activeStartedAt: goal.status === "active" ? now : undefined,
	};
}

function isGoal(value: unknown): value is ActiveGoal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<ActiveGoal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.text === "string" &&
		[
			"active",
			"queued",
			"paused",
			"blocked",
			"usage_limited",
			"budget_limited",
			"complete",
		].includes(String(goal.status)) &&
		typeof goal.startedAt === "number" &&
		typeof goal.updatedAt === "number" &&
		typeof goal.iteration === "number" &&
		typeof goal.tokensUsed === "number" &&
		typeof goal.timeUsedSeconds === "number" &&
		typeof goal.baselineTokens === "number" &&
		(goal.activeStartedAt === undefined || typeof goal.activeStartedAt === "number")
	);
}
