import type { GoalPromptContext } from "./prompts.js";
import { buildGoalContextPrompt } from "./prompts.js";

export const GOAL_CONTRACT_MESSAGE_TYPE = "goal-contract";
export const GOAL_CONTRACT_VERSION = 2;

const INACTIVE_GOAL_CONTRACT_CONTENT = [
  "Goal mode is inactive.",
  "This Goal contract supersedes every earlier goal-contract message.",
  "Do not treat an earlier Goal objective, goal_id, Goal-mode rule, or summary of them as current unless a later Goal contract explicitly reactivates Goal mode.",
].join("\n");

interface ContractMessage {
  role?: string;
  customType?: string;
  content?: unknown;
}

interface ContractSessionEntry extends ContractMessage {
  type?: string;
  message?: unknown;
}

export function createGoalContextContract(goal: GoalPromptContext) {
  return {
    role: "custom" as const,
    customType: GOAL_CONTRACT_MESSAGE_TYPE,
    content: [
      "This Goal contract supersedes every earlier goal-contract message.",
      "Only the objective and goal_id in this latest Goal contract are current.",
      buildGoalContextPrompt(goal),
    ].join("\n\n"),
    display: false,
    details: { version: GOAL_CONTRACT_VERSION, state: "active", goalId: goal.id },
    timestamp: 0,
  };
}

export function createInactiveGoalContextContract() {
  return {
    role: "custom" as const,
    customType: GOAL_CONTRACT_MESSAGE_TYPE,
    content: INACTIVE_GOAL_CONTRACT_CONTENT,
    display: false,
    details: { version: GOAL_CONTRACT_VERSION, state: "inactive" },
    timestamp: 0,
  };
}

export function reconcileGoalContextContract(messages: unknown[], goal: GoalPromptContext) {
  return reconcileContract(messages, createGoalContextContract(goal));
}

export function reconcileInactiveGoalContextContract(messages: unknown[]) {
  return reconcileContract(messages, createInactiveGoalContextContract());
}

export function hasGoalContextContract(entries: unknown[], goal: GoalPromptContext) {
  return latestGoalContractContent(entries) === createGoalContextContract(goal).content;
}

export function hasInactiveGoalContextContract(entries: unknown[]) {
  return latestGoalContractContent(entries) === INACTIVE_GOAL_CONTRACT_CONTENT;
}

export function hasGoalContextContractHistory(entries: unknown[]) {
  return entries.some(isGoalContextContract);
}

export function isGoalContextContract(message: unknown) {
  return unwrapMessage(message).customType === GOAL_CONTRACT_MESSAGE_TYPE;
}

function reconcileContract(
  messages: unknown[],
  expected: {
    role: "custom";
    customType: string;
    content: string;
    display: boolean;
    details: object;
    timestamp: number;
  },
) {
  if (latestGoalContractContent(messages) === expected.content) return messages;
  const summaryBoundary = leadingSummaryBoundary(messages);
  if (!hasGoalContextContractHistory(messages) && summaryBoundary > 0) {
    return [...messages.slice(0, summaryBoundary), expected, ...messages.slice(summaryBoundary)];
  }
  return [...messages, expected];
}

function latestGoalContractContent(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isGoalContextContract(message)) return unwrapMessage(message).content;
  }
  return undefined;
}

function leadingSummaryBoundary(messages: readonly unknown[]) {
  let index = 0;
  while (index < messages.length) {
    const role = unwrapMessage(messages[index]).role;
    if (role !== "compactionSummary" && role !== "branchSummary") break;
    index += 1;
  }
  return index;
}

function unwrapMessage(message: unknown): ContractMessage {
  const entry = message as ContractSessionEntry | undefined;
  if (entry?.type === "custom_message") return entry;
  return (entry?.message ?? message ?? {}) as ContractMessage;
}
