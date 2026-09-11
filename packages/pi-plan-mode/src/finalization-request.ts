export const FINALIZE_PLAN_PROMPT =
  "Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.";

export const RETRY_FINALIZE_PLAN_PROMPT =
  "Your previous finalization response did not call plan_mode_question or plan_mode_complete. Both tools are available in the current Plan-mode request. If a material decision remains, call plan_mode_question now. Otherwise call plan_mode_complete alone with the complete decision-ready plan. Do not respond with prose about tool availability.";

export type FinalizationRunOutcome = "normal" | "cancelled" | "error";
export type FinalizationSettlementAction = "retry" | "failed" | undefined;

interface PendingFinalizationRequest {
  workflowGeneration: number;
  retryCount: number;
  awaitingSettlement: boolean;
}

export function createFinalizationRequestCoordinator() {
  let pending: PendingFinalizationRequest | undefined;

  return {
    request(workflowGeneration: number) {
      pending = { workflowGeneration, retryCount: 0, awaitingSettlement: false };
    },
    satisfy() {
      pending = undefined;
    },
    observeRunEnd(workflowGeneration: number, outcome: FinalizationRunOutcome) {
      if (!pending || pending.workflowGeneration !== workflowGeneration) return;
      if (outcome !== "normal") {
        pending = undefined;
        return;
      }
      pending.awaitingSettlement = true;
    },
    settle(workflowGeneration: number): FinalizationSettlementAction {
      if (!pending || pending.workflowGeneration !== workflowGeneration || !pending.awaitingSettlement) {
        return undefined;
      }
      if (pending.retryCount === 0) {
        pending.retryCount = 1;
        pending.awaitingSettlement = false;
        return "retry";
      }
      pending = undefined;
      return "failed";
    },
    reset() {
      pending = undefined;
    },
    hasPendingRequest() {
      return pending !== undefined;
    },
  };
}
