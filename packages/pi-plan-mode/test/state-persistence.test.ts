import assert from "node:assert/strict";
import { test } from "vitest";
import { type PlanModeState, restorePlanModeState } from "../src/state.js";
import { createPlanModeStatePersistence } from "../src/state-persistence.js";

const TYPE = "plan-mode-state";
const INACTIVE: PlanModeState = { enabled: false, awaitingAction: false };
const PLAN = "# Plan\n\n1. Verify persistence.";

function fixture(retainFailedAppend = false) {
  const branch: unknown[] = [];
  const entries: PlanModeState[] = [];
  let fail = false;
  const persistence = createPlanModeStatePersistence(TYPE, (state) => {
    if (fail && !retainFailedAppend) throw new Error("append failed");
    branch.push({ type: "custom", customType: TYPE, data: state });
    if (fail) throw new Error("append failed");
    entries.push(state);
  });
  return { branch, entries, persistence, setFail: (value: boolean) => (fail = value) };
}

test("absent and restored inactive state need no append", () => {
  const f = fixture();
  f.persistence.persist(INACTIVE, f.branch);
  f.persistence.restore(restorePlanModeState([{ type: "custom", customType: TYPE, data: INACTIVE }], TYPE));
  f.persistence.persist({ awaitingAction: false, enabled: false, latestPlan: undefined }, f.branch);
  assert.deepEqual(f.entries, []);
});

const changes: Partial<PlanModeState>[] = [
  { enabled: true },
  { interactionMode: "discussion" },
  { interactionRestorations: [{ version: 1, mode: "questions", boundary: { length: 0, hash: "0".repeat(64) } }] },
  { latestPlan: PLAN },
  { latestPlanSource: "plan_mode_complete" },
  { awaitingAction: true },
  { savedPlan: { plan: PLAN, source: "plan_mode_complete" } },
  { activeImplementation: { id: "implementation", plan: PLAN, source: "plan_mode_complete", startedAt: 1 } },
  { pendingImplementationRuntime: { version: 1, thinkingLevel: "high" } },
  { selectedToolNames: ["read"] },
  { selectedToolKeys: ["read-key"] },
  { workflowToolPolicy: { kind: "automatic", allowedNames: ["read"], resolved: true } },
  { previousThinkingLevel: "low" },
  { appliedThinkingLevel: "medium" },
  { manualThinkingLevel: "high" },
];

for (const change of changes) {
  test(`persists a change to ${Object.keys(change)[0]} exactly once`, () => {
    const f = fixture();
    const state = { ...INACTIVE, ...change };
    f.persistence.persist(state, f.branch);
    f.persistence.persist(state, f.branch);
    assert.deepEqual(f.entries, [state]);
  });
}

test("JSON equality ignores object key order and omitted undefined fields", () => {
  const f = fixture();
  f.persistence.restore({
    ...INACTIVE,
    pendingImplementationRuntime: { version: 1, model: { provider: "provider", modelId: "model" } },
  });
  f.persistence.persist(
    {
      awaitingAction: false,
      enabled: false,
      latestPlan: undefined,
      pendingImplementationRuntime: { model: { modelId: "model", provider: "provider" }, version: 1 },
    },
    f.branch,
  );
  assert.deepEqual(f.entries, []);
});

test("runtime mutation cannot change append payloads or the comparison baseline", () => {
  const f = fixture();
  const state: PlanModeState = { ...INACTIVE, selectedToolNames: ["read"] };
  f.persistence.persist(state, f.branch);
  state.selectedToolNames?.push("bash");
  assert.deepEqual(f.entries[0]?.selectedToolNames, ["read"]);
  f.persistence.persist(state, f.branch);
  assert.equal(f.entries.length, 2);
  f.entries[1]?.selectedToolNames?.push("external-mutation");
  f.persistence.persist(state, f.branch);
  assert.equal(f.entries.length, 2);
});

test("restore detaches its baseline and resets it for another branch", () => {
  const f = fixture();
  const restored: PlanModeState = { ...INACTIVE, selectedToolNames: ["read"] };
  f.persistence.restore(restored);
  restored.selectedToolNames?.push("bash");
  f.persistence.persist(restored, f.branch);
  assert.equal(f.entries.length, 1);
  f.persistence.restore(INACTIVE);
  f.persistence.persist(INACTIVE, []);
  assert.equal(f.entries.length, 1);
  f.persistence.persist(restored, []);
  assert.equal(f.entries.length, 2);
});

for (const retainFailedAppend of [false, true]) {
  test(`failed append permits retry and rollback (retained in memory: ${retainFailedAppend})`, () => {
    const f = fixture(retainFailedAppend);
    f.persistence.persist({ ...INACTIVE, enabled: true }, f.branch);
    f.setFail(true);
    assert.throws(() => f.persistence.persist(INACTIVE, f.branch), /append failed/u);
    f.setFail(false);
    f.persistence.persist({ ...INACTIVE, enabled: true }, f.branch);
    f.persistence.persist({ ...INACTIVE, enabled: true }, f.branch);
    assert.equal(f.entries.length, 2, "one repair append after uncertain persistence");
    assert.equal(restorePlanModeState(f.branch, TYPE).enabled, true);
    f.persistence.persist(INACTIVE, f.branch);
    assert.deepEqual(f.entries.at(-1), INACTIVE);
  });
}

test("a repeated no-plan state remains a barrier to trailing completion recovery", () => {
  const f = fixture();
  const state = { enabled: true, awaitingAction: false };
  f.persistence.persist(state, f.branch);
  f.branch.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "plan_mode_complete",
      details: { version: 1, source: "plan_mode_complete", plan: PLAN },
    },
  });
  assert.equal(restorePlanModeState(f.branch, TYPE).latestPlan, PLAN);
  f.persistence.persist(state, f.branch);
  assert.equal(restorePlanModeState(f.branch, TYPE).latestPlan, undefined);
  f.persistence.persist(state, f.branch);
  assert.equal(f.entries.length, 2);
});

test("restored completion details need no redundant state entry", () => {
  const f = fixture();
  f.branch.push(
    { type: "custom", customType: TYPE, data: { enabled: true, awaitingAction: false } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "plan_mode_complete",
        details: { version: 1, source: "plan_mode_complete", plan: PLAN },
      },
    },
  );
  const restored = restorePlanModeState(f.branch, TYPE);
  f.persistence.restore(restored);
  f.persistence.persist(restored, f.branch);
  assert.deepEqual(f.entries, []);
});
