import assert from "node:assert/strict";
import { test } from "vitest";
import { assertPlanModeHelperToolsAvailable, planModeHelperToolsAvailable } from "../src/required-tools.js";

test("Plan helper availability accepts the stable registered envelope", () => {
  const tools = ["read", "plan_mode_question", "plan_mode_update", "plan_mode_complete"];
  assert.equal(planModeHelperToolsAvailable(tools), true);
  assert.doesNotThrow(() => assertPlanModeHelperToolsAvailable(tools));
});

test("Plan helper availability rejects a restrictive envelope without mutating it", () => {
  const tools = ["read", "plan_mode_question"];
  assert.equal(planModeHelperToolsAvailable(tools), false);
  assert.throws(() => assertPlanModeHelperToolsAvailable(tools), /unavailable: plan_mode_update, plan_mode_complete/u);
  assert.deepEqual(tools, ["read", "plan_mode_question"]);
});

test("the old question and completion envelope is insufficient without the update tool", () => {
  const tools = ["read", "plan_mode_question", "plan_mode_complete"];
  assert.equal(planModeHelperToolsAvailable(tools), false);
  assert.throws(() => assertPlanModeHelperToolsAvailable(tools), /unavailable: plan_mode_update;/u);
});
