import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";

function runtime() {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const state = new GoalRuntime(mock.pi);
  state.bindWorkflowSession({});
  assert.equal(state.acquireWorkflow(), true);
  return { mock, state };
}

test("stopped transition owner applies explicit-pause invariants once", () => {
  const { mock, state } = runtime();
  const goal = createGoal("pause safely", undefined, 0);
  state.activeGoal = goal;
  state.requestContinuation(goal);
  state.budgetWrapUp = { goalId: goal.id, delivered: true };
  state.goalRecovery = {
    goalId: goal.id,
    kind: "provider_retry",
    automaticOwner: true,
  };
  state.beginAgentRun(goal.id, "manual");
  let aborts = 0;
  const context = createMockContext({ abort: () => aborts++ });

  const stopped = state.stopActiveGoal(context.ctx, {
    kind: "explicit_pause",
    expectedGoalId: goal.id,
  });

  assert.equal(stopped?.status, "paused");
  assert.equal(state.activeGoal?.id, goal.id);
  assert.equal(state.continuationIntent, undefined);
  assert.equal(state.budgetWrapUp, undefined);
  assert.equal(state.goalRecovery, undefined);
  assert.equal(state.staleGoalToolCallsBlocked, true);
  assert.equal(aborts, 1);
  assert.equal(mock.entries.at(-1)?.customType, "goal-state");
  assert.equal(context.statuses.get("goal")?.startsWith("paused"), true);
});

test("stopped transition owner rejects stale goal ownership without side effects", () => {
  const { mock, state } = runtime();
  const goal = createGoal("current", undefined, 0);
  state.activeGoal = goal;
  state.requestContinuation(goal);
  const context = createMockContext();

  const stopped = state.stopActiveGoal(context.ctx, {
    kind: "explicit_pause",
    expectedGoalId: "stale-goal-id",
  });

  assert.equal(stopped, undefined);
  assert.equal(state.activeGoal, goal);
  assert.equal(state.continuationIntent?.goalId, goal.id);
  assert.equal(state.staleGoalToolCallsBlocked, false);
  assert.equal(mock.entries.length, 0);
});

test("activation rollback stops the restored goal only while the failed activation owns state", () => {
  const { state } = runtime();
  const previous = createGoal("previous", undefined, 0);
  const failed = createGoal("failed activation", undefined, 0);
  state.activeGoal = failed;
  const context = createMockContext();

  const stopped = state.stopActiveGoal(context.ctx, {
    kind: "activation_rollback",
    expectedGoalId: failed.id,
    restoreGoal: previous,
    abortTurn: true,
  });

  assert.equal(stopped?.id, previous.id);
  assert.equal(stopped?.status, "paused");
  assert.equal(state.staleGoalToolCallsBlocked, true);
});
