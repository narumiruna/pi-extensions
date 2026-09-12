import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  formatUsageReport,
  formatUsageStatusline,
  type KimiCodingUsagePayload,
  normalizeKimiCodingUsagePayload,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
} from "../src/index.js";

const KIMI_MODEL = {
  id: "kimi-k2",
  name: "Kimi K2",
  provider: "kimi-coding",
  baseUrl: "https://api.kimi.com/coding",
};

const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "kimi-coding");
const TERMINAL_ESCAPE = String.fromCharCode(27);
assert.ok(adapter);

function fixture(name: string): KimiCodingUsagePayload {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/kimi-coding-${name}.json`, import.meta.url), "utf8"),
  ) as KimiCodingUsagePayload;
}

function kimiAuth(secret = "kimi-test-secret"): ResolvedUsageAuth {
  return {
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    fingerprint: "fingerprint",
    secrets: [secret, `Bearer ${secret}`],
    model: KIMI_MODEL as never,
  };
}

function combinedPlanFixture(): KimiCodingUsagePayload {
  return {
    ...fixture("weekly"),
    limits: fixture("five-hour").limits,
  };
}

test("Kimi fixtures are sanitized and contain no credential or account fields", () => {
  for (const name of ["weekly", "five-hour", "daily", "malformed", "booster-wallet", "empty"]) {
    const text = readFileSync(new URL(`./fixtures/kimi-coding-${name}.json`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /authorization|access_token|refresh_token|api[_-]?key|email/iu);
  }
});

test("Kimi adapter normalizes weekly, five-hour, and daily numeric-string windows", () => {
  const report = normalizeKimiCodingUsagePayload(combinedPlanFixture(), 500);
  assert.equal(report.providerId, "kimi-coding");
  assert.equal(report.providerName, "Kimi For Coding");
  assert.equal(report.source, "kimi-managed-usage");
  assert.deepEqual(report.semantics, {
    kind: "consumer-subscription",
    label: "Kimi Coding Plan usage",
  });
  assert.deepEqual(report.buckets, [
    {
      id: "five-hour",
      label: "Five-hour limit",
      used: 1,
      remaining: 99,
      limit: 100,
      unit: "count",
      windowMinutes: 300,
      resetsAt: 1_893_474_000,
    },
    {
      id: "weekly",
      label: "Weekly window",
      used: 40,
      remaining: 960,
      limit: 1_000,
      unit: "count",
      windowMinutes: 10_080,
      resetsAt: 1_893_974_400,
    },
  ]);
  assert.equal(formatUsageStatusline(report), "kimi 99% 5h 96% wk");
  assert.match(formatUsageReport(report, "current"), /1 of 100 used · 99% left.*resets/);
  assert.match(formatUsageReport(report, "current"), /40 of 1000 used · 96% left.*resets/);

  const daily = normalizeKimiCodingUsagePayload(fixture("daily"), 600);
  assert.deepEqual(daily.buckets[0], {
    id: "daily",
    label: "Daily cap",
    used: 5,
    remaining: 95,
    limit: 100,
    unit: "count",
    windowMinutes: 1_440,
    resetsAt: 1_893_542_400,
  });
  assert.equal(formatUsageStatusline(daily), "kimi 95% 1d");
});

test("Kimi adapter omits malformed, duplicate, unknown, and unsafe window fields", () => {
  const report = normalizeKimiCodingUsagePayload(fixture("malformed"), 700);
  assert.equal(report.buckets.length, 1);
  assert.deepEqual(report.buckets[0], {
    id: "daily",
    label: "Daily cap",
    used: 5,
    remaining: 95,
    limit: 100,
    unit: "count",
    windowMinutes: 1_440,
  });
  assert.deepEqual(report.notes, ["Unsupported, malformed, or duplicate plan windows were unavailable."]);
  const rendered = formatUsageReport(report, "current");
  assert.equal(rendered.includes(TERMINAL_ESCAPE), false);
  assert.doesNotMatch(rendered, /unknown-window/u);

  const oversized = fixture("daily") as { limits?: Record<string, unknown>[] };
  const first = oversized.limits?.[0];
  if (first) first.name = `safe${"x".repeat(10_000)}\u001b[31m`;
  const oversizedReport = normalizeKimiCodingUsagePayload(oversized, 800);
  assert.ok((oversizedReport.buckets[0]?.label.length ?? 0) <= 80);
  assert.equal((oversizedReport.buckets[0]?.label ?? "").includes(TERMINAL_ESCAPE), false);

  const impossibleTimestamp = fixture("daily") as { limits?: Record<string, unknown>[] };
  const detail = impossibleTimestamp.limits?.[0]?.detail as Record<string, unknown> | undefined;
  if (detail) detail.resetTime = "2030-02-30T00:00:00Z";
  assert.equal(normalizeKimiCodingUsagePayload(impossibleTimestamp, 850).buckets[0]?.resetsAt, undefined);
});

test("Kimi adapter keeps booster-wallet currency separate from plan counts", () => {
  const report = normalizeKimiCodingUsagePayload(fixture("booster-wallet"), 900);
  assert.deepEqual(report.buckets, []);
  assert.deepEqual(report.metrics, [
    { id: "booster-balance", label: "Balance", value: 100, unit: "currency", currency: "USD" },
    {
      id: "booster-total",
      label: "Total balance",
      value: 200,
      unit: "currency",
      currency: "USD",
    },
    {
      id: "booster-monthly-used",
      label: "Used this month",
      value: 50,
      unit: "currency",
      currency: "USD",
    },
    {
      id: "booster-monthly-limit",
      label: "Monthly limit",
      value: 200,
      unit: "currency",
      currency: "USD",
    },
  ]);
  const rendered = formatUsageReport(report, "current");
  assert.match(rendered, /Extra usage wallet:/);
  assert.match(rendered, /Balance:\s+\$100\.00 of \$200\.00/);
  assert.match(rendered, /Used this month:\s+\$50\.00/);
  assert.match(rendered, /Monthly limit:\s+\$200\.00/);
  assert.doesNotMatch(rendered, /requests|% left/iu);
  assert.equal(formatUsageStatusline(report), undefined);
});

test("Kimi booster wallet omits unverifiable currency and absent monthly fields", () => {
  const missingCurrency = {
    ...combinedPlanFixture(),
    ...fixture("booster-wallet"),
  } as KimiCodingUsagePayload & {
    boosterWallet?: {
      monthlyChargeLimit?: Record<string, unknown>;
      monthlyUsed?: Record<string, unknown>;
    };
  };
  assert.ok(missingCurrency.boosterWallet);
  delete missingCurrency.boosterWallet.monthlyChargeLimit;
  delete missingCurrency.boosterWallet.monthlyUsed;
  assert.deepEqual(normalizeKimiCodingUsagePayload(missingCurrency, 925).metrics, []);

  const conflicting = {
    ...combinedPlanFixture(),
    ...fixture("booster-wallet"),
  } as KimiCodingUsagePayload & {
    boosterWallet?: { monthlyUsed?: Record<string, unknown> };
  };
  assert.ok(conflicting.boosterWallet?.monthlyUsed);
  conflicting.boosterWallet.monthlyUsed.currency = "CNY";
  assert.deepEqual(normalizeKimiCodingUsagePayload(conflicting, 930).metrics, []);

  const partial = fixture("booster-wallet") as KimiCodingUsagePayload & {
    boosterWallet?: { monthlyUsed?: Record<string, unknown> };
  };
  assert.ok(partial.boosterWallet);
  delete partial.boosterWallet.monthlyUsed;
  const partialReport = normalizeKimiCodingUsagePayload(partial, 935);
  assert.deepEqual(
    partialReport.metrics.map((metric) => metric.id),
    ["booster-balance", "booster-total", "booster-monthly-limit"],
  );
  assert.doesNotMatch(formatUsageReport(partialReport, "current"), /Used this month:/u);

  const withoutCurrency = normalizeKimiCodingUsagePayload(fixture("booster-wallet"), 940);
  withoutCurrency.metrics = withoutCurrency.metrics.map(({ currency: _currency, ...metric }) => metric);
  const rendered = formatUsageReport(withoutCurrency, "current");
  assert.match(rendered, /Balance:\s+unavailable of unavailable/u);
  assert.doesNotMatch(rendered, /\$\d/u);
});

test("Kimi booster wallet honors an enabled zero-dollar monthly cap", () => {
  const payload = fixture("booster-wallet") as KimiCodingUsagePayload & {
    boosterWallet?: { monthlyChargeLimit?: Record<string, unknown> };
  };
  assert.ok(payload.boosterWallet?.monthlyChargeLimit);
  payload.boosterWallet.monthlyChargeLimit.priceInCents = "0";
  const report = normalizeKimiCodingUsagePayload(payload, 945);
  assert.equal(report.metrics.find((metric) => metric.id === "booster-monthly-limit")?.value, 0);
  assert.match(formatUsageReport(report, "current"), /Monthly limit:\s+\$0\.00/u);
});

test("Kimi booster wallet preserves first-party minimum cents and unlimited monthly limits", () => {
  const payload = fixture("booster-wallet") as {
    boosterWallet?: {
      balance?: Record<string, unknown>;
      monthlyChargeLimitEnabled?: boolean;
      monthlyChargeLimit?: Record<string, unknown>;
      monthlyUsed?: Record<string, unknown>;
    };
  };
  const wallet = payload.boosterWallet;
  assert.ok(wallet?.balance);
  wallet.balance.amount = "1";
  delete wallet.balance.amountLeft;
  wallet.monthlyChargeLimitEnabled = false;
  delete wallet.monthlyChargeLimit;
  if (wallet.monthlyUsed) wallet.monthlyUsed.currency = "CNY";
  const report = normalizeKimiCodingUsagePayload(payload, 950);
  assert.equal(report.metrics.find((metric) => metric.id === "booster-balance")?.value, 0);
  assert.equal(report.metrics.find((metric) => metric.id === "booster-total")?.value, 0.01);
  assert.equal(report.metrics.find((metric) => metric.id === "booster-monthly-limit")?.value, "unlimited");
  assert.match(formatUsageReport(report, "current"), /Balance:\s+¥0\.00 of ¥0\.01/);
});

test("Kimi adapter rejects empty data and never invents missing counts or future units", () => {
  assert.throws(() => normalizeKimiCodingUsagePayload(fixture("empty"), 0), /no displayable usage data/iu);
  assert.throws(
    () =>
      normalizeKimiCodingUsagePayload(
        {
          limits: [
            {
              window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" },
              detail: { used: "1", limit: "10" },
            },
          ],
        },
        0,
      ),
    /no displayable usage data/iu,
  );
  assert.throws(() => normalizeKimiCodingUsagePayload({ usage: { limit: "10" } }, 0), /no displayable usage data/iu);
});

test("Kimi runtime auth accepts fresh OAuth and API-key bearers only at the official origin", async () => {
  const { ctx: oauthContext } = createMockContext({
    model: KIMI_MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        headers: { Authorization: "Bearer oauth-access", "X-Private": "do-not-send" },
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "provider-default", baseUrl: KIMI_MODEL.baseUrl },
      }),
      getAvailable: () => [KIMI_MODEL],
      getAll: () => [KIMI_MODEL],
    },
  });
  const oauth = await resolveUsageAuth(oauthContext, adapter);
  assert.deepEqual(oauth?.headers, { Authorization: "Bearer oauth-access" });
  assert.ok(oauth?.secrets.includes("do-not-send"));

  const { ctx: apiKeyContext } = createMockContext({
    model: KIMI_MODEL,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: "kimi-api-key", baseUrl: KIMI_MODEL.baseUrl },
      }),
      getAvailable: () => [KIMI_MODEL],
      getAll: () => [KIMI_MODEL],
    },
  });
  const apiKey = await resolveUsageAuth(apiKeyContext, adapter);
  assert.deepEqual(apiKey?.headers, {
    Authorization: "Bearer kimi-api-key",
  });
  assert.notEqual(oauth?.fingerprint, apiKey?.fingerprint);

  for (const [modelBaseUrl, authBaseUrl, pattern] of [
    ["https://proxy.example.test/coding", undefined, /custom.*official/iu],
    [KIMI_MODEL.baseUrl, "https://proxy.example.test/coding", /proxy-resolved.*official/iu],
  ] as const) {
    const model = { ...KIMI_MODEL, baseUrl: modelBaseUrl };
    const { ctx } = createMockContext({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
        getProviderAuth: async () => ({
          auth: { apiKey: "must-not-send", ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}) },
        }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    await assert.rejects(() => resolveUsageAuth(ctx, adapter), pattern);
  }

  const { ctx: missingContext } = createMockContext({
    model: KIMI_MODEL,
    modelRegistry: {
      getProviderAuth: async () => undefined,
      getAvailable: () => [KIMI_MODEL],
      getAll: () => [KIMI_MODEL],
    },
  });
  assert.equal(await resolveUsageAuth(missingContext, adapter), undefined);
});

test("Kimi transport uses only the fixed endpoint and rejects redirects", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(combinedPlanFixture()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const report = await queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 1_000);
    assert.equal(report.providerId, "kimi-coding");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(requests[0]?.init?.method, "GET");
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.deepEqual(requests[0]?.init?.headers, {
      Authorization: "Bearer kimi-test-secret",
      "User-Agent": "pi-usage",
    });

    const redirected = new Response(JSON.stringify(combinedPlanFixture()), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValueOnce(redirected);
    await assert.rejects(
      () => queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 1_000),
      /refused a redirected response/iu,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Kimi transport bounds timeout, cancellation, bodies, JSON, and redacted errors", async () => {
  const fetchMock = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(() => queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 5), /Timed out/iu);
    const controller = new AbortController();
    const cancelled = queryProviderUsage(adapter, kimiAuth(), controller.signal, 1_000);
    controller.abort();
    await assert.rejects(
      () => cancelled,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    fetchMock.mockResolvedValueOnce(new Response("x".repeat(70_000), { status: 200 }));
    await assert.rejects(
      () => queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 1_000),
      /exceeded.*bytes/iu,
    );

    fetchMock.mockResolvedValueOnce(new Response("{broken", { status: 200 }));
    await assert.rejects(
      () => queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 1_000),
      /invalid JSON/iu,
    );

    fetchMock.mockResolvedValueOnce(
      new Response("Bearer kimi-test-secret failed", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    await assert.rejects(
      () => queryProviderUsage(adapter, kimiAuth(), new AbortController().signal, 1_000),
      (error: unknown) =>
        error instanceof Error &&
        /error.*401|returned 401/iu.test(error.message) &&
        !error.message.includes("kimi-test-secret"),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
