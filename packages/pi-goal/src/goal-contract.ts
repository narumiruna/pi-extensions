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
  details?: { sentAt?: unknown; publicationId?: unknown };
  timestamp?: unknown;
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

export function hasGoalContractPublication(entries: unknown[], publicationId: string) {
  return entries.some(
    (entry) => isGoalContextContract(entry) && unwrapMessage(entry).details?.publicationId === publicationId,
  );
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
  const placed = placeDeferredContracts(messages);
  if (latestGoalContractContent(placed) === expected.content) return placed;
  // Match Pi's immediate persisted-message position after retained history.
  // A deferred publication is moved back to this position by placeDeferredContracts.
  return [...placed, expected];
}

/**
 * Pi queues a contract sent while the agent is streaming until the current turn ends, so it can be
 * persisted after output that started later. Show it where it was sent instead: before the earliest
 * assistant message of the run of messages that are all newer than `details.sentAt`. That is where the
 * transient restoration sat on the previous request, so the request prefix survives the delivery.
 * An assistant message is always a complete turn boundary, so a contract is never placed between a tool
 * call and its result. Contracts without `sentAt` stay where Pi put them.
 */
function placeDeferredContracts(messages: unknown[]) {
  let placed = messages;
  for (let index = 0; index < placed.length; index += 1) {
    const sentAt = deferredSentAt(placed[index]);
    if (sentAt === undefined) continue;
    const boundary = turnBoundaryAfter(placed, index, sentAt);
    if (boundary === undefined) continue;
    // Carry the send time so timestamps stay ordered: Pi's context estimate ignores the usage of an
    // assistant message older than a message placed before it.
    const contract = { ...(placed[index] as object), timestamp: sentAt };
    placed = [...placed.slice(0, boundary), contract, ...placed.slice(boundary, index), ...placed.slice(index + 1)];
  }
  return placed;
}

function turnBoundaryAfter(messages: readonly unknown[], contractIndex: number, sentAt: number) {
  let boundary: number | undefined;
  for (let index = contractIndex - 1; index >= 0; index -= 1) {
    const message = unwrapMessage(messages[index]);
    if (isGoalContextContract(message) || typeof message.timestamp !== "number" || message.timestamp <= sentAt) break;
    if (message.role === "assistant") boundary = index;
  }
  return boundary;
}

function deferredSentAt(message: unknown) {
  if (!isGoalContextContract(message)) return undefined;
  const sentAt = unwrapMessage(message).details?.sentAt;
  return typeof sentAt === "number" && Number.isFinite(sentAt) ? sentAt : undefined;
}

function latestGoalContractContent(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isGoalContextContract(message)) return unwrapMessage(message).content;
  }
  return undefined;
}

function unwrapMessage(message: unknown): ContractMessage {
  const entry = message as ContractSessionEntry | undefined;
  if (entry?.type === "custom_message") return entry;
  return (entry?.message ?? message ?? {}) as ContractMessage;
}
