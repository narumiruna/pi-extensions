import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { UsageReport } from "../src/index.js";
import {
  awaitWithDeadline,
  fingerprintResolvedAuth,
  queryProviderUsage,
  redactUsageError,
  resolveUsageAuth,
  runWithConcurrency,
  SUPPORTED_ADAPTERS,
  sanitizeDisplayText,
  UsageCache,
} from "../src/index.js";

const report: UsageReport = {
  providerId: "openrouter",
  providerName: "OpenRouter",
  capturedAt: 1,
  source: "openrouter-key",
  semantics: { kind: "api-key", label: "API-key spend limits" },
  buckets: [],
  metrics: [{ id: "usage-total", label: "All-time usage", value: 1, unit: "usd" }],
};

test("credential fingerprints are process-salted, deterministic, and do not expose secrets", () => {
  const auth = {
    apiKey: "sk-secret",
    headers: { Authorization: "Bearer header-secret", "X-Test": "value" },
  };
  const first = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const same = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const anotherProcess = fingerprintResolvedAuth(auth, Buffer.alloc(32, 2));
  const anotherAccount = fingerprintResolvedAuth({ apiKey: "different" }, Buffer.alloc(32, 1));

  assert.equal(first, same);
  assert.notEqual(first, anotherProcess);
  assert.notEqual(first, anotherAccount);
  assert.doesNotMatch(first, /secret/);
});

test("usage cache isolates identities, expires entries, and remains bounded", () => {
  const cache = new UsageCache(300_000, 4);
  cache.set("openrouter", "account-a", report, 1_000);

  assert.equal(cache.get("openrouter", "account-a", 1_001), report);
  assert.equal(cache.get("openrouter", "account-b", 1_001), undefined);
  assert.equal(cache.get("openai-codex", "account-a", 1_001), undefined);
  assert.equal(cache.get("openrouter", "account-a", 301_001), undefined);
  assert.equal(cache.size, 0);

  for (let index = 0; index < 10; index += 1) {
    cache.set("openrouter", `account-${index}`, report, 400_000 + index);
  }
  assert.equal(cache.size, 4);
  assert.equal(cache.get("openrouter", "account-0", 400_020), undefined);
  assert.equal(cache.get("openrouter", "account-9", 400_020), report);
  cache.clearProvider("openrouter");
  assert.equal(cache.size, 0);
});

test("usage cache deletion preserves other credentials and providers", () => {
  const cache = new UsageCache(300_000);
  cache.set("zai", "account-a", report, 1_000);
  cache.set("zai", "account-b", report, 1_000);
  cache.set("zai-coding-cn", "account-a", report, 1_000);
  cache.delete("zai", "account-a");
  cache.delete("zai", "account-a");
  assert.equal(cache.get("zai", "account-a", 1_001), undefined);
  assert.equal(cache.get("zai", "account-b", 1_001), report);
  assert.equal(cache.get("zai-coding-cn", "account-a", 1_001), report);
});

for (const method of ["get", "getEntry"] as const) {
  test(`usage cache ${method} expires at the exact TTL boundary without extending reads`, () => {
    const cache = new UsageCache(100);
    cache.set("openrouter", "account-a", report, 1_000);

    assert.deepEqual(cache.getEntry("openrouter", "account-a", 1_000), { report, expiresAt: 1_100 });
    assert.equal(cache.get("openrouter", "account-a", 1_050), report);
    assert.equal(cache.getEntry("openrouter", "account-a", 1_099)?.report, report);
    assert.equal(cache.getEntry("openrouter", "account-a", 1_099)?.expiresAt, 1_100);
    assert.equal(cache[method]("openrouter", "account-a", 1_100), undefined);
    assert.equal(cache.size, 0);
  });
}

test("usage cache metadata uses the default clock and does not expose mutable expiry state", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const cache = new UsageCache(100);
  cache.set("openrouter", "account-a", report);
  clock.mockReturnValue(1_050);
  const entry = cache.getEntry("openrouter", "account-a");
  assert.ok(entry);
  assert.equal(entry.report, report);
  assert.equal(entry.expiresAt, 1_100);
  entry.expiresAt = 5_000;
  assert.equal(cache.getEntry("openrouter", "account-a")?.expiresAt, 1_100);
  clock.mockReturnValue(1_100);
  assert.equal(cache.getEntry("openrouter", "account-a"), undefined);
});

test("usage cache publishes initial and replacement state before update notifications", () => {
  let now = 1_000;
  const observed: unknown[] = [];
  const cache: UsageCache = new UsageCache(100, 2, (providerId, reason) => {
    observed.push({ providerId, reason, entry: cache.getEntry(providerId, "account-a", now), size: cache.size });
  });
  cache.set("openrouter", "account-a", report, now);
  now = 1_050;
  const replacement = { ...report, capturedAt: 2 };
  cache.set("openrouter", "account-a", replacement, now);
  assert.deepEqual(observed, [
    { providerId: "openrouter", reason: "updated", entry: { report, expiresAt: 1_100 }, size: 1 },
    { providerId: "openrouter", reason: "updated", entry: { report: replacement, expiresAt: 1_150 }, size: 1 },
  ]);
});

for (const { name, remove, invalidated, remaining } of [
  {
    name: "delete",
    remove: (cache: UsageCache) => cache.delete("zai", "account-a"),
    invalidated: ["zai"],
    remaining: [false, true, true, true],
  },
  {
    name: "clearProvider",
    remove: (cache: UsageCache) => cache.clearProvider("zai"),
    invalidated: ["zai"],
    remaining: [false, false, true, true],
  },
  {
    name: "clear",
    remove: (cache: UsageCache) => cache.clear(),
    invalidated: ["zai", "zai-coding-cn", "zai:other"],
    remaining: [false, false, false, false],
  },
]) {
  test(`usage cache ${name} notifies affected providers only after all removals`, () => {
    const identities = [
      ["zai", "account-a"],
      ["zai", "account-b"],
      ["zai-coding-cn", "account-a"],
      ["zai:other", "account-a"],
    ] as const;
    const observed: unknown[] = [];
    const cache: UsageCache = new UsageCache(100, 4, (providerId, reason) => {
      observed.push({
        providerId,
        reason,
        remaining: identities.map(([provider, fingerprint]) => cache.get(provider, fingerprint, 1_000) !== undefined),
      });
    });
    for (const [providerId, fingerprint] of identities) cache.set(providerId, fingerprint, report, 1_000);
    observed.length = 0;

    remove(cache);
    assert.deepEqual(
      observed,
      invalidated.map((providerId) => ({ providerId, reason: "invalidated", remaining })),
    );
    observed.length = 0;
    remove(cache);
    cache.delete("missing", "account-a");
    cache.clearProvider("missing");
    assert.deepEqual(observed, []);
  });
}

for (const method of ["get", "getEntry", "set"] as const) {
  test(`usage cache ${method} sweeps expired providers once before notification`, () => {
    const observed: unknown[] = [];
    let now = 1_000;
    const cache: UsageCache = new UsageCache(100, 4, (providerId, reason) => {
      observed.push({ providerId, reason, size: cache.size, live: cache.get("live", "account-a", now) });
    });
    cache.set("expired", "account-a", report, now);
    cache.set("expired", "account-b", report, now);
    cache.set("other-expired", "account-a", report, now);
    now = 1_050;
    cache.set("live", "account-a", report, now);
    observed.length = 0;
    now = 1_100;

    if (method === "set") cache.set("new", "account-a", report, now);
    else assert.equal(cache[method]("missing", "account-a", now), undefined);
    const size = method === "set" ? 2 : 1;
    assert.deepEqual(observed, [
      { providerId: "expired", reason: "invalidated", size, live: report },
      { providerId: "other-expired", reason: "invalidated", size, live: report },
      ...(method === "set" ? [{ providerId: "new", reason: "updated", size, live: report }] : []),
    ]);
    observed.length = 0;
    cache.getEntry("expired", "account-a", now);
    assert.deepEqual(observed, []);
  });
}

test("usage cache capacity eviction publishes the successor before invalidation", () => {
  const observed: unknown[] = [];
  const cache: UsageCache = new UsageCache(100, 2, (providerId, reason) => {
    observed.push({
      providerId,
      reason,
      size: cache.size,
      oldest: cache.get("oldest", "account-a", 1_000),
      newest: cache.getEntry("newest", "account-a", 1_000),
    });
  });
  cache.set("oldest", "account-a", report, 1_000);
  cache.set("middle", "account-a", report, 1_000);
  cache.get("oldest", "account-a", 1_000);
  observed.length = 0;
  cache.set("newest", "account-a", report, 1_000);
  assert.deepEqual(observed, [
    {
      providerId: "oldest",
      reason: "invalidated",
      size: 2,
      oldest: undefined,
      newest: { report, expiresAt: 1_100 },
    },
    {
      providerId: "newest",
      reason: "updated",
      size: 2,
      oldest: undefined,
      newest: { report, expiresAt: 1_100 },
    },
  ]);
});

test("usage cache replacement refreshes insertion order without capacity invalidation", () => {
  const changes: unknown[] = [];
  const cache = new UsageCache(100, 2, (providerId, reason) => changes.push([providerId, reason]));
  cache.set("first", "account-a", report, 1_000);
  cache.set("second", "account-a", report, 1_000);
  changes.length = 0;
  cache.set("first", "account-a", report, 1_050);
  cache.set("third", "account-a", report, 1_050);
  assert.deepEqual(changes, [
    ["first", "updated"],
    ["second", "invalidated"],
    ["third", "updated"],
  ]);
  assert.equal(cache.getEntry("first", "account-a", 1_100)?.expiresAt, 1_150);
  assert.equal(cache.size, 2);
});

test("usage cache reentrant expiry observers cannot sweep successor entries", () => {
  const changes: unknown[] = [];
  const reads: unknown[] = [];
  let now = 1_000;
  const successor = { ...report, capturedAt: 2 };
  const cache: UsageCache = new UsageCache(100, 4, (providerId, reason) => {
    changes.push([providerId, reason]);
    if (reason !== "invalidated") return;
    reads.push(cache.getEntry(providerId, "account-a", now));
    cache.set(providerId, "account-a", successor, now);
    reads.push(cache.getEntry(providerId, "account-a", now));
  });
  cache.set("first", "account-a", report, now);
  cache.set("first", "account-b", report, now);
  cache.set("second", "account-a", report, now);
  changes.length = 0;
  now = 1_100;

  assert.deepEqual(cache.getEntry("first", "account-a", now), { report: successor, expiresAt: 1_200 });
  assert.deepEqual(changes, [
    ["first", "invalidated"],
    ["second", "invalidated"],
    ["first", "updated"],
    ["second", "updated"],
  ]);
  assert.deepEqual(reads, [
    undefined,
    { report: successor, expiresAt: 1_200 },
    undefined,
    { report: successor, expiresAt: 1_200 },
  ]);
  assert.equal(cache.getEntry("second", "account-a", now)?.report, successor);
  assert.equal(cache.size, 2);
});

test("usage cache reentrant eviction observers remain bounded and do not loop notifications", () => {
  const changes: unknown[] = [];
  const sizes: number[] = [];
  const cache: UsageCache = new UsageCache(100, 1, (providerId, reason) => {
    changes.push([providerId, reason]);
    sizes.push(cache.size);
    // The cap also keeps a broken implementation from hanging this regression test.
    if (reason === "invalidated" && changes.length < 10) cache.set(providerId, "account-a", report, 1_000);
  });
  cache.set("first", "account-a", report, 1_000);
  changes.length = 0;
  sizes.length = 0;
  cache.set("second", "account-a", report, 1_000);
  assert.deepEqual(changes, [
    ["first", "invalidated"],
    ["second", "updated"],
    ["second", "invalidated"],
    ["first", "updated"],
  ]);
  assert.deepEqual(sizes, [1, 1, 1, 1]);
  assert.equal(cache.get("second", "account-a", 1_000), report);
  assert.equal(cache.get("first", "account-a", 1_000), undefined);
});

test("usage cache coalesces synchronous update feedback but not later operations", () => {
  const changes: unknown[] = [];
  let callbackNow = 1_050;
  const cache: UsageCache = new UsageCache(100, 1, (providerId, reason) => {
    changes.push([providerId, reason]);
    if (reason === "updated" && changes.length < 10) cache.set(providerId, "account-a", report, callbackNow);
  });
  cache.set("openrouter", "account-a", report, 1_000);
  callbackNow = 1_150;
  cache.set("openrouter", "account-a", report, 1_100);
  assert.deepEqual(changes, [
    ["openrouter", "updated"],
    ["openrouter", "updated"],
  ]);
  assert.equal(cache.getEntry("openrouter", "account-a", 1_150)?.expiresAt, 1_250);
});

test("usage cache isolates observer exceptions and continues later notifications", () => {
  const changes: unknown[] = [];
  const cache = new UsageCache(100, 2, (providerId, reason) => {
    changes.push([providerId, reason]);
    throw new Error("observer failed");
  });
  cache.set("first", "account-a", report, 1_000);
  cache.set("second", "account-a", report, 1_000);
  changes.length = 0;
  cache.set("third", "account-a", report, 1_100);
  assert.deepEqual(changes, [
    ["first", "invalidated"],
    ["second", "invalidated"],
    ["third", "updated"],
  ]);
  assert.equal(cache.get("third", "account-a", 1_100), report);
  cache.delete("third", "account-a");
  cache.set("third", "account-a", report, 1_100);
  cache.clearProvider("third");
  cache.set("third", "account-a", report, 1_100);
  cache.clear();
  assert.equal(cache.size, 0);
  cache.set("third", "account-a", report, 1_100);
  assert.equal(cache.getEntry("third", "account-a", 1_200), undefined);
  assert.equal(cache.size, 0);
});

test("bounded orchestration retains stable partial results and respects cancellation", async () => {
  let active = 0;
  let maximumActive = 0;
  const controller = new AbortController();
  const results = await runWithConcurrency(
    [1, 2, 3, 4],
    2,
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
      active -= 1;
      if (value === 3) throw new Error("provider failed");
      return value * 2;
    },
    controller.signal,
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map((result) => (result.status === "fulfilled" ? ["ok", result.value] : ["error", result.reason.message])),
    [
      ["ok", 2],
      ["ok", 4],
      ["error", "provider failed"],
      ["ok", 8],
    ],
  );

  controller.abort();
  await assert.rejects(() => runWithConcurrency([1], 2, async (value) => value, controller.signal), /aborted/i);
});

test("end-to-end deadline bounds slow work and preserves caller cancellation", async () => {
  const never = new Promise<never>(() => undefined);
  const controller = new AbortController();
  await assert.rejects(
    () => awaitWithDeadline(never, controller.signal, 5, "resolving auth"),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );

  const cancelled = new AbortController();
  const pending = awaitWithDeadline(never, cancelled.signal, 1_000, "resolving auth");
  cancelled.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("runtime auth rejects proxy origins and forwards only adapter-approved headers", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const proxyModel = {
    id: "proxy-model",
    name: "Proxy",
    provider: "openrouter",
    baseUrl: "https://proxy.example.test/v1",
  };
  const { ctx: proxyContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  await assert.rejects(() => resolveUsageAuth(proxyContext, adapter), /custom.*base URL|official/iu);

  const officialModel = { ...proxyModel, baseUrl: "https://openrouter.ai/api/v1" };
  const { ctx: effectiveProxyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  await assert.rejects(() => resolveUsageAuth(effectiveProxyContext, adapter), /proxy-resolved.*official/iu);

  const { ctx: providerOverrideContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://proxy.example.test/v1" }),
      getProviderAuth: async () => ({ auth: { apiKey: "must-not-send" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(providerOverrideContext, adapter),
    /overridden provider credential.*official/iu,
  );

  const { ctx: officialContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: "official-key",
          headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
        },
        env: { OPENROUTER_ACCOUNT: "account-a" },
        source: "test credential",
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const auth = await resolveUsageAuth(officialContext, adapter);
  assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });
  assert.deepEqual(auth?.auth, {
    apiKey: "official-key",
    headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
  });
  assert.deepEqual(auth?.env, { OPENROUTER_ACCOUNT: "account-a" });
  assert.equal(auth?.source, "test credential");
  assert.equal(auth?.effectiveBaseUrl, "https://openrouter.ai/api/v1");

  const { ctx: rotatedEnvContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "official-key" },
        env: { OPENROUTER_ACCOUNT: "account-b" },
        source: "test credential",
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const rotatedEnv = await resolveUsageAuth(rotatedEnvContext, adapter);
  assert.notEqual(rotatedEnv?.fingerprint, auth?.fingerprint);

  const { ctx: modelScopedContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "provider-default-key",
        headers: {
          Authorization: "Bearer current-model-key",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelScopedAuth = await resolveUsageAuth(modelScopedContext, adapter);
  assert.deepEqual(modelScopedAuth?.headers, { Authorization: "Bearer current-model-key" });
  assert.ok(modelScopedAuth?.secrets.includes("Bearer current-model-key"));
  assert.ok(modelScopedAuth?.secrets.includes("must-not-leak"));

  const { ctx: modelKeyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelKeyAuth = await resolveUsageAuth(modelKeyContext, adapter);
  assert.deepEqual(modelKeyAuth?.headers, { Authorization: "Bearer current-model-key" });
});

test("GitHub Copilot usage uses the matching Pi OAuth refresh token", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "github-copilot");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: "copilot-session-token", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const credentialReader = () => ({
    type: "oauth",
    access: "copilot-session-token",
    refresh: "github-oauth-token",
    expires: Date.now() + 60_000,
    enterpriseUrl: "github.com",
  });

  const auth = await resolveUsageAuth(ctx, adapter, new Uint8Array(32), credentialReader);
  assert.deepEqual(auth?.headers, {
    Authorization: "Bearer github-oauth-token",
    "X-GitHub-Api-Version": "2025-05-01",
  });
  assert.ok(auth?.secrets.includes("copilot-session-token"));
  assert.ok(auth?.secrets.includes("github-oauth-token"));

  await assert.rejects(
    () =>
      resolveUsageAuth(ctx, adapter, new Uint8Array(32), () => ({
        ...credentialReader(),
        access: "another-session-token",
      })),
    /does not match/iu,
  );
  const { ctx: conflictingHeaderContext } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "copilot-session-token",
        headers: { Authorization: "Bearer another-session-token" },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "copilot-session-token" } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(conflictingHeaderContext, adapter, new Uint8Array(32), credentialReader),
    /does not match/iu,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(ctx, adapter, new Uint8Array(32), () => ({
        ...credentialReader(),
        enterpriseUrl: "company.ghe.com",
      })),
    /Enterprise/iu,
  );
});

test("GitHub Copilot named credential selection is deterministic and reaches only the official endpoint", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "github-copilot");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: "runtime-access", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const matching = {
    type: "oauth" as const,
    access: "runtime-access",
    refresh: "matching-github-oauth",
    expires: Date.now() + 60_000,
    enterpriseUrl: "github.com",
  };
  const candidateReader = () => ({ ok: true as const, candidates: [matching] });
  const auth = await resolveUsageAuth(
    ctx,
    adapter,
    new Uint8Array(32),
    () => ({ ...matching, access: "default-access" }),
    candidateReader,
  );
  assert.ok(auth);
  assert.equal(auth.apiKey, "matching-github-oauth");

  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        quota_snapshots: {
          premium_interactions: { entitlement: 10, remaining: 7 },
        },
        login: "named-user",
      }),
      { status: 200 },
    ),
  );
  try {
    await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0], "https://api.github.com/copilot_internal/user");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    assert.deepEqual(init.headers, {
      Authorization: "Bearer matching-github-oauth",
      "X-GitHub-Api-Version": "2025-05-01",
      "User-Agent": "pi-usage",
    });
  } finally {
    fetchMock.mockRestore();
  }

  for (const candidates of [
    [matching, { ...matching, refresh: "conflicting-oauth" }],
    [{ ...matching, refresh: "conflicting-oauth" }, matching],
  ]) {
    await assert.rejects(
      () =>
        resolveUsageAuth(
          ctx,
          adapter,
          new Uint8Array(32),
          () => undefined,
          () => ({
            ok: true,
            candidates,
          }),
        ),
      /conflicting/iu,
    );
  }
  const duplicate = await resolveUsageAuth(
    ctx,
    adapter,
    new Uint8Array(32),
    () => undefined,
    () => ({ ok: true, candidates: [matching, structuredClone(matching)] }),
  );
  assert.equal(duplicate?.apiKey, "matching-github-oauth");
  await assert.rejects(
    () =>
      resolveUsageAuth(
        ctx,
        adapter,
        new Uint8Array(32),
        () => undefined,
        () => ({
          ok: true,
          candidates: [{ ...matching, enterpriseUrl: "company.ghe.test" }],
        }),
      ),
    /Enterprise/iu,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(
        ctx,
        adapter,
        new Uint8Array(32),
        () => undefined,
        () => ({
          ok: false,
        }),
      ),
    /failed closed/iu,
  );
});

test("OpenCode Go usage resolves auth before using the canonical versioned endpoint", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "opencode-go");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "provider-default-key",
        headers: {
          Authorization: "Bearer current-model-key",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "provider-default-key", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 1 },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const auth = await resolveUsageAuth(ctx, adapter);
    assert.ok(auth);
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0], "https://opencode.ai/zen/go/v1/usage");
    const request = fetchMock.mock.calls[0]?.[1];
    assert.equal(request?.method, "GET");
    assert.deepEqual(request?.headers, {
      Authorization: "Bearer current-model-key",
      "User-Agent": "pi-usage",
    });
    assert.ok(request?.signal instanceof AbortSignal);
    assert.equal(report.providerId, "opencode-go");
    assert.equal(report.buckets[0]?.used, 1);
    assert.equal(report.buckets[0]?.remaining, 99);
  } finally {
    fetchMock.mockRestore();
  }
});

test("OpenCode Go usage rejects custom model and auth origins before fetching", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "opencode-go");
  assert.ok(adapter);
  const proxyModel = {
    id: "proxy-model",
    name: "Proxy model",
    provider: "opencode-go",
    baseUrl: "https://proxy.example.test/v1",
  };
  const { ctx: proxyModelContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "proxy-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  const officialModel = {
    ...proxyModel,
    id: "official-model",
    name: "Official model",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  const { ctx: proxyAuthContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "official-key" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    await assert.rejects(() => resolveUsageAuth(proxyModelContext, adapter), /custom.*base URL|official/iu);
    await assert.rejects(() => resolveUsageAuth(proxyAuthContext, adapter), /proxy-resolved.*official/iu);
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    fetchMock.mockRestore();
  }
});

test("provider cancellation preserves AbortError identity", async () => {
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const adapter = {
    id: "test",
    displayName: "Test",
    semantics: { kind: "api-key" as const, label: "Test" },
    query: async () => {
      throw abort;
    },
  };
  const controller = new AbortController();
  await assert.rejects(
    () =>
      queryProviderUsage(
        adapter,
        {
          headers: { Authorization: "Bearer secret" },
          fingerprint: "fingerprint",
          secrets: ["secret"],
          model: {} as never,
        },
        controller.signal,
        10,
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("display sanitization strips terminal escapes, controls, and excessive text", () => {
  const sanitized = sanitizeDisplayText("safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext", 20);
  assert.equal(sanitized, "safelink next");
  assert.equal(sanitizeDisplayText("x".repeat(100), 10), "xxxxxxxxx…");
});

test("provider response reads are byte-bounded", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const auth = {
    headers: { Authorization: "Bearer secret" },
    fingerprint: "fingerprint",
    secrets: ["secret"],
    model: { ...report, baseUrl: "https://openrouter.ai/api/v1" } as never,
  };
  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    /exceeded.*bytes|too large/iu,
  );

  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 500 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    (error: unknown) => error instanceof Error && error.message.length < 1_000 && /returned 500/.test(error.message),
  );
});

test("usage error redaction removes exact runtime auth and common token fields", () => {
  const redacted = redactUsageError('Bearer common-token {"access_token":"json-token"} sk-secret header-secret', [
    "sk-secret",
    "header-secret",
  ]);
  assert.doesNotMatch(redacted, /common-token|json-token|sk-secret|header-secret/);
  assert.match(redacted, /<redacted>/);
});
