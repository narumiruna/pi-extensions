import { sanitizeDisplayText, UsageUnsupportedError } from "../core.js";
import type {
	UsageBucket,
	UsageMetric,
	UsageReport,
	ZaiPlanInfo,
	ZaiQuotaPayload,
	ZaiSubscriptionPayload,
} from "../types.js";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10_080;

export function normalizeZaiQuotaPayload(
	providerId: string,
	providerName: string,
	payload: ZaiQuotaPayload,
	capturedAt: number,
	plan?: ZaiPlanInfo,
): UsageReport {
	const data = asObject(payload.data);
	if (!data) {
		// Only the observed no-plan response establishes that this credential cannot be metered.
		// Missing or malformed data alone can also indicate a transient provider failure.
		if (
			(payload.data === undefined || payload.data === null) &&
			payload.code === 500 &&
			payload.success === false &&
			payload.msg === "当前用户不存在coding plan"
		) {
			throw new UsageUnsupportedError(
				"No GLM Coding Plan on this Z.AI credential; API usage is not metered.",
			);
		}
		// Do not echo msg: truncating provider text before redaction can expose secret prefixes.
		throw new Error("Z.AI quota response data was not an object.");
	}
	const limits = Array.isArray(data.limits) ? (data.limits as unknown[]) : [];

	const buckets: UsageBucket[] = [];
	const metrics: UsageMetric[] = [];
	for (const raw of limits) {
		const limit = asObject(raw);
		if (!limit) continue;
		const type = asString(limit.type);
		const unit = asNonnegativeNumber(limit.unit);
		const isPlanUsage = type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
		if (type === "TIME_LIMIT") {
			addCountBucket(buckets, limit, "mcp-monthly", "MCP monthly allowance");
			addUsageDetailMetrics(metrics, limit.usageDetails);
		} else if (isPlanUsage && unit === 3) {
			addPercentBucket(
				buckets,
				limit,
				"five-hour",
				sessionWindowLabel(limit),
				sessionWindowMinutes(limit),
			);
		} else if (isPlanUsage && unit === 6) {
			const used = asNonnegativeNumber(limit.currentValue);
			const quota = asNonnegativeNumber(limit.usage);
			if (used !== undefined && quota !== undefined) {
				addCountBucket(buckets, limit, "weekly", "Weekly window", weeklyWindowMinutes(limit));
			} else {
				addPercentBucket(buckets, limit, "weekly", "Weekly window", weeklyWindowMinutes(limit));
			}
		}
	}
	if (buckets.length === 0) {
		throw new Error("Z.AI quota endpoint returned no displayable usage data.");
	}

	const notes: string[] = [];
	const level = asString(data.level);
	const planLabel = plan?.name ?? level;
	if (planLabel) {
		notes.push(
			plan?.renewsAt ? `Plan: ${planLabel} · renews ${plan.renewsAt}` : `Plan: ${planLabel}`,
		);
	}

	return {
		providerId,
		providerName,
		capturedAt,
		source: "zai-quota",
		semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
		buckets,
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

// The undocumented subscription endpoint can include historical products. Prefer the current,
// valid product and fail closed to the quota plan level when only explicitly inactive products exist.
export function normalizeZaiSubscriptionPayload(
	payload: ZaiSubscriptionPayload,
): ZaiPlanInfo | undefined {
	if (payload.success === false) return undefined;
	if (typeof payload.code === "number" && payload.code !== 0 && payload.code !== 200) {
		return undefined;
	}
	if (!Array.isArray(payload.data)) return undefined;

	const candidates: Array<{
		plan: ZaiPlanInfo;
		status?: string;
		inCurrentPeriod?: boolean;
	}> = [];
	for (const raw of payload.data) {
		const entry = asObject(raw);
		if (!entry) continue;
		const name = asString(entry.productName);
		if (!name) continue;
		const renewsAt = planRenewalDate(entry.nextRenewTime);
		const status = asString(entry.status)?.toUpperCase();
		const inCurrentPeriod = asBoolean(entry.inCurrentPeriod);
		candidates.push({
			plan: { name, ...(renewsAt !== undefined ? { renewsAt } : {}) },
			...(status !== undefined ? { status } : {}),
			...(inCurrentPeriod !== undefined ? { inCurrentPeriod } : {}),
		});
	}

	const hasStateMetadata = candidates.some(
		(candidate) => candidate.status !== undefined || candidate.inCurrentPeriod !== undefined,
	);
	if (!hasStateMetadata) return candidates[0]?.plan;
	return (
		candidates.find(
			(candidate) => candidate.inCurrentPeriod === true && candidate.status === "VALID",
		)?.plan ??
		candidates.find(
			(candidate) => candidate.inCurrentPeriod === true && candidate.status === undefined,
		)?.plan ??
		candidates.find(
			(candidate) => candidate.status === "VALID" && candidate.inCurrentPeriod === undefined,
		)?.plan
	);
}

function planRenewalDate(value: unknown): string | undefined {
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)) return value.slice(0, 10);
	const millis = asNonnegativeNumber(value);
	if (millis === undefined || millis === 0) return undefined;
	return new Date(millis).toISOString().slice(0, 10);
}

// Z.AI encodes each window as a (unit, number) pair — unit 3 counts hours and unit 6 counts
// weeks — so the payload's number drives the window length and session label; the established
// 5-hour and weekly constants remain the fallback when the payload omits it.
function sessionWindowMinutes(limit: Record<string, unknown>): number {
	const hours = asPositiveNumber(limit.number);
	return hours === undefined ? FIVE_HOUR_WINDOW_MINUTES : Math.round(hours * 60);
}

function sessionWindowLabel(limit: Record<string, unknown>): string {
	const minutes = sessionWindowMinutes(limit);
	return minutes === FIVE_HOUR_WINDOW_MINUTES ? "5h window" : `${Math.round(minutes / 60)}h window`;
}

function weeklyWindowMinutes(limit: Record<string, unknown>): number {
	const weeks = asPositiveNumber(limit.number);
	return weeks === undefined ? WEEKLY_WINDOW_MINUTES : Math.round(weeks * WEEKLY_WINDOW_MINUTES);
}

function addPercentBucket(
	buckets: UsageBucket[],
	limit: Record<string, unknown>,
	id: string,
	label: string,
	windowMinutes: number,
): void {
	const used = asNonnegativeNumber(limit.percentage);
	if (used === undefined) return;
	const percent = clampPercent(used);
	const resetsAt = asEpochSeconds(limit.nextResetTime);
	buckets.push({
		id,
		label,
		used: percent,
		remaining: 100 - percent,
		limit: 100,
		unit: "percent",
		windowMinutes,
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function addCountBucket(
	buckets: UsageBucket[],
	limit: Record<string, unknown>,
	id: string,
	label: string,
	windowMinutes?: number,
): void {
	const used = asNonnegativeNumber(limit.currentValue);
	const quota = asNonnegativeNumber(limit.usage);
	if (used === undefined || quota === undefined) return;
	const resetsAt = asEpochSeconds(limit.nextResetTime);
	buckets.push({
		id,
		label,
		used,
		remaining: Math.max(0, quota - used),
		limit: quota,
		unit: "count",
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function addUsageDetailMetrics(metrics: UsageMetric[], value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const raw of value) {
		const detail = asObject(raw);
		if (!detail) continue;
		const label = asString(detail.modelCode);
		const usage = asNonnegativeNumber(detail.usage);
		if (!label || usage === undefined) continue;
		metrics.push({ id: `mcp-${kebabCase(label)}`, label, value: usage, unit: "count" });
	}
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

function asPositiveNumber(value: unknown): number | undefined {
	const number = asNonnegativeNumber(value);
	return number !== undefined && number > 0 ? number : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === 1) return true;
	if (value === 0) return false;
	return undefined;
}

function asEpochSeconds(value: unknown): number | undefined {
	const millis = asNonnegativeNumber(value);
	if (millis === undefined) return undefined;
	return Math.floor(millis / 1000);
}

function kebabCase(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "tool"
	);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
