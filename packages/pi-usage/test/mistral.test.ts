import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { queryProviderUsage, type ResolvedUsageAuth, SUPPORTED_ADAPTERS, type UsageProviderAdapter } from "../src/index.js";

const MISTRAL_MODEL = {
  id: "codestral-2508",
  name: "Codestral 25.08",
  provider: "mistral",
  baseUrl: "https://api.mistral.ai",
};

const SUBSCRIPTION = { plan_name: "INDIVIDUAL", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };

// Captured from a live INDIVIDUAL-plan standard API key.
const BUDGET = {
  vibe_budget: {
    usage_percentage: 3.257940325333333,
    initial_budget: 255.0,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 0.0,
    initial_budget: 25.5,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
};

function mistralAdapter(): UsageProviderAdapter {
  const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === "mistral");
  assert.ok(candidate);
  return candidate;
}

const adapter = mistralAdapter();

function mistralAuth(): ResolvedUsageAuth {
  const secret = "mistral-test-secret";
  return {
    apiKey: secret,
    headers: { Authorization: `Bearer ${secret}` },
    fingerprint: "fingerprint",
    secrets: [secret, `Bearer ${secret}`],
    model: MISTRAL_MODEL as never,
  };
}

function queryMistral(signal = new AbortController().signal, timeoutMs = 2_000) {
  return queryProviderUsage(adapter, mistralAuth(), signal, timeoutMs, async () => undefined);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Mistral reads the subscription and budget routes, mirroring the official Vibe CLI", async () => {
  const seen: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    seen.push(url);
    return jsonResponse(url.includes("/v1/billing/budget") ? BUDGET : SUBSCRIPTION);
  });
  try {
    const report = await queryMistral();
    assert.equal(report.source, "mistral-billing");
    assert.equal(report.accountLabel, "INDIVIDUAL");
    assert.deepEqual(
      report.buckets.map((bucket) => [bucket.id, bucket.used, bucket.remaining]),
      [
        ["vibe-allowance", 3.257940325333333, 96.74205967466667],
        ["api-allowance", 0, 100],
      ],
    );
    assert.deepEqual(seen.map((url) => new URL(url).pathname).sort(), [
      "/v1/billing/budget",
      "/v1/billing/subscription",
    ]);
    assert.ok(seen.every((url) => new URL(url).origin === "https://api.mistral.ai"));
  } finally {
    fetchMock.mockRestore();
  }
});

test("Mistral keeps plan details when the budget route denies the usage permission", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("/v1/billing/subscription") ? jsonResponse(SUBSCRIPTION) : jsonResponse({ detail: "forbidden" }, 403),
  );
  try {
    const report = await queryMistral();
    assert.equal(report.accountLabel, "INDIVIDUAL");
    assert.deepEqual(report.buckets, []);
    assert.match(report.notes?.join(" ") ?? "", /usage permission/u);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Mistral keeps a route that answers when the other 404s", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("/v1/billing/subscription") ? jsonResponse(SUBSCRIPTION, 404) : jsonResponse(BUDGET),
  );
  try {
    // Subscription is the required route here; the adapter fails closed rather than guessing a plan.
    await assert.rejects(() => queryMistral(), /404|Not Found/u);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Mistral keeps the required subscription failure fatal and never leaves the official origin", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => jsonResponse({ detail: "Invalid API Key" }, 401));
  try {
    await assert.rejects(() => queryMistral(), /401|Unauthorized|Invalid API Key|authentication/iu);
    for (const [input] of fetchMock.mock.calls) {
      assert.equal(new URL(String(input)).origin, "https://api.mistral.ai");
    }
  } finally {
    fetchMock.mockRestore();
  }
});

test("Mistral propagates cancellation instead of degrading to plan details", async () => {
  const controller = new AbortController();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  try {
    await assert.rejects(() => queryMistral(controller.signal), /abort/iu);
  } finally {
    fetchMock.mockRestore();
  }
});
