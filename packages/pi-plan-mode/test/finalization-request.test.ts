import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createFinalizationRequestCoordinator,
  FINALIZE_PLAN_PROMPT,
  RETRY_FINALIZE_PLAN_PROMPT,
} from "../src/finalization-request.js";

test("finalization request retries one normal prose-only run after settlement", () => {
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

test("finalization prompts name the structured outcomes and bound the retry", () => {
  assert.match(FINALIZE_PLAN_PROMPT, /plan_mode_question/);
  assert.match(FINALIZE_PLAN_PROMPT, /plan_mode_complete/);
  assert.match(RETRY_FINALIZE_PLAN_PROMPT, /previous finalization response/);
  assert.match(RETRY_FINALIZE_PLAN_PROMPT, /Do not respond with prose/);
});
