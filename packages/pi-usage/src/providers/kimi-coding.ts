import { sanitizeDisplayText } from "../core.js";
import type { KimiCodingUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const DAILY_WINDOW_MINUTES = 1_440;
const WEEKLY_WINDOW_MINUTES = 10_080;
const FIXED_POINT_UNITS_PER_CENT = 1_000_000;

/**
 * Source contract revalidated on 2026-08-27.
 * Pi c49906ec77788625aacbdc53ebca6fbe65bd20f5 defines provider `kimi-coding`,
 * `https://api.kimi.com/coding`, API-key auth, and OAuth Bearer auth:
 * https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/providers/kimi-coding.ts
 * https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/auth/oauth/kimi-coding.ts
 * Kimi Code 676e4d82240855044fe809fea89ce1dbe8e512cf defines `GET /coding/v1/usages`,
 * numeric-string plan rows, proto-style windows, and 1,000,000 fixed-point units per cent:
 * https://github.com/MoonshotAI/kimi-code/blob/676e4d82240855044fe809fea89ce1dbe8e512cf/packages/oauth/src/managed-usage.ts
 * Live responses observed on 2026-09-12 omit both `used` and `remaining` on untouched rows and may report only
 * `remaining` once usage starts, so a row with a positive `limit` and no counters means zero usage, and when only
 * one counter is present the other is derived from `limit`. Counters that are present but malformed stay rejected.
 */
export function normalizeKimiCodingUsagePayload(payload: KimiCodingUsagePayload, capturedAt: number): UsageReport {
  const root = asObject(payload);
  if (!root) throw new Error("Kimi Coding usage response was not an object.");

  const candidates: UsageBucket[] = [];
  let omittedWindow = false;
  const summary = parseUsageRow(root.usage, WEEKLY_WINDOW_MINUTES, "Weekly window");
  if (summary) candidates.push(summary);
  else if (root.usage !== undefined) omittedWindow = true;

  if (Array.isArray(root.limits)) {
    for (const raw of root.limits) {
      const item = asObject(raw);
      const windowMinutes = parseWindowMinutes(item?.window);
      const label = sanitizedLabel(item?.name);
      const bucket =
        windowMinutes === undefined
          ? undefined
          : parseUsageRow(item?.detail, windowMinutes, label ?? defaultWindowLabel(windowMinutes));
      if (bucket) candidates.push(bucket);
      else omittedWindow = true;
    }
  } else if (root.limits !== undefined) {
    omittedWindow = true;
  }

  const buckets: UsageBucket[] = [];
  const byWindow = new Map<number, UsageBucket[]>();
  for (const bucket of candidates) {
    const windowMinutes = bucket.windowMinutes as number;
    byWindow.set(windowMinutes, [...(byWindow.get(windowMinutes) ?? []), bucket]);
  }
  for (const rows of byWindow.values()) {
    if (rows.length === 1) buckets.push(rows[0] as UsageBucket);
    else omittedWindow = true;
  }
  buckets.sort((left, right) => (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0));

  const metrics = parseBoosterWallet(root.boosterWallet);
  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("Kimi Coding usage endpoint returned no displayable usage data.");
  }

  return {
    providerId: "kimi-coding",
    providerName: "Kimi For Coding",
    capturedAt,
    source: "kimi-managed-usage",
    semantics: { kind: "consumer-subscription", label: "Kimi Coding Plan usage" },
    buckets,
    metrics,
    ...(omittedWindow ? { notes: ["Unsupported, malformed, or duplicate plan windows were unavailable."] } : {}),
  };
}

function parseUsageRow(value: unknown, windowMinutes: number, label: string): UsageBucket | undefined {
  const row = asObject(value);
  if (!row) return undefined;
  const limit = asNonnegativeInteger(row.limit);
  if (limit === undefined || limit === 0) return undefined;
  const usedRaw = asNonnegativeInteger(row.used);
  const remainingRaw = asNonnegativeInteger(row.remaining);
  // Counters that are present but malformed reject the row instead of silently inventing a count.
  if (
    (row.used !== undefined && usedRaw === undefined) ||
    (row.remaining !== undefined && remainingRaw === undefined)
  ) {
    return undefined;
  }
  // Live responses omit both counters on untouched rows, so a bare `limit` means zero usage.
  const used = usedRaw ?? (remainingRaw === undefined ? 0 : Math.max(0, limit - remainingRaw));
  const remaining = remainingRaw ?? Math.max(0, limit - used);
  const resetsAt = asIsoEpochSeconds(row.resetTime);
  return {
    id: windowId(windowMinutes),
    label,
    used,
    remaining,
    limit,
    unit: "count",
    windowMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseWindowMinutes(value: unknown): number | undefined {
  const window = asObject(value);
  if (!window) return undefined;
  const duration = asPositiveInteger(window.duration);
  if (duration === undefined) return undefined;
  const multiplier =
    window.timeUnit === "TIME_UNIT_MINUTE"
      ? 1
      : window.timeUnit === "TIME_UNIT_HOUR"
        ? 60
        : window.timeUnit === "TIME_UNIT_DAY"
          ? 1_440
          : window.timeUnit === "TIME_UNIT_WEEK"
            ? 10_080
            : undefined;
  if (multiplier === undefined) return undefined;
  const minutes = duration * multiplier;
  return Number.isSafeInteger(minutes) ? minutes : undefined;
}

function parseBoosterWallet(value: unknown): UsageMetric[] {
  const wallet = asObject(value);
  const balance = asObject(wallet?.balance);
  if (!wallet || !balance || balance.type !== "BOOSTER") return [];
  const totalRaw = asPositiveInteger(balance.amount);
  if (totalRaw === undefined) return [];
  const leftRaw = asNonnegativeInteger(balance.amountLeft) ?? 0;
  const monthlyLimit = parseMoney(wallet.monthlyChargeLimit);
  const monthlyUsed = parseMoney(wallet.monthlyUsed);
  const currencies = new Set(
    [monthlyLimit?.currency, monthlyUsed?.currency].filter((currency): currency is string => currency !== undefined),
  );
  if (currencies.size !== 1) return [];
  const currency = currencies.values().next().value;
  if (!currency) return [];
  const total = fixedPointToMajor(totalRaw);
  const left = fixedPointToMajor(leftRaw);
  if (total === undefined || left === undefined) return [];

  const metrics: UsageMetric[] = [
    { id: "booster-balance", label: "Balance", value: left, unit: "currency", currency },
    { id: "booster-total", label: "Total balance", value: total, unit: "currency", currency },
  ];
  if (monthlyUsed) {
    metrics.push({
      id: "booster-monthly-used",
      label: "Used this month",
      value: monthlyUsed.cents / 100,
      unit: "currency",
      currency,
    });
  }
  if (wallet.monthlyChargeLimitEnabled === false) {
    metrics.push({
      id: "booster-monthly-limit",
      label: "Monthly limit",
      value: "unlimited",
      unit: "currency",
      currency,
    });
  } else if (wallet.monthlyChargeLimitEnabled === true && monthlyLimit) {
    metrics.push({
      id: "booster-monthly-limit",
      label: "Monthly limit",
      value: monthlyLimit.cents / 100,
      unit: "currency",
      currency,
    });
  }
  return metrics;
}

function parseMoney(value: unknown): { cents: number; currency: string } | undefined {
  const money = asObject(value);
  if (!money) return undefined;
  const cents = asNonnegativeInteger(money.priceInCents);
  if (cents === undefined) return undefined;
  const currency = asCurrency(money.currency);
  if (!currency) return undefined;
  return { cents, currency };
}

function fixedPointToMajor(value: number): number | undefined {
  const cents = value / FIXED_POINT_UNITS_PER_CENT;
  const roundedCents = cents > 0 && cents < 1 ? 1 : Math.round(cents);
  const major = roundedCents / 100;
  return Number.isSafeInteger(roundedCents) && Number.isFinite(major) ? major : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonnegativeInteger(value: unknown): number | undefined {
  if (typeof value === "string" && !/^\d+$/u.test(value)) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return undefined;
  return number;
}

function asPositiveInteger(value: unknown): number | undefined {
  const number = asNonnegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function asIsoEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= 0 ? Math.floor(millis / 1000) : undefined;
}

function sanitizedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 80) || undefined;
}

function asCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const currency = sanitizeDisplayText(value, 3).toUpperCase();
  return /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

function windowId(minutes: number): string {
  if (minutes === FIVE_HOUR_WINDOW_MINUTES) return "five-hour";
  if (minutes === DAILY_WINDOW_MINUTES) return "daily";
  if (minutes === WEEKLY_WINDOW_MINUTES) return "weekly";
  return `window-${minutes}-minutes`;
}

function defaultWindowLabel(minutes: number): string {
  if (minutes === WEEKLY_WINDOW_MINUTES) return "Weekly window";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w window`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}
