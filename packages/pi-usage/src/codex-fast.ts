import { calculateCost, hasApi } from "@earendil-works/pi-ai";
import type { PiModel } from "./types.js";

export const CODEX_FAST_SERVICE_TIER = "priority";
export const CODEX_STANDARD_SERVICE_TIER = "default";

export type CodexFastCapability = { kind: "supported" } | { kind: "unsupported" } | { kind: "unknown"; reason: string };

export const UNKNOWN_CODEX_FAST_CAPABILITY = {
  kind: "unknown",
  reason: "Codex Fast capability information has not been fetched.",
} as const;

export type CodexFastAvailability =
  | { kind: "available"; enabled: boolean }
  | { kind: "not-codex" }
  | { kind: "unavailable"; reason: string }
  | { kind: "unknown"; reason: string };

export function codexFastAvailability(
  model: PiModel | undefined,
  enabled: boolean,
  capability: CodexFastCapability = UNKNOWN_CODEX_FAST_CAPABILITY,
): CodexFastAvailability {
  if (model?.provider !== "openai-codex") return { kind: "not-codex" };
  if (!isOfficialCodexModel(model)) {
    return {
      kind: "unavailable",
      reason: "Fast mode requires the official OpenAI Codex Responses endpoint.",
    };
  }
  if (capability.kind === "unknown") return capability;
  if (capability.kind === "unsupported") {
    return {
      kind: "unavailable",
      reason: `${model.id} does not advertise Codex Fast support.`,
    };
  }
  return { kind: "available", enabled };
}

export function codexFastIsEffective(
  model: PiModel | undefined,
  enabled: boolean,
  capability: CodexFastCapability = UNKNOWN_CODEX_FAST_CAPABILITY,
): boolean {
  return codexFastAvailability(model, enabled, capability).kind === "available" && enabled;
}

export function codexFastRequestTier(
  model: PiModel | undefined,
  enabled: boolean,
  capability: CodexFastCapability = UNKNOWN_CODEX_FAST_CAPABILITY,
): typeof CODEX_FAST_SERVICE_TIER | typeof CODEX_STANDARD_SERVICE_TIER | undefined {
  if (!isOfficialCodexModel(model)) return undefined;
  return enabled && capability.kind === "supported" ? CODEX_FAST_SERVICE_TIER : CODEX_STANDARD_SERVICE_TIER;
}

export function rewriteCodexFastPayload(
  payload: unknown,
  model: PiModel | undefined,
  enabled: boolean,
  capability: CodexFastCapability = UNKNOWN_CODEX_FAST_CAPABILITY,
): unknown | undefined {
  const serviceTier = codexFastRequestTier(model, enabled, capability);
  if (!serviceTier || !isRecord(payload)) return undefined;
  return { ...payload, service_tier: serviceTier };
}

export function correctCodexFastMessageCost(
  message: unknown,
  model: PiModel | undefined,
  fastRequested: boolean,
  capability: CodexFastCapability = UNKNOWN_CODEX_FAST_CAPABILITY,
): unknown | undefined {
  if (
    !codexFastIsEffective(model, fastRequested, capability) ||
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.provider !== model?.provider ||
    message.model !== model?.id
  ) {
    return undefined;
  }
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
  if (!usage || !cost || !hasCompleteUsage(usage) || !isOfficialCodexModel(model)) return undefined;
  const correctedUsage = structuredClone(usage) as typeof usage;
  calculateCost(model, correctedUsage as never);
  const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  const correctedCost = correctedUsage.cost as Record<string, number>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    correctedCost[key] *= multiplier;
  }
  if (costsEqual(cost, correctedCost)) return undefined;
  return { ...message, usage: correctedUsage };
}

export function codexFastStatusLabel(status: string, enabled: boolean): string {
  if (!enabled || !/^codex(?:\s|$)/u.test(status)) return status;
  return status === "codex" ? "codex fast" : `codex fast${status.slice("codex".length)}`;
}

export function isOfficialCodexModel(model: PiModel | undefined): model is PiModel & { api: "openai-codex-responses" } {
  if (model?.provider !== "openai-codex" || !hasApi(model, "openai-codex-responses")) {
    return false;
  }
  try {
    return new URL(model.baseUrl).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCompleteUsage(value: Record<string, unknown>): boolean {
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

function costsEqual(left: Record<string, unknown>, right: Record<string, number>): boolean {
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => left[key] === right[key]);
}
