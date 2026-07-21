import { sanitizeDisplayText } from "../core.js";
import type { OpenRouterKeyPayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

export function normalizeOpenRouterKeyPayload(
	payload: OpenRouterKeyPayload,
	capturedAt: number,
): UsageReport {
	const data = asObject(payload.data);
	if (!data) throw new Error("OpenRouter key response data was not an object.");

	const limit = asNonnegativeNumber(data.limit);
	const remaining = asNonnegativeNumber(data.limit_remaining);
	const period = asString(data.limit_reset);
	const totalUsage = asNonnegativeNumber(data.usage);
	const buckets: UsageBucket[] = [];
	if (limit !== undefined) {
		buckets.push({
			id: "key-limit",
			label: "Key limit",
			...(remaining !== undefined ? { used: Math.max(0, limit - remaining), remaining } : {}),
			limit,
			unit: "usd",
			...(period ? { period } : {}),
		});
	}

	const metrics: UsageMetric[] = [];
	addUsageMetric(metrics, "usage-daily", "Usage today", data.usage_daily);
	addUsageMetric(metrics, "usage-weekly", "Usage this week", data.usage_weekly);
	addUsageMetric(metrics, "usage-monthly", "Usage this month", data.usage_monthly);
	addUsageMetric(metrics, "usage-total", "All-time usage", totalUsage);
	if (buckets.length === 0 && metrics.length === 0) {
		throw new Error("OpenRouter key response returned no displayable usage data.");
	}

	const notes: string[] = [];
	if (data.limit === null) notes.push("No per-key spend cap");
	else if (limit === undefined) notes.push("Per-key spend cap unavailable");
	if (data.is_free_tier === true) notes.push("Free-tier API key");

	return {
		providerId: "openrouter",
		providerName: "OpenRouter",
		capturedAt,
		source: "openrouter-key",
		semantics: { kind: "api-key", label: "API-key spend limits" },
		accountLabel: asString(data.label),
		buckets,
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

function addUsageMetric(metrics: UsageMetric[], id: string, label: string, value: unknown): void {
	const amount = typeof value === "number" ? asNonnegativeNumber(value) : undefined;
	if (amount === undefined) return;
	metrics.push({ id, label, value: amount, unit: "usd" });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeDisplayText(value, 80) || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}
