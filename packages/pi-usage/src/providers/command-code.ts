import { sanitizeDisplayText } from "../core.js";
import type {
  CommandCodeAccountPayload,
  CommandCodeUsageBundle,
  UsageBucket,
  UsageMetric,
  UsageReport,
} from "../types.js";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10_080;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const MILLISECOND_EPOCH_FLOOR = 1e12;
const WINDOWS = [
  { key: "fiveHour", id: "five-hour", label: "Five-hour window", windowMinutes: FIVE_HOUR_WINDOW_MINUTES },
  { key: "weekly", id: "weekly", label: "Weekly window", windowMinutes: WEEKLY_WINDOW_MINUTES },
] as const;
const PLAN_LABELS: Readonly<Record<string, string>> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
};

export function commandCodeOrgId(account: CommandCodeAccountPayload): string | undefined {
  const id = asObject(account.org)?.id;
  return typeof id === "string" && IDENTIFIER_PATTERN.test(id) ? id : undefined;
}

/**
 * Source contract observed live on 2026-09-29. Command Code serves the account, credits, plan,
 * and billing-period usage that its CLI `/usage` command displays from the undocumented
 * `https://api.commandcode.ai/alpha/*` endpoints, authenticated with the same Bearer API key Pi
 * stores for the `command-code` provider. `resetAt` is a millisecond epoch, plan credits and
 * rolling-window caps are USD-denominated, and `org` may be `null` for a personal account.
 * `credits.monthlyCredits`, `purchasedCredits`, and `freeCredits` are remaining amounts, so the
 * billing-period pool is their sum plus `usage/summary.totalCost`.
 */
export function normalizeCommandCodeUsagePayload(bundle: CommandCodeUsageBundle, capturedAt: number): UsageReport {
  const account = asObject(bundle.account);
  const user = asObject(account?.user);
  const accountLabel = asString(user?.userName) ?? asString(user?.name);
  if (!accountLabel) {
    throw new Error("Command Code account response omitted a safe account name.");
  }

  const creditsPayload = asObject(bundle.credits);
  const credits = asObject(creditsPayload?.credits);
  const windowLimits = asObject(creditsPayload?.windowLimits);
  const subscription = asObject(asObject(bundle.subscription)?.data);
  const usage = asObject(bundle.usage);

  const buckets: UsageBucket[] = [];
  for (const window of WINDOWS) {
    const bucket = parseWindow(windowLimits?.[window.key], window);
    if (bucket) buckets.push(bucket);
  }

  const totalCost = asNonnegativeNumber(usage?.totalCost);
  const remainingCredits = commandCodeRemainingCredits(credits);
  const monthlyReset = asIsoEpochSeconds(subscription?.currentPeriodEnd);
  if (totalCost !== undefined && remainingCredits !== undefined) {
    const pool = totalCost + remainingCredits;
    if (pool > 0) {
      buckets.push({
        id: "monthly",
        label: "Monthly credits",
        used: totalCost,
        remaining: remainingCredits,
        limit: pool,
        unit: "usd",
        period: "billing-period",
        ...(monthlyReset !== undefined ? { resetsAt: monthlyReset } : {}),
      });
    }
  }

  const metrics: UsageMetric[] = [];
  const plan = planLabel(subscription?.planId);
  const planStatus = asString(subscription?.status, 40);
  if (plan || planStatus) {
    metrics.push({
      id: "plan",
      label: "Plan",
      value: [plan, planStatus ? `(${planStatus})` : undefined].filter(Boolean).join(" "),
    });
  }
  if (buckets.every((bucket) => bucket.id !== "monthly")) {
    if (remainingCredits !== undefined) {
      metrics.push({
        id: "monthly-credits",
        label: "Monthly credits remaining",
        value: remainingCredits,
        unit: "usd",
      });
    } else if (totalCost !== undefined) {
      metrics.push({ id: "period-cost", label: "Cost this billing period", value: totalCost, unit: "usd" });
    }
  }
  const purchased = asNonnegativeNumber(credits?.purchasedCredits);
  if (purchased) {
    metrics.push({ id: "purchased-credits", label: "Purchased credits remaining", value: purchased, unit: "usd" });
  }
  const free = asNonnegativeNumber(credits?.freeCredits);
  if (free) {
    metrics.push({ id: "free-credits", label: "Free credits remaining", value: free, unit: "usd" });
  }
  const totalCount = asNonnegativeNumber(usage?.totalCount);
  if (totalCount !== undefined) {
    metrics.push({ id: "requests", label: "Requests this period", value: totalCount, unit: "count" });
  }
  const totalTokens = asNonnegativeNumber(usage?.totalTokens);
  if (totalTokens !== undefined) {
    metrics.push({ id: "tokens", label: "Tokens this period", value: totalTokens, unit: "count" });
  } else {
    const tokensIn = asNonnegativeNumber(usage?.totalTokensIn);
    const tokensOut = asNonnegativeNumber(usage?.totalTokensOut);
    if (tokensIn !== undefined) {
      metrics.push({ id: "tokens-in", label: "Input tokens", value: tokensIn, unit: "count" });
    }
    if (tokensOut !== undefined) {
      metrics.push({ id: "tokens-out", label: "Output tokens", value: tokensOut, unit: "count" });
    }
  }

  const notes: string[] = [];
  if (!creditsPayload) notes.push("Command Code credits were unavailable.");
  else if (windowLimits?.limited === false) {
    notes.push("Rolling 5-hour and weekly limits are not enabled for this plan.");
  }
  if (!subscription) notes.push("Command Code plan details were unavailable.");
  if (!usage) notes.push("Command Code billing-period usage was unavailable.");

  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("Command Code usage response returned no displayable usage data.");
  }

  return {
    providerId: "command-code",
    providerName: "Command Code",
    capturedAt,
    source: "command-code-alpha-usage",
    semantics: { kind: "consumer-subscription", label: "Command Code plan credits and rolling limits" },
    accountLabel,
    buckets,
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function parseWindow(value: unknown, window: (typeof WINDOWS)[number]): UsageBucket | undefined {
  const row = asObject(value);
  if (!row) return undefined;
  const used = asNonnegativeNumber(row.used);
  const cap = asNonnegativeNumber(row.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  const resetsAt = asMillisecondEpochSeconds(row.resetAt);
  return {
    id: window.id,
    label: window.label,
    used,
    remaining: Math.max(0, cap - used),
    limit: cap,
    unit: "usd",
    windowMinutes: window.windowMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function commandCodeRemainingCredits(credits: Record<string, unknown> | undefined): number | undefined {
  if (!credits) return undefined;
  const parts = ["monthlyCredits", "purchasedCredits", "freeCredits"]
    .map((key) => asNonnegativeNumber(credits[key]))
    .filter((value): value is number => value !== undefined);
  if (parts.length === 0) return undefined;
  return parts.reduce((total, value) => total + value, 0);
}

function planLabel(value: unknown): string | undefined {
  const raw = asString(value, 40);
  if (!raw) return undefined;
  const known = PLAN_LABELS[raw];
  if (known) return known;
  const words = raw
    .replace(/^individual[-_]/u, "")
    .replace(/[-_]+/gu, " ")
    .trim();
  return words ? capitalize(words) : raw;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, maxLength) || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asIsoEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function asMillisecondEpochSeconds(value: unknown): number | undefined {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : undefined;
  if (raw === undefined || raw < 0) return undefined;
  return Math.floor(raw >= MILLISECOND_EPOCH_FLOOR ? raw / 1000 : raw);
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
