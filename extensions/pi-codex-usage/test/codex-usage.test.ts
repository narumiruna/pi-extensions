import assert from "node:assert/strict";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import codexUsage, {
	type CodexUsageReport,
	formatCodexUsageReport,
	formatCodexUsageStatusline,
	normalizeAppServerResponse,
	normalizeBackendPayload,
	parseArgs,
} from "../src/codex-usage.js";

test("codex-usage registers command and statusline lifecycle hooks", () => {
	const mock = createMockPi();
	codexUsage(mock.pi);

	assert.ok(mock.commands.has("codex-status"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"model_select",
		"session_shutdown",
		"session_start",
		"session_tree",
	]);
});

test("parseArgs handles refresh, statusline, clear, and timeout options", () => {
	assert.deepEqual(parseArgs("--refresh --no-statusline --timeout 2"), {
		ok: true,
		value: { clearStatusline: false, refresh: true, statusline: false, timeoutMs: 2000 },
	});
	assert.deepEqual(parseArgs("--clear-statusline"), {
		ok: true,
		value: { clearStatusline: true, refresh: false, statusline: true, timeoutMs: 15000 },
	});
	assert.equal(parseArgs("--timeout 0").ok, false);
});

test("normalizeBackendPayload keeps primary and additional rate limits", () => {
	const report = normalizeBackendPayload(
		{
			plan_type: "pro_lite",
			rate_limit: {
				primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1 },
			},
			credits: { has_credits: true, unlimited: false, balance: "12" },
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3 Codex Spark",
					metered_feature: "gpt-5.3-codex-spark",
					rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
				},
			],
		},
		1000,
		"pi-auth",
	);

	assert.equal(report.source, "pi-auth");
	assert.equal(report.planType, "pro_lite");
	assert.equal(report.snapshots.length, 2);
	assert.equal(report.snapshots[0]?.primary?.windowMinutes, 300);
	assert.equal(report.snapshots[1]?.limitId, "gpt-5.3-codex-spark");
});

test("normalizeAppServerResponse merges duplicate snapshots by limit id", () => {
	const report = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 }, planType: "team" },
			rateLimitsByLimitId: {
				codex: { limitId: "codex", secondary: { usedPercent: 20, windowDurationMins: 10080 } },
			},
		},
		2000,
	);

	assert.equal(report.source, "codex-app-server");
	assert.equal(report.snapshots.length, 1);
	assert.equal(report.snapshots[0]?.primary?.usedPercent, 40);
	assert.equal(report.snapshots[0]?.secondary?.windowMinutes, 10080);
});

test("formatters render report text and model-specific statusline buckets", () => {
	const report: CodexUsageReport = {
		source: "pi-auth",
		capturedAt: 0,
		snapshots: [
			{ limitId: "codex", primary: { usedPercent: 60 }, secondary: { usedPercent: 80 } },
			{ limitId: "gpt-5.3-codex-spark", primary: { usedPercent: 10 } },
		],
	};

	assert.match(formatCodexUsageReport(report), /5h limit:/);
	assert.equal(
		formatCodexUsageStatusline(report, {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			provider: "openai-codex",
		}),
		"📊 codex spark 90% 5h",
	);
	assert.equal(formatCodexUsageStatusline(report), "📊 codex 40% 5h 20% wk");
});
