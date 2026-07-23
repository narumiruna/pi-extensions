import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	checkpointGoalActiveTime,
	formatDuration,
	formatTokenCount,
	updateGoalUsage,
} from "./accounting.js";
import { formatError, truncateNotification } from "./errors.js";
import {
	appendGoalPromptMarker,
	extractContinuationMarker,
	extractGoalPromptMarker,
} from "./markers.js";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	type PendingQueueAction,
	type SafetyPauseCause,
	serializeGoalState,
} from "./persistence.js";
import { buildContinuePrompt, type GoalStatus } from "./prompts.js";
import { nextToolFreeRepeatState, resetGoalSafetyEpoch } from "./safety.js";

export { queueGoalSafetyReset, resetGoalSafetyEpoch } from "./safety.js";

import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "./settings.js";

export interface ContinuationTicket {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

export interface BudgetWrapUp {
	goalId: string;
	delivered: boolean;
}

export type GoalRecoveryKind = "provider_retry" | "compaction_retry";

export type GoalRunOrigin = "manual" | "automatic";

export interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
	automaticOwner: boolean;
	errorMessage?: string;
}

export interface CompletedGoalRun {
	goalId?: string | null;
	origin?: GoalRunOrigin;
	toolAttempted: boolean;
}

export interface StatusContext {
	cwd: string;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
}

export interface GoalToolVisibilitySnapshot {
	activeTools: string[];
	goalToolsUnlocked: boolean;
	goalToolsHiddenByPolicy: string[];
}

export const STATUS_KEY = "goal";
export const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const GOAL_COMPLETE_TOOL = "goal_complete";
export const GOAL_BLOCKED_TOOL = "goal_blocked";
export const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;

/** Cross-extension event channel carrying the canonical persisted goal state. */
export const GOAL_STATE_EVENT_CHANNEL = "pi-goal:state";

/** State values broadcast to cross-extension listeners. */
export type GoalStateEventStatus = GoalStatus | "cleared";

/** Payload emitted on {@link GOAL_STATE_EVENT_CHANNEL} whenever goal state persists. */
export interface GoalStateEventPayload {
	goalId: string;
	status: GoalStateEventStatus;
	summary?: string;
	reason?: string;
}

/** Terminal statuses broadcast to cross-extension listeners. */
export function isTerminalGoalStatus(status: GoalStateEventStatus): boolean {
	return status !== "active" && status !== "queued";
}

/**
 * Build the cross-extension state payload from the canonical goal plus the most
 * recent completion summary or blocked/failure reason, without re-deriving state.
 */
export function buildGoalStateEvent(
	goal: ActiveGoal,
	summary: string | undefined,
	reason: string | undefined,
): GoalStateEventPayload {
	const payload: GoalStateEventPayload = { goalId: goal.id, status: goal.status };
	if (goal.status === "complete" && summary) payload.summary = summary;
	else if (goal.status !== "complete" && isTerminalGoalStatus(goal.status) && reason) {
		payload.reason = reason;
	}
	return payload;
}

interface GoalTerminalDetails {
	goalId: string;
	summary?: string;
	reason?: string;
}

interface PendingGoalPrompt {
	goalId: string;
	resetSafetyEpoch: boolean;
}

interface PendingNonGoalInput {
	behavior: "steer" | "followUp";
	fingerprint: string;
	resetSafetyEpoch: boolean;
}

const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const MAX_PENDING_GOAL_PROMPTS = 20;
const MAX_PENDING_NON_GOAL_INPUTS = 20;
const BUDGET_WRAP_UP_MESSAGE_TYPE = "goal-budget-wrap-up";
const BUDGET_WRAP_UP_PROMPT =
	"The active /goal token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goal_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";
const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
// One instance belongs to one extension factory. It owns all mutable session state
// and the cross-cutting invariants used by command and lifecycle orchestration.
export class GoalRuntime {
	settings: GoalSettings = DEFAULT_GOAL_SETTINGS;
	activeGoal?: ActiveGoal;
	/** Terminal details captured for the matching cross-extension state event. */
	private terminalDetails?: GoalTerminalDetails;
	queuedGoals: ActiveGoal[] = [];
	pendingQueueAction?: PendingQueueAction;
	queueFrozen = false;
	completionStatusTimer?: NodeJS.Timeout;
	continuationIntent?: ContinuationTicket;
	continuationDelivery?: ContinuationTicket;
	goalRecovery?: GoalRecovery;
	budgetWrapUp?: BudgetWrapUp;
	/** `null` marks a run that must not be charged to the active goal. */
	agentRunGoalId?: string | null;
	agentRunOrigin?: GoalRunOrigin;
	agentRunToolAttempted = false;
	guardAbortGoalId?: string;
	staleGoalToolCallsBlocked = false;
	/** Once true, goal tools stay in the active set for this runtime (prompt-cache stable). */
	goalToolsUnlocked = false;
	/** Exact lazy goal tools this runtime removed and may restore on a mode change. */
	goalToolsHiddenByPolicy = new Set<string>();
	pendingGoalPromptMarkers = new Map<string, PendingGoalPrompt>();
	cancelledContinuationMarkers = new Set<string>();
	pendingNonGoalInputs: PendingNonGoalInput[] = [];

	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	canRecordGoalUsage(goalId?: string) {
		return (
			this.agentRunGoalId !== null &&
			(goalId === undefined ||
				this.agentRunGoalId === undefined ||
				this.agentRunGoalId === goalId) &&
			!(
				this.pendingQueueAction?.kind === "prioritize" &&
				this.pendingQueueAction.displacedUsageFinalized === true
			)
		);
	}

	hasActiveBudgetWrapUp() {
		return (
			this.activeGoal?.status === "budget_limited" &&
			this.budgetWrapUp?.goalId === this.activeGoal.id &&
			this.budgetWrapUp.delivered
		);
	}

	hasActiveGoalRecovery() {
		return Boolean(this.activeGoal && this.goalRecovery?.goalId === this.activeGoal.id);
	}

	beginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {
		this.agentRunGoalId = goalId;
		this.agentRunOrigin = origin;
		this.agentRunToolAttempted = false;
	}

	beginRecoveryRunIfNeeded() {
		if (this.agentRunGoalId !== undefined || !this.activeGoal) return;
		const recovery = this.goalRecovery;
		if (!recovery || recovery.goalId !== this.activeGoal.id) return;
		this.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");
	}

	markAgentToolAttempted() {
		if (this.agentRunGoalId !== undefined) this.agentRunToolAttempted = true;
	}

	finishAgentRun(): CompletedGoalRun {
		const run = {
			goalId: this.agentRunGoalId,
			origin: this.agentRunOrigin,
			toolAttempted: this.agentRunToolAttempted,
		};
		this.clearAgentRun();
		return run;
	}

	clearAgentRun() {
		this.agentRunGoalId = undefined;
		this.agentRunOrigin = undefined;
		this.agentRunToolAttempted = false;
	}

	reclassifyAgentRunAsManual() {
		if (this.agentRunGoalId !== undefined) this.agentRunOrigin = "manual";
	}

	isAutomaticRunForGoal(goalId: string) {
		return this.agentRunGoalId === goalId && this.agentRunOrigin === "automatic";
	}

	recordGoalUsage(
		goal: ActiveGoal,
		ctx: StatusContext,
		checkpointActiveTime = goal.status === "active",
	) {
		if (!this.canRecordGoalUsage(goal.id)) return false;
		updateGoalUsage(goal, ctx, checkpointActiveTime);
		return true;
	}

	requestContinuation(goal: ActiveGoal) {
		if (this.hasContinuationWorkForGoal(goal.id)) return false;
		const marker = continuationMarker(goal);
		this.continuationIntent = {
			goalId: goal.id,
			iteration: goal.iteration,
			marker,
			prompt: buildContinuePrompt(goal, marker),
		};
		return true;
	}

	dispatchContinuationIfSettled(ctx: StatusContext) {
		const intent = this.continuationIntent;
		if (!intent) return false;
		if (this.activeGoal?.status === "active" && !this.goalToolsAvailable()) {
			this.pauseGoalForUnavailableTools(ctx);
			return false;
		}
		if (
			!this.activeGoal ||
			this.activeGoal.id !== intent.goalId ||
			this.activeGoal.status !== "active"
		) {
			this.continuationIntent = undefined;
			return false;
		}
		if (this.enforceAutomaticTurnLimit(ctx, false) || this.enforceNoProgressLimit(ctx)) {
			return false;
		}
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

		this.continuationIntent = undefined;
		this.continuationDelivery = intent;
		try {
			this.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });
			return true;
		} catch (error) {
			if (this.continuationDelivery?.marker === intent.marker) {
				this.continuationDelivery = undefined;
			}
			if (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
				this.continuationIntent = intent;
			}
			ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	hasContinuationWorkForGoal(goalId: string) {
		return (
			this.continuationIntent?.goalId === goalId || this.continuationDelivery?.goalId === goalId
		);
	}

	updateStatus(ctx: StatusContext, goal: ActiveGoal) {
		this.clearCompletionStatusTimer();
		ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
	}

	blockStaleGoalToolCalls() {
		this.staleGoalToolCallsBlocked = true;
	}

	clearStaleGoalToolCallBlock() {
		this.staleGoalToolCallsBlocked = false;
	}

	clearGoalRecovery() {
		this.goalRecovery = undefined;
	}

	clearBudgetWrapUp() {
		this.budgetWrapUp = undefined;
	}

	setCompletionSummary(goalId: string, summary: string) {
		this.terminalDetails = { goalId, summary };
	}

	setTerminalReason(goalId: string, reason: string) {
		this.terminalDetails = { goalId, reason };
	}

	clearTerminalDetails() {
		this.terminalDetails = undefined;
	}

	isActiveBudgetWrapUpMessage(message: unknown) {
		if (!message || typeof message !== "object") return false;
		const candidate = message as {
			role?: unknown;
			customType?: unknown;
			details?: { goalId?: unknown };
		};
		return (
			candidate.role === "custom" &&
			candidate.customType === BUDGET_WRAP_UP_MESSAGE_TYPE &&
			typeof candidate.details?.goalId === "string" &&
			candidate.details.goalId === this.budgetWrapUp?.goalId &&
			candidate.details.goalId === this.activeGoal?.id
		);
	}

	keepBudgetWrapUpMessage(message: unknown) {
		if (!message || typeof message !== "object") return true;
		const candidate = message as { role?: unknown; customType?: unknown };
		if (candidate.role !== "custom" || candidate.customType !== BUDGET_WRAP_UP_MESSAGE_TYPE) {
			return true;
		}
		return this.isActiveBudgetWrapUpMessage(message);
	}

	queueBudgetWrapUp(ctx: StatusContext, goal: ActiveGoal) {
		if (!this.budgetWrapUp || this.budgetWrapUp.goalId !== goal.id) {
			this.budgetWrapUp = { goalId: goal.id, delivered: false };
		}
		if (this.budgetWrapUp.delivered) return true;
		this.budgetWrapUp.delivered = true;
		try {
			this.pi.sendMessage(
				{
					customType: BUDGET_WRAP_UP_MESSAGE_TYPE,
					content: BUDGET_WRAP_UP_PROMPT,
					display: true,
					details: { goalId: goal.id },
				},
				{ deliverAs: "steer" },
			);
			return true;
		} catch (error) {
			this.budgetWrapUp.delivered = false;
			ctx.ui.notify(`Goal budget wrap-up failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	limitActiveGoalForBudget(ctx: StatusContext, sendWrapUp: boolean) {
		const goal = this.activeGoal;
		if (
			goal?.status !== "active" ||
			goal.tokenBudget === undefined ||
			goal.tokensUsed < goal.tokenBudget
		) {
			return false;
		}

		this.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		this.activeGoal = transitionGoal(goal, "budget_limited");
		this.setTerminalReason(
			this.activeGoal.id,
			`token budget reached (${formatBudget(this.activeGoal)})`,
		);
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		ctx.ui.notify(`Goal token budget reached: ${formatBudget(this.activeGoal)}`, "warning");
		if (sendWrapUp) this.queueBudgetWrapUp(ctx, this.activeGoal);
		return true;
	}

	recordAutomaticTurn(ctx: StatusContext, message: unknown) {
		const goal = this.activeGoal;
		if (goal?.status !== "active" || !this.isAutomaticRunForGoal(goal.id)) return false;
		const candidate = message as { role?: unknown; stopReason?: unknown } | undefined;
		if (candidate?.role === "assistant" && candidate.stopReason === "aborted") return false;
		goal.automaticModelTurns = Math.min(Number.MAX_SAFE_INTEGER, goal.automaticModelTurns + 1);
		this.recordGoalUsage(goal, ctx);
		this.persistGoal(goal);
		this.updateStatus(ctx, goal);
		// Terminal errors need agent_end classification before a safety pause can
		// choose between usage_limited, blocked, or retryable cleanup.
		if (candidate?.role === "assistant" && candidate.stopReason === "error") return false;
		return this.enforceAutomaticTurnLimit(ctx, true);
	}

	recordAutomaticRunProgress(
		ctx: StatusContext,
		goalId: string,
		messages: readonly unknown[],
		toolAttempted: boolean,
	) {
		const goal = this.activeGoal;
		if (goal?.id !== goalId || goal.status !== "active") return false;
		const next = nextToolFreeRepeatState(goal, messages, toolAttempted);
		goal.toolFreeRepeatCount = next.toolFreeRepeatCount;
		goal.lastToolFreeOutputFingerprint = next.lastToolFreeOutputFingerprint;
		this.persistGoal(goal);
		this.updateStatus(ctx, goal);
		const limit = this.settings.continuationLimits.noProgressTurns;
		if (limit === null || goal.toolFreeRepeatCount < limit) return false;
		return this.pauseGoalForSafety(ctx, "no_progress", false);
	}

	enforceAutomaticTurnLimit(ctx: StatusContext, abortTurn: boolean) {
		const goal = this.activeGoal;
		const limit = this.settings.continuationLimits.automaticTurns;
		if (goal?.status !== "active" || limit === null || goal.automaticModelTurns < limit) {
			return false;
		}
		return this.pauseGoalForSafety(ctx, "continuation_limit", abortTurn);
	}

	enforceNoProgressLimit(ctx: StatusContext) {
		const goal = this.activeGoal;
		const limit = this.settings.continuationLimits.noProgressTurns;
		if (goal?.status !== "active" || limit === null || goal.toolFreeRepeatCount < limit) {
			return false;
		}
		return this.pauseGoalForSafety(ctx, "no_progress", false);
	}

	pauseGoalForSafety(ctx: StatusContext, cause: SafetyPauseCause, abortTurn: boolean) {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		this.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		this.blockStaleGoalToolCalls();
		if (abortTurn) {
			this.guardAbortGoalId = goal.id;
			abortCurrentTurn(ctx);
		}
		this.activeGoal = transitionGoal({ ...goal, safetyPauseCause: cause }, "paused");
		const count =
			cause === "continuation_limit"
				? `${this.activeGoal.automaticModelTurns} automatic model responses`
				: `no progress across ${this.activeGoal.toolFreeRepeatCount} automatic runs`;
		this.setTerminalReason(
			this.activeGoal.id,
			`${cause} (${count}; ${formatTokenCount(this.activeGoal.tokensUsed)} tokens)`,
		);
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		ctx.ui.notify(
			`Goal paused: ${count}; ${formatTokenCount(this.activeGoal.tokensUsed)} cumulative tokens. Run /goal resume to continue.`,
			"warning",
		);
		return true;
	}

	resetActiveSafetyEpoch(ctx: StatusContext) {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		this.activeGoal = resetGoalSafetyEpoch(goal);
		this.reclassifyAgentRunAsManual();
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		return true;
	}

	finalizeSettledRecovery(ctx: StatusContext) {
		const recovery = this.goalRecovery;
		if (!recovery) return false;
		this.goalRecovery = undefined;
		const goal = this.activeGoal;
		if (goal?.id !== recovery.goalId || goal.status !== "active") return false;
		this.cancelContinuationWork();
		this.clearBudgetWrapUp();
		this.blockStaleGoalToolCalls();
		this.activeGoal = transitionGoal(goal, "blocked");
		const details = recovery.errorMessage ? `: ${truncateNotification(recovery.errorMessage)}` : "";
		this.setTerminalReason(this.activeGoal.id, `agent error after retries${details}`);
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		ctx.ui.notify(
			`Goal blocked after agent error retries were exhausted${details}. Resolve the blocker or run /goal resume to retry.`,
			"warning",
		);
		return true;
	}

	clearSettledSafetyTracking() {
		this.guardAbortGoalId = undefined;
		this.pendingNonGoalInputs = [];
		this.clearAgentRun();
	}

	clearGoalRecoveryForGoal(goalId: string) {
		if (this.goalRecovery?.goalId === goalId) this.goalRecovery = undefined;
	}

	isPiOwnedCompactionRetry(event: unknown, goalId: string) {
		const compaction = event as { reason?: unknown; willRetry?: unknown };
		if (compaction.willRetry === true) return true;
		return (
			this.goalRecovery?.goalId === goalId &&
			this.goalRecovery.kind === "compaction_retry" &&
			(compaction.reason === undefined || compaction.reason === "overflow")
		);
	}

	clearContinuationTracking() {
		this.continuationIntent = undefined;
		this.continuationDelivery = undefined;
		this.cancelledContinuationMarkers.clear();
	}

	clearPendingGoalPrompts() {
		this.pendingGoalPromptMarkers.clear();
		this.pendingNonGoalInputs = [];
	}

	async sendOwnedGoalPrompt(
		ctx: StatusContext,
		goalId: string,
		prompt: string,
		resetSafetyEpoch = true,
	) {
		const pending = this.rememberPendingGoalPrompt(goalId, prompt, resetSafetyEpoch);
		const sent = await sendPrompt(this.pi, ctx, pending.prompt);
		if (!sent) this.pendingGoalPromptMarkers.delete(pending.marker);
		return sent;
	}

	cancelContinuationWork() {
		if (this.continuationDelivery) {
			this.rememberCancelledContinuationMarker(this.continuationDelivery.marker);
		}
		this.continuationIntent = undefined;
		this.continuationDelivery = undefined;
	}

	consumeCancelledContinuationPrompt(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		return marker ? this.cancelledContinuationMarkers.delete(marker) : false;
	}

	hasPendingOwnedGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		return marker ? this.pendingGoalPromptMarkers.has(marker) : false;
	}

	consumeStaleOwnedGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return false;
		const pending = this.pendingGoalPromptMarkers.get(marker);
		if (!pending) return false;
		if (
			!this.queueFrozen &&
			!this.pendingQueueAction &&
			this.activeGoal?.id === pending.goalId &&
			this.activeGoal.status === "active"
		) {
			return false;
		}
		this.pendingGoalPromptMarkers.delete(marker);
		return true;
	}

	noteQueuedNonGoalInput(prompt: string, behavior: "steer" | "followUp", resetSafetyEpoch = false) {
		this.pendingNonGoalInputs.push({
			behavior,
			fingerprint: inputFingerprint(prompt),
			resetSafetyEpoch,
		});
		if (this.pendingNonGoalInputs.length > MAX_PENDING_NON_GOAL_INPUTS) {
			this.pendingNonGoalInputs.shift();
		}
	}

	consumeQueuedNonGoalInput(prompt: string, allowDeliveryFallback = true) {
		if (typeof prompt !== "string") return undefined;
		const fingerprint = inputFingerprint(prompt);
		// Pi delivers steers before follow-ups. Prefer a matching steer even when an
		// identical follow-up was queued first so it cannot steal follow-up ownership.
		const steerIndex = this.pendingNonGoalInputs.findIndex(
			(pending) => pending.behavior === "steer" && pending.fingerprint === fingerprint,
		);
		const exactIndex =
			steerIndex >= 0
				? steerIndex
				: this.pendingNonGoalInputs.findIndex(
						(pending) => pending.behavior === "followUp" && pending.fingerprint === fingerprint,
					);
		if (exactIndex >= 0) return this.pendingNonGoalInputs.splice(exactIndex, 1)[0];
		if (!allowDeliveryFallback) return undefined;

		// Skills, templates, and later input handlers can transform the raw text after
		// pi-goal records it. Fall back to Pi's delivery priority as a bounded marker:
		// steers drain before follow-ups, and settlement clears stale entries.
		const fallbackSteerIndex = this.pendingNonGoalInputs.findIndex(
			(pending) => pending.behavior === "steer",
		);
		const fallbackIndex =
			fallbackSteerIndex >= 0
				? fallbackSteerIndex
				: this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
		if (fallbackIndex < 0) return undefined;
		return this.pendingNonGoalInputs.splice(fallbackIndex, 1)[0];
	}

	consumeQueuedNonGoalFollowUpForAgentStart() {
		// A pending steer owns the next intra-run boundary. Do not let a later
		// follow-up suppress cleanup until all earlier-priority steers have started.
		if (this.pendingNonGoalInputs.some((pending) => pending.behavior === "steer")) return false;
		const index = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
		if (index < 0) return false;
		this.pendingNonGoalInputs.splice(index, 1);
		return true;
	}

	markContinuationStarted(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		if (!marker) {
			// A user, retry, or another extension started newer work. Cancel both an
			// unsent intent and a delivery that may have lost the non-atomic idle race;
			// the newer work's agent_end will record a fresh intent.
			this.cancelContinuationWork();
			return undefined;
		}
		if (this.continuationDelivery?.marker === marker) this.continuationDelivery = undefined;
		return marker.split(":", 1)[0];
	}

	persistGoal(goal: ActiveGoal) {
		if (!isTerminalGoalStatus(goal.status) || this.terminalDetails?.goalId !== goal.id) {
			this.clearTerminalDetails();
		}
		this.pi.appendEntry(
			GOAL_STATE_ENTRY_TYPE,
			serializeGoalState(goal, this.queuedGoals, this.pendingQueueAction),
		);
		this.pi.events.emit(
			GOAL_STATE_EVENT_CHANNEL,
			buildGoalStateEvent(goal, this.terminalDetails?.summary, this.terminalDetails?.reason),
		);
	}

	clearPersistedGoal(cwd: string, clearedGoal?: ActiveGoal, reason = "goal cleared") {
		this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(undefined, [], undefined));
		if (clearedGoal) {
			this.pi.events.emit(GOAL_STATE_EVENT_CHANNEL, {
				goalId: clearedGoal.id,
				status: "cleared",
				reason,
			} satisfies GoalStateEventPayload);
		}
		this.clearTerminalDetails();
		clearLegacyPersistedGoal(cwd);
	}

	clearActiveGoal(ctx: StatusContext, reason = "goal cleared") {
		const clearedGoal = this.activeGoal;
		this.cancelContinuationWork();
		this.clearGoalRecovery();
		this.clearBudgetWrapUp();
		this.clearStaleGoalToolCallBlock();
		this.activeGoal = undefined;
		this.queuedGoals = [];
		this.pendingQueueAction = undefined;
		this.queueFrozen = false;
		this.clearPersistedGoal(ctx.cwd, clearedGoal, reason);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		// Do not clear goalToolsUnlocked: after first activation, keep tools visible
		// for the rest of this extension runtime to avoid repeated goal-tool schema
		// churn within the same runtime.
	}

	isGoalToolName(name: string) {
		return (GOAL_TOOL_NAMES as readonly string[]).includes(name);
	}

	goalToolsAvailable() {
		const active = new Set(this.pi.getActiveTools());
		return GOAL_TOOL_NAMES.every((name) => active.has(name));
	}

	hideGoalToolsIfLocked() {
		if (this.goalToolsUnlocked) return;
		const active = this.pi.getActiveTools();
		const hidden = active.filter((name) => this.isGoalToolName(name));
		if (hidden.length === 0) return;
		this.pi.setActiveTools(active.filter((name) => !this.isGoalToolName(name)));
		for (const name of hidden) this.goalToolsHiddenByPolicy.add(name);
	}

	restoreGoalToolsHiddenByPolicy() {
		const activeBeforeRestore = this.pi.getActiveTools();
		const activeSet = new Set(activeBeforeRestore);
		const missingOwnedTools = [...this.goalToolsHiddenByPolicy].filter(
			(name) => !activeSet.has(name),
		);
		if (missingOwnedTools.length === 0) {
			this.goalToolsHiddenByPolicy.clear();
			return;
		}
		try {
			this.pi.setActiveTools([...activeBeforeRestore, ...missingOwnedTools]);
			const restored = new Set(this.pi.getActiveTools());
			if (missingOwnedTools.some((name) => !restored.has(name))) {
				throw new Error("the active tool policy rejected a previously hidden goal tool");
			}
			this.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			this.pi.setActiveTools(activeBeforeRestore);
			throw error;
		}
	}

	assertGoalToolsAvailable() {
		if (this.goalToolsAvailable()) return;
		throw new Error(
			"goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
		);
	}

	ensureGoalToolsVisible() {
		const active = this.pi.getActiveTools();
		const activeSet = new Set(active);
		const missing = GOAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
		if (missing.length > 0) this.pi.setActiveTools([...active, ...missing]);
		this.assertGoalToolsAvailable();
	}

	prepareGoalToolsForActivation(ctx: StatusContext) {
		if (this.settings.toolVisibility === "after-first-goal") {
			if (!this.goalToolsAvailable() && ctx.isIdle?.() !== true) {
				throw new Error("wait until Pi is idle before revealing the goal tools");
			}
			this.revealGoalTools();
			return;
		}
		this.assertGoalToolsAvailable();
	}

	/** Mark lazy tools permanently desired for this runtime and make them active now. */
	revealGoalTools() {
		const activeBeforeReveal = this.pi.getActiveTools();
		const wasUnlocked = this.goalToolsUnlocked;
		try {
			this.ensureGoalToolsVisible();
			this.goalToolsUnlocked = true;
			this.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			this.pi.setActiveTools(activeBeforeReveal);
			this.goalToolsUnlocked = wasUnlocked;
			throw error;
		}
	}

	snapshotGoalToolVisibility(): GoalToolVisibilitySnapshot {
		return {
			activeTools: this.pi.getActiveTools(),
			goalToolsUnlocked: this.goalToolsUnlocked,
			goalToolsHiddenByPolicy: [...this.goalToolsHiddenByPolicy],
		};
	}

	restoreGoalToolVisibility(snapshot: GoalToolVisibilitySnapshot) {
		this.pi.setActiveTools(snapshot.activeTools);
		this.goalToolsUnlocked = snapshot.goalToolsUnlocked;
		this.goalToolsHiddenByPolicy.clear();
		for (const name of snapshot.goalToolsHiddenByPolicy) {
			this.goalToolsHiddenByPolicy.add(name);
		}
	}

	pauseGoalForUnavailableTools(ctx: StatusContext, abortTurn = true, recordUsage = true) {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		if (recordUsage) this.recordGoalUsage(goal, ctx);
		this.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		if (abortTurn) {
			this.blockStaleGoalToolCalls();
			abortCurrentTurn(ctx);
		} else {
			this.clearStaleGoalToolCallBlock();
		}
		this.activeGoal = transitionGoal(goal, "paused");
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		ctx.ui.notify(
			"Goal tools are unavailable, so the active goal was paused. Restore the tools and run /goal resume.",
			"warning",
		);
		return true;
	}

	showCompletionStatus(ctx: StatusContext) {
		this.clearCompletionStatusTimer();
		ctx.ui.setStatus(STATUS_KEY, "complete");
		this.completionStatusTimer = setTimeout(() => {
			this.completionStatusTimer = undefined;
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// The completion status is best-effort; the captured ctx may be stale after
				// session replacement or reload before this timer fires.
			}
		}, 8_000);
	}

	clearCompletionStatusTimer() {
		if (!this.completionStatusTimer) return;
		clearTimeout(this.completionStatusTimer);
		this.completionStatusTimer = undefined;
	}

	private rememberPendingGoalPrompt(goalId: string, prompt: string, resetSafetyEpoch: boolean) {
		const marker = randomUUID();
		this.pendingGoalPromptMarkers.set(marker, { goalId, resetSafetyEpoch });
		if (this.pendingGoalPromptMarkers.size > MAX_PENDING_GOAL_PROMPTS) {
			const oldest = this.pendingGoalPromptMarkers.keys().next().value;
			if (oldest) this.pendingGoalPromptMarkers.delete(oldest);
		}
		return { marker, prompt: appendGoalPromptMarker(prompt, marker) };
	}

	private consumePendingGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return undefined;
		const pending = this.pendingGoalPromptMarkers.get(marker);
		this.pendingGoalPromptMarkers.delete(marker);
		return pending;
	}

	consumeOwnedGoalPrompt(prompt: string) {
		return this.consumePendingGoalPrompt(prompt);
	}

	private rememberCancelledContinuationMarker(marker: string) {
		this.cancelledContinuationMarkers.add(marker);
		if (this.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
		const oldest = this.cancelledContinuationMarkers.values().next().value;
		if (oldest) this.cancelledContinuationMarkers.delete(oldest);
	}
}

export function createGoal(
	text: string,
	tokenBudget: number | undefined,
	baselineTokens: number,
): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
		activeStartedAt: now,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
	};
}

export function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus): ActiveGoal {
	const now = Date.now();
	const status =
		requestedStatus === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
			? "budget_limited"
			: requestedStatus;
	const next = { ...goal, status, updatedAt: now };
	checkpointGoalActiveTime(next, now, status === "active");
	return next;
}

export function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
	return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

export function editedGoalStatus(status: GoalStatus): GoalStatus {
	if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
	return "active";
}

export function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

export function formatStatus(goal: ActiveGoal | undefined) {
	if (!goal) return undefined;
	if (goal.status === "complete") return "complete";
	if (goal.status === "queued") return "queued";
	if (goal.status === "paused") return "paused";
	if (goal.status === "blocked") return "blocked";
	if (goal.status === "usage_limited") return "usage";
	if (goal.status === "budget_limited") return `budget ${formatBudget(goal)}`;
	if (goal.tokenBudget !== undefined) return `active ${formatBudget(goal)}`;
	return `active ${formatDuration(goal.timeUsedSeconds)}`;
}

export function formatBudget(goal: ActiveGoal) {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export function goalSummary(
	goal: ActiveGoal,
	queuedGoals: readonly ActiveGoal[] = [],
	experimentalGoals = false,
	queueFrozen = false,
) {
	const summary = [
		`Goal: ${goal.text}`,
		`Status: ${queueFrozen ? "queue off" : goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Automatic model responses: ${goal.automaticModelTurns}`,
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
	];
	if (goal.safetyPauseCause) {
		summary.push(
			`Safety pause: ${goal.safetyPauseCause === "continuation_limit" ? "automatic response limit" : "no progress"}`,
		);
	}
	if (experimentalGoals || queuedGoals.length > 0 || queueFrozen) {
		summary.push(
			`Goals (${queuedGoals.length + 1}):`,
			...[goal, ...queuedGoals].map(
				(queuedGoal, index) => `${index + 1}. [${queuedGoal.status}] ${queuedGoal.text}`,
			),
		);
	}
	if (queueFrozen) {
		summary.push(
			"Queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			"Commands: /goal, /goal clear",
		);
	} else {
		summary.push(`Commands: ${goalCommandHint(goal.status, experimentalGoals)}`);
	}
	return summary.join("\n");
}

export function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

export function abortCurrentTurn(ctx: StatusContext) {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

export function blocksStaleGoalToolCalls(status: GoalStatus) {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isResumableGoalStatus(status: GoalStatus) {
	return blocksStaleGoalToolCalls(status) || status === "budget_limited";
}

export function stoppedStatusLabel(status: GoalStatus) {
	if (status === "usage_limited") return "usage-limited";
	if (status === "budget_limited") return "budget-limited";
	return status;
}

export function isContradictoryCompletionSummary(summary: string) {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string) {
	if (!requestedGoalId) return "missing goal_id";
	if (requestedGoalId !== goal.id) return "goal_id does not match the active goal";
	return undefined;
}

function inputFingerprint(prompt: string) {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function goalCommandHint(status: GoalStatus, experimentalGoals = false) {
	const queueCommands = experimentalGoals
		? ", /goal add <objective>, /goal prioritize <objective>, /goal drop-last, /goal skip"
		: "";
	if (status === "active") {
		return `/goal edit <objective>, /goal pause, /goal clear${queueCommands}`;
	}
	if (isResumableGoalStatus(status)) {
		return `/goal edit <objective>, /goal resume, /goal clear${queueCommands}`;
	}
	return `/goal edit <objective>, /goal clear${queueCommands}`;
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

export type { AssistantMessageLike } from "./errors.js";
export {
	findFinalAssistantMessage,
	formatError,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	truncateNotification,
} from "./errors.js";
