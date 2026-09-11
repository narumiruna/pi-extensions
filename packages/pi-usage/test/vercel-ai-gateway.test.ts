import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeVercelAIGatewayCreditsPayload,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
  type UsageProviderAdapter,
} from "../src/index.js";

const VERCEL_MODEL = {
  id: "anthropic/claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
  provider: "vercel-ai-gateway",
  baseUrl: "https://ai-gateway.vercel.sh",
};

function vercelAdapter(): UsageProviderAdapter {
  const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === "vercel-ai-gateway");
  assert.ok(candidate);
  return candidate;
}

const adapter = vercelAdapter();

function vercelAuth(secret = "vercel-test-secret"): ResolvedUsageAuth {
  return {
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    fingerprint: "fingerprint",
    secrets: [secret, `Bearer ${secret}`],
    model: VERCEL_MODEL as never,
  };
}

function queryVercel(
  signal = new AbortController().signal,
  timeoutMs = 1_000,
  guard: () => Promise<void> = async () => undefined,
) {
  return queryProviderUsage(adapter, vercelAuth(), signal, timeoutMs, guard);
}

test("Vercel AI Gateway credits preserve decimal strings and native semantics", () => {
  const report = normalizeVercelAIGatewayCreditsPayload(
    { balance: "95.500000000000000001", total_used: "4.499999999999999999" },
    1_000,
  );

  assert.equal(report.providerId, "vercel-ai-gateway");
  assert.equal(report.source, "vercel-ai-gateway-credits");
  assert.deepEqual(report.semantics, {
    kind: "api-key",
    label: "AI Gateway credits and lifetime spend",
  });
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value, metric.currency]),
    [
      ["credit-balance", "95.500000000000000001", "USD"],
      ["lifetime-spend", "4.499999999999999999", "USD"],
    ],
  );
  const formatted = formatUsageReport(report, "current");
  assert.match(formatted, /^Vercel AI Gateway Credits · Current/mu);
  assert.match(formatted, /Credit balance:\s+USD 95\.500000000000000001/u);
  assert.match(formatted, /Lifetime spend:\s+USD 4\.499999999999999999/u);
  assert.equal(formatUsageStatusline(report), "vercel USD 95.500000000000000001 left");
});

test("Vercel AI Gateway credits reject malformed or ambiguous monetary fields", () => {
  for (const payload of [
    {},
    { balance: 95.5, total_used: "4.5" },
    { balance: "-1", total_used: "4.5" },
    { balance: "1e3", total_used: "4.5" },
    { balance: "1", total_used: "NaN" },
    { balance: "9".repeat(65), total_used: "0" },
  ]) {
    assert.throws(() => normalizeVercelAIGatewayCreditsPayload(payload, 0), /not a valid nonnegative amount/iu);
  }
});

test("Vercel AI Gateway runtime auth accepts only the official model and auth origin", async () => {
  const { ctx: officialContext } = createMockContext({
    model: VERCEL_MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        headers: {
          Authorization: "Bearer current-vercel-key",
          "X-Private": "must-not-send",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }),
      getAvailable: () => [VERCEL_MODEL],
      getAll: () => [VERCEL_MODEL],
    },
  });
  const auth = await resolveUsageAuth(officialContext, adapter);
  assert.deepEqual(auth?.headers, { Authorization: "Bearer current-vercel-key" });
  assert.ok(auth?.secrets.includes("must-not-send"));

  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    for (const [modelBaseUrl, authBaseUrl, pattern] of [
      ["https://proxy.example.test/v1", undefined, /custom.*official/iu],
      [VERCEL_MODEL.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
    ] as const) {
      const model = { ...VERCEL_MODEL, baseUrl: modelBaseUrl };
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

test("Vercel AI Gateway transport revalidates around the fixed no-redirect request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let guardCalls = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ balance: "95.50", total_used: "4.50" }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const report = await queryVercel(undefined, 1_000, async () => {
      guardCalls += 1;
    });
    assert.equal(report.providerId, "vercel-ai-gateway");
    assert.equal(guardCalls, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://ai-gateway.vercel.sh/v1/credits");
    assert.equal(requests[0]?.init?.method, "GET");
    assert.equal(requests[0]?.init?.redirect, "error");
    assert.deepEqual(requests[0]?.init?.headers, {
      Authorization: "Bearer vercel-test-secret",
      "User-Agent": "pi-usage",
    });

    const redirected = new Response(JSON.stringify({ balance: "1", total_used: "1" }), {
      status: 200,
    });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValueOnce(redirected);
    await assert.rejects(() => queryVercel(), /refused a redirected response/iu);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Vercel AI Gateway transport fails before or after network access when auth becomes stale", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ balance: "95.50", total_used: "4.50" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(
      () => queryProviderUsage(adapter, vercelAuth(), new AbortController().signal, 1_000),
      /request-boundary revalidation/iu,
    );
    assert.equal(fetchMock.mock.calls.length, 0);

    let guardCalls = 0;
    await assert.rejects(
      () =>
        queryVercel(undefined, 1_000, async () => {
          guardCalls += 1;
          if (guardCalls === 2) {
            throw Object.assign(new Error("stale auth"), { name: "AbortError" });
          }
        }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Vercel AI Gateway transport bounds response bodies and redacts credentials", async () => {
  const fetchMock = vi.fn(async () => new Response("x".repeat(70_000), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(() => queryVercel(), /exceeded.*bytes/iu);
    fetchMock.mockResolvedValueOnce(
      new Response("Bearer vercel-test-secret failed\u001b[31m", {
        status: 401,
        statusText: "Denied",
      }),
    );
    await assert.rejects(
      () => queryVercel(),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("401") &&
        !error.message.includes("vercel-test-secret") &&
        !error.message.includes("\u001b"),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
