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
	currentTokenTotal,
	formatDuration,
	formatTokenCount,
	nonNegativeFiniteNumber,
	updateGoalUsage,
} from "./accounting.js";
import { completeGoalArguments, parseCommand, validateObjective } from "./command.js";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	type GoalStateEntryData,
	loadGoalFromSession,
} from "./persistence.js";
import {
	buildContinuePrompt,
	buildGoalPrompt,
	buildGoalSystemPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	type GoalStatus,
} from "./prompts.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings, readGoalSettings } from "./settings.js";

type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// Per-factory GoalRuntime owns mutable goal/continuation/budget/recovery state
// so concurrent in-process AgentSessions cannot clobber each other. Pure helpers
// live at module scope (single source of truth). registerGoalRuntime still keeps
// the orchestration handlers together so mutable ownership does not fragment
// across files; a file-size split is deferred until that ownership boundary is
// stable under isolation tests.

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

const STATUS_KEY = "goal";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const GOAL_COMPLETE_TOOL = "goal_complete";
const GOAL_BLOCKED_TOOL = "goal_blocked";
const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;
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

interface GoalOptions {
	settingsPath?: string;
}

interface GoalToolVisibilitySnapshot {
	activeTools: string[];
	goalToolsUnlocked: boolean;
	goalToolsHiddenByPolicy: string[];
}

interface GoalRuntime {
	readonly pi: ExtensionAPI;
	settings: GoalSettings;
	activeGoal?: ActiveGoal;
	completionStatusTimer?: NodeJS.Timeout;
	continuationIntent?: ContinuationTicket;
	continuationDelivery?: ContinuationTicket;
	goalRecovery?: GoalRecovery;
	budgetWrapUp?: BudgetWrapUp;
	agentRunGoalId?: string;
	staleGoalToolCallsBlocked: boolean;
	/** Once true, goal tools stay in the active set for this runtime (prompt-cache stable). */
	goalToolsUnlocked: boolean;
	/** Exact lazy goal tools this runtime removed and may restore on a mode change. */
	goalToolsHiddenByPolicy: Set<string>;
	pendingGoalPromptMarkers: Map<string, string>;
	cancelledContinuationMarkers: Set<string>;
}

function createGoalRuntime(pi: ExtensionAPI): GoalRuntime {
	return {
		pi,
		settings: DEFAULT_GOAL_SETTINGS,
		staleGoalToolCallsBlocked: false,
		goalToolsUnlocked: false,
		goalToolsHiddenByPolicy: new Set(),
		pendingGoalPromptMarkers: new Map(),
		cancelledContinuationMarkers: new Set(),
	};
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
	const runtime = createGoalRuntime(pi);

	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
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
			const completedGoal = runtime.activeGoal;
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
				runtime.budgetWrapUp?.goalId === completedGoal.id &&
				runtime.budgetWrapUp.delivered;
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

			runtime.activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
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
		name: GOAL_BLOCKED_TOOL,
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
			const blockedGoal = runtime.activeGoal;
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
			clearBudgetWrapUp();
			clearGoalRecoveryForGoal(blockedGoal.id);
			blockStaleGoalToolCalls();
			runtime.activeGoal = transitionGoal(blockedGoal, "blocked");
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
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

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);
	// Do not touch the active tool set during factory registration: ExtensionAPI
	// actions are unbound until the session binds the runtime. session_start applies
	// baseline visibility once actions work; later hooks only enforce goal safety.

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
					await resumeGoal(runtime.pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, runtime.pi, ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, runtime.pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearCompletionStatusTimer();
		clearContinuationTracking();
		clearPendingGoalPrompts();
		runtime.agentRunGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		const previousToolVisibility = runtime.settings.toolVisibility;
		const settingsResult = readGoalSettings(options.settingsPath);
		runtime.settings =
			settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
		if (settingsResult.kind === "invalid") {
			ctx.ui.notify(
				`pi-goal settings ignored: ${settingsResult.reason}. Using toolVisibility "always".`,
				"warning",
			);
		}
		if (
			runtime.settings.toolVisibility === "after-first-goal" &&
			previousToolVisibility === "always"
		) {
			runtime.goalToolsUnlocked = false;
		}
		if (runtime.settings.toolVisibility === "always") {
			if (runtime.goalToolsHiddenByPolicy.size > 0) {
				try {
					restoreGoalToolsHiddenByPolicy();
				} catch (error) {
					ctx.ui.notify(
						`Could not restore always-visible goal tools: ${formatError(error)}`,
						"error",
					);
				}
			}
			runtime.goalToolsUnlocked = true;
		}

		runtime.activeGoal = loadGoalFromSession(ctx);
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx);
				if (limitActiveGoalForBudget(ctx, false)) return;
			}
			if (runtime.settings.toolVisibility === "after-first-goal") {
				// Registered tools are already active on an unrestricted fresh runtime.
				// If an earlier session_start handler removed them, that restrictive
				// policy wins: mark lazy visibility unlocked without widening its set.
				runtime.goalToolsUnlocked = true;
				runtime.goalToolsHiddenByPolicy.clear();
			}
			if (runtime.activeGoal.status === "active" && !goalToolsAvailable()) {
				pauseGoalForUnavailableTools(ctx, false);
				return;
			}
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		} else {
			if (runtime.settings.toolVisibility === "after-first-goal" && !runtime.goalToolsUnlocked) {
				hideGoalToolsIfLocked();
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (runtime.activeGoal) {
			updateGoalUsage(runtime.activeGoal, ctx, false);
			persistGoal(runtime.activeGoal);
		}
		clearContinuationTracking();
		clearPendingGoalPrompts();
		runtime.agentRunGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (runtime.activeGoal?.status === "budget_limited") {
			if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		updateGoalUsage(runtime.activeGoal, ctx);
		cancelContinuationWork();
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (limitActiveGoalForBudget(ctx, false)) return { cancel: true as const };
	});

	pi.on("session_compact", (event, ctx) => {
		if (runtime.activeGoal?.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredGoal = loadGoalFromSession(ctx);
		if (restoredGoal?.id === runtime.activeGoal.id) runtime.activeGoal = restoredGoal;
		updateGoalUsage(runtime.activeGoal, ctx);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (limitActiveGoalForBudget(ctx, false)) return;

		const wasPiRetry = isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		clearGoalRecoveryForGoal(runtime.activeGoal.id);
		if (wasPiRetry) return;
		requestContinuation(runtime.activeGoal);
		// Manual compaction does not emit agent_settled. This common dispatcher is
		// therefore the narrow fallback; threshold compaction leaves the intent for
		// agent_settled when Pi is still busy.
		dispatchContinuationIfSettled(ctx);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") {
			if (consumeCancelledContinuationPrompt(event.text)) return { action: "handled" as const };
			return;
		}
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
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
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			event.toolName !== "goal_complete"
		) {
			// A blocked tool result would normally trigger another model call. Abort the
			// wrap-up instead so a tool-seeking model cannot create an unbounded loop.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
			};
		}
		if (!runtime.staleGoalToolCallsBlocked) return;
		if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			!runtime.budgetWrapUp.delivered
		) {
			queueBudgetWrapUp(ctx, runtime.activeGoal);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		updateGoalUsage(runtime.activeGoal, ctx);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		limitActiveGoalForBudget(ctx, true);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const goalPromptGoalId = consumePendingGoalPrompt(event.prompt);
		const continuationGoalId = goalPromptGoalId ? undefined : markContinuationStarted(event.prompt);
		const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
		if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
			runtime.agentRunGoalId = ownedPromptGoalId;
			if (runtime.activeGoal?.status === "active" && !goalToolsAvailable()) {
				pauseGoalForUnavailableTools(ctx, false);
			}
			abortCurrentTurn(ctx);
			return;
		}
		if (runtime.activeGoal?.status !== "active") {
			runtime.agentRunGoalId = undefined;
			return;
		}
		runtime.agentRunGoalId = runtime.activeGoal.id;
		if (!goalToolsAvailable()) {
			pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
			return;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(runtime.activeGoal)}`,
		};
	});

	pi.on("agent_end", (event, ctx) => {
		const agentRunGoalId = runtime.agentRunGoalId;
		runtime.agentRunGoalId = undefined;
		if (agentRunGoalId && agentRunGoalId !== runtime.activeGoal?.id) return;
		if (!runtime.activeGoal) return;
		if (
			runtime.activeGoal.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id
		) {
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			clearBudgetWrapUp();
			return;
		}
		if (runtime.activeGoal.status !== "active") return;

		const goalId = runtime.activeGoal.id;
		const alreadyAwaitingContinuation = hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(event.messages);

		if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
		updateGoalUsage(runtime.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted") {
			clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (limitActiveGoalForBudget(ctx, false)) return;
				if (!goalToolsAvailable()) {
					pauseGoalForUnavailableTools(ctx);
					return;
				}
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationWork();
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(
				ctx,
				runtime.activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (limitActiveGoalForBudget(ctx, false)) return;
		if (!goalToolsAvailable()) {
			pauseGoalForUnavailableTools(ctx);
			return;
		}

		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		requestContinuation(currentGoal);
	});

	pi.on("agent_settled", (_event, ctx) => {
		dispatchContinuationIfSettled(ctx);
	});

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

		const existingGoal = runtime.activeGoal?.status !== "complete" ? runtime.activeGoal : undefined;
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

		// Unlock lazy visibility only for a real activation. In always mode, a
		// missing tool means another policy or allowlist intentionally removed it.
		const goalToolVisibilityBeforeActivation = snapshotGoalToolVisibility();
		try {
			prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot start /goal: ${formatError(error)}`, "error");
			if (existingGoal?.status === "active") pauseGoalForUnavailableTools(ctx);
			return;
		}

		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		const startedGoal = runtime.activeGoal;
		const sent = await sendOwnedGoalPrompt(pi, ctx, startedGoal.id, buildGoalPrompt(startedGoal));
		if (!sent) {
			let rolledBackStartedGoal = false;
			if (runtime.activeGoal?.id === startedGoal.id) {
				rolledBackStartedGoal = true;
				if (existingGoal) {
					updateGoalUsage(existingGoal, ctx);
					if (existingGoal.status === "active") {
						abortCurrentTurn(ctx);
						runtime.activeGoal = transitionGoal(existingGoal, "paused");
						blockStaleGoalToolCalls();
					} else {
						runtime.activeGoal = existingGoal;
						if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
						else clearStaleGoalToolCallBlock();
					}
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				} else {
					clearActiveGoal(ctx);
				}
			}
			if (
				rolledBackStartedGoal &&
				!goalToolVisibilityBeforeActivation.goalToolsUnlocked &&
				!existingGoal
			) {
				restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		ctx.ui.notify(
			existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`,
			"info",
		);
	}

	function pauseGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal is ${runtime.activeGoal.status}; only active goals can be paused.`,
				"warning",
			);
			return;
		}
		updateGoalUsage(runtime.activeGoal, ctx);
		cancelContinuationWork();
		clearBudgetWrapUp();
		blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		runtime.activeGoal = transitionGoal(runtime.activeGoal, "paused");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(`Goal paused: ${runtime.activeGoal.text}`, "info");
	}

	async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (!isResumableGoalStatus(runtime.activeGoal.status)) {
			ctx.ui.notify(
				`Goal is ${runtime.activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
				"warning",
			);
			return;
		}
		if (
			runtime.activeGoal.tokenBudget !== undefined &&
			runtime.activeGoal.tokensUsed >= runtime.activeGoal.tokenBudget
		) {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		try {
			prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot resume /goal: ${formatError(error)}`, "error");
			return;
		}
		const stoppedGoal = runtime.activeGoal;
		const stoppedStatus = stoppedGoal.status;
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = transitionGoal(nextGoalInstance(runtime.activeGoal), "active");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const resumedGoal = runtime.activeGoal;
		const sent = await sendOwnedGoalPrompt(
			pi,
			ctx,
			resumedGoal.id,
			buildResumePrompt(resumedGoal, stoppedStatus),
		);
		if (!sent) {
			if (runtime.activeGoal?.id === resumedGoal.id && runtime.activeGoal.status === "active") {
				runtime.activeGoal = stoppedGoal;
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
			}
			return;
		}
		ctx.ui.notify(
			`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`,
			"info",
		);
	}

	function clearGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			cancelContinuationWork();
			clearGoalRecovery();
			clearBudgetWrapUp();
			clearStaleGoalToolCallBlock();
			clearPersistedGoal(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const stoppedGoal = runtime.activeGoal.text;
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
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
			return;
		}

		updateGoalUsage(runtime.activeGoal, ctx);
		const previousGoal = { ...runtime.activeGoal };
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		const previousStatus = runtime.activeGoal.status;
		const nextGoal = transitionGoal(
			{
				...nextGoalInstance(runtime.activeGoal),
				text: objective,
				tokenBudget: tokenBudget ?? runtime.activeGoal.tokenBudget,
			},
			editedGoalStatus(previousStatus),
		);
		if (nextGoal.status === "active") {
			try {
				prepareGoalToolsForActivation(ctx);
			} catch (error) {
				ctx.ui.notify(`Cannot reactivate /goal: ${formatError(error)}`, "error");
				if (runtime.activeGoal?.status === "active") pauseGoalForUnavailableTools(ctx);
				return;
			}
		}
		runtime.activeGoal = nextGoal;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		const editedGoal = runtime.activeGoal;
		if (!editedGoal) return;
		if (editedGoal.status === "active") {
			clearStaleGoalToolCallBlock();
			const sent = await sendOwnedGoalPrompt(
				pi,
				ctx,
				editedGoal.id,
				buildObjectiveUpdatedPrompt(editedGoal),
			);
			if (!sent) {
				if (runtime.activeGoal?.id === editedGoal.id) {
					if (previousStatus === "active") {
						abortCurrentTurn(ctx);
						runtime.activeGoal = transitionGoal(previousGoal, "paused");
						blockStaleGoalToolCalls();
					} else {
						runtime.activeGoal = previousGoal;
						if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
						else clearStaleGoalToolCallBlock();
					}
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
				return;
			}
		} else if (blocksStaleGoalToolCalls(editedGoal.status)) {
			blockStaleGoalToolCalls();
		} else {
			clearStaleGoalToolCallBlock();
		}
		ctx.ui.notify(`Goal updated: ${objective}`, "info");
	}

	function showGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		updateGoalUsage(runtime.activeGoal, ctx);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(goalSummary(runtime.activeGoal), "info");
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
		runtime.activeGoal = transitionGoal(goal, status);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const details = assistant.errorMessage
			? ` (${truncateNotification(assistant.errorMessage)})`
			: "";
		if (status === "paused") {
			ctx.ui.notify(
				`Goal paused after interruption${details}. Run /goal resume to continue.`,
				"warning",
			);
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

	function requestContinuation(goal: ActiveGoal) {
		if (hasContinuationWorkForGoal(goal.id)) return false;
		const marker = continuationMarker(goal);
		runtime.continuationIntent = {
			goalId: goal.id,
			iteration: goal.iteration,
			marker,
			prompt: buildContinuePrompt(goal, marker),
		};
		return true;
	}

	function dispatchContinuationIfSettled(ctx: StatusContext) {
		const intent = runtime.continuationIntent;
		if (!intent) return false;
		if (runtime.activeGoal?.status === "active" && !goalToolsAvailable()) {
			pauseGoalForUnavailableTools(ctx);
			return false;
		}
		if (
			!runtime.activeGoal ||
			runtime.activeGoal.id !== intent.goalId ||
			runtime.activeGoal.status !== "active"
		) {
			runtime.continuationIntent = undefined;
			return false;
		}
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = intent;
		try {
			runtime.pi.sendUserMessage(intent.prompt);
			return true;
		} catch (error) {
			if (runtime.continuationDelivery?.marker === intent.marker)
				runtime.continuationDelivery = undefined;
			if (runtime.activeGoal?.id === intent.goalId && runtime.activeGoal.status === "active") {
				runtime.continuationIntent = intent;
			}
			ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	function hasContinuationWorkForGoal(goalId: string) {
		return (
			runtime.continuationIntent?.goalId === goalId ||
			runtime.continuationDelivery?.goalId === goalId
		);
	}

	function updateStatus(ctx: StatusContext, goal: ActiveGoal) {
		clearCompletionStatusTimer();
		ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
	}

	function blockStaleGoalToolCalls() {
		runtime.staleGoalToolCallsBlocked = true;
	}

	function clearStaleGoalToolCallBlock() {
		runtime.staleGoalToolCallsBlocked = false;
	}

	function clearGoalRecovery() {
		runtime.goalRecovery = undefined;
	}

	function clearBudgetWrapUp() {
		runtime.budgetWrapUp = undefined;
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
			candidate.details.goalId === runtime.budgetWrapUp?.goalId &&
			candidate.details.goalId === runtime.activeGoal?.id
		);
	}

	function queueBudgetWrapUp(ctx: StatusContext, goal: ActiveGoal) {
		if (!runtime.budgetWrapUp || runtime.budgetWrapUp.goalId !== goal.id) {
			runtime.budgetWrapUp = { goalId: goal.id, delivered: false };
		}
		if (runtime.budgetWrapUp.delivered) return true;
		runtime.budgetWrapUp.delivered = true;
		try {
			runtime.pi.sendMessage(
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
			runtime.budgetWrapUp.delivered = false;
			ctx.ui.notify(`Goal budget wrap-up failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	function limitActiveGoalForBudget(ctx: StatusContext, sendWrapUp: boolean) {
		const goal = runtime.activeGoal;
		if (
			goal?.status !== "active" ||
			goal.tokenBudget === undefined ||
			goal.tokensUsed < goal.tokenBudget
		) {
			return false;
		}

		cancelContinuationWork();
		clearGoalRecoveryForGoal(goal.id);
		clearBudgetWrapUp();
		runtime.activeGoal = transitionGoal(goal, "budget_limited");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(`Goal token budget reached: ${formatBudget(runtime.activeGoal)}`, "warning");
		if (sendWrapUp) queueBudgetWrapUp(ctx, runtime.activeGoal);
		return true;
	}

	function clearGoalRecoveryForGoal(goalId: string) {
		if (runtime.goalRecovery?.goalId === goalId) runtime.goalRecovery = undefined;
	}

	function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
		const compaction = event as { reason?: unknown; willRetry?: unknown };
		if (compaction.willRetry === true) return true;
		return (
			runtime.goalRecovery?.goalId === goalId &&
			runtime.goalRecovery.kind === "compaction_retry" &&
			(compaction.reason === undefined || compaction.reason === "overflow")
		);
	}

	function clearContinuationTracking() {
		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = undefined;
		runtime.cancelledContinuationMarkers.clear();
	}

	function clearPendingGoalPrompts() {
		runtime.pendingGoalPromptMarkers.clear();
	}

	function rememberPendingGoalPrompt(goalId: string, prompt: string) {
		const marker = randomUUID();
		runtime.pendingGoalPromptMarkers.set(marker, goalId);
		if (runtime.pendingGoalPromptMarkers.size > MAX_PENDING_GOAL_PROMPTS) {
			const oldest = runtime.pendingGoalPromptMarkers.keys().next().value;
			if (oldest) runtime.pendingGoalPromptMarkers.delete(oldest);
		}
		return { marker, prompt: `${prompt}\n\n<!-- ${GOAL_PROMPT_MARKER_PREFIX}${marker} -->` };
	}

	function consumePendingGoalPrompt(prompt: string) {
		const marker = extractGoalPromptMarker(prompt);
		if (!marker) return undefined;
		const goalId = runtime.pendingGoalPromptMarkers.get(marker);
		runtime.pendingGoalPromptMarkers.delete(marker);
		return goalId;
	}

	async function sendOwnedGoalPrompt(
		pi: ExtensionAPI,
		ctx: StatusContext,
		goalId: string,
		prompt: string,
	) {
		const pending = rememberPendingGoalPrompt(goalId, prompt);
		const sent = await sendPrompt(pi, ctx, pending.prompt);
		if (!sent) runtime.pendingGoalPromptMarkers.delete(pending.marker);
		return sent;
	}

	function cancelContinuationWork() {
		if (runtime.continuationDelivery)
			rememberCancelledContinuationMarker(runtime.continuationDelivery.marker);
		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = undefined;
	}

	function rememberCancelledContinuationMarker(marker: string) {
		runtime.cancelledContinuationMarkers.add(marker);
		if (runtime.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
		const oldest = runtime.cancelledContinuationMarkers.values().next().value;
		if (oldest) runtime.cancelledContinuationMarkers.delete(oldest);
	}

	function consumeCancelledContinuationPrompt(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		return marker ? runtime.cancelledContinuationMarkers.delete(marker) : false;
	}

	function markContinuationStarted(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		if (!marker) {
			// A user, retry, or another extension started newer work. Cancel both an
			// unsent intent and a delivery that may have lost the non-atomic idle race;
			// the newer work's agent_end will record a fresh intent.
			cancelContinuationWork();
			return undefined;
		}
		if (runtime.continuationDelivery?.marker === marker) runtime.continuationDelivery = undefined;
		return marker.split(":", 1)[0];
	}

	function persistGoal(goal: ActiveGoal) {
		runtime.pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal });
	}

	function clearPersistedGoal(cwd: string) {
		runtime.pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal: null });
		clearLegacyPersistedGoal(cwd);
	}

	function clearActiveGoal(ctx: StatusContext) {
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		clearPersistedGoal(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		// Do not clear goalToolsUnlocked: after first activation, keep tools visible
		// for the rest of this extension runtime to avoid repeated goal-tool schema
		// churn within the same runtime.
	}

	function isGoalToolName(name: string) {
		return (GOAL_TOOL_NAMES as readonly string[]).includes(name);
	}

	function goalToolsAvailable() {
		const active = new Set(runtime.pi.getActiveTools());
		return GOAL_TOOL_NAMES.every((name) => active.has(name));
	}

	function hideGoalToolsIfLocked() {
		if (runtime.goalToolsUnlocked) return;
		const active = runtime.pi.getActiveTools();
		const hidden = active.filter(isGoalToolName);
		if (hidden.length === 0) return;
		runtime.pi.setActiveTools(active.filter((name) => !isGoalToolName(name)));
		for (const name of hidden) runtime.goalToolsHiddenByPolicy.add(name);
	}

	function restoreGoalToolsHiddenByPolicy() {
		const activeBeforeRestore = runtime.pi.getActiveTools();
		const activeSet = new Set(activeBeforeRestore);
		const missingOwnedTools = [...runtime.goalToolsHiddenByPolicy].filter(
			(name) => !activeSet.has(name),
		);
		if (missingOwnedTools.length === 0) {
			runtime.goalToolsHiddenByPolicy.clear();
			return;
		}
		try {
			runtime.pi.setActiveTools([...activeBeforeRestore, ...missingOwnedTools]);
			const restored = new Set(runtime.pi.getActiveTools());
			if (missingOwnedTools.some((name) => !restored.has(name))) {
				throw new Error("the active tool policy rejected a previously hidden goal tool");
			}
			runtime.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			runtime.pi.setActiveTools(activeBeforeRestore);
			throw error;
		}
	}

	function assertGoalToolsAvailable() {
		if (goalToolsAvailable()) return;
		throw new Error(
			"goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
		);
	}

	function ensureGoalToolsVisible() {
		const active = runtime.pi.getActiveTools();
		const activeSet = new Set(active);
		const missing = GOAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
		if (missing.length > 0) runtime.pi.setActiveTools([...active, ...missing]);
		assertGoalToolsAvailable();
	}

	function prepareGoalToolsForActivation(ctx: StatusContext) {
		if (runtime.settings.toolVisibility === "after-first-goal") {
			if (!goalToolsAvailable() && ctx.isIdle?.() !== true) {
				throw new Error("wait until Pi is idle before revealing the goal tools");
			}
			revealGoalTools();
			return;
		}
		assertGoalToolsAvailable();
	}

	/** Mark lazy tools permanently desired for this runtime and make them active now. */
	function revealGoalTools() {
		const activeBeforeReveal = runtime.pi.getActiveTools();
		const wasUnlocked = runtime.goalToolsUnlocked;
		try {
			ensureGoalToolsVisible();
			runtime.goalToolsUnlocked = true;
			runtime.goalToolsHiddenByPolicy.clear();
		} catch (error) {
			runtime.pi.setActiveTools(activeBeforeReveal);
			runtime.goalToolsUnlocked = wasUnlocked;
			throw error;
		}
	}

	function snapshotGoalToolVisibility(): GoalToolVisibilitySnapshot {
		return {
			activeTools: runtime.pi.getActiveTools(),
			goalToolsUnlocked: runtime.goalToolsUnlocked,
			goalToolsHiddenByPolicy: [...runtime.goalToolsHiddenByPolicy],
		};
	}

	function restoreGoalToolVisibility(snapshot: GoalToolVisibilitySnapshot) {
		runtime.pi.setActiveTools(snapshot.activeTools);
		runtime.goalToolsUnlocked = snapshot.goalToolsUnlocked;
		runtime.goalToolsHiddenByPolicy.clear();
		for (const name of snapshot.goalToolsHiddenByPolicy) {
			runtime.goalToolsHiddenByPolicy.add(name);
		}
	}

	function pauseGoalForUnavailableTools(ctx: StatusContext, abortTurn = true) {
		const goal = runtime.activeGoal;
		if (goal?.status !== "active") return false;
		updateGoalUsage(goal, ctx);
		cancelContinuationWork();
		clearGoalRecoveryForGoal(goal.id);
		clearBudgetWrapUp();
		if (abortTurn) {
			blockStaleGoalToolCalls();
			abortCurrentTurn(ctx);
		} else {
			clearStaleGoalToolCallBlock();
		}
		runtime.activeGoal = transitionGoal(goal, "paused");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(
			"Goal tools are unavailable, so the active goal was paused. Restore the tools and run /goal resume.",
			"warning",
		);
		return true;
	}

	function showCompletionStatus(ctx: StatusContext) {
		clearCompletionStatusTimer();
		ctx.ui.setStatus(STATUS_KEY, "complete");
		runtime.completionStatusTimer = setTimeout(() => {
			runtime.completionStatusTimer = undefined;
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// The completion status is best-effort; the captured ctx may be stale after
				// session replacement or reload before this timer fires.
			}
		}, 8_000);
	}

	function clearCompletionStatusTimer() {
		if (!runtime.completionStatusTimer) return;
		clearTimeout(runtime.completionStatusTimer);
		runtime.completionStatusTimer = undefined;
	}
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
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
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

function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
	registerGoalRuntime(pi, options);
}

export {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	formatDuration,
	formatTokenCount,
} from "./accounting.js";

export {
	completeGoalArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";
