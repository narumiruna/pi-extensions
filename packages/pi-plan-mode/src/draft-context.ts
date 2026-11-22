import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  PLAN_MODE_UPDATE_TOOL_NAME,
  planFromCompletionDetails,
} from "./completion-tool.js";
import { MODEL_DRAFT_MESSAGE_TYPE } from "./message-transform.js";
import { modeContractFromMessage } from "./mode-contract.js";

const DRAFT_PREFIX =
  "[PI PLAN MODE DRAFT v1]\nThe current Markdown draft follows. It is not an implementation instruction.\n\n";

export function createDraftContextMessage(plan: string, timestamp = Date.now()) {
  return {
    role: "custom" as const,
    customType: MODEL_DRAFT_MESSAGE_TYPE,
    content: DRAFT_PREFIX + plan,
    display: false,
    details: { version: 1 as const },
    timestamp,
  };
}

type DraftContextMessage = {
  role?: string;
  customType?: string;
  display?: boolean;
  content?: unknown;
  details?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export function planFromDraftContextMessage(value: unknown) {
  const message = value as DraftContextMessage | undefined;
  if (
    message?.role !== "custom" ||
    message.customType !== MODEL_DRAFT_MESSAGE_TYPE ||
    message.display !== false ||
    (message.details as { version?: unknown } | undefined)?.version !== 1 ||
    typeof message.content !== "string" ||
    !message.content.startsWith(DRAFT_PREFIX)
  )
    return undefined;
  const plan = normalizePlanModeCompletion({ plan: message.content.slice(DRAFT_PREFIX.length) });
  return plan.ok && message.content === DRAFT_PREFIX + plan.plan ? plan.plan : undefined;
}

export function needsDraftContext(messages: readonly unknown[], plan: string) {
  let visiblePlan: string | undefined;
  const updates = new Map<string, string>();
  for (const value of messages) {
    const message = value as DraftContextMessage | undefined;
    if (!message) continue;
    if (modeContractFromMessage(message) === "normal") {
      visiblePlan = undefined;
      updates.clear();
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || block.name !== PLAN_MODE_UPDATE_TOOL_NAME || typeof block.id !== "string")
          continue;
        const parsed = normalizePlanModeCompletion(block.arguments);
        if (parsed.ok) updates.set(block.id, parsed.plan);
      }
    } else if (message.role === "toolResult" && !message.isError) {
      if (message.toolName === PLAN_MODE_COMPLETE_TOOL_NAME) {
        visiblePlan = planFromCompletionDetails(message.details) ?? visiblePlan;
      } else if (message.toolName === PLAN_MODE_UPDATE_TOOL_NAME && message.toolCallId) {
        const details = message.details as { version?: unknown; source?: unknown } | undefined;
        if (details?.version === 1 && details.source === PLAN_MODE_UPDATE_TOOL_NAME) {
          visiblePlan = updates.get(message.toolCallId) ?? visiblePlan;
        }
      }
    } else {
      visiblePlan = planFromDraftContextMessage(value) ?? visiblePlan;
    }
  }
  return visiblePlan !== plan;
}
