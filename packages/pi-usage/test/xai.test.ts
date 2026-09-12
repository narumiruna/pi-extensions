import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { formatUsageReport, formatUsageStatusline } from "../src/format.js";
import { normalizeXaiBillingPayload } from "../src/providers/xai.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth, XAI_ADAPTER } from "../src/query.js";
import type { ResolvedUsageAuth, XaiBillingPayload, XaiUserPayload } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const xaiModel = {
  id: "grok-4.5",
  name: "Grok 4.5",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
};

async function fixture<T>(name: string): Promise<T> {
  const path = fileURLToPath(new URL(`./fixtures/xai/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function oauth(access = "oauth-access", refresh = "oauth-refresh") {
  return { type: "oauth", access, refresh, expires: Date.now() + 60_000 } as const;
}

function xaiContext(resolved = "oauth-access", options: { model?: typeof xaiModel; baseUrl?: string } = {}) {
  const model = options.model ?? xaiModel;
  return createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: resolved }),
      getProviderAuth: async () => ({
        auth: { apiKey: resolved, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  }).ctx;
}

function candidateReader(candidates: readonly unknown[]) {
  return () => ({ ok: true as const, candidates: candidates as never[], offeredCount: 0 });
}

function resolvedAuth(): ResolvedUsageAuth {
  return {
    apiKey: "oauth-access",
    headers: { Authorization: "Bearer oauth-access" },
    fingerprint: "fingerprint",
    secrets: ["oauth-access", "oauth-refresh", "Bearer oauth-access"],
    model: xaiModel as never,
  };
}

test("xAI is always registered for explicit usage actions", () => {
  assert.equal(adapterForProvider("xai"), XAI_ADAPTER);
});

test("normalizes current credits while keeping allowance, on-demand, and prepaid values distinct", async () => {
  const billing = await fixture<XaiBillingPayload>("billing-current.json");
  const report = normalizeXaiBillingPayload(billing, "SuperGrok", 123);
  assert.equal(report.semantics.kind, "consumer-subscription");
  assert.deepEqual(report.buckets, [
    {
      id: "included-allowance",
      label: "Included allowance",
      used: 42.5,
      remaining: 57.5,
      unit: "percent",
      period: "Weekly",
      resetsAt: Date.parse("2026-06-08T00:00:00Z") / 1000,
    },
    {
      id: "on-demand",
      label: "On-demand usage",
      limit: 50,
      used: 3,
      remaining: 47,
      unit: "usd",
    },
  ]);
  assert.deepEqual(report.metrics, [
    { id: "prepaid-balance", label: "Prepaid balance", value: 12.5, unit: "usd" },
    { id: "subscription-tier", label: "Plan tier", value: "SuperGrok" },
  ]);
  const formatted = formatUsageReport(report, "current");
  assert.match(formatted, /Included allowance:\s+\[█{12}░{8}\] 58% left · Weekly/);
  assert.match(formatted, /On-demand usage:\s+\$3\.00 used of \$50\.00 cap/);
  assert.match(formatted, /Prepaid balance:\s+\$12\.50/);
  assert.match(formatted, /Plan tier:\s+SuperGrok/);
  assert.equal(formatUsageStatusline(report), undefined);
});

test("normalizes legacy limits, signed cents, zero wrappers, and empty configs", async () => {
  const legacy = normalizeXaiBillingPayload(await fixture<XaiBillingPayload>("billing-legacy.json"), null, 123);
  assert.deepEqual(legacy.buckets[0], {
    id: "included-allowance",
    label: "Included allowance",
    limit: 20,
    used: 12.34,
    remaining: 7.66,
    unit: "usd",
    period: "Monthly",
    resetsAt: Date.parse("2025-05-01T00:00:00Z") / 1000,
  });
  assert.deepEqual(legacy.buckets[1], {
    id: "on-demand",
    label: "On-demand usage",
    limit: 0,
    used: -0.5,
    remaining: 0.5,
    unit: "usd",
  });
  assert.deepEqual(legacy.metrics, [{ id: "prepaid-balance", label: "Prepaid balance", value: 0, unit: "usd" }]);
  const limitOnly = normalizeXaiBillingPayload({ config: { monthlyLimit: { val: 2_000 } } }, undefined, 123);
  assert.deepEqual(limitOnly.buckets, [
    {
      id: "included-allowance",
      label: "Included allowance",
      limit: 20,
      unit: "usd",
    },
  ]);
  const formattedLimitOnly = formatUsageReport(limitOnly, "current");
  assert.match(formattedLimitOnly, /Included allowance:\s+usage unavailable · \$20\.00 limit/);
  assert.doesNotMatch(formattedLimitOnly, /\$0\.00 used/);
  const periodOnly = normalizeXaiBillingPayload(
    {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          end: "2026-07-01T00:00:00Z",
        },
      },
    },
    undefined,
    123,
  );
  assert.deepEqual(periodOnly.buckets, [
    {
      id: "included-allowance",
      label: "Included allowance",
      unit: "percent",
      period: "Monthly",
      resetsAt: Date.parse("2026-07-01T00:00:00Z") / 1000,
    },
  ]);
  for (const name of ["billing-null.json", "billing-absent.json"]) {
    const report = normalizeXaiBillingPayload(await fixture(name), undefined, 123);
    assert.deepEqual(report.buckets, []);
    assert.deepEqual(report.metrics, []);
    assert.match(report.notes?.[0] ?? "", /No xAI consumer billing configuration/);
  }
});

test("rejects malformed or unbounded billing values and sanitizes hostile tiers", async () => {
  for (const payload of [
    { config: [] },
    { config: { creditUsagePercent: 101 } },
    { config: { monthlyLimit: { val: Number.MAX_SAFE_INTEGER + 1 } } },
    { config: { currentPeriod: { end: "not-a-date" } } },
  ]) {
    assert.throws(() => normalizeXaiBillingPayload(payload, undefined, 123), /xAI billing/);
  }
  const hostile = await fixture<XaiUserPayload>("user-hostile-tier.json");
  const report = normalizeXaiBillingPayload({ config: null }, hostile.subscriptionTier, 123);
  const tier = report.metrics.find((metric) => metric.id === "subscription-tier")?.value;
  assert.equal(tier, "SuperGrokhostile Tier");
  assert.equal(
    [...String(tier)].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }),
    false,
  );
});

test("xAI auth requires one exact complete OAuth match and rejects custom origins", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("auth validation must not fetch");
  };
  const auth = await resolveUsageAuth(
    xaiContext(),
    XAI_ADAPTER,
    new Uint8Array(32),
    () => undefined,
    candidateReader([oauth()]),
  );
  assert.deepEqual(auth?.headers, { Authorization: "Bearer oauth-access" });
  assert.ok(auth?.secrets.includes("oauth-refresh"));

  const failures: Array<{ candidates: readonly unknown[]; pattern: RegExp }> = [
    { candidates: [], pattern: /OAuth subscription account/ },
    { candidates: [oauth("other")], pattern: /does not match/ },
    {
      candidates: [{ type: "oauth", access: "oauth-access", expires: Date.now() + 60_000 }],
      pattern: /incomplete/,
    },
    { candidates: [oauth(), oauth()], pattern: /Multiple OAuth credentials/ },
    { candidates: [oauth(), oauth("oauth-access", "other-refresh")], pattern: /Multiple/ },
  ];
  for (const failure of failures) {
    await assert.rejects(
      () =>
        resolveUsageAuth(
          xaiContext(),
          XAI_ADAPTER,
          new Uint8Array(32),
          () => undefined,
          candidateReader(failure.candidates),
        ),
      failure.pattern,
    );
  }

  await assert.rejects(
    () =>
      resolveUsageAuth(xaiContext("api-key"), XAI_ADAPTER, new Uint8Array(32), () => undefined, candidateReader([])),
    /XAI_API_KEY.*console\.x\.ai/,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(
        xaiContext("oauth-access", {
          model: { ...xaiModel, baseUrl: "https://proxy.example.test/v1" },
        }),
        XAI_ADAPTER,
      ),
    /custom.*base URL|official/iu,
  );
  await assert.rejects(
    () => resolveUsageAuth(xaiContext("oauth-access", { baseUrl: "https://proxy.example.test/v1" }), XAI_ADAPTER),
    /proxy-resolved/iu,
  );
  assert.equal(fetches, 0);
});

test("identity-first transport sends only approved headers in exact order and does not retain raw payloads", async () => {
  const user = await fixture<XaiUserPayload>("user-current.json");
  const billing = await fixture<XaiBillingPayload>("billing-current.json");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(requests.length === 1 ? user : billing), { status: 200 });
  };
  let guards = 0;
  const report = await queryProviderUsage(
    XAI_ADAPTER,
    resolvedAuth(),
    new AbortController().signal,
    1_000,
    async () => {
      guards += 1;
    },
  );
  assert.equal(guards, 4);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    ],
  );
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.deepEqual(Object.fromEntries(new Headers(requests[0]?.init?.headers)), {
    authorization: "Bearer oauth-access",
    "x-grok-client-mode": "interactive",
    "x-grok-client-version": "1.0.10",
    "x-xai-token-auth": "xai-grok-cli",
  });
  assert.deepEqual(Object.fromEntries(new Headers(requests[1]?.init?.headers)), {
    authorization: "Bearer oauth-access",
    "x-grok-client-mode": "interactive",
    "x-grok-client-version": "1.0.10",
    "x-userid": "fixture-user-0001",
    "x-xai-token-auth": "xai-grok-cli",
  });
  assert.equal(JSON.stringify(report).includes("fixture-user-0001"), false);
});

test("transport refuses unsafe identity, redirects, stale guards, cancellation, and body stalls", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ userId: "bad\r\nheader" }), { status: 200 });
  };
  await assert.rejects(
    () => queryProviderUsage(XAI_ADAPTER, resolvedAuth(), new AbortController().signal, 1_000, async () => undefined),
    /unsafe canonical user ID/,
  );
  assert.equal(requests, 1);

  globalThis.fetch = async () => new Response("redirect", { status: 302 });
  await assert.rejects(
    () => queryProviderUsage(XAI_ADAPTER, resolvedAuth(), new AbortController().signal, 1_000, async () => undefined),
    /returned 302/,
  );

  requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ userId: "fixture-user-0001" }), { status: 200 });
  };
  let guards = 0;
  await assert.rejects(
    () =>
      queryProviderUsage(XAI_ADAPTER, resolvedAuth(), new AbortController().signal, 1_000, async () => {
        guards += 1;
        if (guards === 2) throw Object.assign(new Error("stale"), { name: "AbortError" });
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(requests, 1);

  const controller = new AbortController();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start() {},
      }),
      { status: 200 },
    );
  const pending = queryProviderUsage(XAI_ADAPTER, resolvedAuth(), controller.signal, 1_000, async () => undefined);
  setImmediate(() => controller.abort());
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start() {},
      }),
      { status: 200 },
    );
  await assert.rejects(
    () => queryProviderUsage(XAI_ADAPTER, resolvedAuth(), new AbortController().signal, 5, async () => undefined),
    /Timed out/,
  );
});

test("HTTP failures redact OAuth secrets and the transient consumer identity", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({ userId: "fixture-user-0001" }), { status: 200 });
    }
    return new Response("Bearer oauth-access, oauth-refresh, fixture-user-0001", {
      status: 401,
      statusText: "Unauthorized",
    });
  };
  await assert.rejects(
    () => queryProviderUsage(XAI_ADAPTER, resolvedAuth(), new AbortController().signal, 1_000, async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /oauth-access|oauth-refresh|fixture-user-0001/);
      assert.match(error.message, /<redacted>/);
      return true;
    },
  );
});
