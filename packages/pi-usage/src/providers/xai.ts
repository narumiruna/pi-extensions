import { sanitizeDisplayText } from "../core.js";
import type { UsageBucket, UsageMetric, UsageReport, XaiBillingPayload } from "../types.js";

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function normalizeXaiBillingPayload(
  payload: XaiBillingPayload,
  subscriptionTier: unknown,
  capturedAt: number,
): UsageReport {
  const configValue = payload.config;
  if (configValue !== null && configValue !== undefined && !isRecord(configValue)) {
    throw new Error("xAI billing response config was not an object or null.");
  }
  const config = isRecord(configValue) ? configValue : undefined;
  const buckets: UsageBucket[] = [];
  const metrics: UsageMetric[] = [];
  const notes: string[] = [];

  if (config) {
    const period = normalizePeriod(config.currentPeriod, config.billingPeriodStart, config.billingPeriodEnd);
    const preferredPercent = optionalPercent(config.creditUsagePercent, "creditUsagePercent");
    if (preferredPercent !== undefined) {
      buckets.push({
        id: "included-allowance",
        label: "Included allowance",
        used: preferredPercent,
        remaining: 100 - preferredPercent,
        unit: "percent",
        ...period,
      });
    } else {
      const limit = optionalUsd(config.monthlyLimit, "monthlyLimit");
      const used = optionalUsd(config.used, "used");
      if (limit !== undefined || used !== undefined) {
        buckets.push({
          id: "included-allowance",
          label: "Included allowance",
          ...(limit !== undefined ? { limit } : {}),
          ...(used !== undefined ? { used } : {}),
          ...(limit !== undefined && used !== undefined ? { remaining: limit - used } : {}),
          unit: "usd",
          ...period,
        });
      } else if (period.period || period.resetsAt !== undefined) {
        buckets.push({
          id: "included-allowance",
          label: "Included allowance",
          unit: "percent",
          ...period,
        });
      }
    }

    const onDemandCap = optionalUsd(config.onDemandCap, "onDemandCap");
    const onDemandUsed = optionalUsd(config.onDemandUsed, "onDemandUsed");
    if (onDemandCap !== undefined || onDemandUsed !== undefined) {
      buckets.push({
        id: "on-demand",
        label: "On-demand usage",
        ...(onDemandCap !== undefined ? { limit: onDemandCap } : {}),
        ...(onDemandUsed !== undefined ? { used: onDemandUsed } : {}),
        ...(onDemandCap !== undefined && onDemandUsed !== undefined ? { remaining: onDemandCap - onDemandUsed } : {}),
        unit: "usd",
      });
    }

    const prepaidBalance = optionalUsd(config.prepaidBalance, "prepaidBalance");
    if (prepaidBalance !== undefined) {
      metrics.push({
        id: "prepaid-balance",
        label: "Prepaid balance",
        value: prepaidBalance,
        unit: "usd",
      });
    }
  }

  const tier = optionalTier(subscriptionTier);
  if (tier) metrics.push({ id: "subscription-tier", label: "Plan tier", value: tier });
  if (!config) notes.push("No xAI consumer billing configuration is available for this account.");
  else if (buckets.length === 0 && metrics.length === 0) {
    notes.push("The xAI consumer billing response contained no displayable usage fields.");
  }

  return {
    providerId: "xai",
    providerName: "xAI",
    capturedAt,
    source: "cli-chat-proxy.grok.com consumer billing",
    semantics: {
      kind: "consumer-subscription",
      label: "xAI consumer subscription usage",
    },
    buckets,
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function normalizePeriod(
  currentPeriod: unknown,
  legacyStart: unknown,
  legacyEnd: unknown,
): Pick<UsageBucket, "period" | "resetsAt"> {
  if (currentPeriod !== undefined && currentPeriod !== null && !isRecord(currentPeriod)) {
    throw new Error("xAI billing currentPeriod was not an object or null.");
  }
  if (isRecord(currentPeriod)) {
    const type = optionalString(currentPeriod.type, "currentPeriod.type");
    const start = optionalTimestamp(currentPeriod.start, "currentPeriod.start");
    const end = optionalTimestamp(currentPeriod.end, "currentPeriod.end");
    return {
      ...(periodLabel(type, start) ? { period: periodLabel(type, start) } : {}),
      ...(end !== undefined ? { resetsAt: end } : {}),
    };
  }
  const start = optionalTimestamp(legacyStart, "billingPeriodStart");
  const end = optionalTimestamp(legacyEnd, "billingPeriodEnd");
  return {
    ...(start !== undefined ? { period: "Monthly" } : {}),
    ...(end !== undefined ? { resetsAt: end } : {}),
  };
}

function periodLabel(type: string | undefined, start: number | undefined): string | undefined {
  if (type === "USAGE_PERIOD_TYPE_WEEKLY") return "Weekly";
  if (type === "USAGE_PERIOD_TYPE_MONTHLY") return "Monthly";
  if (type) return sanitizeDisplayText(type.replace(/^USAGE_PERIOD_TYPE_/u, "").replaceAll("_", " "), 40);
  return start === undefined ? undefined : "Current period";
}

function optionalUsd(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`xAI billing ${field} was not a cent wrapper.`);
  const cents = value.val === undefined ? 0 : value.val;
  if (!Number.isSafeInteger(cents) || Math.abs(cents as number) > MAX_SAFE_CENTS) {
    throw new Error(`xAI billing ${field}.val was not a safe signed integer.`);
  }
  return (cents as number) / 100;
}

function optionalPercent(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`xAI billing ${field} was outside 0–100.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 80) {
    throw new Error(`xAI billing ${field} was not a bounded timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`xAI billing ${field} was invalid.`);
  return Math.floor(milliseconds / 1000);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 80) {
    throw new Error(`xAI billing ${field} was not a bounded string.`);
  }
  return value;
}

function optionalTier(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 160) {
    throw new Error("xAI subscription tier was not a bounded string or null.");
  }
  return sanitizeDisplayText(value, 80) || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
