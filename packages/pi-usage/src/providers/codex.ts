import { sanitizeDisplayText } from "../core.js";
import type {
  CodexBackendPayload,
  ResolvedUsageAuth,
  UsageAllowance,
  UsageBucket,
  UsageMetric,
  UsageReport,
} from "../types.js";

// Exact ordinary-allowance path, not a model-name heuristic. See the provider guide's evidence audit.
const ALLOWANCE_MODEL_ID = "gpt-5.6-sol";

/** Match Pi's Codex transport: it derives both final auth headers from apiKey, not model headers. */
export function codexAllowanceBinding(auth: ResolvedUsageAuth): { modelId: string; accountId: string } | undefined {
  if (
    auth.model.provider !== "openai-codex" ||
    auth.model.id !== ALLOWANCE_MODEL_ID ||
    auth.model.api !== "openai-codex-responses" ||
    !auth.apiKey
  )
    return;
  try {
    if (new URL(auth.model.baseUrl).origin !== "https://chatgpt.com") return;
    if (auth.effectiveBaseUrl && new URL(auth.effectiveBaseUrl).origin !== "https://chatgpt.com") return;
    const authorization = Object.entries(auth.headers).filter(([name]) => name.toLowerCase() === "authorization");
    if (authorization.length !== 1 || authorization[0]?.[1] !== `Bearer ${auth.apiKey}`) return;
    const parts = auth.apiKey.split(".");
    if (parts.length !== 3 || !parts[1]) return;
    const payload = asObject(JSON.parse(atob(parts[1])));
    const claims = asObject(payload?.["https://api.openai.com/auth"]);
    const accountId = claims?.chatgpt_account_id;
    if (typeof accountId !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/u.test(accountId)) return;
    const accounts = Object.entries(auth.headers).filter(([name]) => name.toLowerCase() === "chatgpt-account-id");
    if (accounts.length > 1 || (accounts.length === 1 && accounts[0]?.[1] !== accountId)) return;
    return { modelId: ALLOWANCE_MODEL_ID, accountId };
  } catch {
    return;
  }
}

export function normalizeCodexBackendPayload(
  payload: CodexBackendPayload,
  capturedAt: number,
  runtimeModelId?: string,
): UsageReport {
  const buckets: UsageBucket[] = [];
  normalizeRateLimitGroup(buckets, "codex", "Codex", payload.rate_limit, false);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    const value = asObject(item);
    const id = asString(value?.metered_feature) ?? asString(value?.limit_name);
    if (!value || !id) continue;
    try {
      normalizeRateLimitGroup(buckets, id, asString(value.limit_name) ?? id, value.rate_limit, true);
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
  const allowance = normalizeAllowance(payload, capturedAt, runtimeModelId, buckets);
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
    ...(allowance ? { allowance } : {}),
    ...(planType ? { notes: [`Plan: ${planType}`] } : {}),
  };
}

function normalizeAllowance(
  payload: CodexBackendPayload,
  capturedAt: number,
  runtimeModelId: string | undefined,
  buckets: UsageBucket[],
): UsageAllowance | undefined {
  if (runtimeModelId !== ALLOWANCE_MODEL_ID) return;
  const details = asObject(payload.rate_limit);
  if (!details) return;
  const bucketIds: string[] = [];
  // Null explicitly means no constraint. Missing or malformed windows cannot prove full coverage.
  let complete = Object.keys(details).every((key) =>
    ["allowed", "limit_reached", "primary_window", "secondary_window"].includes(key),
  );
  for (const position of ["primary", "secondary"] as const) {
    const window = details[`${position}_window`];
    if (window === null) continue;
    const value = asObject(window);
    const used = value?.used_percent;
    const remaining = value?.remaining_percent;
    const seconds = value?.limit_window_seconds;
    const reset = value?.reset_at;
    if (
      typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100 ||
      (remaining !== undefined &&
        (typeof remaining !== "number" || !Number.isFinite(remaining) || Math.abs(used + remaining - 100) > 1e-9)) ||
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      typeof reset !== "number" ||
      !Number.isSafeInteger(reset) ||
      reset <= capturedAt / 1_000 ||
      reset > 8_640_000_000_000 ||
      buckets.filter((bucket) => bucket.id === `codex:${position}`).length !== 1
    ) {
      complete = false;
      continue;
    }
    bucketIds.push(`codex:${position}`);
  }
  if (!bucketIds.length) return;
  // Additional metered features are opaque. They may constrain this model; do not guess from labels.
  if (
    payload.additional_rate_limits !== null &&
    payload.additional_rate_limits !== undefined &&
    (!Array.isArray(payload.additional_rate_limits) || payload.additional_rate_limits.length > 0)
  )
    complete = false;
  return {
    kind: "included",
    scope: { kind: "models", modelIds: [ALLOWANCE_MODEL_ID] },
    coverage: complete ? "complete" : "partial",
    bucketIds,
    authBinding: "runtime",
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
