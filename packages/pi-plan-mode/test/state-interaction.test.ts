import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeCompleted } from "../src/completion-tool.js";
import { restorePlanModeState } from "../src/state.js";

const STATE_TYPE = "plan-mode-state";
const stateEntry = (data: unknown) => ({ type: "custom", customType: STATE_TYPE, data });

test("restoration retains both explicit interaction modes in enabled workflows", () => {
  for (const interactionMode of ["questions", "discussion"] as const) {
    const entries = [stateEntry({ enabled: true, interactionMode })];
    const original = JSON.stringify(entries);
    const restored = restorePlanModeState(entries, STATE_TYPE);
    assert.equal(restored.enabled, true);
    assert.equal(restored.interactionMode, interactionMode);
    assert.equal(JSON.stringify(entries), original);
    assert.equal(restorePlanModeState(JSON.parse(original), STATE_TYPE).interactionMode, interactionMode);
  }
});

test("legacy missing interaction mode defaults logically to questions without adding a property", () => {
  for (const data of [{ enabled: true }, { enabled: true, interactionMode: undefined }]) {
    const restored = restorePlanModeState([stateEntry(data)], STATE_TYPE);
    assert.equal(restored.enabled, true);
    assert.equal(restored.interactionMode ?? "questions", "questions");
    assert.equal(Object.hasOwn(restored, "interactionMode"), false);
  }
});

test("invalid persisted interaction values normalize to questions, not discussion", () => {
  for (const interactionMode of [
    null,
    false,
    true,
    0,
    1,
    "",
    "Discussion",
    "QUESTIONS",
    " discussion ",
    "normal",
    [],
    {},
  ]) {
    const entries = [stateEntry({ enabled: true, interactionMode })];
    const original = JSON.stringify(entries);
    const restored = restorePlanModeState(entries, STATE_TYPE);
    assert.equal(restored.interactionMode, "questions", JSON.stringify(interactionMode));
    assert.equal(JSON.stringify(entries), original);
  }
});

test("inactive, malformed, and absent states never retain an interaction property", () => {
  for (const data of [
    undefined,
    null,
    [],
    {},
    { enabled: false, interactionMode: "discussion" },
    { enabled: false, interactionMode: "questions" },
    { enabled: "true", interactionMode: "discussion" },
    { interactionMode: "discussion" },
  ]) {
    const restored = restorePlanModeState([stateEntry(data)], STATE_TYPE);
    assert.equal(restored.enabled, false);
    assert.equal(Object.hasOwn(restored, "interactionMode"), false);
  }
  assert.deepEqual(restorePlanModeState([], STATE_TYPE), { enabled: false, awaitingAction: false });
});

test("latest owned branch state wins and a new workflow does not inherit discussion", () => {
  const entries = [
    stateEntry({ enabled: true, interactionMode: "discussion" }),
    { type: "custom", customType: "another-state", data: { enabled: true, interactionMode: "questions" } },
  ];
  assert.equal(restorePlanModeState(entries, STATE_TYPE).interactionMode, "discussion");
  entries.push(stateEntry({ enabled: false }));
  assert.equal(Object.hasOwn(restorePlanModeState(entries, STATE_TYPE), "interactionMode"), false);
  entries.push(stateEntry({ enabled: true }));
  const nextWorkflow = restorePlanModeState(entries, STATE_TYPE);
  assert.equal(Object.hasOwn(nextWorkflow, "interactionMode"), false);
  assert.equal(nextWorkflow.interactionMode ?? "questions", "questions");
});

test("ready plans and completion recovery are independent of interaction mode", () => {
  for (const interactionMode of ["questions", "discussion"] as const) {
    const ready = restorePlanModeState(
      [
        stateEntry({
          enabled: true,
          interactionMode,
          latestPlan: "# Ready plan",
          latestPlanSource: "plan_mode_complete",
        }),
      ],
      STATE_TYPE,
    );
    assert.equal(ready.interactionMode, interactionMode);
    assert.equal(ready.latestPlan, "# Ready plan");
    assert.equal(ready.latestPlanSource, "plan_mode_complete");
    assert.equal(ready.awaitingAction, true);
    const recovered = restorePlanModeState(
      [
        stateEntry({ enabled: true, interactionMode }),
        {
          type: "message",
          message: { role: "toolResult", toolName: "plan_mode_complete", ...planModeCompleted("# Recovered") },
        },
      ],
      STATE_TYPE,
    );
    assert.equal(recovered.interactionMode, interactionMode);
    assert.equal(recovered.latestPlan, "# Recovered");
    assert.equal(recovered.awaitingAction, true);
  }
});

test("Pi branch navigation and compaction restore only the supplied branch interaction state", () => {
  const session = SessionManager.inMemory();
  const questions = session.appendCustomEntry(STATE_TYPE, { enabled: true, interactionMode: "questions" });
  session.appendCustomEntry(STATE_TYPE, { enabled: true, interactionMode: "discussion" });
  assert.equal(restorePlanModeState(session.getBranch(), STATE_TYPE).interactionMode, "discussion");
  session.branch(questions);
  assert.equal(restorePlanModeState(session.getBranch(), STATE_TYPE).interactionMode, "questions");
  const retained = session.appendMessage({ role: "user", content: "New branch", timestamp: 1 });
  session.appendCompaction("Earlier planning", retained, 100);
  assert.equal(restorePlanModeState(session.getBranch(), STATE_TYPE).interactionMode, "questions");
  const copiedBranch = JSON.parse(JSON.stringify(session.getBranch()));
  assert.equal(restorePlanModeState(copiedBranch, STATE_TYPE).interactionMode, "questions");
  session.appendCustomEntry(STATE_TYPE, { enabled: false });
  assert.equal(Object.hasOwn(restorePlanModeState(session.getBranch(), STATE_TYPE), "interactionMode"), false);
});
