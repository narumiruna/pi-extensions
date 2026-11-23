import { sanitizeDisplayText } from "../core.js";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.js";

const MAX_PLAN_NAME_LENGTH = 64;

export type MistralSubscriptionPayload = {
  plan_name?: unknown;
  payg_enabled?: unknown;
  vibe_payg_enabled?: unknown;
  enterprise?: unknown;
};

export type MistralBudgetDetail = {
  usage_percentage?: unknown;
  initial_budget?: unknown;
  currency?: unknown;
  reset_at?: unknown;
  payg_enabled?: unknown;
};

export type MistralBudgetPayload = {
  vibe_budget?: unknown;
  api_budget?: unknown;
};

type Budget = {
  bucket: UsageBucket;
  payg?: boolean;
};

/**
 * Normalize the two public billing routes the official Mistral Vibe CLI reads
 * (`vibe/app_server/_billing.py`). `/billing/subscription` names the plan; `/billing/budget`
 * reports the monthly Vibe Code and API allowances as a used percentage. Both are optional
 * upstream: a member without the usage permission gets 403 on `/budget` only, so each route
 * degrades independently instead of failing the report.
 */
export function normalizeMistralBillingPayload(
  subscription: MistralSubscriptionPayload | undefined,
  budget: MistralBudgetPayload | undefined,
  capturedAt: number,
): UsageReport {
  const plan = subscription === undefined ? undefined : optionalPlanName(subscription.plan_name);
  const enterprise = subscription === undefined ? undefined : optionalBoolean(subscription.enterprise, "enterprise");

  const buckets: UsageBucket[] = [];
  let paygState: boolean | undefined;
  for (const [key, label] of [
    ["vibe_budget", "Vibe Code monthly allowance"],
    ["api_budget", "API monthly allowance"],
  ] as const) {
    const parsed = parseBudget(budget?.[key], label);
    if (parsed === undefined) continue;
    buckets.push(parsed.bucket);
    // Vibe pay-as-you-go decides whether spend can continue past the allowance.
    paygState ??= parsed.payg;
  }
  paygState ??= optionalBoolean(subscription?.vibe_payg_enabled, "vibe_payg_enabled");

  const metrics: UsageMetric[] = [];
  if (plan !== undefined) metrics.push({ id: "plan", label: "Plan", value: plan });
  if (paygState !== undefined) {
    metrics.push({ id: "payg", label: "Pay-as-you-go", value: paygState ? "enabled" : "disabled" });
  }

  const notes: string[] = [];
  if (budget === undefined) {
    notes.push(
      subscription?.enterprise === true
        ? "Mistral returned no budget data for this account."
        : "Mistral did not report a monthly allowance; this member may lack the usage permission.",
    );
  } else if (buckets.length === 0 && enterprise === true) {
    notes.push("Mistral reported no monthly allowance for this account.");
  }

  return {
    providerId: "mistral",
    providerName: "Mistral",
    capturedAt,
    source: "mistral-billing",
    semantics: { kind: "api-key", label: "Mistral monthly allowance" },
    ...(plan !== undefined ? { accountLabel: plan } : {}),
    buckets,
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function parseBudget(value: unknown, label: string): Budget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const detail = value as MistralBudgetDetail;
  // The official CLI ignores a non-positive budget: it means the allowance is not configured.
  const limit = optionalNumber(detail.initial_budget, "initial_budget");
  if (limit === undefined || limit <= 0) return undefined;
  const usedPercent = optionalNumber(detail.usage_percentage, "usage_percentage");
  if (usedPercent === undefined) return undefined;
  const used = Math.max(0, usedPercent);
  return {
    bucket: {
      id: label.includes("Vibe") ? "vibe-allowance" : "api-allowance",
      label,
      used,
      remaining: Math.max(0, 100 - used),
      limit: 100,
      unit: "percent",
      period: "monthly",
      ...(() => {
        const resetsAt = optionalTimestamp(detail.reset_at);
        return resetsAt === undefined ? {} : { resetsAt };
      })(),
    },
    payg: optionalBoolean(detail.payg_enabled, "payg_enabled"),
  };
}

function optionalPlanName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_PLAN_NAME_LENGTH) {
    throw new Error("Mistral plan_name was not a bounded string.");
  }
  return sanitizeDisplayText(value, MAX_PLAN_NAME_LENGTH) || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Mistral ${field} was not a boolean.`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`Mistral ${field} was not a finite number.`);
  }
  return parsed;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}
