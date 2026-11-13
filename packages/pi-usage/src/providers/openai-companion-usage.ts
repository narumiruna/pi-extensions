import { fetchProviderJson } from "../query.js";
import type { ResolvedUsageAuth, UsageBucket, UsageReport, UsageRequestGuard } from "../types.js";
import { CHATGPT_USAGE_SETTINGS_URL } from "./openai-chatgpt.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_APPS = 128;
const MAX_WINDOWS = 32;

// Evidence: pinned Specode openai.ts at 1015f9f419dfef9ac27c9845ec2318394928fa38
// and OpenAI's Help Center article 20001542. Backend shapes remain undocumented.
// Accept only a complete list; unknown list envelope fields fail closed, including pagination.
export function matchingOpenAIAppBuckets(
  payload: unknown,
  clientId: string,
): { buckets: UsageBucket[]; allowance?: number } {
  const root = object(payload);
  if (
    !root ||
    !Array.isArray(root.items) ||
    root.items.length > MAX_APPS ||
    Object.keys(root).some((key) => !["items", "has_more", "next_cursor"].includes(key)) ||
    (root.has_more !== undefined && root.has_more !== false) ||
    (root.next_cursor !== undefined && root.next_cursor !== null && root.next_cursor !== "")
  ) {
    throw new Error("ChatGPT app usage requires a complete, bounded registration list; pagination is unsupported.");
  }
  const apps = root.items.map(object);
  if (apps.some((app) => !app || typeof app.id !== "string" || !app.id.trim())) {
    throw new Error(
      "ChatGPT app usage returned an unreadable registration identity; uniqueness cannot be established.",
    );
  }
  const matches = apps.filter((app) => app?.id === clientId);
  if (!clientId || matches.length !== 1) {
    throw new Error(
      "The native registration was not uniquely found in the companion Codex account; use the same ChatGPT account/workspace for both logins.",
    );
  }
  const app = matches[0];
  if (!Array.isArray(app?.windows) || app.windows.length === 0 || app.windows.length > MAX_WINDOWS) {
    throw new Error("ChatGPT app usage returned no bounded, displayable windows.");
  }
  const allowance = app.allowed_usage_percent;
  if (allowance !== undefined && !percent(allowance)) throw new Error("ChatGPT app allowance was invalid.");
  return {
    buckets: app.windows.map((window, index) => normalizeWindow(window, `app:${index}`, "chatgpt-app", "App limits")),
    ...(allowance === undefined ? {} : { allowance: allowance as number }),
  };
}

export async function queryOpenAICompanionUsage(
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard?: UsageRequestGuard,
): Promise<UsageReport> {
  if (!guard) throw new Error("Companion ChatGPT usage requires request-boundary revalidation.");
  if (!auth.openaiCompanion || !auth.openaiClientId)
    throw new Error("Companion ChatGPT usage authentication was incomplete.");
  const startedAt = Date.now();
  // Never pass native apiKey/auth/env to transport: the only request credential is the companion.
  const backend: ResolvedUsageAuth = {
    headers: { ...auth.openaiCompanion.headers },
    fingerprint: auth.fingerprint,
    secrets: auth.secrets,
    model: auth.model,
  };
  const read = async (url: string, description: string) => {
    signal.throwIfAborted();
    await guard();
    signal.throwIfAborted();
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Timed out while fetching companion ChatGPT usage.");
    const payload = await fetchProviderJson(url, backend, signal, remaining, description, { redirect: "error" });
    await guard();
    signal.throwIfAborted();
    return payload;
  };
  const appPayload = await read(`${USAGE_URL}/chatpass/apps`, "ChatGPT companion app usage endpoint");
  const app = matchingOpenAIAppBuckets(appPayload, auth.openaiClientId);
  // Match and validate the app before reading plan data; never substitute Codex-only quotas.
  const planPayload = await read(USAGE_URL, "ChatGPT companion plan usage endpoint");
  const rateLimit = object(planPayload.rate_limit);
  const planBuckets: UsageBucket[] = [];
  for (const position of ["primary", "secondary"] as const) {
    const window = rateLimit?.[`${position}_window`];
    if (window !== undefined && window !== null)
      planBuckets.push(normalizeWindow(window, `plan:${position}`, "chatgpt-plan", "Plan limits"));
  }
  if (planBuckets.length === 0) throw new Error("ChatGPT plan usage returned no displayable windows.");
  const buckets = [...planBuckets, ...app.buckets];
  // Display accepts rounded counters. Optional metadata must not turn those
  // previously valid reports (or a custom model ID) into an API projection error.
  const evidenceCompatible =
    auth.model.id.length <= 512 &&
    auth.model.id.trim().length > 0 &&
    buckets.length <= 128 &&
    new Set(buckets.map((bucket) => bucket.id)).size === buckets.length &&
    buckets.every(
      (bucket) =>
        bucket.used !== undefined &&
        bucket.remaining !== undefined &&
        Math.abs(bucket.used + bucket.remaining - 100) <= 1e-9,
    );
  return {
    providerId: "openai",
    providerName: "OpenAI",
    capturedAt: Date.now(),
    source: "openai-chatgpt-companion",
    semantics: { kind: "consumer-subscription", label: "ChatGPT plan and app limits (experimental companion source)" },
    buckets,
    ...(evidenceCompatible
      ? {
          allowance: {
            kind: "included" as const,
            scope: { kind: "models" as const, modelIds: [auth.model.id] },
            coverage: "partial" as const,
            bucketIds: buckets.map((bucket) => bucket.id),
            authBinding: "unbound" as const,
          },
        }
      : {}),
    metrics:
      app.allowance === undefined
        ? []
        : [{ id: "app-allowance", label: "App allowance", value: app.allowance, unit: "percent" }],
    notes: [
      "Source: companion Codex OAuth; registration matching is not independent proof of the same user/workspace.",
      "App allowance caps shared plan usage; it is not remaining or reserved quota.",
      `Manage usage: ${CHATGPT_USAGE_SETTINGS_URL}`,
    ],
  };
}

function normalizeWindow(raw: unknown, id: string, groupId: string, groupLabel: string): UsageBucket {
  const window = object(raw);
  const used = window?.used_percent;
  const remaining = window?.remaining_percent;
  const seconds = window?.limit_window_seconds;
  const resetsAt = window?.reset_at;
  if (
    !percent(used) ||
    (remaining !== undefined && (!percent(remaining) || Math.abs(used + remaining - 100) > 1)) ||
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    (resetsAt !== undefined &&
      (typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt) || resetsAt < 0 || resetsAt > 8_640_000_000_000))
  ) {
    throw new Error("ChatGPT usage returned an invalid or contradictory window.");
  }
  return {
    id,
    label: "Subscription limit",
    groupId,
    groupLabel,
    used,
    remaining: remaining === undefined ? 100 - used : (remaining as number),
    limit: 100,
    unit: "percent",
    windowMinutes: Math.ceil(seconds / 60),
    ...(resetsAt === undefined ? {} : { resetsAt: resetsAt as number }),
  };
}

function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
