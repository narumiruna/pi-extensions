import { randomUUID } from "node:crypto";
import {
	isContextOverflow,
	type AssistantMessage as PiAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	assistantUsageTokens,
	checkpointGoalActiveTime,
	cumulativeAssistantTokens,
	currentTokenTotal,
	formatDuration,
	formatTokenCount,
	isNonNegativeFiniteNumber,
	nonNegativeFiniteNumber,
	normalizeTokenBudget,
	updateGoalUsage,
} from "./accounting.js";
import {
	completeGoalsArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.js";
import {
	type ActiveGoal,
	type GoalStateEntryData,
	loadGoalsFromSession,
	loadPendingUnshiftFromSession,
} from "./persistence.js";
import {
	buildContinuePrompt,
	buildGoalPrompt,
	buildGoalSystemPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	type GoalStatus,
} from "./prompts.js";
type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

const EXPERIMENTAL_WARNING =
	"Warning: pi-goals is an experimental Pi extension. Behavior and persisted state may change.";

// This module intentionally retains the shared lifecycle state machine: every
// Pi hooks, goal tools, and queue commands coordinate the same current goal,
// ordered queue, continuation, retry, stale-turn guard, and budget single-flight
// state. Pure command, prompt, accounting, and persistence logic lives in focused
// modules; splitting the remaining handlers would create ambiguous mutable-state
// ownership across lifecycle races.

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

interface ContinuationTicket {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

interface BudgetWrapUp {
	goalId: string;
	delivered: boolean;
}

interface QueueAdvance {
	completedGoalId: string;
	completedText: string;
}

interface PendingUnshift {
	objective: string;
	tokenBudget: number | undefined;
}

type GoalRecoveryKind = "provider_retry" | "compaction_retry";

interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
}

interface AssistantMessageLike {
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

interface StatusContext {
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

const STATUS_KEY = "goals";
const GOALS_STATE_ENTRY_TYPE = "goals-state";
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;
const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const CONTINUATION_MARKER_PREFIX = "pi-goals-continuation:";
const BUDGET_WRAP_UP_MESSAGE_TYPE = "goals-budget-wrap-up";
const BUDGET_WRAP_UP_PROMPT =
	"The active /goals token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goals_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";
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
let activeGoal: ActiveGoal | undefined;
let queuedGoals: ActiveGoal[] = [];
let completionStatusTimer: NodeJS.Timeout | undefined;
let extensionApi: ExtensionAPI | undefined;
let continuationIntent: ContinuationTicket | undefined;
let continuationDelivery: ContinuationTicket | undefined;
let goalRecovery: GoalRecovery | undefined;
let budgetWrapUp: BudgetWrapUp | undefined;
let queueAdvance: QueueAdvance | undefined;
let pendingUnshift: PendingUnshift | undefined;
let staleGoalToolCallsBlocked = false;
const cancelledContinuationMarkers = new Set<string>();

const goalCompleteTool = defineTool({
	name: "goals_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goals as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
	promptSnippet:
		"Mark the active /goals as complete after fully finishing and verifying it, with the current goal_id",
	promptGuidelines: [
		"When a /goals is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
		"Before calling goals_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
		"Pass the exact goal_id shown in the current /goals prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
		"Call goals_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
	],
	parameters: Type.Object({
		goal_id: Type.String({
			description:
				"The exact goal_id shown in the current active /goals prompt. Used only to reject stale completion calls from older turns.",
		}),
		summary: Type.String({
			description:
				"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
		}),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const completedGoal = activeGoal;
		const goal = completedGoal?.text ?? "unknown goal";
		const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
		const summary = typeof params.summary === "string" ? params.summary.trim() : "";

		if (!completedGoal) {
			const rejection = "Goal completion rejected: no active goal.";
			ctx.ui.notify(rejection, "warning");

			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
			};
		}

		const completingDuringBudgetWrapUp =
			completedGoal.status === "budget_limited" &&
			budgetWrapUp?.goalId === completedGoal.id &&
			budgetWrapUp.delivered;
		const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
		if (staleGoalRejection) {
			const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
			ctx.ui.notify(rejection, "warning");
			if (completingDuringBudgetWrapUp) {
				updateGoalUsage(completedGoal, ctx);
				persistGoal(completedGoal);
				updateStatus(ctx, completedGoal);
				clearBudgetWrapUp();
			}

			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				terminate: completingDuringBudgetWrapUp || undefined,
			};
		}
		if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
			const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
			ctx.ui.notify(rejection, "warning");

			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
			};
		}

		const rejectionReason = !summary
			? "summary is empty"
			: isContradictoryCompletionSummary(summary)
				? "summary says the goal is not complete"
				: undefined;
		if (rejectionReason) {
			updateGoalUsage(completedGoal, ctx);
			persistGoal(completedGoal);
			updateStatus(ctx, completedGoal);
			const rejection = `Goal completion rejected: ${rejectionReason}.`;
			ctx.ui.notify(rejection, "warning");
			if (completingDuringBudgetWrapUp) clearBudgetWrapUp();

			return {
				content: [
					{
						type: "text",
						text: rejection,
					},
				],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				terminate: completingDuringBudgetWrapUp || undefined,
			};
		}

		activeGoal = transitionGoal(completedGoal, "complete");
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);

		if (queuedGoals.length > 0) {
			queueAdvance = { completedGoalId: activeGoal.id, completedText: goal };
			ctx.ui.setStatus(STATUS_KEY, "complete");
			ctx.ui.notify(`Goal complete: ${goal}. Next goal queued: ${queuedGoals[0]?.text}`, "info");
			return {
				content: [
					{
						type: "text",
						text: `Goal complete: ${summary}\nNext goal queued: ${queuedGoals[0]?.text}`,
					},
				],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				terminate: true,
			};
		}

		ctx.ui.setStatus(STATUS_KEY, formatStatus(activeGoal));
		clearActiveGoal(ctx);
		showCompletionStatus(ctx);
		ctx.ui.notify(`Goal complete: ${goal}`, "info");

		return {
			content: [{ type: "text", text: `Goal complete: ${summary}` }],
			details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
			terminate: true,
		};
	},
});

const goalBlockedTool = defineTool({
	name: "goals_blocked",
	label: "Goal Blocked",
	description:
		"Stop the active /goals only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
	promptSnippet:
		"Mark the active /goals blocked only after the same blocker recurs for three consecutive goal turns",
	promptGuidelines: [
		"Use goals_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
		"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goals_blocked again.",
		"Do not use goals_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
		"Pass goals_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
	],
	parameters: Type.Object({
		goal_id: Type.String({
			description: "The exact goal_id shown in the current active /goals prompt.",
		}),
		reason: Type.String({
			minLength: 1,
			maxLength: MAX_BLOCKER_REASON_LENGTH,
			description: "The specific user or external action required to unblock the goal.",
		}),
		evidence: Type.String({
			minLength: 1,
			maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
			description: "Concrete evidence from the repeated attempts that proves the impasse.",
		}),
		repeated_turns: Type.Integer({
			minimum: 3,
			description: "Number of separate turns spent trying to resolve this same blocker.",
		}),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const blockedGoal = activeGoal;
		const goal = blockedGoal?.text ?? "unknown goal";
		const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
		const reason = typeof params.reason === "string" ? params.reason.trim() : "";
		const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
		const repeatedTurns =
			typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
		const reject = (rejectionReason: string) => {
			const rejection = `goals_blocked rejected: ${rejectionReason}.`;
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text" as const, text: rejection }],
				details: {
					goal,
					goal_id: requestedGoalId,
					reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
					evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
					repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
				} satisfies GoalBlockedDetails,
			};
		};

		if (!blockedGoal) return reject("no active goal");
		const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
		if (staleGoalRejection) return reject(staleGoalRejection);
		if (blockedGoal.status !== "active") {
			return reject(`goal is ${blockedGoal.status}, not active`);
		}
		if (!reason) return reject("reason is empty");
		if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
		if (!evidence) return reject("evidence is empty");
		if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
		if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
		if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

		updateGoalUsage(blockedGoal, ctx);
		cancelContinuationWork();
		clearBudgetWrapUp();
		clearGoalRecoveryForGoal(blockedGoal.id);
		blockStaleGoalToolCalls();
		activeGoal = transitionGoal(blockedGoal, "blocked");
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
		ctx.ui.notify(`Goal blocked: ${truncateNotification(reason)}`, "warning");

		return {
			content: [{ type: "text", text: `Goal blocked: ${reason}` }],
			details: {
				goal,
				goal_id: requestedGoalId,
				reason,
				evidence,
				repeated_turns: repeatedTurns,
			} satisfies GoalBlockedDetails,
			terminate: true,
		};
	},
});

export default function goals(pi: ExtensionAPI) {
	extensionApi = pi;
	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);

	pi.registerCommand("goals", {
		description:
			"Experimental: run an ordered array of goals to completion: /goals [--tokens 100k] <goal>",
		getArgumentCompletions: completeGoalsArguments,
		handler: async (args, ctx) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}
			if (queueAdvance && result.kind !== "show" && result.kind !== "clear") {
				ctx.ui.notify(
					"The completed goal is advancing. Retry the command after it settles.",
					"warning",
				);
				return;
			}
			if (pendingUnshift && result.kind !== "show" && result.kind !== "clear") {
				ctx.ui.notify(
					"An urgent goal is waiting for the current run to settle. Retry the command afterward.",
					"warning",
				);
				return;
			}

			switch (result.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx);
					return;
				case "resume":
					await resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "push":
					await pushGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "unshift":
					await unshiftGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "pop":
					popGoal(ctx);
					return;
				case "shift":
					await shiftGoal(ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(EXPERIMENTAL_WARNING, "warning");
		clearCompletionStatusTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearQueueAdvance();
		clearPendingUnshift();
		clearStaleGoalToolCallBlock();
		let startRestoredQueuedGoal = false;
		const restoredGoals = loadGoalsFromSession(ctx);
		pendingUnshift = loadPendingUnshiftFromSession(ctx);
		activeGoal = restoredGoals.shift();
		queuedGoals = restoredGoals;
		if (activeGoal?.status === "queued" && !pendingUnshift) {
			activeGoal = activateQueuedGoal(activeGoal, ctx);
			startRestoredQueuedGoal = true;
		}
		if (pendingUnshift) {
			const pending = pendingUnshift;
			clearPendingUnshift();
			await activateUnshiftGoal(pending.objective, pending.tokenBudget, pi, ctx);
			return;
		}
		if (activeGoal) {
			if (activeGoal.status === "active") {
				updateGoalUsage(activeGoal, ctx);
				if (limitActiveGoalForBudget(pi, ctx, false)) return;
			}
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			if (startRestoredQueuedGoal) {
				const restoredGoal = activeGoal;
				const sent = await sendGoalPrompt(pi, ctx, restoredGoal);
				if (!sent && activeGoal?.id === restoredGoal.id) {
					activeGoal = transitionGoal(activeGoal, "paused");
					persistGoal(activeGoal);
					updateStatus(ctx, activeGoal);
					blockStaleGoalToolCalls();
				}
			}
		} else ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeGoal) updateGoalUsage(activeGoal, ctx, false);
		queuePendingUnshiftForReload();
		if (activeGoal) persistGoal(activeGoal);
		clearContinuationTracking();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearQueueAdvance();
		clearPendingUnshift();
		clearStaleGoalToolCallBlock();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (activeGoal?.status === "budget_limited") {
			if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
			return;
		}
		if (!activeGoal || activeGoal.status !== "active") return;
		updateGoalUsage(activeGoal, ctx);
		cancelContinuationWork();
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
		if (limitActiveGoalForBudget(pi, ctx, false)) return { cancel: true as const };
	});

	pi.on("session_compact", (event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredGoals = loadGoalsFromSession(ctx);
		if (restoredGoals[0]?.id === activeGoal.id) {
			activeGoal = restoredGoals[0];
			queuedGoals = restoredGoals.slice(1);
		}
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
		if (limitActiveGoalForBudget(pi, ctx, false)) return;

		const wasPiRetry = isPiOwnedCompactionRetry(event, activeGoal.id);
		clearGoalRecoveryForGoal(activeGoal.id);
		if (wasPiRetry) return;
		requestContinuation(activeGoal);
		// Manual compaction does not emit agent_settled. This common dispatcher is
		// therefore the narrow fallback; threshold compaction leaves the intent for
		// agent_settled when Pi is still busy.
		dispatchContinuationIfSettled(pi, ctx);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") {
			if (consumeCancelledContinuationPrompt(event.text)) return { action: "handled" as const };
			return;
		}
		if (/^\/goals(?:\s|$)/u.test(event.text.trimStart())) return;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => keepBudgetWrapUpMessage(message));
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.on("tool_call", (event, ctx) => {
		if (
			activeGoal?.status === "budget_limited" &&
			budgetWrapUp?.goalId === activeGoal.id &&
			event.toolName !== "goals_complete"
		) {
			// A blocked tool result would normally trigger another model call. Abort the
			// wrap-up instead so a tool-seeking model cannot create an unbounded loop.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goals_complete is allowed during wrap-up.",
			};
		}
		if (!staleGoalToolCallsBlocked) return;
		if (!activeGoal || !blocksStaleGoalToolCalls(activeGoal.status)) {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goals tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (
			activeGoal?.status === "budget_limited" &&
			budgetWrapUp?.goalId === activeGoal.id &&
			!budgetWrapUp.delivered
		) {
			queueBudgetWrapUp(pi, ctx, activeGoal);
			return;
		}
		if (!activeGoal || activeGoal.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
		limitActiveGoalForBudget(pi, ctx, true);
	});

	pi.on("before_agent_start", (event) => {
		markContinuationStarted(event.prompt);
		if (!activeGoal || activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal)}`,
		};
	});

	pi.on("agent_end", (event, ctx) => {
		if (!activeGoal) return;
		if (activeGoal.status === "budget_limited" && budgetWrapUp?.goalId === activeGoal.id) {
			updateGoalUsage(activeGoal, ctx);
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			clearBudgetWrapUp();
			return;
		}
		if (activeGoal.status !== "active") return;

		const goalId = activeGoal.id;
		const alreadyAwaitingContinuation = hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(event.messages);

		if (!alreadyAwaitingContinuation) activeGoal = incrementGoal(activeGoal);
		updateGoalUsage(activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted") {
			clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(ctx, activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (limitActiveGoalForBudget(pi, ctx, false)) return;
				goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationWork();
				persistGoal(activeGoal);
				updateStatus(ctx, activeGoal);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(
				ctx,
				activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (limitActiveGoalForBudget(pi, ctx, false)) return;

		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		const currentGoal = activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (pendingUnshift) return;
		requestContinuation(currentGoal);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (await dispatchPendingUnshiftIfSettled(ctx)) return;
		if (await dispatchQueueAdvanceIfSettled(ctx)) return;
		dispatchContinuationIfSettled(pi, ctx);
	});
}

async function startGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}

	const existingGoal = activeGoal?.status !== "complete" ? activeGoal : undefined;
	const existingQueuedGoals = [...queuedGoals];
	if (existingGoal) {
		const shouldReplace = await ctx.ui.confirm(
			"Replace goal?",
			`Current goal: ${existingGoal.text}\n\nNew goal: ${objective}`,
		);
		if (!shouldReplace) {
			ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
			return;
		}
	}

	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearStaleGoalToolCallBlock();
	queuedGoals = [];
	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	const startedGoal = activeGoal;
	const sent = await sendGoalPrompt(pi, ctx, startedGoal);
	if (!sent) {
		if (activeGoal?.id === startedGoal.id) {
			if (existingGoal) {
				queuedGoals = existingQueuedGoals;
				updateGoalUsage(existingGoal, ctx);
				if (existingGoal.status === "active") {
					abortCurrentTurn(ctx);
					activeGoal = transitionGoal(existingGoal, "paused");
					blockStaleGoalToolCalls();
				} else {
					activeGoal = existingGoal;
					if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
					else clearStaleGoalToolCallBlock();
				}
				persistGoal(activeGoal);
				updateStatus(ctx, activeGoal);
			} else {
				clearActiveGoal(ctx);
			}
		}
		return;
	}
	ctx.ui.notify(
		existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`,
		"info",
	);
}

async function pushGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError.replace("/goals", "/goals push"), "warning");
		return;
	}
	if (!activeGoal) {
		await startGoal(objective, tokenBudget, pi, ctx);
		return;
	}
	queuedGoals.push(createQueuedGoal(objective, tokenBudget));
	persistGoal(activeGoal);
	ctx.ui.notify(`Goal pushed to position ${queuedGoals.length + 1}: ${objective}`, "info");
}

async function unshiftGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError.replace("/goals", "/goals unshift"), "warning");
		return;
	}
	if (!activeGoal) {
		await startGoal(objective, tokenBudget, pi, ctx);
		return;
	}
	if (ctx.isIdle?.() !== true) {
		cancelContinuationWork();
		pendingUnshift = { objective, tokenBudget };
		persistGoal(activeGoal);
		ctx.ui.notify(`Urgent goal queued until the current run settles: ${objective}`, "info");
		return;
	}

	await activateUnshiftGoal(objective, tokenBudget, pi, ctx);
}

async function activateUnshiftGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	if (!activeGoal) {
		await startGoal(objective, tokenBudget, pi, ctx);
		return;
	}
	if (activeGoal.status === "active") updateGoalUsage(activeGoal, ctx);
	const previousGoal = { ...activeGoal };
	const previousQueuedGoals = [...queuedGoals];
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearStaleGoalToolCallBlock();
	const displacedGoal =
		activeGoal.status === "active" ? transitionGoal(activeGoal, "queued") : activeGoal;
	queuedGoals = [displacedGoal, ...queuedGoals];
	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	const prioritizedGoal = activeGoal;
	const sent = await sendGoalPrompt(pi, ctx, prioritizedGoal);
	if (!sent && activeGoal?.id === prioritizedGoal.id) {
		queuedGoals = previousQueuedGoals;
		if (previousGoal.status === "active") {
			abortCurrentTurn(ctx);
			activeGoal = transitionGoal(previousGoal, "paused");
			blockStaleGoalToolCalls();
		} else {
			activeGoal = previousGoal;
			if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
		}
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
		return;
	}
	ctx.ui.notify(`Goal unshifted to the front: ${objective}`, "info");
}

function popGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No goals to pop.", "info");
		return;
	}
	if (queuedGoals.length > 0) {
		const removed = queuedGoals.pop();
		persistGoal(activeGoal);
		ctx.ui.notify(`Goal popped: ${removed?.text ?? "unknown goal"}`, "warning");
		return;
	}
	const removed = activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal popped: ${removed}`, "warning");
}

async function shiftGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No goals to shift.", "info");
		return;
	}
	if (activeGoal.status === "active") updateGoalUsage(activeGoal, ctx);
	const removed = activeGoal.text;
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearStaleGoalToolCallBlock();
	activeGoal = queuedGoals.shift();
	if (!activeGoal) {
		clearActiveGoal(ctx);
		ctx.ui.notify(`Goal shifted: ${removed}. No goals remain.`, "warning");
		return;
	}

	activeGoal =
		activeGoal.status === "queued"
			? activateQueuedGoal(activeGoal, ctx)
			: restoreShelvedGoal(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status === "active") {
		const nextGoal = activeGoal;
		const sent = extensionApi ? await sendGoalPrompt(extensionApi, ctx, nextGoal) : false;
		if (!sent && activeGoal?.id === nextGoal.id) {
			activeGoal = transitionGoal(activeGoal, "paused");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			blockStaleGoalToolCalls();
			return;
		}
		ctx.ui.notify(`Goal shifted: ${removed}. Started: ${nextGoal.text}`, "warning");
		return;
	}
	if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
	ctx.ui.notify(
		`Goal shifted: ${removed}. Next goal remains ${activeGoal.status}: ${activeGoal.text}`,
		"warning",
	);
}

async function dispatchPendingUnshiftIfSettled(ctx: StatusContext) {
	const pending = pendingUnshift;
	if (!pending) return false;
	if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
	clearPendingUnshift();
	cancelContinuationWork();
	if (activeGoal?.status === "complete") {
		clearQueueAdvance();
		activeGoal = queuedGoals.shift();
	}
	if (!extensionApi) return false;
	await activateUnshiftGoal(pending.objective, pending.tokenBudget, extensionApi, ctx);
	return true;
}

async function dispatchQueueAdvanceIfSettled(ctx: StatusContext) {
	const pending = queueAdvance;
	if (!pending) return false;
	if (
		!activeGoal ||
		activeGoal.id !== pending.completedGoalId ||
		activeGoal.status !== "complete"
	) {
		clearQueueAdvance();
		return false;
	}
	if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
	clearQueueAdvance();
	await advanceToNextGoalAfterCompletion(ctx, pending.completedText);
	return true;
}

async function advanceToNextGoalAfterCompletion(ctx: StatusContext, completedText: string) {
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearStaleGoalToolCallBlock();
	activeGoal = queuedGoals.shift();
	if (!activeGoal) return undefined;
	activeGoal =
		activeGoal.status === "queued"
			? activateQueuedGoal(activeGoal, ctx)
			: restoreShelvedGoal(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status === "active") {
		const nextGoal = activeGoal;
		const sent = extensionApi ? await sendGoalPrompt(extensionApi, ctx, nextGoal) : false;
		if (!sent && activeGoal?.id === nextGoal.id) {
			activeGoal = transitionGoal(activeGoal, "paused");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			blockStaleGoalToolCalls();
			ctx.ui.notify(
				`Goal complete: ${completedText}. Next goal paused after prompt delivery failed: ${activeGoal.text}`,
				"warning",
			);
			return activeGoal;
		}
		ctx.ui.notify(`Goal complete: ${completedText}. Started next goal: ${nextGoal.text}`, "info");
		return nextGoal;
	}
	if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
	ctx.ui.notify(
		`Goal complete: ${completedText}. Next goal remains ${activeGoal.status}: ${activeGoal.text}`,
		"info",
	);
	return activeGoal;
}

function pauseGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only active goals can be paused.`, "warning");
		return;
	}
	updateGoalUsage(activeGoal, ctx);
	cancelContinuationWork();
	clearBudgetWrapUp();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	activeGoal = transitionGoal(activeGoal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal paused: ${activeGoal.text}`, "info");
}

async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (!isResumableGoalStatus(activeGoal.status)) {
		ctx.ui.notify(
			`Goal is ${activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
			"warning",
		);
		return;
	}
	if (activeGoal.tokenBudget !== undefined && activeGoal.tokensUsed >= activeGoal.tokenBudget) {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(activeGoal)}`, "warning");
		return;
	}
	const stoppedGoal = activeGoal;
	const stoppedStatus = stoppedGoal.status;
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearStaleGoalToolCallBlock();
	activeGoal = transitionGoal(nextGoalInstance(activeGoal), "active");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(activeGoal)}`, "warning");
		return;
	}
	const resumedGoal = activeGoal;
	const sent = await sendResumePrompt(pi, ctx, resumedGoal, stoppedStatus);
	if (!sent) {
		if (activeGoal?.id === resumedGoal.id && activeGoal.status === "active") {
			activeGoal = stoppedGoal;
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
		}
		return;
	}
	ctx.ui.notify(
		`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`,
		"info",
	);
}

function clearGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		clearPersistedGoal();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const stoppedGoal = activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
}

async function editGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}
	if (!activeGoal) {
		ctx.ui.notify("No active goal. Use /goals <objective> to start one.", "warning");
		return;
	}

	updateGoalUsage(activeGoal, ctx);
	const previousGoal = { ...activeGoal };
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	const previousStatus = activeGoal.status;
	activeGoal = transitionGoal(
		{
			...nextGoalInstance(activeGoal),
			text: objective,
			tokenBudget: tokenBudget ?? activeGoal.tokenBudget,
		},
		editedGoalStatus(previousStatus),
	);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status === "active") {
		clearStaleGoalToolCallBlock();
		const editedGoal = activeGoal;
		const sent = await sendObjectiveUpdatedPrompt(pi, ctx, editedGoal);
		if (!sent) {
			if (activeGoal?.id === editedGoal.id) {
				if (previousStatus === "active") {
					abortCurrentTurn(ctx);
					activeGoal = transitionGoal(previousGoal, "paused");
					blockStaleGoalToolCalls();
				} else {
					activeGoal = previousGoal;
					if (blocksStaleGoalToolCalls(activeGoal.status)) blockStaleGoalToolCalls();
					else clearStaleGoalToolCallBlock();
				}
				persistGoal(activeGoal);
				updateStatus(ctx, activeGoal);
			}
			return;
		}
	} else if (blocksStaleGoalToolCalls(activeGoal.status)) {
		blockStaleGoalToolCalls();
	} else {
		clearStaleGoalToolCallBlock();
	}
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
}

function showGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("Usage: /goals <objective>\nNo goal is currently set.", "info");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	updateGoalUsage(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(goalSummary(activeGoal), "info");
}

function createGoal(
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

function createQueuedGoal(text: string, tokenBudget: number | undefined): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "queued",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};
}

function activateQueuedGoal(goal: ActiveGoal, ctx: StatusContext) {
	return transitionGoal(restoreShelvedGoal(nextGoalInstance(goal), ctx), "active");
}

function restoreShelvedGoal(goal: ActiveGoal, ctx: StatusContext): ActiveGoal {
	return {
		...goal,
		baselineTokens: Math.max(0, currentTokenTotal(ctx) - goal.tokensUsed),
		activeStartedAt: undefined,
		updatedAt: Date.now(),
	};
}

function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus): ActiveGoal {
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

function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
	return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

function editedGoalStatus(status: GoalStatus): GoalStatus {
	if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
	return "active";
}

function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

function stopGoalAfterAgentEnd(
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike,
	status: "paused" | "blocked" | "usage_limited",
) {
	cancelContinuationWork();
	clearBudgetWrapUp();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	activeGoal = transitionGoal(goal, status);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);

	const details = assistant.errorMessage
		? ` (${truncateNotification(assistant.errorMessage)})`
		: "";
	if (status === "paused") {
		ctx.ui.notify(
			`Goal paused after interruption${details}. Run /goals resume to continue.`,
			"warning",
		);
		return;
	}
	if (status === "usage_limited") {
		ctx.ui.notify(
			`Goal stopped after provider usage limit${details}. Run /goals resume when usage is available.`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		`Goal blocked after agent error${details}. Resolve the blocker or run /goals resume to retry.`,
		"warning",
	);
}

async function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildGoalPrompt(goal));
}

async function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildObjectiveUpdatedPrompt(goal));
}

async function sendResumePrompt(
	pi: ExtensionAPI,
	ctx: StatusContext,
	goal: ActiveGoal,
	stoppedStatus: GoalStatus,
) {
	return sendPrompt(pi, ctx, buildResumePrompt(goal, stoppedStatus));
}

function requestContinuation(goal: ActiveGoal) {
	if (hasContinuationWorkForGoal(goal.id)) return false;
	const marker = continuationMarker(goal);
	continuationIntent = {
		goalId: goal.id,
		iteration: goal.iteration,
		marker,
		prompt: buildContinuePrompt(goal, marker),
	};
	return true;
}

function dispatchContinuationIfSettled(pi: ExtensionAPI, ctx: StatusContext) {
	const intent = continuationIntent;
	if (!intent) return false;
	if (!activeGoal || activeGoal.id !== intent.goalId || activeGoal.status !== "active") {
		continuationIntent = undefined;
		return false;
	}
	if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

	continuationIntent = undefined;
	continuationDelivery = intent;
	try {
		pi.sendUserMessage(intent.prompt);
		return true;
	} catch (error) {
		if (continuationDelivery?.marker === intent.marker) continuationDelivery = undefined;
		if (activeGoal?.id === intent.goalId && activeGoal.status === "active") {
			continuationIntent = intent;
		}
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function hasContinuationWorkForGoal(goalId: string) {
	return continuationIntent?.goalId === goalId || continuationDelivery?.goalId === goalId;
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		const sent = ctx.isIdle?.()
			? (pi.sendUserMessage(prompt) as void | Promise<void>)
			: (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function updateStatus(ctx: StatusContext, goal: ActiveGoal) {
	clearCompletionStatusTimer();
	ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
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

function formatBudget(goal: ActiveGoal) {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

function goalSummary(goal: ActiveGoal) {
	const summary = [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
	];
	summary.push(
		`Goals (${queuedGoals.length + 1}):`,
		...[goal, ...queuedGoals].map(
			(queuedGoal, index) => `${index + 1}. [${queuedGoal.status}] ${queuedGoal.text}`,
		),
	);
	summary.push(`Commands: ${goalCommandHint(goal.status)}`);
	return summary.join("\n");
}

function goalCommandHint(status: GoalStatus) {
	const queueCommands =
		", /goals push <objective>, /goals unshift <objective>, /goals pop, /goals shift";
	if (status === "active") {
		return `/goals edit <objective>, /goals pause, /goals clear${queueCommands}`;
	}
	if (isResumableGoalStatus(status)) {
		return `/goals edit <objective>, /goals resume, /goals clear${queueCommands}`;
	}
	return `/goals edit <objective>, /goals clear${queueCommands}`;
}

function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

function abortCurrentTurn(ctx: StatusContext) {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

function blockStaleGoalToolCalls() {
	staleGoalToolCallsBlocked = true;
}

function blocksStaleGoalToolCalls(status: GoalStatus) {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}

function isResumableGoalStatus(status: GoalStatus) {
	return blocksStaleGoalToolCalls(status) || status === "budget_limited";
}

function stoppedStatusLabel(status: GoalStatus) {
	if (status === "usage_limited") return "usage-limited";
	if (status === "budget_limited") return "budget-limited";
	return status;
}

function clearStaleGoalToolCallBlock() {
	staleGoalToolCallsBlocked = false;
}

function clearGoalRecovery() {
	goalRecovery = undefined;
}

function clearBudgetWrapUp() {
	budgetWrapUp = undefined;
}

function clearQueueAdvance() {
	queueAdvance = undefined;
}

function clearPendingUnshift() {
	pendingUnshift = undefined;
}

function queuePendingUnshiftForReload() {
	const pending = pendingUnshift;
	if (!pending) return;
	clearPendingUnshift();
	if (activeGoal?.status === "complete") {
		clearQueueAdvance();
		activeGoal = queuedGoals.shift();
	}
	if (activeGoal) {
		const displacedGoal =
			activeGoal.status === "active" ? transitionGoal(activeGoal, "queued") : activeGoal;
		queuedGoals = [displacedGoal, ...queuedGoals];
	}
	activeGoal = createQueuedGoal(pending.objective, pending.tokenBudget);
}

function keepBudgetWrapUpMessage(message: unknown) {
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
		candidate.details.goalId === budgetWrapUp?.goalId &&
		candidate.details.goalId === activeGoal?.id
	);
}

function queueBudgetWrapUp(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	if (!budgetWrapUp || budgetWrapUp.goalId !== goal.id) {
		budgetWrapUp = { goalId: goal.id, delivered: false };
	}
	if (budgetWrapUp.delivered) return true;
	budgetWrapUp.delivered = true;
	try {
		pi.sendMessage(
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
		budgetWrapUp.delivered = false;
		ctx.ui.notify(`Goal budget wrap-up failed: ${formatError(error)}`, "error");
		return false;
	}
}

function limitActiveGoalForBudget(pi: ExtensionAPI, ctx: StatusContext, sendWrapUp: boolean) {
	const goal = activeGoal;
	if (
		!goal ||
		goal.status !== "active" ||
		goal.tokenBudget === undefined ||
		goal.tokensUsed < goal.tokenBudget
	) {
		return false;
	}

	cancelContinuationWork();
	clearGoalRecoveryForGoal(goal.id);
	clearBudgetWrapUp();
	activeGoal = transitionGoal(goal, "budget_limited");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal token budget reached: ${formatBudget(activeGoal)}`, "warning");
	if (sendWrapUp) queueBudgetWrapUp(pi, ctx, activeGoal);
	return true;
}

function clearGoalRecoveryForGoal(goalId: string) {
	if (goalRecovery?.goalId === goalId) goalRecovery = undefined;
}

function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
	const compaction = event as { reason?: unknown; willRetry?: unknown };
	if (compaction.willRetry === true) return true;
	return (
		goalRecovery?.goalId === goalId &&
		goalRecovery.kind === "compaction_retry" &&
		(compaction.reason === undefined || compaction.reason === "overflow")
	);
}

export function isContradictoryCompletionSummary(summary: string) {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string) {
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

function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(toPiAssistantMessage(assistant));
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

function clearContinuationTracking() {
	continuationIntent = undefined;
	continuationDelivery = undefined;
	cancelledContinuationMarkers.clear();
}

function cancelContinuationWork() {
	if (continuationDelivery) rememberCancelledContinuationMarker(continuationDelivery.marker);
	continuationIntent = undefined;
	continuationDelivery = undefined;
}

function rememberCancelledContinuationMarker(marker: string) {
	cancelledContinuationMarkers.add(marker);
	if (cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
	const oldest = cancelledContinuationMarkers.values().next().value;
	if (oldest) cancelledContinuationMarkers.delete(oldest);
}

function consumeCancelledContinuationPrompt(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	return marker ? cancelledContinuationMarkers.delete(marker) : false;
}

function markContinuationStarted(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	if (!marker) {
		// A user, retry, or another extension started newer work. Cancel both an
		// unsent intent and a delivery that may have lost the non-atomic idle race;
		// the newer work's agent_end will record a fresh intent.
		cancelContinuationWork();
		return;
	}
	if (continuationDelivery?.marker === marker) continuationDelivery = undefined;
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

function continuationMarkerComment(marker: string) {
	return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
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
		if (Array.isArray(candidate.content))
			assistant.content = candidate.content as PiAssistantMessage["content"];
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

function escapeXmlText(value: string) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function persistGoal(goal: ActiveGoal) {
	const data: GoalStateEntryData = {
		goals: [goal, ...queuedGoals],
		...(pendingUnshift ? { pendingUnshift } : {}),
	};
	extensionApi?.appendEntry<GoalStateEntryData>(GOALS_STATE_ENTRY_TYPE, data);
}

function clearPersistedGoal() {
	const data: GoalStateEntryData = { goals: [] };
	extensionApi?.appendEntry<GoalStateEntryData>(GOALS_STATE_ENTRY_TYPE, data);
}

function clearActiveGoal(ctx: StatusContext) {
	cancelContinuationWork();
	clearGoalRecovery();
	clearBudgetWrapUp();
	clearQueueAdvance();
	clearPendingUnshift();
	clearStaleGoalToolCallBlock();
	activeGoal = undefined;
	queuedGoals = [];
	clearPersistedGoal();
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function showCompletionStatus(ctx: StatusContext) {
	clearCompletionStatusTimer();
	ctx.ui.setStatus(STATUS_KEY, "complete");
	completionStatusTimer = setTimeout(() => {
		completionStatusTimer = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// The completion status is best-effort; the captured ctx may be stale after
			// session replacement or reload before this timer fires.
		}
	}, 8_000);
}

function clearCompletionStatusTimer() {
	if (!completionStatusTimer) return;
	clearTimeout(completionStatusTimer);
	completionStatusTimer = undefined;
}

export {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	formatDuration,
	formatTokenCount,
} from "./accounting.js";
export {
	completeGoalsArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.js";
export { buildGoalSystemPrompt } from "./prompts.js";
