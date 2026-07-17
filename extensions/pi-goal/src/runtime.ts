import { randomUUID } from "node:crypto";
import {
	isContextOverflow,
	type AssistantMessage as PiAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	assistantUsageTokens,
	checkpointGoalActiveTime,
	formatDuration,
	formatTokenCount,
	nonNegativeFiniteNumber,
	updateGoalUsage,
} from "./accounting.js";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	type PendingQueueAction,
	serializeGoalState,
} from "./persistence.js";
import { buildContinuePrompt, type GoalStatus } from "./prompts.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "./settings.js";

export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

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

export interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
}

export interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason;
	errorMessage?: string;
	content?: PiAssistantMessage["content"];
	api?: PiAssistantMessage["api"];
	provider?: PiAssistantMessage["provider"];
	model?: string;
	usage?: Usage;
	timestamp?: number;
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

const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const MAX_PENDING_GOAL_PROMPTS = 20;
const GOAL_PROMPT_MARKER_PREFIX = "pi-goal-prompt:";
const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";
const BUDGET_WRAP_UP_MESSAGE_TYPE = "goal-budget-wrap-up";
const BUDGET_WRAP_UP_PROMPT =
	"The active /goal token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goal_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";
const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
const USAGE_LIMIT_GOAL_ERROR_PATTERNS = [
	/usage[_\s-]*(?:limit|cap)|chatgpt.{0,32}usage/i,
	/quota.{0,32}(?:reached|exceeded|exhausted|depleted)|(?:reached|exceeded|exhausted|depleted).{0,32}quota/i,
	/insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|payment required/i,
	/(?:credit|balance).{0,32}(?:low|exhausted|depleted)|billing/i,
] as const;
const NON_RETRYABLE_GOAL_ERROR_RE =
	/multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key/i;
// Pi 0.79 does not export its assistant-error retry classifier. Keep this
// compatibility mirror aligned with Pi's public retry utility in newer versions.
const RETRYABLE_GOAL_ERROR_PATTERNS = [
	/overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error/i,
	/provider.?returned.?error|you can retry your request|try your request again|please retry your request/i,
	/network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up/i,
	/timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|http2 request did not get a response|retry delay/i,
	/context[_\s-]*length[_\s-]*exceeded|input exceeds the context window/i,
] as const;

// One instance belongs to one extension factory. It owns all mutable session state
// and the cross-cutting invariants used by command and lifecycle orchestration.
export class GoalRuntime {
	settings: GoalSettings = DEFAULT_GOAL_SETTINGS;
	activeGoal?: ActiveGoal;
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
	staleGoalToolCallsBlocked = false;
	/** Once true, goal tools stay in the active set for this runtime (prompt-cache stable). */
	goalToolsUnlocked = false;
	/** Exact lazy goal tools this runtime removed and may restore on a mode change. */
	goalToolsHiddenByPolicy = new Set<string>();
	pendingGoalPromptMarkers = new Map<string, string>();
	cancelledContinuationMarkers = new Set<string>();

	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	canRecordGoalUsage() {
		return (
			this.agentRunGoalId !== null &&
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

	recordGoalUsage(
		goal: ActiveGoal,
		ctx: StatusContext,
		checkpointActiveTime = goal.status === "active",
	) {
		if (!this.canRecordGoalUsage()) return false;
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

	keepBudgetWrapUpMessage(message: unknown) {
		if (!message || typeof message !== "object") return true;
		const candidate = message as {
			role?: unknown;
			customType?: unknown;
			details?: { goalId?: unknown };
		};
		if (candidate.role !== "custom" || candidate.customType !== BUDGET_WRAP_UP_MESSAGE_TYPE) {
			return true;
		}
		return (
			typeof candidate.details?.goalId === "string" &&
			candidate.details.goalId === this.budgetWrapUp?.goalId &&
			candidate.details.goalId === this.activeGoal?.id
		);
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
		this.persistGoal(this.activeGoal);
		this.updateStatus(ctx, this.activeGoal);
		ctx.ui.notify(`Goal token budget reached: ${formatBudget(this.activeGoal)}`, "warning");
		if (sendWrapUp) this.queueBudgetWrapUp(ctx, this.activeGoal);
		return true;
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
	}

	async sendOwnedGoalPrompt(ctx: StatusContext, goalId: string, prompt: string) {
		const pending = this.rememberPendingGoalPrompt(goalId, prompt);
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
		this.pi.appendEntry(
			GOAL_STATE_ENTRY_TYPE,
			serializeGoalState(goal, this.queuedGoals, this.pendingQueueAction),
		);
	}

	clearPersistedGoal(cwd: string) {
		this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(undefined, [], undefined));
		clearLegacyPersistedGoal(cwd);
	}

	clearActiveGoal(ctx: StatusContext) {
		this.cancelContinuationWork();
		this.clearGoalRecovery();
		this.clearBudgetWrapUp();
		this.clearStaleGoalToolCallBlock();
		this.activeGoal = undefined;
		this.queuedGoals = [];
		this.pendingQueueAction = undefined;
		this.queueFrozen = false;
		this.clearPersistedGoal(ctx.cwd);
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

	private rememberPendingGoalPrompt(goalId: string, prompt: string) {
		const marker = randomUUID();
		this.pendingGoalPromptMarkers.set(marker, goalId);
		if (this.pendingGoalPromptMarkers.size > MAX_PENDING_GOAL_PROMPTS) {
			const oldest = this.pendingGoalPromptMarkers.keys().next().value;
			if (oldest) this.pendingGoalPromptMarkers.delete(oldest);
		}
		return { marker, prompt: `${prompt}\n\n<!-- ${GOAL_PROMPT_MARKER_PREFIX}${marker} -->` };
	}

	private consumePendingGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return undefined;
		const goalId = this.pendingGoalPromptMarkers.get(marker);
		this.pendingGoalPromptMarkers.delete(marker);
		return goalId;
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
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
	];
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

export function isUsageLimitedGoalInterruption(assistant: AssistantMessageLike) {
	const errorMessage = assistant.errorMessage;
	return (
		assistant.stopReason === "error" &&
		typeof errorMessage === "string" &&
		USAGE_LIMIT_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
	);
}

export function isRetryableGoalInterruption(assistant: AssistantMessageLike) {
	if (assistant.stopReason !== "error") return false;
	if (!assistant.errorMessage) return false;
	if (
		isUsageLimitedGoalInterruption(assistant) ||
		NON_RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage)
	) {
		return false;
	}
	return (
		isGoalContextOverflow(assistant) ||
		RETRYABLE_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(assistant.errorMessage ?? ""))
	);
}

export function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(toPiAssistantMessage(assistant));
}

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "assistant") continue;
		const assistant: AssistantMessageLike = {
			role: "assistant",
			stopReason: isAgentStopReason(candidate.stopReason) ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
		if (Array.isArray(candidate.content)) {
			assistant.content = candidate.content as PiAssistantMessage["content"];
		}
		if (typeof candidate.api === "string") assistant.api = candidate.api;
		if (typeof candidate.provider === "string") assistant.provider = candidate.provider;
		if (typeof candidate.model === "string") assistant.model = candidate.model;
		if (typeof candidate.timestamp === "number") assistant.timestamp = candidate.timestamp;
		const usage = normalizeUsage(candidate.usage);
		if (usage) assistant.usage = usage;
		return assistant;
	}
	return undefined;
}

export function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

export function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
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

function toPiAssistantMessage(assistant: AssistantMessageLike): PiAssistantMessage {
	return {
		role: "assistant",
		content: assistant.content ?? [],
		api: assistant.api ?? "openai-responses",
		provider: assistant.provider ?? "unknown",
		model: assistant.model ?? "unknown",
		usage: assistant.usage ?? zeroUsage(),
		stopReason: assistant.stopReason ?? "error",
		errorMessage: assistant.errorMessage,
		timestamp: assistant.timestamp ?? Date.now(),
	};
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GOAL_PROMPT_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(GOAL_PROMPT_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);
const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

function extractGoalPromptMarker(prompt: string) {
	return GOAL_PROMPT_MARKER_PATTERN.exec(prompt)?.[1];
}

function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
	return ["stop", "length", "toolUse", "error", "aborted"].includes(String(value));
}

function normalizeUsage(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	if (typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
	return {
		input: nonNegativeFiniteNumber(usage.input),
		output: nonNegativeFiniteNumber(usage.output),
		cacheRead: nonNegativeFiniteNumber(usage.cacheRead),
		cacheWrite: nonNegativeFiniteNumber(usage.cacheWrite),
		totalTokens: assistantUsageTokens(usage),
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}
