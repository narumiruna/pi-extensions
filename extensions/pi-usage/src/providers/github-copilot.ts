import { sanitizeDisplayText } from "../core.js";
import type { GitHubCopilotUsagePayload, UsageBucket, UsageReport } from "../types.js";

export function normalizeGitHubCopilotUsagePayload(
	payload: GitHubCopilotUsagePayload,
	capturedAt: number,
): UsageReport {
	const snapshots = asObject(payload.quota_snapshots);
	const premium = asObject(snapshots?.premium_interactions);
	if (!premium) {
		throw new Error("GitHub Copilot usage response contained no premium request quota.");
	}

	const unlimited = premium.unlimited === true;
	const entitlement = asNonnegativeNumber(premium.entitlement);
	const remaining =
		asNonnegativeNumber(premium.remaining) ?? asNonnegativeNumber(premium.quota_remaining);
	const buckets: UsageBucket[] = [];
	if (unlimited) {
		buckets.push({ id: "premium-requests", label: "Premium requests", unit: "count" });
	} else {
		if (entitlement === undefined || remaining === undefined) {
			throw new Error("GitHub Copilot premium request quota was incomplete.");
		}
		buckets.push({
			id: "premium-requests",
			label: "Premium requests",
			used: Math.max(0, entitlement - remaining),
			remaining,
			limit: entitlement,
			unit: "count",
			period: "monthly",
			...resetTimestamp(payload),
		});
	}

	const notes: string[] = [];
	const plan = asString(payload.copilot_plan) ?? asString(payload.access_type_sku);
	if (plan) notes.push(`Plan: ${plan}`);

	return {
		providerId: "github-copilot",
		providerName: "GitHub Copilot",
		capturedAt,
		source: "github-copilot-user",
		semantics: {
			kind: "consumer-subscription",
			label: "GitHub Copilot premium request quota",
		},
		accountLabel: asString(payload.login),
		buckets,
		metrics: [],
		...(notes.length > 0 ? { notes } : {}),
	};
}

function resetTimestamp(payload: GitHubCopilotUsagePayload): { resetsAt?: number } {
	const raw = asString(payload.quota_reset_date_utc) ?? asString(payload.quota_reset_date);
	if (!raw) return {};
	const milliseconds = Date.parse(raw);
	return Number.isNaN(milliseconds) ? {} : { resetsAt: Math.floor(milliseconds / 1000) };
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
