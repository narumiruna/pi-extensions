import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeMoonshotBalancePayload,
  providerIsConfigured,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
  type UsageProviderAdapter,
} from "../src/index.js";

const MODELS = {
  moonshotai: {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshotai",
    baseUrl: "https://api.moonshot.ai/v1",
  },
  "moonshotai-cn": {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshotai-cn",
    baseUrl: "https://api.moonshot.cn/v1",
  },
} as const;

type ProviderId = keyof typeof MODELS;

const UNRELATED_MODEL = {
  id: "unrelated",
  name: "Unrelated",
  provider: "unrelated",
  baseUrl: "https://unrelated.example.test/v1",
};

function moonshotAdapter(providerId: ProviderId): UsageProviderAdapter {
  const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === providerId);
  assert.ok(candidate);
  return candidate;
}

function moonshotAuth(providerId: ProviderId, secret = "moonshot-test-secret"): ResolvedUsageAuth {
  return {
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    fingerprint: "fingerprint",
    secrets: [secret, `Bearer ${secret}`],
    model: MODELS[providerId] as never,
  };
}

function successPayload() {
  return {
    code: 0,
    data: {
      available_balance: 49.58894,
      voucher_balance: 46.58893,
      cash_balance: 3.00001,
    },
    scode: "0x0",
    status: true,
  };
}

test("Moonshot balances retain region currency and separate account components", () => {
  for (const [providerId, currency, title] of [
    ["moonshotai", "USD", "Moonshot AI Balance"],
    ["moonshotai-cn", "CNY", "Moonshot AI CN Balance"],
  ] as const) {
    const report = normalizeMoonshotBalancePayload(providerId, successPayload(), 1_000);
    assert.equal(report.providerId, providerId);
    assert.equal(report.source, "moonshot-balance");
    assert.deepEqual(report.semantics, {
      kind: "api-key",
      label: "Moonshot API account balance",
    });
    assert.deepEqual(
      report.metrics.map((metric) => [metric.id, metric.value, metric.currency]),
      [
        ["available-balance", "49.58894", currency],
        ["voucher-balance", "46.58893", currency],
        ["cash-balance", "3.00001", currency],
      ],
    );
    const formatted = formatUsageReport(report, "current");
    assert.match(formatted, new RegExp(`^${title} · Current`, "mu"));
    assert.match(formatted, new RegExp(`Available balance:\\s+${currency} 49\\.58894`, "u"));
    assert.equal(formatUsageStatusline(report), `moonshot ${currency} 49.58894`);
  }
});

test("Moonshot balance preserves a negative cash component without making available credit negative", () => {
  const report = normalizeMoonshotBalancePayload(
    "moonshotai",
    {
      code: 0,
      data: { available_balance: 10, voucher_balance: 10, cash_balance: -2.5 },
      status: true,
    },
    2_000,
  );
  assert.equal(report.metrics.find((metric) => metric.id === "cash-balance")?.value, "-2.5");
  assert.match(formatUsageReport(report, "configured"), /Cash balance:\s+USD -2\.5/u);
});

test("Moonshot balance rejects failed, incomplete, or hostile responses", () => {
  for (const payload of [
    {},
    { ...successPayload(), code: 1 },
    { ...successPayload(), status: false },
    { code: 0, status: true, data: null },
    { code: 0, status: true, data: { ...successPayload().data, available_balance: -1 } },
    { code: 0, status: true, data: { ...successPayload().data, voucher_balance: Number.NaN } },
    { code: 0, status: true, data: { ...successPayload().data, cash_balance: "3" } },
    {
      code: 0,
      status: true,
      data: { ...successPayload().data, cash_balance: Number.MAX_SAFE_INTEGER + 1 },
    },
  ]) {
    assert.throws(
      () => normalizeMoonshotBalancePayload("moonshotai", payload, 0),
      /not report success|not an object|not a valid amount/iu,
    );
  }
});

test("Moonshot shared environment auth is limited to the selected region", async () => {
  const globalModel = MODELS.moonshotai;
  const resolvedProviders: string[] = [];
  const { ctx } = createMockContext({
    model: globalModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "shared-environment-key" }),
      getProviderAuth: async (providerId: string) => {
        resolvedProviders.push(providerId);
        return { auth: { apiKey: "shared-environment-key" } };
      },
      getProviderAuthStatus: () => ({
        configured: true,
        source: "environment" as const,
        label: "MOONSHOT_API_KEY",
      }),
      getAvailable: () => Object.values(MODELS),
      getAll: () => Object.values(MODELS),
    },
  });

  assert.equal(providerIsConfigured(ctx, "moonshotai"), true);
  assert.equal(providerIsConfigured(ctx, "moonshotai-cn"), false);
  assert.ok(await resolveUsageAuth(ctx, moonshotAdapter("moonshotai")));
  assert.equal(await resolveUsageAuth(ctx, moonshotAdapter("moonshotai-cn")), undefined);
  assert.deepEqual(resolvedProviders, ["moonshotai"]);
});

test("Moonshot sibling accepts provider-specific environment credentials", async () => {
  for (const [providerId, label] of [
    ["moonshotai", "MOONSHOT_GLOBAL_API_KEY"],
    ["moonshotai-cn", "MOONSHOT_CN_API_KEY"],
  ] as const) {
    const { ctx } = createMockContext({
      model: UNRELATED_MODEL,
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: `${providerId}-key` } }),
        getProviderAuthStatus: () => ({
          configured: true,
          source: "environment" as const,
          label,
        }),
        getAvailable: () => Object.values(MODELS),
        getAll: () => Object.values(MODELS),
      },
    });

    assert.equal(providerIsConfigured(ctx, providerId), true);
    assert.deepEqual((await resolveUsageAuth(ctx, moonshotAdapter(providerId)))?.headers, {
      Authorization: `Bearer ${providerId}-key`,
    });
  }
});

test("Moonshot sibling revalidates credential provenance throughout resolution", async () => {
  let source: "environment" | "stored" = "stored";
  let label: string | undefined;
  let changeSourceDuringResolution = false;
  const { ctx } = createMockContext({
    model: UNRELATED_MODEL,
    modelRegistry: {
      getProviderAuth: async () => {
        if (changeSourceDuringResolution) {
          source = "environment";
          label = "MOONSHOT_API_KEY";
        }
        return { auth: { apiKey: `${source}-key` } };
      },
      getProviderAuthStatus: () => ({ configured: true, source, label }),
      getAvailable: () => Object.values(MODELS),
      getAll: () => Object.values(MODELS),
    },
  });

  assert.equal(providerIsConfigured(ctx, "moonshotai-cn"), true);
  assert.ok(await resolveUsageAuth(ctx, moonshotAdapter("moonshotai-cn")));
  changeSourceDuringResolution = true;
  assert.equal(await resolveUsageAuth(ctx, moonshotAdapter("moonshotai-cn")), undefined);
  assert.equal(providerIsConfigured(ctx, "moonshotai-cn"), false);
});

test("Moonshot runtime auth keeps Global and China credentials on their official origin", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    for (const providerId of ["moonshotai", "moonshotai-cn"] as const) {
      const model = MODELS[providerId];
      const adapter = moonshotAdapter(providerId);
      const { ctx } = createMockContext({
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            headers: {
              Authorization: `Bearer ${providerId}-key`,
              "X-Private": "must-not-send",
            },
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }),
          getAvailable: () => [model],
          getAll: () => [model],
        },
      });
      const auth = await resolveUsageAuth(ctx, adapter);
      assert.deepEqual(auth?.headers, { Authorization: `Bearer ${providerId}-key` });
      assert.ok(auth?.secrets.includes("must-not-send"));

      for (const [modelBaseUrl, authBaseUrl, pattern] of [
        ["https://proxy.example.test/v1", undefined, /custom.*official/iu],
        [model.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
      ] as const) {
        const rejectedModel = { ...model, baseUrl: modelBaseUrl };
        const { ctx: rejectedContext } = createMockContext({
          model: rejectedModel,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
            getProviderAuth: async () => ({
              auth: {
                apiKey: "must-not-send",
                ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
              },
            }),
            getAvailable: () => [rejectedModel],
            getAll: () => [rejectedModel],
          },
        });
        await assert.rejects(() => resolveUsageAuth(rejectedContext, adapter), pattern);
      }
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Moonshot transport uses only its region endpoint and revalidates around the request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(successPayload()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    for (const [providerId, expectedUrl] of [
      ["moonshotai", "https://api.moonshot.ai/v1/users/me/balance"],
      ["moonshotai-cn", "https://api.moonshot.cn/v1/users/me/balance"],
    ] as const) {
      let guardCalls = 0;
      const report = await queryProviderUsage(
        moonshotAdapter(providerId),
        moonshotAuth(providerId),
        new AbortController().signal,
        1_000,
        async () => {
          guardCalls += 1;
        },
      );
      assert.equal(report.providerId, providerId);
      assert.equal(guardCalls, 2);
      const request = requests.at(-1);
      assert.equal(request?.url, expectedUrl);
      assert.equal(request?.init?.method, "GET");
      assert.equal(request?.init?.redirect, "error");
      assert.deepEqual(request?.init?.headers, {
        Authorization: "Bearer moonshot-test-secret",
        "User-Agent": "pi-usage",
      });
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Moonshot transport bounds timeout, response bodies, and credential errors", async () => {
  const adapter = moonshotAdapter("moonshotai");
  const fetchMock = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(
      () =>
        queryProviderUsage(adapter, moonshotAuth("moonshotai"), new AbortController().signal, 5, async () => undefined),
      /Timed out/iu,
    );
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(70_000), { status: 200 }));
    await assert.rejects(
      () =>
        queryProviderUsage(
          adapter,
          moonshotAuth("moonshotai"),
          new AbortController().signal,
          1_000,
          async () => undefined,
        ),
      /exceeded.*bytes/iu,
    );
    fetchMock.mockResolvedValueOnce(
      new Response("Bearer moonshot-test-secret failed\u001b[31m", {
        status: 401,
        statusText: "Denied",
      }),
    );
    await assert.rejects(
      () =>
        queryProviderUsage(
          adapter,
          moonshotAuth("moonshotai"),
          new AbortController().signal,
          1_000,
          async () => undefined,
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("401") &&
        !error.message.includes("moonshot-test-secret") &&
        !error.message.includes("\u001b"),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Moonshot transport requires revalidation and rejects redirects or stale post-response auth", async () => {
  const adapter = moonshotAdapter("moonshotai");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(successPayload()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await assert.rejects(
      () => queryProviderUsage(adapter, moonshotAuth("moonshotai"), new AbortController().signal, 1_000),
      /request-boundary revalidation/iu,
    );
    assert.equal(fetchMock.mock.calls.length, 0);

    const redirected = new Response(JSON.stringify(successPayload()), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValueOnce(redirected);
    await assert.rejects(
      () =>
        queryProviderUsage(
          adapter,
          moonshotAuth("moonshotai"),
          new AbortController().signal,
          1_000,
          async () => undefined,
        ),
      /refused a redirected response/iu,
    );

    let guardCalls = 0;
    await assert.rejects(
      () =>
        queryProviderUsage(adapter, moonshotAuth("moonshotai"), new AbortController().signal, 1_000, async () => {
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
