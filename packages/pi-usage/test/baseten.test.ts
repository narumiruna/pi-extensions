import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeBasetenBillingUsagePayload,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
  type UsageProviderAdapter,
} from "../src/index.js";

const BASETEN_MODEL = {
  id: "zai-org/GLM-5.2",
  name: "GLM-5.2",
  provider: "baseten",
  baseUrl: "https://inference.baseten.co/v1",
};

function basetenAdapter(): UsageProviderAdapter {
  const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === "baseten");
  assert.ok(candidate);
  return candidate;
}

const adapter = basetenAdapter();

function basetenAuth(secret = "baseten-test-secret"): ResolvedUsageAuth {
  return {
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    fingerprint: "fingerprint",
    secrets: [secret, `Bearer ${secret}`],
    model: BASETEN_MODEL as never,
  };
}

function billingPayload() {
  return {
    dedicated_usage: {
      total: "1000.00",
      credits_used: "100.00",
      subtotal: "900.00",
    },
    model_apis_usage: {
      total: "171.150000000000000001",
      credits_used: 5,
      subtotal: "166.150000000000000001",
    },
    training_usage: {
      total: "500.00",
      credits_used: "0",
      subtotal: "500.00",
    },
  };
}

test("Baseten billing reports only Model APIs gross, credits, and net spend", () => {
  const report = normalizeBasetenBillingUsagePayload(billingPayload(), 1_000);
  assert.equal(report.providerId, "baseten");
  assert.equal(report.source, "baseten-billing-usage-summary");
  assert.deepEqual(report.semantics, {
    kind: "api-key",
    label: "Organization Model APIs spend",
  });
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value, metric.currency]),
    [
      ["gross-usage", "171.150000000000000001", "USD"],
      ["credits-used", "5", "USD"],
      ["net-subtotal", "166.150000000000000001", "USD"],
    ],
  );
  const formatted = formatUsageReport(report, "current");
  assert.match(formatted, /^Baseten Model APIs Spend · Current/mu);
  assert.match(formatted, /Spend window:\s+Last 30 days/u);
  assert.match(formatted, /Gross usage:\s+USD 171\.150000000000000001/u);
  assert.doesNotMatch(formatted, /1000\.00|500\.00/u);
  assert.equal(formatUsageStatusline(report), "baseten USD 166.150000000000000001 net");
});

test("Baseten billing treats absent Model APIs usage as an empty provider report", () => {
  for (const payload of [{}, { dedicated_usage: {}, training_usage: {} }, { model_apis_usage: null }]) {
    const report = normalizeBasetenBillingUsagePayload(payload, 2_000);
    assert.deepEqual(report.metrics, []);
    assert.deepEqual(report.notes, ["Baseten returned no Model APIs usage for the last 30 days."]);
    assert.equal(formatUsageStatusline(report), "baseten no Model APIs usage");
  }
});

test("Baseten billing rejects malformed, negative, or ambiguous Model APIs money", () => {
  for (const payload of [
    { model_apis_usage: [] },
    { model_apis_usage: { total: "1", credits_used: "0", subtotal: "-1" } },
    { model_apis_usage: { total: "1e3", credits_used: "0", subtotal: "1" } },
    { model_apis_usage: { total: Number.NaN, credits_used: "0", subtotal: "1" } },
    { model_apis_usage: { total: "1", credits_used: {}, subtotal: "1" } },
    { model_apis_usage: { total: "9".repeat(65), credits_used: "0", subtotal: "1" } },
  ]) {
    assert.throws(
      () => normalizeBasetenBillingUsagePayload(payload, 0),
      /not an object|not a valid nonnegative amount/iu,
    );
  }
});

test("Baseten runtime auth accepts only official inference or management origins", async () => {
  const { ctx: officialContext } = createMockContext({
    model: BASETEN_MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        headers: {
          Authorization: "Bearer current-baseten-key",
          "X-Private": "must-not-send",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }),
      getAvailable: () => [BASETEN_MODEL],
      getAll: () => [BASETEN_MODEL],
    },
  });
  const auth = await resolveUsageAuth(officialContext, adapter);
  assert.deepEqual(auth?.headers, { Authorization: "Bearer current-baseten-key" });
  assert.ok(auth?.secrets.includes("must-not-send"));

  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    for (const [modelBaseUrl, authBaseUrl, pattern] of [
      ["https://proxy.example.test/v1", undefined, /custom.*official/iu],
      [BASETEN_MODEL.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
    ] as const) {
      const model = { ...BASETEN_MODEL, baseUrl: modelBaseUrl };
      const { ctx } = createMockContext({
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
          getProviderAuth: async () => ({
            auth: {
              apiKey: "must-not-send",
              ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
            },
          }),
          getAvailable: () => [model],
          getAll: () => [model],
        },
      });
      await assert.rejects(() => resolveUsageAuth(ctx, adapter), pattern);
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Baseten transport uses a trailing 30-day fixed management request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const nowMock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-30T12:34:56Z"));
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(billingPayload()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    let guardCalls = 0;
    const report = await queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000, async () => {
      guardCalls += 1;
    });
    assert.equal(report.providerId, "baseten");
    assert.equal(guardCalls, 2);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "https://api.baseten.co/v1/billing/usage_summary?start_date=2026-07-31T12%3A34%3A56.000Z&end_date=2026-08-30T12%3A34%3A56.000Z",
    );
    assert.equal(requests[0]?.init?.method, "GET");
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.deepEqual(requests[0]?.init?.headers, {
      Authorization: "Bearer baseten-test-secret",
      "User-Agent": "pi-usage",
    });
  } finally {
    nowMock.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("Baseten transport requires auth guards and rejects redirects or stale post-response auth", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(billingPayload()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(
      () => queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000),
      /request-boundary revalidation/iu,
    );
    assert.equal(fetchMock.mock.calls.length, 0);

    const redirected = new Response(JSON.stringify(billingPayload()), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValueOnce(redirected);
    await assert.rejects(
      () => queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000, async () => undefined),
      /refused a redirected response/iu,
    );

    let guardCalls = 0;
    await assert.rejects(
      () =>
        queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000, async () => {
          guardCalls += 1;
          if (guardCalls === 2) {
            throw Object.assign(new Error("stale auth"), { name: "AbortError" });
          }
        }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Baseten transport bounds bodies and redacts credential errors", async () => {
  const fetchMock = vi.fn(async () => new Response("x".repeat(70_000), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(
      () => queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000, async () => undefined),
      /exceeded.*bytes/iu,
    );
    fetchMock.mockResolvedValueOnce(
      new Response("Bearer baseten-test-secret failed\u001b[31m", {
        status: 401,
        statusText: "Denied",
      }),
    );
    await assert.rejects(
      () => queryProviderUsage(adapter, basetenAuth(), new AbortController().signal, 1_000, async () => undefined),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("401") &&
        !error.message.includes("baseten-test-secret") &&
        !error.message.includes("\u001b"),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
