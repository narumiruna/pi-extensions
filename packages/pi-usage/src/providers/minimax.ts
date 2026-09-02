import { sanitizeDisplayText } from "../core.js";
import type { MiniMaxUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

export type MiniMaxProviderId = "minimax" | "minimax-cn";
export type MiniMaxUsageKind = "token-plan" | "account-balance";

const PROVIDERS = {
	minimax: { name: "MiniMax", currency: "USD" },
	"minimax-cn": { name: "MiniMax CN", currency: "CNY" },
} as const;
const DECIMAL_AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const PERCENT_TOLERANCE = 1;

export function miniMaxUsageKind(apiKey: string): MiniMaxUsageKind {
	return apiKey.startsWith("sk-api-") ? "account-balance" : "token-plan";
}

export function normalizeMiniMaxUsagePayload(
	providerId: MiniMaxProviderId,
	kind: MiniMaxUsageKind,
	payload: MiniMaxUsagePayload,
	capturedAt: number,
): UsageReport {
	return kind === "account-balance"
		? normalizeBalance(providerId, payload, capturedAt)
		: normalizeTokenPlan(providerId, payload, capturedAt);
}

function normalizeBalance(
	providerId: MiniMaxProviderId,
	payload: MiniMaxUsagePayload,
	capturedAt: number,
): UsageReport {
	assertSuccess(payload);
	const provider = PROVIDERS[providerId];
	const metrics: UsageMetric[] = [
		balanceMetric(
			"available-balance",
			"Available balance",
			payload.available_amount,
			provider.currency,
		),
		balanceMetric("cash-balance", "Cash balance", payload.cash_balance, provider.currency, true),
		balanceMetric("voucher-balance", "Voucher balance", payload.voucher_balance, provider.currency),
		balanceMetric("credit-balance", "Credit balance", payload.credit_balance, provider.currency),
		balanceMetric("owed-amount", "Owed amount", payload.owed_amount, provider.currency),
	];
	return {
		providerId,
		providerName: provider.name,
		capturedAt,
		source: "minimax-account-balance",
		semantics: { kind: "api-key", label: "MiniMax pay-as-you-go account balance" },
		buckets: [],
		metrics,
	};
}

function normalizeTokenPlan(
	providerId: MiniMaxProviderId,
	payload: MiniMaxUsagePayload,
	capturedAt: number,
): UsageReport {
	assertSuccess(payload);
	if (!Array.isArray(payload.model_remains) || payload.model_remains.length === 0) {
		throw new Error("MiniMax Token Plan returned no quota rows.");
	}
	const provider = PROVIDERS[providerId];
	const buckets: UsageBucket[] = [];
	const groups = new Set<string>();
	for (const [index, raw] of payload.model_remains.entries()) {
		const row = asObject(raw);
		if (!row) throw new Error("MiniMax Token Plan quota row was not an object.");
		const groupLabel = safeLabel(row.model_name, `Quota ${index + 1}`);
		const groupId = uniqueGroupId(groupLabel, index, groups);
		buckets.push(
			normalizeWindow(row, {
				id: `${groupId}:interval`,
				label: "Rolling window",
				groupId,
				groupLabel,
				countField: "current_interval_usage_count",
				totalField: "current_interval_total_count",
				percentField: "current_interval_remaining_percent",
				statusField: "current_interval_status",
				startField: "start_time",
				endField: "end_time",
			}),
			normalizeWindow(row, {
				id: `${groupId}:weekly`,
				label: "Weekly window",
				groupId,
				groupLabel,
				countField: "current_weekly_usage_count",
				totalField: "current_weekly_total_count",
				percentField: "current_weekly_remaining_percent",
				statusField: "current_weekly_status",
				startField: "weekly_start_time",
				endField: "weekly_end_time",
				boostPermille: row.weekly_boost_permille,
			}),
		);
	}
	return {
		providerId,
		providerName: provider.name,
		capturedAt,
		source: "minimax-token-plan",
		semantics: { kind: "consumer-subscription", label: "MiniMax Token Plan quota" },
		buckets,
		metrics: [],
	};
}

type WindowFields = {
	id: string;
	label: string;
	groupId: string;
	groupLabel: string;
	countField: string;
	totalField: string;
	percentField: string;
	statusField: string;
	startField: string;
	endField: string;
	boostPermille?: unknown;
};

function normalizeWindow(row: Record<string, unknown>, fields: WindowFields): UsageBucket {
	const status = optionalInteger(row[fields.statusField], fields.statusField);
	if (status !== undefined && ![1, 2, 3].includes(status)) {
		throw new Error(`MiniMax Token Plan ${fields.label} status was unsupported.`);
	}
	const percent = optionalPercent(row[fields.percentField], fields.percentField);
	validateBoost(fields.boostPermille);
	const start = timestamp(row[fields.startField], fields.startField);
	const end = timestamp(row[fields.endField], fields.endField);
	if (end < start) throw new Error(`MiniMax Token Plan ${fields.label} timestamps were reversed.`);
	const resetsAt = Math.floor(end / 1_000);
	const windowMinutes = Math.max(1, Math.round((end - start) / 60_000));
	if (status === 3) {
		return {
			id: fields.id,
			label: fields.label,
			groupId: fields.groupId,
			groupLabel: fields.groupLabel,
			remaining: 100,
			unit: "percent",
			period: "unlimited",
			windowMinutes,
		};
	}
	const total = nonnegativeInteger(row[fields.totalField], fields.totalField);
	const count = nonnegativeInteger(row[fields.countField], fields.countField);
	if (total === 0 && percent === undefined) {
		throw new Error(`MiniMax Token Plan ${fields.label} returned no quota and no percent.`);
	}
	// Token Plan reports remaining_percent as the quota even when counts are 0.
	if (total === 0) {
		return {
			id: fields.id,
			label: fields.label,
			groupId: fields.groupId,
			groupLabel: fields.groupLabel,
			remaining: percent as number,
			used: 100 - (percent as number),
			limit: 0,
			unit: "percent",
			windowMinutes,
			resetsAt,
		};
	}
	const resolved = resolveQuotaCounts(count, total, percent);
	if (!resolved) throw new Error(`MiniMax Token Plan ${fields.label} counts were inconsistent.`);
	return {
		id: fields.id,
		label: fields.label,
		groupId: fields.groupId,
		groupLabel: fields.groupLabel,
		...resolved,
		unit: "count",
		windowMinutes,
		resetsAt,
	};
}

function resolveQuotaCounts(
	reportedCount: number,
	total: number,
	remainingPercent: number | undefined,
): Pick<UsageBucket, "used" | "remaining" | "limit"> | undefined {
	if (total <= 0 || reportedCount > total) return undefined;
	let remaining = reportedCount;
	if (remainingPercent !== undefined) {
		const asRemaining = (reportedCount / total) * 100;
		const asUsed = ((total - reportedCount) / total) * 100;
		const remainingDistance = Math.abs(asRemaining - remainingPercent);
		const usedDistance = Math.abs(asUsed - remainingPercent);
		if (Math.min(remainingDistance, usedDistance) > PERCENT_TOLERANCE) return undefined;
		if (usedDistance < remainingDistance) remaining = total - reportedCount;
	}
	return { used: total - remaining, remaining, limit: total };
}

function assertSuccess(payload: MiniMaxUsagePayload): void {
	const base = asObject(payload.base_resp);
	if (base?.status_code !== 0) {
		throw new Error("MiniMax usage response did not report success.");
	}
}

function balanceMetric(
	id: string,
	label: string,
	value: unknown,
	currency: "CNY" | "USD",
	allowNegative = false,
): UsageMetric {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!DECIMAL_AMOUNT.test(value) ||
		(!allowNegative && value.startsWith("-"))
	) {
		throw new Error(`MiniMax ${label.toLowerCase()} was not a valid amount.`);
	}
	return { id, label, value, unit: "currency", currency };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function safeLabel(value: unknown, fallback: string): string {
	if (typeof value !== "string") throw new Error("MiniMax Token Plan model name was not a string.");
	return sanitizeDisplayText(value, 80) || fallback;
}

function uniqueGroupId(label: string, index: number, groups: Set<string>): string {
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-|-$/gu, "") || "quota";
	const id = groups.has(base) ? `${base}-${index + 1}` : base;
	groups.add(id);
	return id;
}

function nonnegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`MiniMax Token Plan ${field} was not a nonnegative safe integer.`);
	}
	return value as number;
}

function optionalInteger(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	return nonnegativeInteger(value, field);
}

function optionalPercent(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		throw new Error(`MiniMax Token Plan ${field} was not a percentage.`);
	}
	return value;
}

function validateBoost(boost: unknown): void {
	if (boost === undefined || boost === null) return;
	const permille = nonnegativeInteger(boost, "weekly_boost_permille");
	if (permille > 10_000) throw new Error("MiniMax Token Plan weekly boost was unreasonable.");
}

function timestamp(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`MiniMax Token Plan ${field} was not a valid timestamp.`);
	}
	return value as number;
}
