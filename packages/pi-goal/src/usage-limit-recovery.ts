import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyTerminal, truncateNotification } from "./errors.js";
import type { GoalRuntime, StatusContext } from "./runtime.js";
import { readUsageReset } from "./usage-reset.js";
import { type GoalWait, MIN_GOAL_WAIT_DELAY_MS, type UsageLimitScope } from "./wait.js";

export const USAGE_LIMIT_RETRY_MS = 15 * 60 * 1000;

/** Owns optional quota reads, not a second continuation loop. */
export class UsageLimitRecovery {
  private query?: { controller: AbortController; waiting: GoalWait };

  private readonly runtime: GoalRuntime;

  constructor(runtime: GoalRuntime) {
    this.runtime = runtime;
  }

  cancel() {
    const query = this.query;
    this.query = undefined;
    query?.controller.abort();
  }

  enter(ctx: StatusContext, errorMessage: string | undefined, origin?: UsageLimitScope) {
    const runtime = this.runtime;
    const goal = runtime.activeGoal;
    if (!goal || !runtime.settings.retryUsageLimits || !runtime.ownsWorkflow(goal)) return false;
    if (origin && !sameUsageLimitScope(origin, usageLimitScope(ctx))) {
      this.stop(ctx, "model changed before usage-limit settlement");
      return true;
    }
    if (
      runtime.enforceAutomaticTurnLimit(ctx, false) ||
      runtime.enforceNoProgressLimit(ctx) ||
      runtime.limitActiveGoalForBudget(ctx, false)
    )
      return true;
    if (!runtime.goalToolsAvailable()) return runtime.pauseGoalForUnavailableTools(ctx, false);
    const waiting: GoalWait = {
      reason: `Provider usage limit${errorMessage ? `: ${truncateNotification(errorMessage)}` : ""}`,
      resumeAt: Date.now() + USAGE_LIMIT_RETRY_MS,
      usageLimit: usageLimitScope(ctx),
    };
    const entered = runtime.enterGoalWait(ctx, goal.id, waiting);
    if (entered?.id !== goal.id || entered.waiting !== waiting || !runtime.ownsWorkflow(entered)) return true;
    notifyTerminal(
      ctx.ui,
      "Goal waiting after provider usage limit. Automatic recovery uses a reset hint when available, otherwise retries in 15 minutes. Pause or clear the Goal to stop recovery.",
      "warning",
    );
    if (runtime.activeGoal?.waiting === waiting && runtime.ownsWorkflow()) this.refreshHint(ctx, goal.id, waiting);
    return true;
  }

  stopIfDisabled(ctx: StatusContext) {
    if (!this.scope() || this.runtime.settings.retryUsageLimits) return false;
    this.stop(ctx, "automatic usage-limit recovery disabled");
    return true;
  }

  modelChanged(ctx: StatusContext) {
    const scope = this.scope();
    if (!scope || sameUsageLimitScope(scope, usageLimitScope(ctx))) return;
    this.stop(ctx, "model changed during usage-limit recovery");
  }

  matches(ctx: StatusContext, waiting: GoalWait) {
    return !waiting.usageLimit || sameUsageLimitScope(waiting.usageLimit, usageLimitScope(ctx));
  }

  private scope() {
    const runtime = this.runtime;
    return (
      runtime.activeGoal?.waiting?.usageLimit ??
      runtime.continuationIntent?.usageLimitRetry ??
      runtime.continuationDelivery?.usageLimitRetry ??
      runtime.agentRunUsageLimitRetry ??
      (runtime.goalRecovery?.goalId === runtime.activeGoal?.id ? runtime.goalRecovery?.usageLimitScope : undefined)
    );
  }

  private stop(ctx: StatusContext, reason: string) {
    const runtime = this.runtime;
    const goal = runtime.activeGoal;
    if (!goal || !runtime.ownsWorkflow(goal)) return;
    runtime.stopActiveGoal(ctx, {
      kind: runtime.agentRunGoalId === goal.id ? "agent_interruption" : "recovery_ended",
      expectedGoalId: goal.id,
      status: "usage_limited",
      reason,
    });
  }

  private refreshHint(ctx: StatusContext, goalId: string, waiting: GoalWait) {
    const session = ctx.sessionManager as { getSessionId?: unknown } | undefined;
    if (!ctx.model || typeof session?.getSessionId !== "function") return;
    const generation = this.runtime.menuGeneration;
    const query = { controller: new AbortController(), waiting };
    this.query = query;
    const current = () =>
      this.query === query &&
      !query.controller.signal.aborted &&
      generation === this.runtime.menuGeneration &&
      this.runtime.settings.retryUsageLimits &&
      this.runtime.activeGoal?.id === goalId &&
      this.runtime.activeGoal.waiting === waiting &&
      this.runtime.ownsWorkflow() &&
      this.matches(ctx, waiting);
    void readUsageReset(
      this.runtime.pi,
      ctx as Pick<ExtensionContext, "sessionManager" | "model">,
      query.controller.signal,
    )
      .then((resetAt) => {
        if (!current()) return;
        this.query = undefined;
        query.controller.abort();
        if (resetAt === undefined) return;
        const goal = this.runtime.activeGoal;
        if (!goal || goal.id !== goalId || goal.waiting !== waiting) return;
        const nextWait = { ...waiting, resumeAt: Math.max(Date.now() + MIN_GOAL_WAIT_DELAY_MS, resetAt) };
        const hintedGoal = { ...goal, waiting: nextWait, updatedAt: Date.now() };
        this.runtime.activeGoal = hintedGoal;
        try {
          this.runtime.persistGoal(hintedGoal);
        } catch {
          if (this.runtime.activeGoal !== hintedGoal || !this.runtime.ownsWorkflow()) return;
          this.runtime.activeGoal = goal;
          try {
            this.runtime.persistGoal(goal);
          } catch {
            // Keep the original in-memory deadline even if storage remains unavailable.
          }
          if (this.runtime.activeGoal === goal && this.runtime.ownsWorkflow()) this.runtime.restoreGoalWaitTimer(ctx);
          return;
        }
        if (
          this.runtime.activeGoal === hintedGoal &&
          this.runtime.ownsWorkflow() &&
          generation === this.runtime.menuGeneration
        )
          this.runtime.restoreGoalWaitTimer(ctx);
      })
      .catch(() => {
        // A stale context, provider failure, or failed publication leaves the
        // persisted fallback in place; no exception escapes an owned task.
      })
      .finally(() => {
        if (this.query === query) this.query = undefined;
        query.controller.abort();
      });
  }
}

export function usageLimitScope(ctx: Pick<StatusContext, "model">): UsageLimitScope {
  return { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", api: ctx.model?.api ?? "" };
}

function sameUsageLimitScope(left: UsageLimitScope, right: UsageLimitScope) {
  return left.provider === right.provider && left.model === right.model && left.api === right.api;
}
