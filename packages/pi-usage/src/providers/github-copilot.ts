import { sanitizeDisplayText } from "../core.js";
import type { GitHubCopilotUsagePayload, UsageBucket, UsageReport } from "../types.js";

export function normalizeGitHubCopilotUsagePayload(
  payload: GitHubCopilotUsagePayload,
  capturedAt: number,
): UsageReport {
  const snapshots = asObject(payload.quota_snapshots);
  const premium = asObject(snapshots?.premium_interactions);
  const metrics: UsageReport["metrics"] = [];
  let semanticsLabel: string;
  let bucket: UsageBucket;

  if (premium) {
    const tokenBasedBilling = premium.token_based_billing === true;
    const id = tokenBasedBilling ? "ai-credits" : "premium-requests";
    const label = tokenBasedBilling ? "AI credits" : "Premium requests";
    semanticsLabel = tokenBasedBilling ? "GitHub Copilot AI Credits allowance" : "GitHub Copilot premium request quota";

    if (premium.unlimited === true) {
      bucket = { id, label, unit: "count" };
    } else {
      const entitlement = asNonnegativeNumber(premium.entitlement);
      const rawRemaining = asFiniteNumber(premium.remaining) ?? asFiniteNumber(premium.quota_remaining);
      if (entitlement === undefined || rawRemaining === undefined) {
        throw new Error(`GitHub Copilot ${label.toLowerCase()} quota was incomplete.`);
      }
      const overageUsed = Math.max(asNonnegativeNumber(premium.overage_count) ?? 0, Math.max(0, -rawRemaining));
      if (overageUsed > 0) {
        metrics.push({
          id: "overage-used",
          label: "Additional usage",
          value: overageUsed,
          unit: "count",
        });
      }
      bucket = {
        id,
        label,
        used: asNonnegativeNumber(premium.credits_used) ?? Math.max(0, entitlement - rawRemaining),
        remaining: Math.max(0, rawRemaining),
        limit: entitlement,
        unit: "count",
        period: "monthly",
        ...resetTimestamp(payload),
      };
    }
  } else {
    const limited = asObject(payload.limited_user_quotas);
    const monthly = asObject(payload.monthly_quotas);
    const remaining = asNonnegativeNumber(limited?.chat);
    const entitlement = asNonnegativeNumber(monthly?.chat);
    if (remaining === undefined || entitlement === undefined) {
      throw new Error("GitHub Copilot usage response contained no supported quota.");
    }
    semanticsLabel = "GitHub Copilot Free chat quota";
    bucket = {
      id: "chat-requests",
      label: "Chat requests",
      used: Math.max(0, entitlement - remaining),
      remaining,
      limit: entitlement,
      unit: "count",
      period: "monthly",
      ...resetTimestamp(payload),
    };
  }

  const notes: string[] = [];
  const plan = asString(payload.copilot_plan) ?? asString(payload.access_type_sku);
  if (plan) notes.push(`Plan: ${plan}`);

  return {
    providerId: "github-copilot",
    providerName: "GitHub Copilot",
    capturedAt,
    source: "github-copilot-user",
    semantics: { kind: "consumer-subscription", label: semanticsLabel },
    accountLabel: asString(payload.login),
    buckets: [bucket],
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function resetTimestamp(payload: GitHubCopilotUsagePayload): { resetsAt?: number } {
  const raw =
    asString(payload.quota_reset_date_utc) ??
    asString(payload.quota_reset_date) ??
    asString(payload.limited_user_reset_date);
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

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number === undefined || number < 0 ? undefined : number;
}
