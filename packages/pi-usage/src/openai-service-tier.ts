import { calculateCost, hasApi } from "@earendil-works/pi-ai";
import type { OpenAIServiceTier } from "./settings.js";
import type { PiModel } from "./types.js";

export const OPENAI_PRIORITY_SERVICE_TIER = "priority" as const;
export const OPENAI_STANDARD_SERVICE_TIER = "default" as const;
export const OPENAI_FLEX_SERVICE_TIER = "flex" as const;
export const OPENAI_SERVICE_TIERS = ["default", "priority", "flex"] as const;

export type ServiceTier = OpenAIServiceTier;
export type ActiveServiceTier = Exclude<ServiceTier, "default">;

export const CODEX_PRIORITY_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

const OPENAI_PRIORITY_MODEL_IDS: ReadonlySet<string> = CODEX_PRIORITY_MODEL_IDS;
export const OPENAI_FLEX_MODEL_IDS: ReadonlySet<string> = new Set([
	"o3",
	"o3-mini",
	"o4-mini",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.2-chat-latest",
	"gpt-5.3-chat-latest",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export type ServiceTierAvailability =
	| {
			kind: "available";
			tier: ServiceTier;
			supportedTiers: readonly ActiveServiceTier[];
	  }
	| { kind: "not-openai" }
	| { kind: "unavailable"; reason: string };

export function serviceTierSupport(model: PiModel | undefined): readonly ActiveServiceTier[] {
	if (isOfficialCodexModel(model)) {
		return CODEX_PRIORITY_MODEL_IDS.has(model.id) ? ["priority"] : [];
	}
	if (isOfficialOpenAIModel(model)) {
		const supported: ActiveServiceTier[] = [];
		if (OPENAI_PRIORITY_MODEL_IDS.has(model.id)) supported.push("priority");
		if (OPENAI_FLEX_MODEL_IDS.has(model.id)) supported.push("flex");
		return supported;
	}
	return [];
}

export function serviceTierAvailability(
	model: PiModel | undefined,
	tier: ServiceTier,
): ServiceTierAvailability {
	if (model?.provider !== "openai" && model?.provider !== "openai-codex") {
		return { kind: "not-openai" };
	}
	if (!isOfficialOpenAIModel(model) && !isOfficialCodexModel(model)) {
		return {
			kind: "unavailable",
			reason: "Service tiers require an official OpenAI Responses endpoint.",
		};
	}
	const supportedTiers = serviceTierSupport(model);
	if (supportedTiers.length === 0) {
		return { kind: "unavailable", reason: `${model.id} does not advertise service-tier support.` };
	}
	if (tier !== "default" && !supportedTiers.includes(tier)) {
		return { kind: "unavailable", reason: `${tier} is not supported for ${model.id}.` };
	}
	return { kind: "available", tier, supportedTiers };
}

export function serviceTierIsEffective(model: PiModel | undefined, tier: ServiceTier): boolean {
	return tier !== "default" && serviceTierSupport(model).includes(tier);
}

export function serviceTierRequestTier(
	model: PiModel | undefined,
	tier: ServiceTier,
): ServiceTier | undefined {
	if (!isOfficialOpenAIModel(model) && !isOfficialCodexModel(model)) return undefined;
	const supportedTiers = serviceTierSupport(model);
	if (supportedTiers.length === 0) return model.provider === "openai-codex" ? "default" : undefined;
	return tier === "default" || supportedTiers.includes(tier) ? tier : "default";
}

export function rewriteOpenAIServiceTierPayload(
	payload: unknown,
	model: PiModel | undefined,
	tier: ServiceTier,
): unknown | undefined {
	const serviceTier = serviceTierRequestTier(model, tier);
	if (!serviceTier || !isRecord(payload)) return undefined;
	return { ...payload, service_tier: serviceTier };
}

export function correctOpenAIServiceTierMessageCost(
	message: unknown,
	model: PiModel | undefined,
	tier: ServiceTier,
): unknown | undefined {
	if (
		!model ||
		!serviceTierIsEffective(model, tier) ||
		!isRecord(message) ||
		message.role !== "assistant" ||
		message.provider !== model.provider ||
		message.model !== model.id
	) {
		return undefined;
	}
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
	if (!usage || !cost || !hasCompleteUsage(usage)) return undefined;
	const correctedUsage = structuredClone(usage) as typeof usage;
	calculateCost(model, correctedUsage as never);
	const multiplier = serviceTierCostMultiplier(model, tier);
	const correctedCost = correctedUsage.cost as Record<string, number>;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		correctedCost[key] *= multiplier;
	}
	if (costsEqual(cost, correctedCost)) return undefined;
	return { ...message, usage: correctedUsage };
}

export function serviceTierCostMultiplier(model: PiModel | undefined, tier: ServiceTier): number {
	if (tier === "flex") return 0.5;
	if (tier === "priority") return model?.id === "gpt-5.5" ? 2.5 : 2;
	return 1;
}

export function openAIServiceTierStatusLabel(
	status: string,
	model: PiModel | undefined,
	tier: ServiceTier,
): string {
	if (
		model?.provider !== "openai-codex" ||
		!serviceTierIsEffective(model, tier) ||
		!/^codex(?:\s|$)/u.test(status)
	) {
		return status;
	}
	return status === "codex" ? `codex ${tier}` : `codex ${tier}${status.slice("codex".length)}`;
}

function isOfficialOpenAIModel(
	model: PiModel | undefined,
): model is PiModel & { api: "openai-responses" } {
	if (model?.provider !== "openai" || !hasApi(model, "openai-responses")) return false;
	return hasOrigin(model, "https://api.openai.com");
}

function isOfficialCodexModel(
	model: PiModel | undefined,
): model is PiModel & { api: "openai-codex-responses" } {
	if (model?.provider !== "openai-codex" || !hasApi(model, "openai-codex-responses")) {
		return false;
	}
	return hasOrigin(model, "https://chatgpt.com");
}

function hasOrigin(model: PiModel, expectedOrigin: string): boolean {
	try {
		return new URL(model.baseUrl).origin === expectedOrigin;
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
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every(
		(key) => left[key] === right[key],
	);
}
