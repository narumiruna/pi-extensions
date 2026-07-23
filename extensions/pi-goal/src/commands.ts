import { currentTokenTotal } from "./accounting.js";
import { validateObjective } from "./command.js";
import type { ActiveGoal } from "./persistence.js";
import { buildGoalPrompt, buildObjectiveUpdatedPrompt, buildResumePrompt } from "./prompts.js";
import {
	activateQueuedGoal,
	appendGoal,
	createQueuedGoal,
	dropLastGoal as dropLastQueuedGoal,
	prioritizeGoal as prioritizeQueuedGoal,
	skipGoal as skipQueuedGoal,
} from "./queue.js";
import {
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	createGoal,
	editedGoalStatus,
	formatBudget,
	formatError,
	type GoalRuntime,
	goalSummary,
	hasPendingMessages,
	isResumableGoalStatus,
	nextGoalInstance,
	STATUS_KEY,
	type StatusContext,
	stoppedStatusLabel,
	transitionGoal,
} from "./runtime.js";

// User-command mutations are kept separate from Pi event wiring. Every controller
// receives exactly one per-factory GoalRuntime, preserving session isolation.
export class GoalCommandController {
	private readonly runtime: GoalRuntime;

	constructor(runtime: GoalRuntime) {
		this.runtime = runtime;
	}

	async startGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		onActivated?: (goal: ActiveGoal) => void,
	) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}

		const existingGoal =
			this.runtime.activeGoal?.status !== "complete" ? this.runtime.activeGoal : undefined;
		const existingQueuedGoals = [...this.runtime.queuedGoals];
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
		const goalToolVisibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot start /goal: ${formatError(error)}`, "error");
			if (existingGoal?.status === "active") this.runtime.pauseGoalForUnavailableTools(ctx);
			return;
		}

		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.queuedGoals = [];
		this.runtime.pendingQueueAction = undefined;
		this.runtime.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const startedGoal = this.runtime.activeGoal;
		onActivated?.(startedGoal);
		this.runtime.persistGoal(startedGoal);
		this.runtime.updateStatus(ctx, startedGoal);
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			startedGoal.id,
			buildGoalPrompt(startedGoal),
		);
		if (!sent) {
			let rolledBackStartedGoal = false;
			if (this.runtime.activeGoal?.id === startedGoal.id) {
				rolledBackStartedGoal = true;
				if (existingGoal) {
					this.runtime.queuedGoals = existingQueuedGoals;
					this.runtime.recordGoalUsage(existingGoal, ctx);
					if (existingGoal.status === "active") {
						abortCurrentTurn(ctx);
						this.runtime.activeGoal = transitionGoal(existingGoal, "paused");
						this.runtime.blockStaleGoalToolCalls();
					} else {
						this.runtime.activeGoal = existingGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
					}
					this.runtime.persistGoal(this.runtime.activeGoal);
					this.runtime.updateStatus(ctx, this.runtime.activeGoal);
				} else {
					this.runtime.clearActiveGoal(ctx);
				}
			}
			if (rolledBackStartedGoal) {
				this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		ctx.ui.notify(
			existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`,
			"info",
		);
	}

	async addGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		this.runtime.queuedGoals = appendGoal(
			this.runtime.queuedGoals,
			createQueuedGoal(objective, tokenBudget),
		);
		this.runtime.persistGoal(this.runtime.activeGoal);
		ctx.ui.notify(
			`Goal added at position ${this.runtime.queuedGoals.length + 1}: ${objective}`,
			"info",
		);
	}

	async prioritizeGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		this.runtime.cancelContinuationWork();
		this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
		this.runtime.persistGoal(this.runtime.activeGoal);
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) {
			ctx.ui.notify(`Priority goal queued until Pi settles: ${objective}`, "info");
			return;
		}
		await this.dispatchPendingQueueActionIfSettled(ctx);
	}

	dropLastGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("No goals to drop.", "info");
			return;
		}
		const result = dropLastQueuedGoal(currentGoal, this.runtime.queuedGoals);
		if (!result.goal) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(`Goal dropped: ${result.removed?.text ?? currentGoal.text}`, "warning");
			return;
		}
		this.runtime.queuedGoals = result.queue;
		this.runtime.persistGoal(result.goal);
		ctx.ui.notify(`Goal dropped: ${result.removed?.text ?? "unknown goal"}`, "warning");
	}

	async skipGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("No goals to skip.", "info");
			return;
		}
		if (this.runtime.queuedGoals.length === 0) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(`Goal skipped: ${currentGoal.text}. No goals remain.`, "warning");
			return;
		}
		if (currentGoal.status === "active") this.runtime.recordGoalUsage(currentGoal, ctx);
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.pendingQueueAction = {
			kind: "advance",
			goalId: currentGoal.id,
			reason: "skip",
			completedText: currentGoal.text,
		};
		this.runtime.persistGoal(currentGoal);
		ctx.ui.notify(`Goal skip queued until Pi settles: ${currentGoal.text}`, "info");
		if (ctx.isIdle?.() === true && !hasPendingMessages(ctx)) {
			await this.dispatchPendingQueueActionIfSettled(ctx);
		}
	}

	async dispatchPendingQueueActionIfSettled(ctx: StatusContext) {
		const pending = this.runtime.pendingQueueAction;
		if (!pending || this.runtime.queueFrozen) return false;
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
		if (pending.kind === "prioritize") {
			this.runtime.pendingQueueAction = undefined;
			return this.activatePrioritizedGoal(
				pending.objective,
				pending.tokenBudget,
				ctx,
				pending.displacedUsageFinalized === true,
			);
		}
		if (
			!this.runtime.activeGoal ||
			this.runtime.activeGoal.id !== pending.goalId ||
			(this.runtime.activeGoal.status !== "complete" && pending.reason === "complete")
		) {
			this.runtime.pendingQueueAction = undefined;
			if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
			return false;
		}

		const previousText = pending.completedText;
		const reason = pending.reason;
		this.runtime.pendingQueueAction = undefined;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const next = skipQueuedGoal(this.runtime.queuedGoals);
		this.runtime.queuedGoals = next.queue;
		this.runtime.activeGoal = next.goal
			? activateQueuedGoal(next.goal, currentTokenTotal(ctx))
			: undefined;
		if (!this.runtime.activeGoal) {
			this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(
				reason === "complete"
					? `Goal complete: ${previousText}. No goals remain.`
					: `Goal skipped: ${previousText}. No goals remain.`,
				"info",
			);
			return true;
		}

		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
				this.runtime.blockStaleGoalToolCalls();
			}
			ctx.ui.notify(
				`${reason === "complete" ? "Goal complete" : "Goal skipped"}: ${previousText}. Next goal remains ${this.runtime.activeGoal.status}: ${this.runtime.activeGoal.text}`,
				"info",
			);
			return true;
		}

		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			this.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
			this.runtime.blockStaleGoalToolCalls();
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			ctx.ui.notify(`Cannot start the next /goal: ${formatError(error)}`, "error");
			return false;
		}
		const activatedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			activatedGoal.id,
			buildGoalPrompt(activatedGoal),
			false, // Queue reactivation preserves its persisted safety epoch.
		);
		if (!sent && this.runtime.activeGoal?.id === activatedGoal.id) {
			this.runtime.activeGoal = transitionGoal(activatedGoal, "paused");
			this.runtime.blockStaleGoalToolCalls();
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			ctx.ui.notify(
				`Next goal paused after prompt delivery failed: ${activatedGoal.text}`,
				"warning",
			);
			return false;
		}
		ctx.ui.notify(
			`${reason === "complete" ? "Goal complete" : "Goal skipped"}: ${previousText}. Started next goal: ${activatedGoal.text}`,
			"info",
		);
		return true;
	}

	notifyFrozenQueue(ctx: StatusContext) {
		ctx.ui.notify(
			"The experimental goal queue is frozen. Re-enable experimental.goals in pi-goal.json and run /reload, or use /goal clear.",
			"warning",
		);
	}

	pauseGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal is ${this.runtime.activeGoal.status}; only active goals can be paused.`,
				"warning",
			);
			return;
		}
		this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
		this.runtime.cancelContinuationWork();
		this.runtime.clearBudgetWrapUp();
		this.runtime.blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		this.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		ctx.ui.notify(`Goal paused: ${this.runtime.activeGoal.text}`, "info");
	}

	async resumeGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (!isResumableGoalStatus(this.runtime.activeGoal.status)) {
			ctx.ui.notify(
				`Goal is ${this.runtime.activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
				"warning",
			);
			return;
		}
		if (
			this.runtime.activeGoal.tokenBudget !== undefined &&
			this.runtime.activeGoal.tokensUsed >= this.runtime.activeGoal.tokenBudget
		) {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const goalToolVisibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot resume /goal: ${formatError(error)}`, "error");
			return;
		}
		const stoppedGoal = this.runtime.activeGoal;
		const stoppedStatus = stoppedGoal.status;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.activeGoal = transitionGoal(nextGoalInstance(this.runtime.activeGoal), "active");
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const resumedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			resumedGoal.id,
			buildResumePrompt(resumedGoal, stoppedStatus),
		);
		if (!sent) {
			if (
				this.runtime.activeGoal?.id === resumedGoal.id &&
				this.runtime.activeGoal.status === "active"
			) {
				this.runtime.activeGoal = stoppedGoal;
				this.runtime.persistGoal(this.runtime.activeGoal);
				this.runtime.updateStatus(ctx, this.runtime.activeGoal);
				if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
				this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		ctx.ui.notify(
			`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`,
			"info",
		);
	}

	clearGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			this.runtime.cancelContinuationWork();
			this.runtime.clearGoalRecovery();
			this.runtime.clearBudgetWrapUp();
			this.runtime.clearStaleGoalToolCallBlock();
			this.runtime.clearPersistedGoal(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const stoppedGoal = this.runtime.activeGoal.text;
		this.runtime.clearActiveGoal(ctx);
		ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
	}

	async editGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
			return;
		}

		this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
		const previousGoal = { ...this.runtime.activeGoal };
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		const previousStatus = this.runtime.activeGoal.status;
		const rotatedGoal = nextGoalInstance(this.runtime.activeGoal);
		const nextGoal = transitionGoal(
			{
				...rotatedGoal,
				text: objective,
				tokenBudget: tokenBudget ?? this.runtime.activeGoal.tokenBudget,
			},
			editedGoalStatus(previousStatus),
		);
		const goalToolVisibilityBeforeActivation =
			nextGoal.status === "active" ? this.runtime.snapshotGoalToolVisibility() : undefined;
		if (nextGoal.status === "active") {
			try {
				this.runtime.prepareGoalToolsForActivation(ctx);
			} catch (error) {
				ctx.ui.notify(`Cannot reactivate /goal: ${formatError(error)}`, "error");
				if (this.runtime.activeGoal?.status === "active") {
					this.runtime.pauseGoalForUnavailableTools(ctx);
				}
				return;
			}
		}
		this.runtime.activeGoal = nextGoal;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const editedGoal = this.runtime.activeGoal;
		if (!editedGoal) return;
		if (editedGoal.status === "active") {
			this.runtime.clearStaleGoalToolCallBlock();
			const sent = await this.runtime.sendOwnedGoalPrompt(
				ctx,
				editedGoal.id,
				buildObjectiveUpdatedPrompt(editedGoal),
			);
			if (!sent) {
				if (this.runtime.activeGoal?.id === editedGoal.id) {
					if (previousStatus === "active") {
						abortCurrentTurn(ctx);
						this.runtime.activeGoal = transitionGoal(previousGoal, "paused");
						this.runtime.blockStaleGoalToolCalls();
					} else {
						this.runtime.activeGoal = previousGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
					}
					this.runtime.persistGoal(this.runtime.activeGoal);
					this.runtime.updateStatus(ctx, this.runtime.activeGoal);
					if (goalToolVisibilityBeforeActivation) {
						this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
					}
				}
				return;
			}
		} else if (blocksStaleGoalToolCalls(editedGoal.status)) {
			this.runtime.blockStaleGoalToolCalls();
		} else {
			this.runtime.clearStaleGoalToolCallBlock();
		}
		ctx.ui.notify(`Goal updated: ${objective}`, "info");
	}

	showGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!this.runtime.queueFrozen) {
			this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		}
		ctx.ui.notify(
			goalSummary(
				this.runtime.activeGoal,
				this.runtime.queuedGoals,
				this.runtime.settings.experimental.goals,
				this.runtime.queueFrozen,
			),
			"info",
		);
	}

	private async activatePrioritizedGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		displacedUsageFinalized = false,
	) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return true;
		}
		if (currentGoal.status === "active" && !displacedUsageFinalized) {
			this.runtime.recordGoalUsage(currentGoal, ctx);
		}
		const previousGoal = { ...currentGoal };
		const previousQueue = [...this.runtime.queuedGoals];
		const visibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot prioritize /goal: ${formatError(error)}`, "error");
			if (currentGoal.status === "complete") {
				// Completion already committed, so retain the priority intent for a
				// later /reload after the tool policy is restored.
				this.runtime.pendingQueueAction = {
					kind: "prioritize",
					objective,
					tokenBudget,
					...(displacedUsageFinalized ? { displacedUsageFinalized: true } : {}),
				};
				this.runtime.persistGoal(currentGoal);
			} else {
				// Roll back an activation that never started. An active displaced goal
				// cannot continue safely without its terminal tools, so make it resumable.
				this.runtime.pendingQueueAction = undefined;
				if (currentGoal.status === "active") {
					this.runtime.pauseGoalForUnavailableTools(ctx, true, !displacedUsageFinalized);
				} else {
					this.runtime.persistGoal(currentGoal);
				}
			}
			return false;
		}

		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const prioritized = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const next =
			currentGoal.status === "complete"
				? { goal: prioritized, queue: [...this.runtime.queuedGoals] }
				: prioritizeQueuedGoal(currentGoal, this.runtime.queuedGoals, prioritized);
		this.runtime.activeGoal = next.goal;
		this.runtime.queuedGoals = next.queue;
		this.runtime.pendingQueueAction = undefined;
		if (!this.runtime.activeGoal) return false;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			this.runtime.activeGoal.id,
			buildGoalPrompt(this.runtime.activeGoal),
		);
		if (!sent && this.runtime.activeGoal.id === prioritized.id) {
			this.runtime.queuedGoals = previousQueue;
			if (previousGoal.status === "active") {
				abortCurrentTurn(ctx);
				this.runtime.activeGoal = transitionGoal(previousGoal, "paused");
				this.runtime.blockStaleGoalToolCalls();
			} else {
				this.runtime.activeGoal = previousGoal;
				if (previousGoal.status === "complete") {
					this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
				} else if (blocksStaleGoalToolCalls(previousGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
			}
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			this.runtime.restoreGoalToolVisibility(visibilityBeforeActivation);
			return false;
		}
		ctx.ui.notify(`Goal prioritized: ${objective}`, "info");
		return true;
	}
}
