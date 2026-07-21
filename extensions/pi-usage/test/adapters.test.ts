import assert from "node:assert/strict";
import test from "node:test";
import {
	formatUsageReport,
	formatUsageStatusline,
	normalizeCodexBackendPayload,
	normalizeOpenRouterKeyPayload,
} from "../src/index.js";

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
	assert.throws(
		() => normalizeOpenRouterKeyPayload({ data: { label: "empty" } }, 0),
		/no displayable usage data/,
	);
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
				primary_window: { used_percent: 60, limit_window_seconds: 18_000, reset_at: 100 },
				secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
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
	assert.equal(
		formatUsageStatusline(report, {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			provider: "openai-codex",
		}),
		"codex spark 90% 5h",
	);
});
