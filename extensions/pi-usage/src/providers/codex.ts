import { sanitizeDisplayText } from "../core.js";
import type { CodexBackendPayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

export function normalizeCodexBackendPayload(
	payload: CodexBackendPayload,
	capturedAt: number,
): UsageReport {
	const buckets: UsageBucket[] = [];
	normalizeRateLimitGroup(buckets, "codex", "Codex", payload.rate_limit, false);

	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: [];
	for (const item of additional) {
		const value = asObject(item);
		const id = asString(value?.metered_feature) ?? asString(value?.limit_name);
		if (!value || !id) continue;
		try {
			normalizeRateLimitGroup(
				buckets,
				id,
				asString(value.limit_name) ?? id,
				value.rate_limit,
				true,
			);
		} catch {
			// Optional provider-specific buckets must not hide otherwise useful primary data.
		}
	}

	const metrics: UsageMetric[] = [];
	const credits = asObject(payload.credits);
	if (credits?.has_credits === true) {
		if (credits.unlimited === true) {
			metrics.push({ id: "credits", label: "Credits", value: "unlimited" });
		} else {
			const balance = asNumber(credits.balance);
			if (balance !== undefined) {
				metrics.push({ id: "credits", label: "Credits", value: balance, unit: "count" });
			} else {
				metrics.push({ id: "credits", label: "Credits", value: "available" });
			}
		}
	} else if (credits?.has_credits === false) {
		metrics.push({ id: "credits", label: "Credits", value: "none" });
	}
	const resetCredits = asObject(payload.rate_limit_reset_credits);
	const resetCount = asNonnegativeInteger(resetCredits?.available_count);
	if (resetCount !== undefined) {
		metrics.push({
			id: "reset-credits",
			label: "Usage limit resets",
			value: resetCount,
			unit: "count",
		});
	}
	if (buckets.length === 0 && metrics.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable usage data.");
	}

	const planType = asString(payload.plan_type);
	return {
		providerId: "openai-codex",
		providerName: "OpenAI Codex",
		capturedAt,
		source: "codex-pi-auth",
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		buckets,
		metrics,
		...(planType ? { notes: [`Plan: ${planType}`] } : {}),
	};
}

function normalizeRateLimitGroup(
	buckets: UsageBucket[],
	groupId: string,
	groupLabel: string,
	raw: unknown,
	optional: boolean,
): void {
	if (raw === undefined || raw === null) return;
	const details = asObject(raw);
	if (!details) {
		if (optional) return;
		throw new Error("Codex rate limit was not an object.");
	}
	addWindow(buckets, groupId, groupLabel, "primary", details.primary_window);
	addWindow(buckets, groupId, groupLabel, "secondary", details.secondary_window);
}

function addWindow(
	buckets: UsageBucket[],
	groupId: string,
	groupLabel: string,
	position: "primary" | "secondary",
	raw: unknown,
): void {
	if (raw === undefined || raw === null) return;
	const value = asObject(raw);
	if (!value) throw new Error("Codex rate-limit window was not an object.");
	const used = asNumber(value.used_percent);
	if (used === undefined) return;
	const seconds = asNumber(value.limit_window_seconds);
	const resetsAt = asNumber(value.reset_at);
	buckets.push({
		id: `${groupId}:${position}`,
		label: position === "primary" ? "Primary limit" : "Secondary limit",
		groupId,
		groupLabel,
		modelKeys: [groupId, groupLabel],
		used,
		remaining: 100 - clampPercent(used),
		limit: 100,
		unit: "percent",
		...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeDisplayText(value, 160) || undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
	const parsed = asNumber(value);
	if (parsed === undefined || !Number.isSafeInteger(parsed)) return undefined;
	return Math.max(0, parsed);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
