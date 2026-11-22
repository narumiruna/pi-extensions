import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createFinalizationRequestCoordinator,
  DISCUSSION_FINALIZE_PLAN_PROMPT,
  FINALIZE_PLAN_PROMPT,
  isFinalizePlanPrompt,
  RETRY_FINALIZE_PLAN_PROMPT,
} from "../src/finalization-request.js";

test("finalization retries one normal run that does not ask or complete", () => {
  const coordinator = createFinalizationRequestCoordinator();
  coordinator.request(7);
  coordinator.observeRunEnd(7, "normal");

  assert.equal(coordinator.settle(7), "retry");
  assert.equal(coordinator.hasPendingRequest(), true);

  coordinator.observeRunEnd(7, "normal");
  assert.equal(coordinator.settle(7), "failed");
  assert.equal(coordinator.hasPendingRequest(), false);
  assert.equal(coordinator.settle(7), undefined);
});

test("finalization request ignores duplicate run ends before settlement", () => {
  const coordinator = createFinalizationRequestCoordinator();
  coordinator.request(3);
  coordinator.observeRunEnd(3, "normal");
  coordinator.observeRunEnd(3, "normal");

  assert.equal(coordinator.settle(3), "retry");
  assert.equal(coordinator.settle(3), undefined);
});

test("finalization request clears on success, cancellation, error, reset, and generation change", () => {
  for (const outcome of ["cancelled", "error"] as const) {
    const coordinator = createFinalizationRequestCoordinator();
    coordinator.request(1);
    coordinator.observeRunEnd(1, outcome);
    assert.equal(coordinator.hasPendingRequest(), false);
    assert.equal(coordinator.settle(1), undefined);
  }

  const satisfied = createFinalizationRequestCoordinator();
  satisfied.request(1);
  satisfied.satisfy();
  assert.equal(satisfied.hasPendingRequest(), false);

  const reset = createFinalizationRequestCoordinator();
  reset.request(1);
  reset.reset();
  assert.equal(reset.hasPendingRequest(), false);

  const stale = createFinalizationRequestCoordinator();
  stale.request(1);
  stale.observeRunEnd(2, "normal");
  assert.equal(stale.settle(2), undefined);
  assert.equal(stale.hasPendingRequest(), true);
});

test("finalization and retry prompts separate saving from completion and preserve interaction mode", () => {
  for (const prompt of [FINALIZE_PLAN_PROMPT, DISCUSSION_FINALIZE_PLAN_PROMPT, RETRY_FINALIZE_PLAN_PROMPT]) {
    assert.match(
      prompt,
      /If the draft is missing or changed, save the full Markdown with plan_mode_update\(\{ plan \}\) first and wait for it to succeed/u,
    );
    assert.match(prompt, /Then call plan_mode_complete\(\{\}\) as the only tool call in a separate assistant message/u);
    assert.match(prompt, /Updating alone does not finish this request/u);
  }
  assert.match(FINALIZE_PLAN_PROMPT, /If any material decision remains, use plan_mode_question instead/u);
  assert.match(DISCUSSION_FINALIZE_PLAN_PROMPT, /ask one concise plain-text question instead/u);
  assert.doesNotMatch(DISCUSSION_FINALIZE_PLAN_PROMPT, /plan_mode_question/u);
  assert.match(RETRY_FINALIZE_PLAN_PROMPT, /previous finalization response/u);
  assert.match(RETRY_FINALIZE_PLAN_PROMPT, /Do not respond with prose/u);
});

test("queued questionnaire finalization recognizes only the exact old and new initial prompts", () => {
  const legacy =
    "Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.";
  for (const prompt of [legacy, FINALIZE_PLAN_PROMPT]) {
    assert.equal(isFinalizePlanPrompt(prompt), true);
    assert.equal(isFinalizePlanPrompt(`\n${prompt}  `), true);
    assert.equal(isFinalizePlanPrompt(`${prompt} Something else.`), false);
  }
  assert.equal(isFinalizePlanPrompt(DISCUSSION_FINALIZE_PLAN_PROMPT), false);
  assert.equal(isFinalizePlanPrompt(RETRY_FINALIZE_PLAN_PROMPT), false);
});
