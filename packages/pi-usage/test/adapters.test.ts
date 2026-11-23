import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeCodexBackendPayload,
  normalizeGitHubCopilotUsagePayload,
  normalizeMistralBillingPayload,
  normalizeOpenRouterKeyPayload,
} from "../src/index.js";

test("GitHub Copilot adapter normalizes legacy premium request quota", () => {
  const report = normalizeGitHubCopilotUsagePayload(
    {
      login: "octocat",
      copilot_plan: "individual",
      quota_reset_date_utc: "2026-08-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          remaining: 245,
          percent_remaining: 81.7,
          token_based_billing: false,
          unlimited: false,
        },
      },
    },
    500,
  );

  assert.equal(report.providerId, "github-copilot");
  assert.equal(report.accountLabel, "octocat");
  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "GitHub Copilot premium request quota",
  });
  assert.deepEqual(report.buckets[0], {
    id: "premium-requests",
    label: "Premium requests",
    used: 55,
    remaining: 245,
    limit: 300,
    unit: "count",
    period: "monthly",
    resetsAt: 1_785_542_400,
  });
  assert.match(formatUsageReport(report, "current"), /245 of 300 left · 82%/);
  assert.equal(formatUsageStatusline(report), "copilot 245/300 82%");
});

test("GitHub Copilot adapter preserves AI-credit billing semantics", () => {
  const report = normalizeGitHubCopilotUsagePayload(
    {
      quota_reset_date_utc: "2026-08-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          credits_used: 300,
          entitlement: 1_500,
          remaining: 1_200,
          token_based_billing: true,
          unlimited: false,
        },
      },
    },
    550,
  );

  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "GitHub Copilot AI Credits allowance",
  });
  assert.deepEqual(report.buckets[0], {
    id: "ai-credits",
    label: "AI credits",
    used: 300,
    remaining: 1_200,
    limit: 1_500,
    unit: "count",
    period: "monthly",
    resetsAt: 1_785_542_400,
  });
  assert.match(formatUsageReport(report, "current"), /AI credits:\s+1200 of 1500 left · 80%/);
  assert.equal(formatUsageStatusline(report), "copilot credits 1200/1500 80%");
});

test("GitHub Copilot adapter represents overage without rejecting negative remaining quota", () => {
  const report = normalizeGitHubCopilotUsagePayload(
    {
      quota_snapshots: {
        premium_interactions: {
          entitlement: 1_500,
          overage_count: 100,
          overage_permitted: true,
          remaining: -100,
          token_based_billing: true,
          unlimited: false,
        },
      },
    },
    575,
  );

  assert.equal(report.buckets[0]?.remaining, 0);
  assert.equal(report.buckets[0]?.used, 1_600);
  assert.deepEqual(report.metrics, [{ id: "overage-used", label: "Additional usage", value: 100, unit: "count" }]);
  assert.match(formatUsageReport(report, "current"), /Additional usage:\s+100 AI credits/);
  assert.equal(formatUsageStatusline(report), "copilot credits 0/1500 0% +100 over");
});

test("GitHub Copilot adapter normalizes the free-tier quota shape", () => {
  const report = normalizeGitHubCopilotUsagePayload(
    {
      access_type_sku: "free_limited_copilot",
      limited_user_quotas: { chat: 40, completions: 1_900 },
      limited_user_reset_date: "2026-08-01T00:00:00Z",
      monthly_quotas: { chat: 50, completions: 2_000 },
    },
    590,
  );

  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "GitHub Copilot Free chat quota",
  });
  assert.deepEqual(report.buckets[0], {
    id: "chat-requests",
    label: "Chat requests",
    used: 10,
    remaining: 40,
    limit: 50,
    unit: "count",
    period: "monthly",
    resetsAt: 1_785_542_400,
  });
  assert.match(formatUsageReport(report, "current"), /Chat requests:\s+40 of 50 left · 80%/);
  assert.equal(formatUsageStatusline(report), "copilot chat 40/50 80%");
});

test("GitHub Copilot adapter handles unlimited quota and rejects incomplete responses", () => {
  const unlimited = normalizeGitHubCopilotUsagePayload(
    {
      quota_snapshots: { premium_interactions: { unlimited: true } },
    },
    600,
  );
  assert.match(formatUsageReport(unlimited, "configured"), /Premium requests:\s+unlimited/);
  assert.equal(formatUsageStatusline(unlimited), "copilot premium unlimited");

  const unlimitedCredits = normalizeGitHubCopilotUsagePayload(
    {
      quota_snapshots: {
        premium_interactions: { token_based_billing: true, unlimited: true },
      },
    },
    650,
  );
  assert.match(formatUsageReport(unlimitedCredits, "current"), /AI credits:\s+unlimited/);
  assert.equal(formatUsageStatusline(unlimitedCredits), "copilot credits unlimited");

  const derivedOverage = normalizeGitHubCopilotUsagePayload(
    {
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          quota_remaining: -20,
          unlimited: false,
        },
      },
    },
    675,
  );
  assert.equal(derivedOverage.metrics[0]?.value, 20);
  assert.equal(formatUsageStatusline(derivedOverage), "copilot 0/300 0% +20 over");

  assert.throws(() => normalizeGitHubCopilotUsagePayload({}, 0), /supported quota/iu);
  assert.throws(
    () => normalizeGitHubCopilotUsagePayload({ quota_snapshots: { premium_interactions: { entitlement: 300 } } }, 0),
    /incomplete/iu,
  );
});

test("OpenRouter adapter normalizes documented per-key spend limits without claiming subscription quota", () => {
  const report = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "Production key",
        limit: 100,
        limit_remaining: 74.5,
        limit_reset: "monthly",
        usage: 25.5,
        usage_daily: 1.25,
        usage_weekly: 8,
        usage_monthly: 25.5,
        is_free_tier: false,
      },
    },
    1_000,
  );

  assert.equal(report.providerId, "openrouter");
  assert.deepEqual(report.semantics, { kind: "api-key", label: "API-key spend limits" });
  assert.equal(report.accountLabel, "Production key");
  assert.deepEqual(report.buckets[0], {
    id: "key-limit",
    label: "Key limit",
    used: 25.5,
    remaining: 74.5,
    limit: 100,
    unit: "usd",
    period: "monthly",
  });
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["usage-daily", 1.25],
      ["usage-weekly", 8],
      ["usage-monthly", 25.5],
      ["usage-total", 25.5],
    ],
  );
  assert.match(formatUsageReport(report, "current"), /OpenRouter Usage · Current/);
  assert.match(formatUsageReport(report, "current"), /API-key spend limits/);
  assert.equal(formatUsageStatusline(report), "openrouter $74.50 left");
});

test("OpenRouter adapter keeps unlimited keys meaningful and sanitizes account labels", () => {
  const report = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "main\u001b[31m\nkey",
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        usage: 12.75,
        usage_daily: 0,
        usage_weekly: 2,
        usage_monthly: 4,
        is_free_tier: true,
      },
    },
    2_000,
  );

  assert.equal(report.accountLabel, "main key");
  assert.deepEqual(report.buckets, []);
  assert.equal(formatUsageStatusline(report), "openrouter $12.75 used");
  assert.match(formatUsageReport(report, "configured"), /OpenRouter Usage · Configured/);
  assert.match(formatUsageReport(report, "configured"), /No per-key spend cap/);
});

test("OpenRouter adapter distinguishes unlimited keys from incomplete capped responses", () => {
  const unlimited = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "unlimited",
        limit: null,
        limit_remaining: null,
        usage: 5,
      },
    },
    2_500,
  );
  const unlimitedText = formatUsageReport(unlimited, "current");
  assert.equal(unlimitedText.match(/No per-key spend cap/g)?.length, 1);

  const incomplete = normalizeOpenRouterKeyPayload(
    {
      data: {
        label: "capped",
        limit: 100,
        limit_remaining: null,
        limit_reset: "monthly",
        usage: 5,
      },
    },
    2_750,
  );
  assert.equal(incomplete.buckets[0]?.limit, 100);
  assert.equal(incomplete.buckets[0]?.remaining, undefined);
  assert.match(formatUsageReport(incomplete, "current"), /remaining unavailable/i);
  assert.doesNotMatch(formatUsageReport(incomplete, "current"), /No per-key spend cap/);
});

test("OpenRouter adapter rejects malformed or empty documented responses", () => {
  assert.throws(() => normalizeOpenRouterKeyPayload({}, 0), /data/);
  assert.throws(() => normalizeOpenRouterKeyPayload({ data: { label: "empty" } }, 0), /no displayable usage data/);
});

test("Codex adapter preserves credit availability without a numeric balance", () => {
  const report = normalizeCodexBackendPayload(
    {
      credits: { has_credits: true, unlimited: false },
    },
    2_900,
  );
  assert.deepEqual(report.metrics, [{ id: "credits", label: "Credits", value: "available" }]);
  assert.match(formatUsageReport(report, "current"), /Credits:\s+available/);
  assert.equal(formatUsageStatusline(report), "codex credits available");
});

test("Codex adapter preserves explicit credit unavailability without rate-limit windows", () => {
  const report = normalizeCodexBackendPayload({ credits: { has_credits: false } }, 2_950);
  assert.deepEqual(report.metrics, [{ id: "credits", label: "Credits", value: "none" }]);
  assert.match(formatUsageReport(report, "current"), /Credits:\s+none/);
  assert.equal(formatUsageStatusline(report), "codex no credits");
});

test("Codex adapter preserves windows, credits, and model-specific statusline buckets", () => {
  const report = normalizeCodexBackendPayload(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 10_000 },
        secondary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: 174_700 },
      },
      credits: { has_credits: true, unlimited: false, balance: "12" },
      rate_limit_reset_credits: { available_count: 2 },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3 Codex Spark",
          metered_feature: "gpt-5.3-codex-spark",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
          },
        },
      ],
    },
    3_000,
  );

  assert.equal(report.providerId, "openai-codex");
  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "ChatGPT subscription limits",
  });
  assert.equal(report.buckets.length, 3);
  assert.equal(report.metrics.find((metric) => metric.id === "reset-credits")?.value, 2);
  assert.match(formatUsageReport(report, "current"), /5h limit:/);
  assert.match(formatUsageReport(report, "current"), /Weekly limit:/);
  const statusNow = 1_000_000;
  assert.equal(formatUsageStatusline(report, undefined, statusNow), "codex 70% ↻ 2h30m · 20% ↻ 2d15m");
  assert.equal(formatUsageStatusline(report, undefined, statusNow, false), "codex 5h:70% · wk:20%");
  assert.equal(formatUsageStatusline(report, undefined, statusNow, true, "used"), "codex 30% ↻ 2h30m · 80% ↻ 2d15m");
  assert.equal(formatUsageStatusline(report, undefined, statusNow, false, "used"), "codex 5h:30% · wk:80%");
  assert.equal(
    formatUsageStatusline(
      report,
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai-codex",
      },
      statusNow,
      true,
      "used",
    ),
    "codex spark 5h:10%",
  );

  const sparkBucket = report.buckets.find((bucket) => bucket.groupId === "gpt-5.3-codex-spark");
  assert.ok(sparkBucket);
  sparkBucket.groupLabel = `Codex${"\t".repeat(100_000)}Spark`;
  assert.equal(
    formatUsageStatusline(report, {
      id: "gpt-5.3-codex-spark",
      name: "-".repeat(100_000),
      provider: "openai-codex",
    }),
    "codex spark 5h:90%",
  );
});

const MISTRAL_SUBSCRIPTION = {
  plan_name: "INDIVIDUAL",
  payg_enabled: false,
  vibe_payg_enabled: false,
  enterprise: false,
};

// Captured verbatim from a live INDIVIDUAL-plan standard API key.
const MISTRAL_BUDGET = {
  vibe_budget: {
    usage_percentage: 3.257940325333333,
    initial_budget: 255.0,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 0.0,
    initial_budget: 25.5,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
};

test("Mistral adapter reports both public allowance budgets from the live payload", () => {
  const report = normalizeMistralBillingPayload(MISTRAL_SUBSCRIPTION, MISTRAL_BUDGET, 1000);

  assert.equal(report.providerId, "mistral");
  assert.equal(report.providerName, "Mistral");
  assert.equal(report.source, "mistral-billing");
  assert.equal(report.accountLabel, "INDIVIDUAL");
  assert.deepEqual(report.metrics, [
    { id: "plan", label: "Plan", value: "INDIVIDUAL" },
    { id: "payg", label: "Pay-as-you-go", value: "disabled" },
  ]);
  assert.deepEqual(report.buckets, [
    {
      id: "vibe-allowance",
      label: "Vibe Code monthly allowance",
      used: 3.257940325333333,
      remaining: 96.74205967466667,
      limit: 100,
      unit: "percent",
      period: "monthly",
      resetsAt: 1_796_083_200,
    },
    {
      id: "api-allowance",
      label: "API monthly allowance",
      used: 0,
      remaining: 100,
      limit: 100,
      unit: "percent",
      period: "monthly",
      resetsAt: 1_796_083_200,
    },
  ]);
  assert.equal(report.notes, undefined);
  const rendered = formatUsageReport(report, "current");
  assert.match(rendered, /Vibe Code monthly allowance: 3% used \u00b7 97% left/u);
  assert.match(rendered, /API monthly allowance:\s+0% used \u00b7 100% left/u);
  // Each bucket is printed once, and no raw fractional percentage leaks through.
  assert.equal(rendered.match(/Vibe Code monthly allowance:/gu)?.length, 1);
  assert.doesNotMatch(rendered, /3\.2579/u);
  assert.equal(formatUsageStatusline(report), "mistral vibe 97% \u00b7 api 100%");
});

test("Mistral adapter ignores a non-positive budget and clamps negative usage", () => {
  const report = normalizeMistralBillingPayload(
    MISTRAL_SUBSCRIPTION,
    { vibe_budget: { usage_percentage: -5, initial_budget: 0 }, api_budget: { usage_percentage: 150, initial_budget: 10 } },
    1100,
  );
  // initial_budget <= 0 means "not configured", exactly as the official CLI treats it.
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["api-allowance"],
  );
  assert.equal(report.buckets[0]?.used, 150);
  assert.equal(report.buckets[0]?.remaining, 0);
});

test("Mistral adapter degrades to plan details when the budget route is unavailable", () => {
  const report = normalizeMistralBillingPayload(MISTRAL_SUBSCRIPTION, undefined, 1200);

  assert.equal(report.accountLabel, "INDIVIDUAL");
  assert.deepEqual(report.buckets, []);
  assert.match(report.notes?.join(" ") ?? "", /usage permission/u);
  assert.match(formatUsageReport(report, "current"), /Plan:\s+INDIVIDUAL/u);
});

test("Mistral adapter prefers the budget payg flag over the subscription fallback", () => {
  const report = normalizeMistralBillingPayload(
    { ...MISTRAL_SUBSCRIPTION, vibe_payg_enabled: true },
    { vibe_budget: { usage_percentage: 42.5, initial_budget: 300, payg_enabled: false } },
    1300,
  );
  assert.equal(report.metrics.find((metric) => metric.id === "payg")?.value, "disabled");

  const fallback = normalizeMistralBillingPayload(
    { ...MISTRAL_SUBSCRIPTION, vibe_payg_enabled: true },
    { vibe_budget: { usage_percentage: 42.5, initial_budget: 300 } },
    1400,
  );
  assert.equal(fallback.metrics.find((metric) => metric.id === "payg")?.value, "enabled");
});

test("Mistral adapter sanitizes display text and rejects invalid field types", () => {
  const report = normalizeMistralBillingPayload({ plan_name: "INDI\t\u001b[31mVIDUAL" }, undefined, 1500);
  assert.equal(report.accountLabel, "INDI VIDUAL");
  assert.doesNotMatch(report.metrics[0]?.value as string, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.throws(() => normalizeMistralBillingPayload({ plan_name: "X".repeat(65) }, undefined, 1600), /bounded/u);
  assert.throws(
    () => normalizeMistralBillingPayload(MISTRAL_SUBSCRIPTION, { vibe_budget: { usage_percentage: "nope", initial_budget: 1 } }, 1700),
    /finite number/u,
  );
});
