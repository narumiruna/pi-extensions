import { buildPlanModePrompt } from "./prompt.js";

export const MODE_CONTRACT_MESSAGE_TYPE = "plan-mode-transition";
export const MODE_CONTRACT_VERSION = 1;
export type PlanModeContract = "plan" | "normal";

const PLAN_CONTRACT_MARKER = `[PI PLAN MODE CONTRACT v${MODE_CONTRACT_VERSION}: PLAN]`;
const NORMAL_CONTRACT_MARKER = `[PI PLAN MODE CONTRACT v${MODE_CONTRACT_VERSION}: NORMAL]`;
const NORMAL_CONTRACT = `${NORMAL_CONTRACT_MARKER}
Plan Mode is no longer active.
Follow the user's current Normal-mode request and ordinary system instructions.
Earlier Plan-mode restrictions no longer apply, but retain the planning conversation as context.
The visible tool schemas are session capabilities; use only tools appropriate for the current request.`;

interface ContractMessage {
  role?: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

export function modeContractContent(mode: PlanModeContract) {
  return mode === "plan" ? `${PLAN_CONTRACT_MARKER}\n${buildPlanModePrompt()}` : NORMAL_CONTRACT;
}

export function createModeContractMessage(mode: PlanModeContract, timestamp = Date.now()) {
  return {
    role: "custom" as const,
    customType: MODE_CONTRACT_MESSAGE_TYPE,
    content: modeContractContent(mode),
    display: false,
    details: { version: MODE_CONTRACT_VERSION, mode },
    timestamp,
  };
}

export function modeContractFromMessage(message: unknown): PlanModeContract | undefined {
  const candidate = unwrapMessage(message);
  if (candidate.customType !== MODE_CONTRACT_MESSAGE_TYPE) return undefined;
  if (candidate.content === modeContractContent("plan")) return "plan";
  if (candidate.content === modeContractContent("normal")) return "normal";
  return undefined;
}

export function hasModeContractArtifact(messages: readonly unknown[]) {
  return messages.some((message) => unwrapMessage(message).customType === MODE_CONTRACT_MESSAGE_TYPE);
}

export function latestModeContract(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const mode = modeContractFromMessage(messages[index]);
    if (mode) return { index, mode };
  }
  return undefined;
}

export function reconcileModeContract(messages: unknown[], expected: PlanModeContract) {
  const latest = latestModeContract(messages);
  if (latest?.mode === expected) return messages;

  const latestContractIndex = findLatestContractArtifactIndex(messages);
  const insertionIndex = latestContractIndex >= 0 ? latestContractIndex + 1 : leadingSummaryBoundary(messages);
  return [
    ...messages.slice(0, insertionIndex),
    createModeContractMessage(expected, 0),
    ...messages.slice(insertionIndex),
  ];
}

function findLatestContractArtifactIndex(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (unwrapMessage(messages[index]).customType === MODE_CONTRACT_MESSAGE_TYPE) return index;
  }
  return -1;
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
  const entry = message as { message?: unknown } | undefined;
  return (entry?.message ?? message ?? {}) as ContractMessage;
}
