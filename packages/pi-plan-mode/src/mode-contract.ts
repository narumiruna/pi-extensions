import { createHash } from "node:crypto";
import { buildPlanModePrompt } from "./prompt.js";

export const MODE_CONTRACT_MESSAGE_TYPE = "plan-mode-transition";
export const PLAN_CONTRACT_VERSION = 2;
export const NORMAL_CONTRACT_VERSION = 1;
export type PlanModeContract = "plan" | "normal";

const LEGACY_PLAN_CONTRACT_DIGESTS = new Set([
  "9d1dcbca0a8641ad639e54a843d1938bae14b5dab81c826e21a03fa525355f59",
  "6e2b4c8d18665ce43408a0b2f04a099fb1b0d7eaa9382c21f821c571ac547cfa",
]);
const PLAN_CONTRACT = `[PI PLAN MODE CONTRACT v${PLAN_CONTRACT_VERSION}: PLAN]\n${buildPlanModePrompt()}`;
const NORMAL_CONTRACT_MARKER = `[PI PLAN MODE CONTRACT v${NORMAL_CONTRACT_VERSION}: NORMAL]`;
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
  return mode === "plan" ? PLAN_CONTRACT : NORMAL_CONTRACT;
}

export function modeContractVersion(mode: PlanModeContract) {
  return mode === "plan" ? PLAN_CONTRACT_VERSION : NORMAL_CONTRACT_VERSION;
}

export function createModeContractMessage(mode: PlanModeContract, timestamp = Date.now()) {
  return {
    role: "custom" as const,
    customType: MODE_CONTRACT_MESSAGE_TYPE,
    content: modeContractContent(mode),
    display: false,
    details: { version: modeContractVersion(mode), mode },
    timestamp,
  };
}

export function modeContractFromMessage(message: unknown): PlanModeContract | undefined {
  return readModeContract(message)?.mode;
}

export function readModeContract(message: unknown): { mode: PlanModeContract; version: 1 | 2 } | undefined {
  const candidate = unwrapMessage(message);
  if (candidate.customType !== MODE_CONTRACT_MESSAGE_TYPE) return undefined;
  if (candidate.content === PLAN_CONTRACT) return { mode: "plan", version: PLAN_CONTRACT_VERSION };
  if (candidate.content === NORMAL_CONTRACT) return { mode: "normal", version: NORMAL_CONTRACT_VERSION };
  if (
    typeof candidate.content === "string" &&
    LEGACY_PLAN_CONTRACT_DIGESTS.has(createHash("sha256").update(candidate.content).digest("hex"))
  )
    return { mode: "plan", version: 1 };
  return undefined;
}

export function hasModeContractArtifact(messages: readonly unknown[]) {
  return messages.some((message) => unwrapMessage(message).customType === MODE_CONTRACT_MESSAGE_TYPE);
}

export function latestModeContract(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const contract = readModeContract(messages[index]);
    if (contract) return { index, ...contract };
  }
  return undefined;
}

export function hasCurrentModeContract(messages: readonly unknown[], expected: PlanModeContract) {
  const latest = latestModeContract(messages);
  return latest?.mode === expected && latest.version === modeContractVersion(expected);
}

export function reconcileModeContract(messages: unknown[], expected: PlanModeContract) {
  if (hasCurrentModeContract(messages, expected)) return messages;
  return [...messages, createModeContractMessage(expected, 0)];
}

function unwrapMessage(message: unknown): ContractMessage {
  const entry = message as { message?: unknown } | undefined;
  return (entry?.message ?? message ?? {}) as ContractMessage;
}
