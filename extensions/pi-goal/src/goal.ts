import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isContextOverflow,
	isRetryableAssistantError,
	type AssistantMessage as PiAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usage_limited"
	| "budget_limited"
	| "complete";
type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface ActiveGoal {
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
}

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

interface GoalStateEntryData {
	goal?: ActiveGoal | null;
}

interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit";
	objective?: string;
	tokenBudget?: number;
}

interface GoalArgumentCompletion {
	value: string;
	label: string;
	description?: string;
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

const STATUS_KEY = "goal";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;
const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";
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
const RETRYABLE_GOAL_ERROR_RE =
	/websocket closed|sse response headers timed out|headers timed out|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|provider returned error/i;
const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "pause", label: "pause", description: "Pause the active goal" },
	{ value: "resume", label: "resume", description: "Resume a stopped or budget-limited goal" },
	{ value: "clear", label: "clear", description: "Clear the current goal" },
	{ value: "edit", label: "edit", description: "Edit the current goal objective" },
	{ value: "status", label: "status", description: "Show the current goal" },
	{ value: "--tokens ", label: "--tokens", description: "Set a token budget before the goal" },
];
const EDIT_TOKEN_COMPLETION: GoalArgumentCompletion = {
	value: "edit --tokens ",
	label: "--tokens",
	description: "Set a token budget before the updated goal",
};
const STATE_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
	"pi-goal-state.json",
);

let activeGoal: ActiveGoal | undefined;
let completionStatusTimer: NodeJS.Timeout | undefined;
let extensionApi: ExtensionAPI | undefined;
let continuationIntent: ContinuationTicket | undefined;
let continuationDelivery: ContinuationTicket | undefined;
let goalRecovery: GoalRecovery | undefined;
let staleGoalToolCallsBlocked = false;
const cancelledContinuationMarkers = new Set<string>();

const goalCompleteTool = defineTool({
	name: "goal_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
	promptSnippet:
		"Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
	promptGuidelines: [
		"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
		"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
		"Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
		"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
	],
	parameters: Type.Object({
		goal_id: Type.String({
			description:
				"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
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

		const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
		if (staleGoalRejection) {
			const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
			ctx.ui.notify(rejection, "warning");

			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
			};
		}

		if (completedGoal.status !== "active") {
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

			return {
				content: [
					{
						type: "text",
						text: rejection,
					},
				],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
			};
		}

		activeGoal = transitionGoal(completedGoal, "complete");
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);

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
	name: "goal_blocked",
	label: "Goal Blocked",
	description:
		"Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
	promptSnippet:
		"Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
	promptGuidelines: [
		"Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
		"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
		"Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
		"Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
	],
	parameters: Type.Object({
		goal_id: Type.String({
			description: "The exact goal_id shown in the current active /goal prompt.",
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
			const rejection = `goal_blocked rejected: ${rejectionReason}.`;
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

export default function goal(pi: ExtensionAPI) {
	extensionApi = pi;
	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: completeGoalArguments,
		handler: async (args, ctx) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
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
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearCompletionStatusTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		activeGoal = loadGoalFromSession(ctx);
		if (activeGoal) updateStatus(ctx, activeGoal);
		else ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeGoal) persistGoal(activeGoal);
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
	});

	pi.on("session_before_compact", (_event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") return;
		updateGoalUsage(activeGoal, ctx);
		cancelContinuationWork();
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
	});

	pi.on("session_compact", (event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredGoal = loadGoalFromSession(ctx);
		if (restoredGoal?.id === activeGoal.id) activeGoal = restoredGoal;
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

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
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
	});

	pi.on("tool_call", () => {
		if (!staleGoalToolCallsBlocked) return;
		if (!activeGoal || !blocksStaleGoalToolCalls(activeGoal.status)) {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("before_agent_start", (event) => {
		markContinuationStarted(event.prompt);
		if (!activeGoal || activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal)}`,
		};
	});

	pi.on("agent_end", (event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") return;

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

		if (activeGoal.tokenBudget !== undefined && activeGoal.tokensUsed >= activeGoal.tokenBudget) {
			cancelContinuationWork();
			activeGoal = transitionGoal(activeGoal, "budget_limited");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(activeGoal)}`, "warning");
			return;
		}

		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		const currentGoal = activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		requestContinuation(currentGoal);
	});

	pi.on("agent_settled", (_event, ctx) => {
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
	clearStaleGoalToolCallBlock();
	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, activeGoal);
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
	cancelContinuationWork();
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
	if (
		activeGoal.tokenBudget !== undefined &&
		activeGoal.tokensUsed >= activeGoal.tokenBudget
	) {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(activeGoal)}`, "warning");
		return;
	}
	const stoppedGoal = activeGoal;
	const stoppedStatus = stoppedGoal.status;
	cancelContinuationWork();
	clearGoalRecovery();
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
		clearStaleGoalToolCallBlock();
		clearPersistedGoal(ctx.cwd);
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
		ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
		return;
	}

	updateGoalUsage(activeGoal, ctx);
	cancelContinuationWork();
	clearGoalRecovery();
	activeGoal = normalizeGoalForBudget({
		...nextGoalInstance(activeGoal),
		text: objective,
		status: editedGoalStatus(activeGoal.status),
		tokenBudget: tokenBudget ?? activeGoal.tokenBudget,
		updatedAt: Date.now(),
	});
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
	if (activeGoal.status === "active") {
		clearStaleGoalToolCallBlock();
		await sendObjectiveUpdatedPrompt(pi, ctx, activeGoal);
	}
}

function showGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	updateGoalUsage(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(goalSummary(activeGoal), "info");
}

function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
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
	};
}

function transitionGoal(goal: ActiveGoal, status: GoalStatus): ActiveGoal {
	return normalizeGoalForBudget({ ...goal, status, updatedAt: Date.now() });
}

function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
	return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

function editedGoalStatus(status: GoalStatus): GoalStatus {
	if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
	return "active";
}

function normalizeGoalForBudget(goal: ActiveGoal): ActiveGoal {
	if (
		goal.status === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
	) {
		return { ...goal, status: "budget_limited" };
	}
	return goal;
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
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	activeGoal = transitionGoal(goal, status);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);

	const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
	if (status === "paused") {
		ctx.ui.notify(`Goal paused after interruption${details}. Run /goal resume to continue.`, "warning");
		return;
	}
	if (status === "usage_limited") {
		ctx.ui.notify(
			`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		`Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
		"warning",
	);
}

function updateGoalUsage(goal: ActiveGoal, ctx: StatusContext) {
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - goal.baselineTokens);
	goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
	goal.updatedAt = Date.now();
}

export function completeGoalArguments(argumentPrefix: string): GoalArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...GOAL_ARGUMENT_COMPLETIONS];

	const editOptionPrefix = /^edit\s+(\S*)$/.exec(prefix)?.[1];
	if (editOptionPrefix !== undefined) {
		return editOptionPrefix === "" || "--tokens".startsWith(editOptionPrefix)
			? [EDIT_TOKEN_COMPLETION]
			: null;
	}

	if (/\s/.test(prefix)) return null;

	const matches = GOAL_ARGUMENT_COMPLETIONS.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? [...matches] : null;
}

export function parseCommand(args: string): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };

	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
	if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "edit") return parseObjective("edit", rest);
	return parseObjective("start", tokens);
}

function parseObjective(kind: "start" | "edit", tokens: string[]): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];

	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) return "Usage: /goal --tokens 100k <goal_to_complete>";
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}

	if (objectiveTokens.length === 0) {
		return kind === "edit" ? "Usage: /goal edit <goal_to_complete>" : "Usage: /goal <goal_to_complete>";
	}

	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;

	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
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
	return [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
		`Commands: ${goalCommandHint(goal.status)}`,
	].join("\n");
}

function goalCommandHint(status: GoalStatus) {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (isResumableGoalStatus(status)) {
		return "/goal edit <objective>, /goal resume, /goal clear";
	}
	return "/goal edit <objective>, /goal clear";
}

export function formatDuration(seconds: number) {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number) {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function buildGoalPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokenCount(goal.tokenBudget)}.`;
	return `Goal mode is active. Complete this goal fully:\n\n${goalContextBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

function buildObjectiveUpdatedPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalContextBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

function buildResumePrompt(goal: ActiveGoal, stoppedStatus: GoalStatus) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The user explicitly resumed the ${stoppedStatusLabel(stoppedStatus)} /goal. Continue working toward this goal:\n\n${goalContextBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildGoalSystemPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\n- Respect the goal token budget (${formatBudget(goal)} used).`;
	return `Active /goal:\n${goalContextBlock(goal)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified, and pass this exact goal_id.${budgetLine}`;
}

function buildContinuePrompt(goal: ActiveGoal, marker: string) {
	return `Continue the active /goal until it is complete:\n\n${goalContextBlock(goal)}\n\nThis is automatic continuation #${goal.iteration}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}\n\n${continuationMarkerComment(marker)}`;
}

function goalContextBlock(goal: ActiveGoal) {
	return `${goalObjectiveBlock(goal)}\n\n${goalCompletionGuardBlock(goal)}`;
}

function goalObjectiveBlock(goal: ActiveGoal) {
	return `<goal_objective>\n${escapeXmlText(goal.text)}\n</goal_objective>`;
}

function goalCompletionGuardBlock(goal: ActiveGoal) {
	return `<goal_id>\n${escapeXmlText(goal.id)}\n</goal_id>\nThis goal_id is only the goal_complete tool stale-turn guard, not part of the objective. If and only if the goal is fully complete, pass this exact goal_id to goal_complete with the completion summary.`;
}

function goalPersistenceRules(goalLabel: string) {
	return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified, and pass this exact goal_id. Never reuse a goal_id from an older, stopped, replaced, or cleared turn.`;
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
		isRetryableAssistantError(toPiAssistantMessage(assistant)) ||
		RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage)
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
		if (Array.isArray(candidate.content)) assistant.content = candidate.content as PiAssistantMessage["content"];
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
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead ?? 0),
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

function currentTokenTotal(ctx: StatusContext): number {
	const sessionManager = ctx.sessionManager as
		| { getBranch?: () => Array<{ type?: string; message?: { role?: string; usage?: unknown } }> }
		| undefined;
	const branch = sessionManager?.getBranch?.() ?? [];
	let total = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage as { input?: number; output?: number } | undefined;
		total += usage?.input ?? 0;
		total += usage?.output ?? 0;
	}
	return total;
}

function persistGoal(goal: ActiveGoal) {
	extensionApi?.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal });
}

function clearPersistedGoal(cwd: string) {
	extensionApi?.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal: null });
	clearLegacyPersistedGoal(cwd);
}

function loadGoalFromSession(ctx: StatusContext): ActiveGoal | undefined {
	const sessionManager = ctx.sessionManager as
		| {
				getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
				getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
			}
		| undefined;
	const entries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
	const entry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	const data = entry?.data as GoalStateEntryData | undefined;
	return isGoal(data?.goal) && data.goal.status !== "complete" ? data.goal : undefined;
}

function clearActiveGoal(ctx: StatusContext) {
	cancelContinuationWork();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	activeGoal = undefined;
	clearPersistedGoal(ctx.cwd);
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

function readState(): Record<string, unknown> {
	if (!existsSync(STATE_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function clearLegacyPersistedGoal(cwd: string) {
	if (!existsSync(STATE_FILE)) return;
	const goals = readState();
	delete goals[cwd];
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(goals, null, 2)}\n`);
}


function isGoal(value: unknown): value is ActiveGoal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<ActiveGoal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.text === "string" &&
		["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(
			String(goal.status),
		) &&
		typeof goal.startedAt === "number" &&
		typeof goal.updatedAt === "number" &&
		typeof goal.iteration === "number" &&
		typeof goal.tokensUsed === "number" &&
		typeof goal.timeUsedSeconds === "number" &&
		typeof goal.baselineTokens === "number"
	);
}
