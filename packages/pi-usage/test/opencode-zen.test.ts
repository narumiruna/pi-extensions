import assert from "node:assert/strict";
import { test } from "vitest";
import { formatUsageReport, formatUsageStatusline, normalizeOpenCodeZenPayload } from "../src/index.js";

const ZEN_PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-08-15T12:34:04.072Z" },
    weekly: { status: "ok", percent: 4, resetsAt: "2026-08-17T00:00:00.072Z" },
    monthly: { status: "ok", percent: 2, resetsAt: "2026-09-12T16:44:54.072Z" },
  },
};

test("OpenCode Zen adapter normalizes rolling, weekly, and monthly windows", () => {
  const report = normalizeOpenCodeZenPayload(ZEN_PAYLOAD, 500);

  assert.equal(report.providerId, "opencode-go");
  assert.equal(report.providerName, "OpenCode Go");
  assert.equal(report.semantics.kind, "consumer-subscription");
  assert.equal(report.buckets.length, 3);

  const rolling = report.buckets.find((bucket) => bucket.id === "rolling");
  assert.deepEqual(rolling?.used, 0);
  assert.deepEqual(rolling?.remaining, 100);
  assert.deepEqual(rolling?.resetsAt, Math.floor(Date.parse("2026-08-15T12:34:04.072Z") / 1000));

  const weekly = report.buckets.find((bucket) => bucket.id === "weekly");
  assert.deepEqual(weekly?.used, 4);
  assert.deepEqual(weekly?.remaining, 96);

  const monthly = report.buckets.find((bucket) => bucket.id === "monthly");
  assert.deepEqual(monthly?.used, 2);
  assert.deepEqual(monthly?.remaining, 98);

  assert.equal(formatUsageStatusline(report), "zen 0% r 4% w 2% m");
  assert.match(formatUsageReport(report, "current"), /OpenCode Go Usage · Current/);
  assert.match(formatUsageReport(report, "current"), /Rolling window:\s+\[█{20}\] 100% left \(resets /);
  assert.match(formatUsageReport(report, "current"), /Weekly window:\s+\[█{19}░\] 96% left/);
  assert.match(formatUsageReport(report, "current"), /Monthly window:\s+\[█{20}\] 98% left/);
});

test("OpenCode Zen adapter reports unknown-status windows as unavailable notes", () => {
  const report = normalizeOpenCodeZenPayload(
    {
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-08-15T12:34:04.072Z" },
        weekly: { status: "error", percent: 4, resetsAt: "2026-08-17T00:00:00.072Z" },
      },
    },
    600,
  );

  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0]?.id, "rolling");
  assert.match(report.notes?.join(" ") ?? "", /Weekly window unavailable/);
  assert.equal(formatUsageStatusline(report), "zen 10% r");
});

test("OpenCode Zen adapter displays rate-limited windows", () => {
  const report = normalizeOpenCodeZenPayload(
    {
      usage: {
        rolling: {
          status: "rate-limited",
          percent: 100,
          resetsAt: "2026-08-15T12:34:04.072Z",
        },
        weekly: { status: "ok", percent: 4, resetsAt: "2026-08-17T00:00:00.072Z" },
      },
    },
    700,
  );

  assert.equal(report.buckets.length, 2);
  assert.equal(report.buckets[0]?.id, "rolling");
  assert.equal(report.buckets[0]?.used, 100);
  assert.equal(report.buckets[0]?.remaining, 0);
  assert.equal(report.notes, undefined);
  assert.equal(formatUsageStatusline(report), "zen 100% r 4% w");
  assert.match(formatUsageReport(report, "current"), /Rolling window:\s+\[░{20}\] 0% left/);
});

test("OpenCode Zen adapter keeps fully rate-limited responses displayable", () => {
  const report = normalizeOpenCodeZenPayload(
    {
      usage: {
        rolling: { status: "rate-limited", percent: 100 },
        weekly: { status: "rate-limited", percent: 100 },
        monthly: { status: "rate-limited", percent: 100 },
      },
    },
    800,
  );

  assert.equal(report.buckets.length, 3);
  assert.equal(formatUsageStatusline(report), "zen 100% r 100% w 100% m");
});

test("OpenCode Zen adapter rejects empty or fully unavailable responses", () => {
  assert.throws(() => normalizeOpenCodeZenPayload({}, 0), /not an object/);
  assert.throws(
    () => normalizeOpenCodeZenPayload({ usage: { rolling: { status: "error" }, weekly: { status: "error" } } }, 0),
    /no displayable usage data/,
  );
});
