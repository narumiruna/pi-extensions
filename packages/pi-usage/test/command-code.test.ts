import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  adapterForProvider,
  commandCodeOrgId,
  formatUsageReport,
  formatUsageStatusline,
  normalizeCommandCodeUsagePayload,
  queryProviderUsage,
  resolveUsageAuth,
} from "../src/index.js";

const ACCOUNT = {
  success: true,
  user: {
    id: "8c9d210f-0000-0000-0000-000da6d7fdec",
    name: "yanjieee",
    email: "yanjieee@example.test",
    userName: "yanjieee",
  },
  org: null,
};

const CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 67.3314357964,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.08658048, cap: 14, exceeded: false, resetAt: 1_790_666_524_172 },
    weekly: { used: 2.6685642036, cap: 35, exceeded: false, resetAt: 1_790_663_250_022 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
};

const SUBSCRIPTION = {
  success: true,
  data: {
    id: "sub_1UIN1JDSZgxV3MJKFicsVwdg",
    status: "active",
    planId: "individual-goat",
    currentPeriodStart: "2026-09-22T06:17:06.000Z",
    currentPeriodEnd: "2026-10-22T06:17:06.000Z",
  },
};

const USAGE = {
  totalCount: 1245,
  totalCost: 2.6721871936000006,
  totalTokensIn: 109_291_728,
  totalTokensOut: 883_023,
  totalTokens: 110_174_751,
  periodBasis: "billing-period",
};

const PERIOD_END_SECONDS = Math.floor(Date.parse("2026-10-22T06:17:06.000Z") / 1000);

test("Command Code adapter normalizes rolling USD windows, plan credits, and period totals", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: CREDITS, subscription: SUBSCRIPTION, usage: USAGE },
    500,
  );

  assert.equal(report.providerId, "command-code");
  assert.equal(report.providerName, "Command Code");
  assert.equal(report.accountLabel, "yanjieee");
  assert.equal(report.semantics.kind, "consumer-subscription");
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly", "monthly"],
  );

  const fiveHour = report.buckets[0];
  assert.equal(fiveHour?.unit, "usd");
  assert.equal(fiveHour?.windowMinutes, 300);
  assert.equal(fiveHour?.used, 0.08658048);
  assert.equal(fiveHour?.limit, 14);
  assert.equal(fiveHour?.remaining, 14 - 0.08658048);
  // Command Code reports `resetAt` in milliseconds; buckets keep epoch seconds.
  assert.equal(fiveHour?.resetsAt, 1_790_666_524);

  const weekly = report.buckets[1];
  assert.equal(weekly?.windowMinutes, 10_080);
  assert.equal(weekly?.resetsAt, 1_790_663_250);

  const monthly = report.buckets[2];
  assert.equal(monthly?.used, USAGE.totalCost);
  assert.equal(monthly?.remaining, CREDITS.credits.monthlyCredits);
  assert.equal(monthly?.limit, USAGE.totalCost + CREDITS.credits.monthlyCredits);
  assert.equal(monthly?.period, "billing-period");
  assert.equal(monthly?.resetsAt, PERIOD_END_SECONDS);

  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["plan", "GOAT (active)"],
      ["requests", 1245],
      ["tokens", 110_174_751],
    ],
  );
  assert.equal(report.notes, undefined);

  assert.equal(formatUsageStatusline(report), "cmd 99% 5h 92% wk 96% mo");
  const text = formatUsageReport(report, "current");
  assert.match(text, /Command Code Usage · Current/);
  assert.match(text, /Semantics: Command Code plan credits and rolling limits/);
  assert.match(text, /Five-hour window:\s+\$0\.09 of \$14\.00 used · 99% left/);
  assert.match(text, /Weekly window:\s+\$2\.67 of \$35\.00 used · 92% left/);
  assert.match(text, /Monthly credits:\s+\$2\.67 of \$70\.00 used · 96% left/);
  assert.match(text, /Plan:\s+GOAT \(active\)/);
  assert.match(text, /Tokens this period:\s+110174751/);
});

test("Command Code adapter degrades to plan and rolling windows when period usage is unavailable", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: CREDITS, subscription: SUBSCRIPTION },
    600,
  );

  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly"],
  );
  const metricIds = report.metrics.map((metric) => metric.id);
  assert.deepEqual(metricIds, ["plan", "monthly-credits"]);
  assert.equal(report.metrics[1]?.value, CREDITS.credits.monthlyCredits);
  assert.match(report.notes?.join(" ") ?? "", /billing-period usage was unavailable/);
  assert.equal(formatUsageStatusline(report), "cmd 99% 5h 92% wk");
});

test("Command Code adapter reports unavailable sections and disabled rolling limits", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: { ...CREDITS, windowLimits: { limited: false, fiveHour: null, weekly: null } } },
    700,
  );

  assert.equal(report.buckets.length, 0);
  assert.equal(formatUsageStatusline(report), undefined);
  assert.deepEqual(
    report.metrics.map((metric) => metric.id),
    ["monthly-credits"],
  );
  assert.match(report.notes?.join(" ") ?? "", /not enabled for this plan/);
  assert.match(report.notes?.join(" ") ?? "", /plan details were unavailable/);
  assert.match(report.notes?.join(" ") ?? "", /billing-period usage was unavailable/);
});

test("Command Code adapter keeps purchased, free, and input/output token metrics", () => {
  const report = normalizeCommandCodeUsagePayload(
    {
      account: ACCOUNT,
      credits: { credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 1 } },
      usage: { totalCost: 4, totalCount: 3, totalTokensIn: 20, totalTokensOut: 5 },
    },
    800,
  );

  const values = new Map(report.metrics.map((metric) => [metric.id, metric.value]));
  assert.equal(values.get("purchased-credits"), 5);
  assert.equal(values.get("free-credits"), 1);
  assert.equal(values.get("tokens-in"), 20);
  assert.equal(values.get("tokens-out"), 5);
  assert.equal(values.get("tokens"), undefined);
  const monthly = report.buckets.find((bucket) => bucket.id === "monthly");
  assert.equal(monthly?.limit, 20);
  assert.equal(monthly?.remaining, 16);
});

test("Command Code adapter treats second-valued reset timestamps as already seconds", () => {
  const report = normalizeCommandCodeUsagePayload(
    {
      account: ACCOUNT,
      credits: {
        credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 1, cap: 2, resetAt: 1_790_666_524 } },
      },
    },
    900,
  );

  assert.equal(report.buckets[0]?.resetsAt, 1_790_666_524);
});

test("Command Code adapter rejects responses without a safe account or displayable data", () => {
  assert.throws(() => normalizeCommandCodeUsagePayload({ account: { user: { userName: "   " } } }, 0), /account name/);
  assert.throws(
    () => normalizeCommandCodeUsagePayload({ account: ACCOUNT, credits: { credits: "nope" } }, 0),
    /no displayable usage data/,
  );
});

test("Command Code organisation ids are optional and bounded", () => {
  assert.equal(commandCodeOrgId(ACCOUNT), undefined);
  assert.equal(commandCodeOrgId({ org: { id: "org_abc-123" } }), "org_abc-123");
  assert.equal(commandCodeOrgId({ org: { id: "bad id" } }), undefined);
  assert.equal(commandCodeOrgId({ org: { id: "x".repeat(200) } }), undefined);
});

test("Command Code usage resolves stored Bearer auth and queries the alpha endpoints in order", async () => {
  const adapter = adapterForProvider("command-code");
  assert.ok(adapter);
  assert.equal(adapter.id, "command-code");
  const model = {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "command-code",
    baseUrl: "https://api.commandcode.ai/provider",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "runtime-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "stored-key", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/alpha/whoami")
      ? ACCOUNT
      : url.includes("/alpha/billing/credits")
        ? CREDITS
        : url.includes("/alpha/billing/subscriptions")
          ? SUBSCRIPTION
          : url.includes("/alpha/usage/summary")
            ? USAGE
            : undefined;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
  });
  try {
    const auth = await resolveUsageAuth(ctx, adapter);
    assert.ok(auth);
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 2_000, async () => undefined);

    assert.deepEqual(
      fetchMock.mock.calls.map((call) => String(call[0])),
      [
        "https://api.commandcode.ai/alpha/whoami",
        "https://api.commandcode.ai/alpha/billing/credits",
        "https://api.commandcode.ai/alpha/billing/subscriptions",
        `https://api.commandcode.ai/alpha/usage/summary?since=${encodeURIComponent(SUBSCRIPTION.data.currentPeriodStart)}`,
      ],
    );
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer runtime-key");
    }
    assert.equal(report.providerId, "command-code");
    assert.equal(report.buckets.length, 3);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Command Code usage rejects custom model origins before fetching", async () => {
  const adapter = adapterForProvider("command-code");
  assert.ok(adapter);
  const model = {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "command-code",
    baseUrl: "https://proxy.example.test/provider",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "runtime-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "runtime-key" } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });

  await assert.rejects(() => resolveUsageAuth(ctx, adapter), /custom provider base URL/);
});
