import { createMockPi as createBaseMockPi } from "../../../test/support.js";
import { restorePlanModeState } from "../src/state.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  createMockContext,
  driveCustomSelector,
  extensionTool,
} from "../../../test/support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_complete"];

export function restoreMockPlanModeState(
  mock: Pick<ReturnType<typeof createBaseMockPi>, "entries">,
  branch: unknown[],
) {
  return restorePlanModeState(
    [...branch, ...mock.entries.map((entry) => ({ type: "custom", ...entry }))],
    "plan-mode-state",
  );
}

export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  return createBaseMockPi({
    ...options,
    activeTools: [...new Set([...(options.activeTools ?? []), ...PLAN_HELPERS])],
  });
}
