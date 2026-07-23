import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentTokenTotal } from "./accounting.js";
import { completeGoalArguments, parseCommand } from "./command.js";
import { GoalCommandController } from "./commands.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import { buildGoalPrompt, buildGoalSystemPrompt } from "./prompts.js";
import { activateQueuedGoal } from "./queue.js";
import { GoalRpcController } from "./rpc.js";
import {
	type AssistantMessageLike,
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	findFinalAssistantMessage,
	formatError,
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	GoalRuntime,
	goalIdRejectionReason,
	incrementGoal,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	resetGoalSafetyEpoch,
	STATUS_KEY,
	type StatusContext,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import { hasAssistantToolCall } from "./safety.js";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "./settings.js";

// goal.ts is the Pi-facing composition root: it keeps tool contracts and event
// ordering together. Per-session mechanisms live in runtime.ts, while user command
// transitions live in commands.ts. Each factory constructs isolated instances.

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

interface GoalOptions {
	settingsPath?: string;
}

const EXPERIMENTAL_GOALS_WARNING =
	"Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
	const runtime = new GoalRuntime(pi);
	const commands = new GoalCommandController(runtime);
	const rpc = new GoalRpcController(runtime, commands);
	rpc.register(pi);

	// Bind per-factory runtime operations once so event orchestration stays concise
	// without reintroducing module-global mutable state.
	const clearCompletionStatusTimer = runtime.clearCompletionStatusTimer.bind(runtime);
	const clearContinuationTracking = runtime.clearContinuationTracking.bind(runtime);
	const clearPendingGoalPrompts = runtime.clearPendingGoalPrompts.bind(runtime);
	const clearGoalRecovery = runtime.clearGoalRecovery.bind(runtime);
	const clearBudgetWrapUp = runtime.clearBudgetWrapUp.bind(runtime);
	const clearStaleGoalToolCallBlock = runtime.clearStaleGoalToolCallBlock.bind(runtime);
	const persistGoal = runtime.persistGoal.bind(runtime);
	const updateGoalUsage = runtime.recordGoalUsage.bind(runtime);
	const updateStatus = runtime.updateStatus.bind(runtime);
	const limitActiveGoalForBudget = runtime.limitActiveGoalForBudget.bind(runtime);
	const hideGoalToolsIfLocked = runtime.hideGoalToolsIfLocked.bind(runtime);
	const goalToolsAvailable = runtime.goalToolsAvailable.bind(runtime);
	const pauseGoalForUnavailableTools = runtime.pauseGoalForUnavailableTools.bind(runtime);
	const isPiOwnedCompactionRetry = runtime.isPiOwnedCompactionRetry.bind(runtime);
	const requestContinuation = runtime.requestContinuation.bind(runtime);
	const dispatchContinuationIfSettled = runtime.dispatchContinuationIfSettled.bind(runtime);
	const keepBudgetWrapUpMessage = runtime.keepBudgetWrapUpMessage.bind(runtime);
	const isGoalToolName = runtime.isGoalToolName.bind(runtime);
	const queueBudgetWrapUp = runtime.queueBudgetWrapUp.bind(runtime);
	const clearGoalRecoveryForGoal = runtime.clearGoalRecoveryForGoal.bind(runtime);
	const blockStaleGoalToolCalls = runtime.blockStaleGoalToolCalls.bind(runtime);
	const cancelContinuationWork = runtime.cancelContinuationWork.bind(runtime);
	const consumeCancelledContinuationPrompt =
		runtime.consumeCancelledContinuationPrompt.bind(runtime);
	const consumeStaleOwnedGoalPrompt = runtime.consumeStaleOwnedGoalPrompt.bind(runtime);
	const consumePendingGoalPrompt = runtime.consumeOwnedGoalPrompt.bind(runtime);
	const markContinuationStarted = runtime.markContinuationStarted.bind(runtime);
	const hasContinuationWorkForGoal = runtime.hasContinuationWorkForGoal.bind(runtime);
	const recordAutomaticTurn = runtime.recordAutomaticTurn.bind(runtime);
	const recordAutomaticRunProgress = runtime.recordAutomaticRunProgress.bind(runtime);
	const enforceAutomaticTurnLimit = runtime.enforceAutomaticTurnLimit.bind(runtime);
	const enforceNoProgressLimit = runtime.enforceNoProgressLimit.bind(runtime);
	const clearActiveGoal = runtime.clearActiveGoal.bind(runtime);
	const showCompletionStatus = runtime.showCompletionStatus.bind(runtime);
	const restoreGoalToolsHiddenByPolicy = runtime.restoreGoalToolsHiddenByPolicy.bind(runtime);
	const sendOwnedGoalPrompt = (
		_pi: ExtensionAPI,
		ctx: StatusContext,
		goalId: string,
		prompt: string,
		resetSafetyEpoch = true,
	) => runtime.sendOwnedGoalPrompt(ctx, goalId, prompt, resetSafetyEpoch);
	const dispatchPendingQueueActionIfSettled =
		commands.dispatchPendingQueueActionIfSettled.bind(commands);

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
			const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
			if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
				const rejection = "Goal completion rejected: current run does not own the active goal.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}
			if (hasPendingSkipForGoal(completedGoal.id)) {
				updateGoalUsage(completedGoal, ctx);
				persistGoal(completedGoal);
				updateStatus(ctx, completedGoal);
				clearBudgetWrapUp();
				const rejection = "Goal completion rejected: goal is queued to be skipped.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
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
			runtime.setCompletionSummary(runtime.activeGoal.id, summary);
			updateGoalUsage(runtime.activeGoal, ctx);
			if (runtime.pendingQueueAction?.kind === "prioritize") {
				persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(`Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
				return {
					content: [{ type: "text", text: `Goal complete: ${summary}` }],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			if (runtime.queuedGoals.length > 0) {
				runtime.pendingQueueAction = {
					kind: "advance",
					goalId: runtime.activeGoal.id,
					reason: "complete",
					completedText: goal,
				};
				persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(
					`Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`,
					"info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`,
						},
					],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
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
			const reject = (rejectionReason: string, terminate = false) => {
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
					...(terminate ? { terminate: true as const } : {}),
				};
			};

			if (!blockedGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			if (hasPendingSkipForGoal(blockedGoal.id)) {
				updateGoalUsage(blockedGoal, ctx);
				persistGoal(blockedGoal);
				updateStatus(ctx, blockedGoal);
				clearBudgetWrapUp();
				return reject("goal is queued to be skipped", true);
			}
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
			runtime.setTerminalReason(runtime.activeGoal.id, reason);
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
		getArgumentCompletions: (prefix) =>
			completeGoalArguments(prefix, {
				experimentalGoals: runtime.settings.experimental.goals,
			}),
		handler: async (args, ctx) => {
			const result = parseCommand(args, {
				experimentalGoals: runtime.settings.experimental.goals,
			});
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}
			if (runtime.queueFrozen) {
				if (result.kind === "show") commands.showGoal(ctx);
				else if (result.kind === "clear") commands.clearGoal(ctx);
				else commands.notifyFrozenQueue(ctx);
				return;
			}
			if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
				ctx.ui.notify(
					"A queued goal change is waiting for Pi to settle. Retry after it finishes.",
					"warning",
				);
				return;
			}

			switch (result.kind) {
				case "show":
					commands.showGoal(ctx);
					return;
				case "pause":
					commands.pauseGoal(ctx);
					return;
				case "resume":
					await commands.resumeGoal(ctx);
					return;
				case "clear":
					commands.clearGoal(ctx);
					return;
				case "edit":
					await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "add":
					await commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "prioritize":
					await commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "drop-last":
					commands.dropLastGoal(ctx);
					return;
				case "skip":
					await commands.skipGoal(ctx);
					return;
				case "start":
					await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearCompletionStatusTimer();
		clearContinuationTracking();
		clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		runtime.clearTerminalDetails();
		rpc.bindSession(ctx);
		const previousToolVisibility = runtime.settings.toolVisibility;
		const settingsResult = readGoalSettings(options.settingsPath);
		runtime.settings =
			settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
		if (settingsResult.kind === "invalid") {
			ctx.ui.notify(
				`pi-goal settings ignored: ${settingsResult.reason}. Using default settings.`,
				"warning",
			);
		}
		if (runtime.settings.experimental.goals) {
			ctx.ui.notify(EXPERIMENTAL_GOALS_WARNING, "warning");
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

		const loaded = loadGoalStateFromSession(ctx);
		runtime.activeGoal = loaded.goal;
		runtime.queuedGoals = loaded.queue;
		runtime.pendingQueueAction = loaded.pendingAction;
		runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
		if (runtime.queueFrozen) {
			if (runtime.activeGoal) persistGoal(runtime.activeGoal);
			ctx.ui.setStatus(STATUS_KEY, "queue off");
			ctx.ui.notify(
				"An experimental goal queue is frozen because experimental.goals is disabled. Re-enable it and run /reload to continue, or use /goal clear.",
				"warning",
			);
			return;
		}

		let startRestoredQueuedGoal = false;
		if (runtime.activeGoal?.status === "queued" && !runtime.pendingQueueAction) {
			runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
			startRestoredQueuedGoal = runtime.activeGoal.status === "active";
		}
		if (runtime.pendingQueueAction) await dispatchPendingQueueActionIfSettled(ctx);
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active" && runtime.activeGoal.safetyResetPending) {
				// Resume/edit activation is persisted before its queued prompt starts. A
				// reload must commit that promised reset before enforcing the old limits.
				runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			}
			if (runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx);
				if (limitActiveGoalForBudget(ctx, false)) return;
				if (enforceAutomaticTurnLimit(ctx, false) || enforceNoProgressLimit(ctx)) return;
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
			if (startRestoredQueuedGoal) {
				const restoredGoal = runtime.activeGoal;
				const sent = await sendOwnedGoalPrompt(
					runtime.pi,
					ctx,
					restoredGoal.id,
					buildGoalPrompt(restoredGoal),
					false, // Reloaded queue activation preserves its persisted safety epoch.
				);
				if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
					runtime.activeGoal = transitionGoal(restoredGoal, "paused");
					blockStaleGoalToolCalls();
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
			}
		} else {
			if (runtime.settings.toolVisibility === "after-first-goal" && !runtime.goalToolsUnlocked) {
				hideGoalToolsIfLocked();
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (runtime.activeGoal) {
			if (!runtime.queueFrozen && runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx, false);
			}
			persistGoal(runtime.activeGoal);
		}
		clearContinuationTracking();
		clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
		runtime.clearTerminalDetails();
		rpc.unbindSession();
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status === "budget_limited") {
			if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		if (!updateGoalUsage(runtime.activeGoal, ctx)) return;
		cancelContinuationWork();
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (runtime.pendingQueueAction) return;
		if (limitActiveGoalForBudget(ctx, false)) return { cancel: true as const };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status !== "active") {
			clearGoalRecovery();
			if (runtime.pendingQueueAction) await dispatchPendingQueueActionIfSettled(ctx);
			return;
		}

		const restoredState = loadGoalStateFromSession(ctx);
		if (restoredState.goal?.id === runtime.activeGoal.id) {
			runtime.activeGoal = restoredState.goal;
			runtime.queuedGoals = restoredState.queue;
			runtime.pendingQueueAction = restoredState.pendingAction;
		}
		const usageRecorded = updateGoalUsage(runtime.activeGoal, ctx);
		if (usageRecorded) {
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}
		if (runtime.pendingQueueAction) {
			await dispatchPendingQueueActionIfSettled(ctx);
			return;
		}
		if (!usageRecorded) return;
		if (limitActiveGoalForBudget(ctx, false)) return;

		const wasPiRetry = isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		if (wasPiRetry) return;
		clearGoalRecoveryForGoal(runtime.activeGoal.id);
		requestContinuation(runtime.activeGoal);
		// Manual compaction does not emit agent_settled. This common dispatcher is
		// therefore the narrow fallback; threshold compaction leaves the intent for
		// agent_settled when Pi is still busy.
		dispatchContinuationIfSettled(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			if (
				consumeCancelledContinuationPrompt(event.text) ||
				consumeStaleOwnedGoalPrompt(event.text)
			) {
				return { action: "handled" as const };
			}
			if (runtime.queueFrozen) return;
			// Streaming input is queued before its model work starts. Keep owned
			// markers pending for message_start, and track non-goal delivery mode so a
			// steer cannot consume a later follow-up's cleanup protection.
			if (runtime.hasPendingOwnedGoalPrompt(event.text)) return;
			if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
				runtime.noteQueuedNonGoalInput(event.text, event.streamingBehavior);
			}
			clearGoalRecovery();
			return;
		}
		if (runtime.queueFrozen) return;
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
		if (event.streamingBehavior === "followUp") {
			runtime.noteQueuedNonGoalInput(event.text, "followUp", true);
			return;
		}
		if (event.streamingBehavior === "steer") {
			runtime.noteQueuedNonGoalInput(event.text, "steer");
		}
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.resetActiveSafetyEpoch(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		const message = event.message as { role?: unknown; content?: unknown };
		if (
			message.role === "assistant" &&
			runtime.activeGoal?.status === "paused" &&
			runtime.guardAbortGoalId === runtime.activeGoal.id
		) {
			abortCurrentTurn(ctx);
			return;
		}
		if (message.role === "custom") {
			if (runtime.isActiveBudgetWrapUpMessage(message)) return;
			if (runtime.guardAbortGoalId === runtime.activeGoal?.id) {
				runtime.guardAbortGoalId = undefined;
			}
			beginNonGoalFollowUp(ctx, false);
			return;
		}
		if (message.role !== "user") return;
		const prompt = Array.isArray(message.content)
			? message.content
					.filter(
						(part) => part && typeof part === "object" && Reflect.get(part, "type") === "text",
					)
					.map((part) => Reflect.get(part as object, "text"))
					.filter((text): text is string => typeof text === "string")
					.join("\n")
			: typeof message.content === "string"
				? message.content
				: "";
		const ownedPrompt = consumePendingGoalPrompt(prompt);
		const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(prompt);
		const queuedNonGoalInput = runtime.consumeQueuedNonGoalInput(prompt, !ownedPromptBoundary);
		if (!ownedPrompt) {
			if (queuedNonGoalInput?.behavior === "followUp") {
				beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
			}
			return;
		}
		if (runtime.activeGoal?.id !== ownedPrompt.goalId || runtime.activeGoal.status !== "active") {
			return;
		}
		if (runtime.agentRunGoalId !== undefined && runtime.agentRunGoalId !== ownedPrompt.goalId) {
			runtime.activeGoal.baselineTokens = Math.max(
				0,
				currentTokenTotal(ctx) - runtime.activeGoal.tokensUsed,
			);
		}
		runtime.beginAgentRun(ownedPrompt.goalId, "manual");
		if (ownedPrompt.resetSafetyEpoch) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
		}
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
	});

	pi.on("context", (event, ctx) => {
		const messages = event.messages.filter((message) => keepBudgetWrapUpMessage(message));
		if (
			runtime.activeGoal?.status === "paused" &&
			runtime.guardAbortGoalId === runtime.activeGoal.id
		) {
			// A current custom follow-up clears the guard at message_start. Otherwise,
			// context transformation aborts before the provider adapter receives the signal.
			abortCurrentTurn(ctx);
		}
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.on("tool_call", (event, ctx) => {
		runtime.markAgentToolAttempted();
		if (runtime.queueFrozen) {
			if (!isGoalToolName(event.toolName)) return;
			return {
				block: true,
				reason:
					"The experimental goal queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			};
		}
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
		if (runtime.queueFrozen) return;
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
		if (!updateGoalUsage(runtime.activeGoal, ctx)) return;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (limitActiveGoalForBudget(ctx, true)) return;
		if (!goalToolsAvailable()) pauseGoalForUnavailableTools(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		runtime.clearAgentRun();
		if (runtime.queueFrozen) return;
		// Pi-owned retries emit agent_start directly. Reaching a normal prompt
		// boundary means cleanup no longer owns the next run, so the hard-cap guard
		// must not abort it.
		if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
		const goalPrompt = consumePendingGoalPrompt(event.prompt);
		const goalPromptGoalId = goalPrompt?.goalId;
		const continuationGoalId = goalPromptGoalId ? undefined : markContinuationStarted(event.prompt);
		const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
		const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(event.prompt);
		const activeBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
		const activeGoalRecovery = runtime.hasActiveGoalRecovery();
		const queuedNonGoalInput = activeBudgetWrapUp
			? undefined
			: runtime.consumeQueuedNonGoalInput(
					event.prompt,
					!activeGoalRecovery && ownedPromptGoalId === undefined && !ownedPromptBoundary,
				);
		if (queuedNonGoalInput?.behavior === "followUp") {
			beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
		}
		const runOrigin = continuationGoalId
			? "automatic"
			: activeGoalRecovery && runtime.goalRecovery?.automaticOwner
				? "automatic"
				: "manual";
		if (
			runtime.pendingQueueAction?.kind === "prioritize" &&
			!activeBudgetWrapUp &&
			!activeGoalRecovery
		) {
			// A turn that starts after priority intent is committed belongs to neither
			// the displaced goal nor the not-yet-activated urgent goal. Persist the
			// displaced goal's final accounting boundary so reload cannot absorb this run.
			if (!runtime.pendingQueueAction.displacedUsageFinalized) {
				if (runtime.activeGoal?.status === "active") {
					updateGoalUsage(runtime.activeGoal, ctx, false);
				}
				runtime.pendingQueueAction.displacedUsageFinalized = true;
				if (runtime.activeGoal) {
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
			}
			runtime.beginAgentRun(null, undefined);
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return;
		}
		if (activeBudgetWrapUp && runtime.activeGoal) {
			runtime.beginAgentRun(runtime.activeGoal.id, "manual");
			return;
		}
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal?.id
		) {
			runtime.beginAgentRun(ownedPromptGoalId ?? runtime.activeGoal.id, runOrigin);
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return;
		}
		if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
			runtime.beginAgentRun(ownedPromptGoalId, runOrigin);
			if (runtime.activeGoal?.status === "active" && !goalToolsAvailable()) {
				pauseGoalForUnavailableTools(ctx, false);
			}
			abortCurrentTurn(ctx);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
		if (!goalToolsAvailable()) {
			pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
			return;
		}
		if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(runtime.activeGoal)}`,
		};
	});

	pi.on("agent_start", (_event, _ctx) => {
		if (runtime.queueFrozen) return;
		const activeGoal = runtime.activeGoal;
		if (
			activeGoal &&
			runtime.guardAbortGoalId === activeGoal.id &&
			activeGoal.status === "paused"
		) {
			if (runtime.consumeQueuedNonGoalFollowUpForAgentStart()) {
				runtime.guardAbortGoalId = undefined;
				clearStaleGoalToolCallBlock();
				runtime.beginAgentRun(null, undefined);
			}
			// Unknown runs defer cleanup until their message/context boundary: custom
			// follow-ups have no input event, while bare recovery is aborted pre-provider.
			return;
		}
		runtime.beginRecoveryRunIfNeeded();
	});

	pi.on("turn_end", (event, ctx) => {
		if (runtime.queueFrozen) return;
		recordAutomaticTurn(ctx, event.message);
	});

	pi.on("agent_end", (event, ctx) => {
		const run = runtime.finishAgentRun();
		if (runtime.queueFrozen || run.goalId === null) return;
		if (!runtime.canRecordGoalUsage() && !runtime.hasActiveBudgetWrapUp()) return;
		if (run.goalId && run.goalId !== runtime.activeGoal?.id) return;
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
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal.id
		) {
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			return;
		}

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
				if (run.origin === "automatic" && enforceAutomaticTurnLimit(ctx, true)) return;
				if (limitActiveGoalForBudget(ctx, false)) return;
				if (!goalToolsAvailable()) {
					pauseGoalForUnavailableTools(ctx);
					return;
				}
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
					automaticOwner: run.origin === "automatic",
					errorMessage: finalAssistant.errorMessage,
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
		if (
			run.origin === "automatic" &&
			recordAutomaticRunProgress(
				ctx,
				goalId,
				event.messages,
				run.toolAttempted || hasAssistantToolCall(event.messages),
			)
		) {
			return;
		}

		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (runtime.pendingQueueAction?.kind === "prioritize") return;
		requestContinuation(currentGoal);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (runtime.queueFrozen) {
			runtime.clearSettledSafetyTracking();
			return;
		}
		runtime.finalizeSettledRecovery(ctx);
		let dispatchedQueueAction = false;
		if (runtime.pendingQueueAction) {
			dispatchedQueueAction = await dispatchPendingQueueActionIfSettled(ctx);
		}
		if (!dispatchedQueueAction) dispatchContinuationIfSettled(ctx);
		runtime.clearSettledSafetyTracking();
	});

	function beginNonGoalFollowUp(ctx: StatusContext, resetSafetyEpoch: boolean) {
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		if (resetSafetyEpoch) clearBudgetWrapUp();
		const activeGoalId =
			runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
		runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? "manual" : undefined);
		if (resetSafetyEpoch && activeGoalId) runtime.resetActiveSafetyEpoch(ctx);
	}

	function hasPendingSkipForGoal(goalId: string) {
		return (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.reason === "skip" &&
			runtime.pendingQueueAction.goalId === goalId
		);
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
		runtime.setTerminalReason(
			runtime.activeGoal.id,
			assistant.errorMessage ?? `goal ${status} after agent interruption`,
		);
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

export {
	findFinalAssistantMessage,
	formatStatus,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./runtime.js";
