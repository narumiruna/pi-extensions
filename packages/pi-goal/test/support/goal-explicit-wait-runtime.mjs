import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  assertActiveGoalContract,
  assertNativeRetries,
  completionResponse,
  continuationMessages,
  createHarness,
  goalIdFromContext,
  persistedGoalHistory,
  persistedGoalState,
  persistedGoalStatus,
  providerError,
  waitForSettlement,
} from "./goal-runtime-harness.mjs";

// Pi continues a parallel batch unless every finalized result terminates it.
// This exercises a real later assistant error after goal_wait was accepted.
export async function explicitWaitErrorScenario() {
  for (const errorMessage of ["Invalid request", "HTTP 503: temporary failure"]) {
    const reason = "Wait for the arranged external review";
    const harness = await createHarness([
      (context) =>
        fauxAssistantMessage([
          fauxToolCall("goal_wait", {
            goal_id: goalIdFromContext(context),
            reason,
            resume_after_ms: 60_000,
          }),
          fauxToolCall("budget_probe", {}),
        ]),
      providerError(errorMessage),
      completionResponse,
    ]);
    try {
      await harness.session.prompt("/goal preserve an accepted wait after a parallel tool batch");
      await waitForSettlement(harness, "explicit wait followed by assistant error");
      const goal = persistedGoalState(harness.session)?.goal;
      assert.equal(goal?.status, "active");
      assert.equal(goal.waiting?.reason, reason);
      assert.ok(goal.waiting.resumeAt > Date.now(), "the original deadline must remain armed");
      const accepted = persistedGoalHistory(harness.session).find((entry) => entry.waiting?.reason === reason);
      assert.deepEqual(goal.waiting, accepted?.waiting);
      assert.equal(harness.faux.state.callCount, 2);
      assert.equal(harness.faux.getPendingResponseCount(), 1);
      assert.equal(continuationMessages(harness.session).length, 0);
      assertNativeRetries(harness, [], false);
      assertActiveGoalContract(harness.session, goal.id);
      assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 1);
      await harness.session.prompt("The external review is complete; finish the same Goal.");
      await harness.session.waitForIdle();
      assert.equal(harness.faux.state.callCount, 3);
      assert.equal(persistedGoalStatus(harness.session), null);
      assert.deepEqual(new Set(persistedGoalHistory(harness.session).map((entry) => entry.id)), new Set([goal.id]));
      assert.deepEqual(
        harness.sdkEvents.filter((event) => event.type === "agent_settled").map((event) => event.providerCalls),
        [2, 3],
      );
    } finally {
      await harness.cleanup();
    }
  }
  console.log("parallel explicit waits: original deadline retained after error; requests=2 then 3 on same-ID wake");
}
