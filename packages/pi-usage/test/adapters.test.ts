import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeCodexBackendPayload,
  normalizeGitHubCopilotUsagePayload,
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
        primary_window: { used_percent: 60, limit_window_seconds: 18_000, reset_at: 10_000 },
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
  assert.equal(formatUsageStatusline(report, undefined, statusNow), "codex 40% ↻ 2h30m 20% ↻ 2d15m");
  assert.equal(formatUsageStatusline(report, undefined, statusNow, false), "codex 40% 5h 20% wk");
  assert.equal(
    formatUsageStatusline(
      report,
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai-codex",
      },
      statusNow,
    ),
    "codex spark 90% 5h",
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
    "codex spark 90% 5h",
  );
});
