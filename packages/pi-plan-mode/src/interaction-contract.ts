import { modeContractFromMessage } from "./mode-contract.js";

export type PlanInteractionMode = "questions" | "discussion";

export const INTERACTION_CONTRACT_MESSAGE_TYPE = "plan-mode-interaction";
const INTERACTION_CONTRACT_VERSION = 1;

const CONTRACTS: Record<PlanInteractionMode, string> = {
  questions: `[PI PLAN MODE INTERACTION CONTRACT v1: QUESTIONS]
Plan Mode remains active with all read-only restrictions unchanged. Do not edit files, perform mutating actions, or implement the plan.
The user has enabled questionnaires. Restore the original Plan-mode rule: every turn that advances or finalizes the plan must end with plan_mode_question when a material decision remains, or plan_mode_complete alone as the final action when the plan is decision-complete. If interactive UI is unavailable, ask one concise plain-text question instead.
Re-evaluate the current discussion after the next user message. Do not replay stale questions or reopen an earlier questionnaire. Enabling questionnaires does not itself start a model turn or open a questionnaire.
Only the user can change this interaction mode.`,
  discussion: `[PI PLAN MODE INTERACTION CONTRACT v1: DISCUSSION]
Plan Mode remains active with all read-only restrictions unchanged. Do not edit files, perform mutating actions, or implement the plan.
This contract overrides the original Plan-mode rule that each advancing or finalizing turn must end with plan_mode_question or plan_mode_complete. You may analyze, answer, ask natural plain-text questions, and end with ordinary text without calling either tool.
Do not call plan_mode_question or open questionnaires. Do not resume questionnaires automatically; only the user can enable them again. Discard unsubmitted questionnaire answers and do not replay stale questions.
When the plan is decision-complete, you may call plan_mode_complete alone as the final action to display and save the complete plan. Completion does not automatically open an action menu in discussion mode; the user can open /plan. Continue revisions through the existing complete-replacement plan flow, and use plain-text questions when decisions remain.`,
};

export function createInteractionContractMessage(mode: PlanInteractionMode, timestamp = Date.now()) {
  return {
    role: "custom" as const,
    customType: INTERACTION_CONTRACT_MESSAGE_TYPE,
    content: CONTRACTS[mode],
    display: false,
    details: { version: INTERACTION_CONTRACT_VERSION, mode },
    timestamp,
  };
}

export function interactionContractFromMessage(message: unknown): PlanInteractionMode | undefined {
  const candidate = customMessage(message);
  if (candidate?.customType !== INTERACTION_CONTRACT_MESSAGE_TYPE || candidate.display !== false) return undefined;
  const details = candidate.details;
  if (!isRecord(details) || details.version !== INTERACTION_CONTRACT_VERSION) return undefined;
  const mode = details.mode;
  if (mode !== "questions" && mode !== "discussion") return undefined;
  return candidate.content === CONTRACTS[mode] ? mode : undefined;
}

export function latestInteractionContract(
  messages: readonly unknown[],
): { index: number; mode: PlanInteractionMode } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const mode = interactionContractFromMessage(message);
    if (mode) return { index, mode };
    // Both transitions start a new boundary. Never inherit another workflow's interaction.
    if (modeContractFromMessage(customMessage(message))) return undefined;
  }
  return undefined;
}

// The caller owns enabled-state checks and durable publication of this fallback.
export function reconcileInteractionContract(messages: unknown[], expected: PlanInteractionMode): unknown[] {
  if (latestInteractionContract(messages)?.mode === expected) return messages;
  return [...messages, createInteractionContractMessage(expected, 0)];
}

// Match Pi's context-producing custom messages, not state entries or user/tool text.
function customMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "custom_message") return value;
  if (value.type === "message") {
    return isRecord(value.message) && value.message.role === "custom" ? value.message : undefined;
  }
  return value.type === undefined && value.role === "custom" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
