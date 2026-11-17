import { isDeepStrictEqual } from "node:util";
import { type PlanModeState, restorePlanModeState } from "./state.js";

export function createPlanModeStatePersistence(stateEntryType: string, append: (state: PlanModeState) => void) {
  let persisted = JSON.stringify({ enabled: false, awaitingAction: false });
  let appendFailed = false;

  return {
    restore(state: PlanModeState) {
      persisted = JSON.stringify(state);
      appendFailed = false;
    },
    persist(state: PlanModeState, branch: unknown[]) {
      const serialized = JSON.stringify(state);
      // Detach the append payload from runtime state. Pi retains this object in memory.
      const payload = JSON.parse(serialized) as PlanModeState;
      if (!appendFailed && isDeepStrictEqual(payload, JSON.parse(persisted))) {
        // A repeated no-plan entry can still be needed to stop recovery from a later tool result.
        const clearsRecoveredPlan =
          state.enabled && !state.latestPlan && restorePlanModeState(branch, stateEntryType).latestPlan !== undefined;
        if (!clearsRecoveredPlan) return;
      }
      try {
        append(payload);
      } catch (error: unknown) {
        // A failed append can leave the in-memory branch uncertain. Let rollback repair it.
        appendFailed = true;
        throw error;
      }
      persisted = serialized;
      appendFailed = false;
    },
  };
}
