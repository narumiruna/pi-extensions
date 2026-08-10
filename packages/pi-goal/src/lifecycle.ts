import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentTokenTotal } from "./accounting.js";
import type { GoalCommandController } from "./commands.js";
import { notifyTerminal } from "./errors.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import { buildGoalPrompt, buildGoalSystemPrompt } from "./prompts.js";
import { activateQueuedGoal } from "./queue.js";
import type { GoalRunController } from "./run-protocol.js";
import {
	type AssistantMessageLike,
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	findFinalAssistantMessage,
	formatError,
	type GoalRuntime,
	incrementGoal,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	resetGoalSafetyEpoch,
	STATUS_KEY,
	type StatusContext,
	truncateNotification,
} from "./runtime.js";
import { hasAssistantToolCall } from "./safety.js";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "./settings.js";

const EXPERIMENTAL_GOALS_WARNING =
	"Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";

interface GoalLifecycleOptions {
	settingsPath?: string;
}

export function registerGoalLifecycle(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	commands: GoalCommandController,
	runController: GoalRunController,
	options: GoalLifecycleOptions = {},
) {
	pi.on("session_start", async (_event, ctx) => {
		runtime.replaceMenuSession();
		runtime.clearCompletionStatusTimer();
		runtime.clearContinuationTracking();
		runtime.clearGoalWaitTimer();
		runtime.clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		runtime.queueFreezeAwaitingSettle = false;
		runtime.clearTerminalDetails();
		const previousToolVisibility = runtime.settings.toolVisibility;
		const settingsResult = readGoalSettings(options.settingsPath);
		runtime.settings =
			settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
		runtime.settingsLoadIssue = settingsResult.kind === "invalid" ? settingsResult : undefined;
		if (settingsResult.kind === "invalid") {
			notifyTerminal(
				ctx.ui,
				`pi-goal settings ignored: ${settingsResult.reason}. Using default settings.`,
				"warning",
			);
		}
		if (runtime.settings.experimental.goals) {
			notifyTerminal(ctx.ui, EXPERIMENTAL_GOALS_WARNING, "warning");
		}
		try {
			runtime.toolPolicy.prepareSessionStart(
				runtime.settings.toolVisibility,
				previousToolVisibility,
			);
		} catch (error) {
			notifyTerminal(
				ctx.ui,
				`Could not restore always-visible goal tools: ${formatError(error)}`,
				"error",
			);
		}

		const loaded = loadGoalStateFromSession(ctx);
		runtime.activeGoal = loaded.goal;
		runtime.queuedGoals = loaded.queue;
		runtime.pendingQueueAction = loaded.pendingAction;
		runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
		runController.bindSession(ctx);
		if (runtime.queueFrozen) {
			if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
			ctx.ui.setStatus(STATUS_KEY, "queue off");
			notifyTerminal(
				ctx.ui,
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
		if (runtime.pendingQueueAction) await commands.dispatchPendingQueueActionIfSettled(ctx);
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active" && runtime.activeGoal.safetyResetPending) {
				// Resume/edit activation is persisted before its queued prompt starts. A
				// reload must commit that promised reset before enforcing the old limits.
				runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			}
			if (runtime.activeGoal.status === "active") {
				runtime.recordGoalUsage(runtime.activeGoal, ctx);
				if (runtime.limitActiveGoalForBudget(ctx, false)) return;
				if (runtime.enforceAutomaticTurnLimit(ctx, false) || runtime.enforceNoProgressLimit(ctx))
					return;
			}
			// On lazy restore, an earlier restrictive session-start policy still wins:
			// reconciliation unlocks ownership without widening the active tool set.
			runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, true);
			if (runtime.activeGoal.status === "active" && !runtime.toolPolicy.toolsAvailable()) {
				runtime.pauseGoalForUnavailableTools(ctx, false);
				return;
			}
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			runtime.restoreGoalWaitTimer(ctx);
			if (startRestoredQueuedGoal) {
				const restoredGoal = runtime.activeGoal;
				const sent = await runtime.sendOwnedGoalPrompt(
					ctx,
					restoredGoal.id,
					buildGoalPrompt(restoredGoal),
					false, // Reloaded queue activation preserves its persisted safety epoch.
				);
				if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
					runtime.stopActiveGoal(ctx, {
						kind: "activation_rollback",
						expectedGoalId: restoredGoal.id,
						restoreGoal: restoredGoal,
						abortTurn: false,
					});
				}
			}
		} else {
			runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, false);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		runController.unbindSession();
		runtime.closeMenuSession();
		runtime.clearGoalWaitTimer();
		if (runtime.activeGoal) {
			if (!runtime.queueFrozen && runtime.activeGoal.status === "active") {
				runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
			}
			runtime.persistGoal(runtime.activeGoal);
		}
		runtime.clearContinuationTracking();
		runtime.clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		runtime.queueFreezeAwaitingSettle = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		runtime.clearCompletionStatusTimer();
		runtime.clearTerminalDetails();
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status === "budget_limited") {
			if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
		runtime.cancelContinuationWork();
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);
		if (runtime.pendingQueueAction) return;
		if (runtime.limitActiveGoalForBudget(ctx, false)) return { cancel: true as const };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status !== "active") {
			runtime.clearGoalRecovery();
			if (runtime.pendingQueueAction) await commands.dispatchPendingQueueActionIfSettled(ctx);
			return;
		}

		const restoredState = loadGoalStateFromSession(ctx);
		if (restoredState.goal?.id === runtime.activeGoal.id) {
			runtime.activeGoal = restoredState.goal;
			runtime.queuedGoals = restoredState.queue;
			runtime.pendingQueueAction = restoredState.pendingAction;
		}
		const usageRecorded = runtime.recordGoalUsage(runtime.activeGoal, ctx);
		if (usageRecorded) {
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
		}
		if (runtime.pendingQueueAction) {
			await commands.dispatchPendingQueueActionIfSettled(ctx);
			return;
		}
		if (!usageRecorded) return;
		if (runtime.limitActiveGoalForBudget(ctx, false)) return;

		const wasPiRetry = runtime.isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		if (wasPiRetry) return;
		runtime.clearGoalRecoveryForGoal(runtime.activeGoal.id);
		runtime.requestContinuation(runtime.activeGoal);
		// Pi emits session_compact before it clears its manual-compaction controller,
		// so sendUserMessage still rejects inside this hook even when ctx reports idle.
		// The owned timer defers one task at the default 0 ms or waits the configured interval.
		// Threshold compaction retains the intent for agent_settled when Pi is still busy.
		runtime.scheduleContinuationDispatch(ctx, runtime.activeGoal.id, { deferImmediate: true });
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			if (
				runtime.consumeCancelledGoalPrompt(event.text) ||
				runtime.consumeCancelledContinuationPrompt(event.text) ||
				runtime.consumeStaleOwnedGoalPrompt(event.text)
			) {
				return { action: "handled" as const };
			}
			if (runtime.queueFrozen) return;
			// Streaming input is queued before its model work starts. Keep owned
			// markers pending for message_start, and track non-goal delivery mode so a
			// steer cannot consume a later follow-up's cleanup protection.
			if (runtime.acceptOwnedInputBoundary(event.text)) return;
			runtime.supersedeOwnedInputCollision(event.text);
			if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
			if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
				runtime.noteQueuedNonGoalInput(event.text, event.streamingBehavior);
			}
			runtime.clearGoalRecovery();
			return;
		}
		if (runtime.queueFrozen) return;
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
		if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
		if (event.streamingBehavior === "followUp") {
			runtime.noteQueuedNonGoalInput(event.text, "followUp", true);
			return;
		}
		if (event.streamingBehavior === "steer") {
			runtime.noteQueuedNonGoalInput(event.text, "steer");
		}
		runtime.clearGoalRecovery();
		runtime.clearBudgetWrapUp();
		runtime.clearStaleGoalToolCallBlock();
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
			if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
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
		const ownedPrompt = runtime.consumeOwnedGoalPrompt(prompt);
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
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);
	});

	pi.on("context", (event, ctx) => {
		const messages = event.messages.filter((message) => runtime.keepBudgetWrapUpMessage(message));
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
			if (!runtime.toolPolicy.isGoalToolName(event.toolName)) return;
			// Blocking alone feeds an error tool result back to the model. Abort too so
			// stale Goal calls cannot loop while the experimental queue remains frozen.
			abortCurrentTurn(ctx);
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
			runtime.clearStaleGoalToolCallBlock();
			return;
		}
		// A blocked tool result would normally trigger another model call. Abort the
		// current turn so a tool-seeking model cannot create an unbounded loop that
		// burns provider quota while the goal is stopped.
		abortCurrentTurn(ctx);
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
			runtime.queueBudgetWrapUp(ctx, runtime.activeGoal);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);
		if (runtime.limitActiveGoalForBudget(ctx, true)) return;
		if (!runtime.toolPolicy.toolsAvailable()) runtime.pauseGoalForUnavailableTools(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		runtime.clearAgentRun();
		if (runtime.queueFrozen) return;
		// Pi-owned retries emit agent_start directly. Reaching a normal prompt
		// boundary means cleanup no longer owns the next run, so the hard-cap guard
		// must not abort it.
		if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
		const goalPrompt = runtime.consumeOwnedGoalPrompt(event.prompt);
		const goalPromptGoalId = goalPrompt?.goalId;
		const continuationGoalId = goalPromptGoalId
			? undefined
			: runtime.markContinuationStarted(event.prompt);
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
		if (!ownedPromptGoalId && !ownedPromptBoundary) {
			runtime.supersedeOwnedInputCollision(event.prompt);
			if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
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
					runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
				}
				runtime.pendingQueueAction.displacedUsageFinalized = true;
				if (runtime.activeGoal) {
					runtime.persistGoal(runtime.activeGoal);
					runtime.updateStatus(ctx, runtime.activeGoal);
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
			if (runtime.activeGoal?.status === "active" && !runtime.toolPolicy.toolsAvailable()) {
				runtime.pauseGoalForUnavailableTools(ctx, false);
			}
			abortCurrentTurn(ctx);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
		if (!runtime.toolPolicy.toolsAvailable()) {
			runtime.pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
			return;
		}
		if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
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
				runtime.clearStaleGoalToolCallBlock();
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
		runtime.recordAutomaticTurn(ctx, event.message);
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
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			runtime.clearBudgetWrapUp();
			return;
		}
		if (runtime.activeGoal.status !== "active") return;
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal.id
		) {
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);
			runtime.updateStatus(ctx, runtime.activeGoal);
			return;
		}

		const goalId = runtime.activeGoal.id;
		const alreadyAwaitingContinuation = runtime.hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(event.messages);

		if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
		runtime.recordGoalUsage(runtime.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted") {
			runtime.clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (run.origin === "automatic" && runtime.enforceAutomaticTurnLimit(ctx, true)) return;
				if (runtime.limitActiveGoalForBudget(ctx, false)) return;
				if (!runtime.toolPolicy.toolsAvailable()) {
					runtime.pauseGoalForUnavailableTools(ctx);
					return;
				}
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
					automaticOwner: run.origin === "automatic",
					errorMessage: finalAssistant.errorMessage,
				};
				runtime.cancelContinuationWork();
				runtime.persistGoal(runtime.activeGoal);
				runtime.updateStatus(ctx, runtime.activeGoal);
				return;
			}
			runtime.clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(
				ctx,
				runtime.activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		runtime.clearGoalRecoveryForGoal(goalId);

		if (runtime.limitActiveGoalForBudget(ctx, false)) return;
		if (!runtime.toolPolicy.toolsAvailable()) {
			runtime.pauseGoalForUnavailableTools(ctx);
			return;
		}
		if (
			run.origin === "automatic" &&
			runtime.recordAutomaticRunProgress(
				ctx,
				goalId,
				event.messages,
				run.toolAttempted || hasAssistantToolCall(event.messages),
			)
		) {
			return;
		}

		runtime.persistGoal(runtime.activeGoal);
		runtime.updateStatus(ctx, runtime.activeGoal);

		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (runtime.pendingQueueAction?.kind === "prioritize") return;
		runtime.requestContinuation(currentGoal);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (runtime.queueFrozen) {
			runtime.clearSettledSafetyTracking();
			runtime.queueFreezeAwaitingSettle = false;
			if (runtime.settings.experimental.goals) {
				await commands.resumeQueueAfterUnfreeze(ctx);
			}
			return;
		}
		runtime.finalizeSettledRecovery(ctx);
		let dispatchedQueueAction = false;
		if (runtime.pendingQueueAction) {
			dispatchedQueueAction = await commands.dispatchPendingQueueActionIfSettled(ctx);
		}
		if (!dispatchedQueueAction) {
			const resumedWait = runtime.dispatchDueGoalWait(ctx);
			if (!resumedWait && runtime.continuationIntent) {
				runtime.scheduleContinuationDispatch(ctx, runtime.continuationIntent.goalId);
			}
		}
		runtime.clearSettledSafetyTracking();
	});

	function beginNonGoalFollowUp(ctx: StatusContext, resetSafetyEpoch: boolean) {
		runtime.clearGoalRecovery();
		runtime.clearStaleGoalToolCallBlock();
		if (resetSafetyEpoch) runtime.clearBudgetWrapUp();
		const activeGoalId =
			runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
		runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? "manual" : undefined);
		if (resetSafetyEpoch && activeGoalId) runtime.resetActiveSafetyEpoch(ctx);
	}

	function stopGoalAfterAgentEnd(
		ctx: StatusContext,
		goal: ActiveGoal,
		assistant: AssistantMessageLike,
		status: "paused" | "blocked" | "usage_limited",
	) {
		const stoppedGoal = runtime.stopActiveGoal(ctx, {
			kind: "agent_interruption",
			expectedGoalId: goal.id,
			status,
			reason: assistant.errorMessage ?? `goal ${status} after agent interruption`,
		});
		if (!stoppedGoal) return;

		const details = assistant.errorMessage
			? ` (${truncateNotification(assistant.errorMessage)})`
			: "";
		if (status === "paused") {
			notifyTerminal(
				ctx.ui,
				`Goal paused after interruption${details}. Run /goal resume to continue.`,
				"warning",
			);
			return;
		}
		if (status === "usage_limited") {
			notifyTerminal(
				ctx.ui,
				`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
				"warning",
			);
			return;
		}
		notifyTerminal(
			ctx.ui,
			`Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
			"warning",
		);
	}
}
