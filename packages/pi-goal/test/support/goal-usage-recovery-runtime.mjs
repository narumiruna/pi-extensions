import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  completionResponse,
  createHarness,
  persistedGoalHistory,
  persistedGoalState,
  persistedGoalStatus,
  providerError,
  waitFor,
  waitForSettlement,
} from "./goal-runtime-harness.mjs";

export async function usageLimitRecoveryScenario() {
  const error = "Codex error: The usage limit has been reached";
  const original = await createHarness([providerError(error)], {}, undefined, { retryUsageLimits: true });
  try {
    await original.session.prompt("/goal recover from the reported quota error");
    await waitForSettlement(original, "initial quota waiting");
    const goal = persistedGoalState(original.session)?.goal;
    assert.equal(goal?.status, "active");
    assert.ok(goal.waiting?.usageLimit);
    assert.ok(goal.waiting.resumeAt > Date.now());
    assert.equal(original.faux.state.callCount, 1);
    assert.equal(original.sdkEvents.filter((event) => event.type === "auto_retry_start").length, 0);
  } finally {
    await original.cleanup();
  }

  // Restore an already-due persisted wait instead of shortening production timing.
  // The actual Pi loader, timer, dispatcher, request ownership, and provider loop run.
  for (const rejected of [true, false]) {
    const options = { api: `quota-smoke-${crypto.randomUUID()}`, provider: `quota-smoke-${crypto.randomUUID()}` };
    const model = createFauxCore(options).getModel();
    const id = crypto.randomUUID();
    const harness = await createHarness(
      rejected ? [providerError(error)] : [fauxAssistantMessage("Verified useful work."), completionResponse],
      options,
      (manager) => {
        const now = Date.now();
        manager.appendCustomEntry("goal-state", {
          goal: {
            id,
            text: "verify restored quota recovery",
            status: "active",
            startedAt: now,
            updatedAt: now,
            iteration: 3,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            baselineTokens: 0,
            automaticModelTurns: 7,
            toolFreeRepeatCount: 0,
            waiting: {
              reason: "Provider usage limit",
              resumeAt: now - 1,
              usageLimit: { provider: model.provider, model: model.id, api: model.api },
            },
          },
        });
      },
      { retryUsageLimits: true },
    );
    try {
      await waitForSettlement(harness, "restored quota wake");
      if (rejected) {
        const goal = persistedGoalState(harness.session)?.goal;
        assert.equal(goal?.id, id);
        assert.equal(goal.status, "active");
        assert.ok(goal.waiting?.usageLimit);
        assert.equal(goal.automaticModelTurns, 7, "quota rejection is not an automatic work response");
        assert.equal(harness.faux.state.callCount, 1);
      } else {
        await waitFor(() => persistedGoalStatus(harness.session) === null, "successful restored quota work");
        assert.equal(harness.faux.state.callCount, 2);
        assert.ok(persistedGoalHistory(harness.session).some((goal) => goal.automaticModelTurns === 8));
        assert.ok(persistedGoalHistory(harness.session).every((goal) => goal.id === id));
      }
    } finally {
      await harness.cleanup();
    }
  }
  console.log(
    "quota recovery: initial error waits; restored deadline dispatches through Pi; rejected work count=7, useful work count=8; Goal identity retained",
  );
}
