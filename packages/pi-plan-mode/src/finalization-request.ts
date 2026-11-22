const LEGACY_FINALIZE_PLAN_PROMPT =
  "Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.";

const SAVE_AND_COMPLETE =
  "If the draft is missing or changed, save the full Markdown with plan_mode_update({ plan }) first and wait for it to succeed. Then call plan_mode_complete({}) as the only tool call in a separate assistant message. Updating alone does not finish this request.";

export const FINALIZE_PLAN_PROMPT = `Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise, finish the saved draft: ${SAVE_AND_COMPLETE}`;

export const DISCUSSION_FINALIZE_PLAN_PROMPT = `Finalize the current implementation plan if it is decision-ready. If a material decision remains, discuss it or ask one concise plain-text question instead. Questionnaires remain paused until the user enables them. Otherwise, finish the saved draft: ${SAVE_AND_COMPLETE}`;

export const RETRY_FINALIZE_PLAN_PROMPT = `Your previous finalization response did not call plan_mode_question or plan_mode_complete. If a material decision remains, call plan_mode_question now. Otherwise, finish the saved draft: ${SAVE_AND_COMPLETE} Do not respond with prose about tool availability.`;

export function isFinalizePlanPrompt(text: string) {
  const prompt = text.trim();
  return prompt === FINALIZE_PLAN_PROMPT || prompt === LEGACY_FINALIZE_PLAN_PROMPT;
}

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
