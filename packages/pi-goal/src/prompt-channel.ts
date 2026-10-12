import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./persistence.js";

/**
 * pi-goal sends every model-facing prompt as a custom message instead of a plain
 * user message. convertToLlm turns custom messages into user messages verbatim, so
 * the model sees the exact same text; the TUI renders them through the registered
 * message renderer as a single collapsed line (expandable globally), like skill
 * invocations.
 */
export const GOAL_PROMPT_MESSAGE_TYPE = "pi.goal.prompt";

export type GoalPromptKind = "set" | "resume" | "edit" | "wait" | "continue" | "claim";

export interface GoalPromptMessageDetails {
  kind: GoalPromptKind;
  objective: string;
  iteration?: number;
}

export function goalPromptDetails(
  kind: GoalPromptKind,
  goal: ActiveGoal,
  iteration?: number,
): GoalPromptMessageDetails {
  const details: GoalPromptMessageDetails = { kind, objective: goal.text };
  if (iteration !== undefined) details.iteration = iteration;
  return details;
}

export function isGoalPromptMessage(message: unknown): message is { content: unknown; details?: unknown } {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown };
  return candidate.role === "custom" && candidate.customType === GOAL_PROMPT_MESSAGE_TYPE;
}

/** Extract the prompt text from a delivered goal-prompt custom message. */
export function goalPromptMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && Reflect.get(part, "type") === "text")
    .map((part) => Reflect.get(part, "text"))
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** Send a goal prompt over the collapsed custom-message channel. */
export function sendGoalPromptMessage(
  pi: ExtensionAPI,
  prompt: string,
  details: GoalPromptMessageDetails,
  deliverAs: "followUp" | "steer",
): Promise<void> | void {
  return pi.sendMessage(
    { customType: GOAL_PROMPT_MESSAGE_TYPE, content: prompt, display: true, details },
    { deliverAs, triggerTurn: true },
  );
}
