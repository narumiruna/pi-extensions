import assert from "node:assert/strict";
import { test } from "vitest";
import { formatUsageReport, formatUsageStatusline, formatUsageStatuslineWithCountdown } from "../src/format.js";
import { normalizeAnthropicUsagePayload } from "../src/providers/anthropic.js";

const extra = { is_enabled: true, currency: "USD", decimal_places: 2, used_credits: 8000, monthly_limit: 10000 };

test("Claude extra usage displays spend, monthly limit, and remaining amount without subscription windows", () => {
  const report = normalizeAnthropicUsagePayload({ extra_usage: extra }, 1);
  const formatted = formatUsageReport(report, "current");
  assert.match(formatted, /Claude Extra Usage · Current/);
  assert.match(formatted, /Used this month:\s+\$80\.00/);
  assert.match(formatted, /Monthly limit:\s+\$100\.00/);
  assert.match(formatted, /Remaining:\s+\$20\.00/);
  assert.equal(formatUsageStatusline(report), "anthropic $20.00 left");
  assert.deepEqual(formatUsageStatuslineWithCountdown(report), { value: "anthropic $20.00 left", hasCountdown: false });
  assert.doesNotMatch(formatted, /5h|weekly|resets|80%|8000/);
  assert.match(formatUsageReport(report, "configured"), /Configured/);
});

for (const [currency, scale, remaining] of [
  ["EUR", 2, "EUR 20.00"],
  ["JPY", 0, "JPY 2000"],
  ["KWD", 3, "KWD 2.000"],
] as const) {
  test(`Claude extra usage retains ${currency} and explicit scale ${scale}`, () => {
    const report = normalizeAnthropicUsagePayload({ extra_usage: { ...extra, currency, decimal_places: scale } }, 1);
    assert.equal(formatUsageStatusline(report), `anthropic ${remaining} left`);
    assert.ok(formatUsageReport(report, "current").includes(remaining));
  });
}

for (const payload of [
  {},
  { extra_usage: null },
  { extra_usage: { is_enabled: false } },
  { extra_usage: { ...extra, monthly_limit: undefined } },
]) {
  test(`unavailable or disabled Claude allowance has no fabricated status: ${JSON.stringify(payload)}`, () => {
    const report = normalizeAnthropicUsagePayload(payload, 1);
    assert.equal(formatUsageStatusline(report), undefined);
    assert.doesNotMatch(formatUsageReport(report, "current"), /Remaining:\s+\$0\.00/);
  });
}

for (const used of [10000, 10001]) {
  test(`exhausted or exceeded Claude limit ${used} shows zero remaining and real spend`, () => {
    const report = normalizeAnthropicUsagePayload({ extra_usage: { ...extra, used_credits: used } }, 1);
    assert.equal(formatUsageStatusline(report), "anthropic $0.00 left");
    assert.match(formatUsageReport(report, "current"), used === 10000 ? /\$100\.00/ : /\$100\.01/);
  });
}

test("fractional minor units remain exact through detail and compact display", () => {
  const report = normalizeAnthropicUsagePayload(
    { extra_usage: { ...extra, used_credits: 0.1, monthly_limit: 0.3 } },
    1,
  );
  assert.equal(formatUsageStatusline(report), "anthropic $0.002 left");
  assert.match(formatUsageReport(report, "current"), /Used this month:\s+\$0\.001/);
});

test.each([
  { currency: "USD\u001b[31m", value: "20.00\u001b[2J" },
  { currency: "USD\n", value: "20.00" },
  { currency: "USD", value: "20.00\n" },
])("Claude monetary display refuses terminal controls without mutating the raw report: %j", ({ currency, value }) => {
  const report = normalizeAnthropicUsagePayload({ extra_usage: extra }, 1);
  const remaining = report.metrics.find((metric) => metric.id === "extra-usage-remaining");
  assert.ok(remaining);
  remaining.currency = currency;
  remaining.value = value;
  const raw = structuredClone(report);
  assert.equal(formatUsageStatusline(report), undefined);
  assert.equal(formatUsageReport(report, "current").includes("\u001b"), false);
  assert.equal(formatUsageReport(report, "current").includes("Remaining:"), false);
  assert.deepEqual(report, raw);
});
