import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import type { ResolvedUsageAuth } from "../src/types.js";

const model = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
};
const access = "sk-ant-oat-synthetic-anthropic-access";
const refresh = "synthetic-anthropic-refresh";
const oauth = () => ({ type: "oauth", access, refresh, expires: Date.now() + 3_600_000 });
const response = {
  extra_usage: { is_enabled: true, currency: "USD", decimal_places: 2, used_credits: 8000, monthly_limit: 10000 },
};

afterEach(() => vi.unstubAllEnvs());

function adapter() {
  const value = adapterForProvider("anthropic");
  assert.ok(value, "Anthropic extra-usage adapter must be registered");
  return value;
}

type Headers = Record<string, string | null>;
function context(
  options: {
    apiKey?: string;
    providerKey?: string;
    headers?: Headers;
    providerHeaders?: Headers;
    modelHeaders?: Headers;
    modelOrigin?: string;
    configuredOrigin?: string;
    providerOrigin?: string;
    resolvedOrigin?: string;
    source?: string;
    configured?: boolean;
  } = {},
) {
  const selected = { ...model, baseUrl: options.modelOrigin ?? model.baseUrl, headers: options.modelHeaders };
  return createMockContext({
    model: options.configured ? { ...model, provider: "other" } : selected,
    modelRegistry: {
      getProvider: () => ({ baseUrl: options.configuredOrigin ?? model.baseUrl }),
      getAvailable: () => [selected],
      getAll: () => [selected],
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: options.apiKey ?? access,
        headers: options.headers ?? options.providerHeaders,
        baseUrl: options.resolvedOrigin,
      }),
      getProviderAuth: async () => ({
        source: options.source ?? "OAuth",
        auth: {
          apiKey: options.providerKey ?? options.apiKey ?? access,
          headers: options.providerHeaders,
          baseUrl: options.providerOrigin,
        },
      }),
    },
  }).ctx;
}

async function resolve(options: Parameters<typeof context>[0] = {}, candidates: unknown[] = [oauth()]) {
  return resolveUsageAuth(
    context(options),
    adapter(),
    new Uint8Array(32),
    () => undefined,
    () => ({
      ok: true,
      candidates: candidates as never[],
      offeredCount: candidates.length,
    }),
  );
}

test("Anthropic uses only a complete matching OAuth access token and deduplicates equivalent grants", async () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  const grant = oauth();
  const auth = await resolve({}, [grant, { ...grant }]);
  assert.ok(auth);
  assert.deepEqual(auth.headers, { Authorization: `Bearer ${access}` });
  assert.equal(auth.apiKey, access);
  assert.ok(auth.secrets.includes(refresh));
  assert.notEqual(auth.fingerprint, access);
  assert.ok(await resolve({ configured: true }));
  assert.ok(await resolve({ source: "stored credential" }));
});

for (const [name, options, accepted] of [
  ["matching Authorization", { headers: { Authorization: `Bearer ${access}` } }, true],
  ["case-insensitive bearer scheme", { headers: { authorization: `bearer ${access}` } }, true],
  ["replaced Authorization", { headers: { Authorization: "Bearer synthetic-other" } }, false],
  ["null Authorization", { headers: { Authorization: null } }, false],
  ["empty Authorization", { headers: { Authorization: "" } }, false],
  ["Basic Authorization", { headers: { Authorization: "Basic synthetic-other" } }, false],
  ["provider Authorization replacement", { providerHeaders: { Authorization: "Bearer synthetic-other" } }, false],
  ["raw model Authorization replacement", { modelHeaders: { Authorization: "Bearer synthetic-other" } }, false],
  ["raw model Authorization removal", { modelHeaders: { Authorization: null } }, false],
  [
    "later case replacement",
    { headers: { Authorization: `Bearer ${access}`, authorization: "Bearer synthetic-other" } },
    false,
  ],
  [
    "later case match",
    { headers: { authorization: "Bearer synthetic-other", Authorization: `Bearer ${access}` } },
    true,
  ],
  ["extra API-key header", { headers: { "x-api-key": "synthetic-other" } }, false],
  ["removed API-key header", { headers: { "x-api-key": null } }, true],
  ["different provider credential", { providerKey: "sk-ant-oat-other" }, false],
  ["ordinary API key", { apiKey: "synthetic-api-key" }, false],
] as const) {
  test(`Anthropic auth handles ${name} without inheriting another account`, async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    if (accepted) assert.ok(await resolve(options));
    else await assert.rejects(resolve(options), /Anthropic|Claude/);
  });
}

for (const value of [
  "Authorization: Bearer synthetic-environment",
  "authorization: Bearer synthetic-environment",
  "X-Api-Key: synthetic-environment",
  "Authorization:",
]) {
  test(`Anthropic refuses SDK-owned auth headers ${value.split(":")[0]}`, async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", value);
    await assert.rejects(resolve(), /custom.*headers|SDK/i);
  });
}

test("unrelated SDK custom headers do not authorize or block extra usage", async () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Unrelated: harmless");
  assert.ok(await resolve());
});

for (const candidates of [
  [],
  [{ ...oauth(), access: "sk-ant-oat-other" }],
  [{ ...oauth(), refresh: "" }],
  [{ ...oauth(), expires: 0 }],
  [oauth(), { ...oauth(), refresh: "synthetic-conflicting-refresh" }],
]) {
  test(`Anthropic rejects missing, stale, incomplete, or conflicting grants (${candidates.length})`, async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    await assert.rejects(resolve({}, candidates), /OAuth|credential/);
  });
}

for (const field of ["modelOrigin", "configuredOrigin", "providerOrigin", "resolvedOrigin"] as const) {
  test(`Anthropic rejects a custom ${field} before sending credentials`, async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await assert.rejects(resolve({ [field]: "https://proxy.example.test" }), /custom|overridden|proxy/);
    assert.equal(fetch.mock.calls.length, 0);
  });
}

test("Anthropic adapter uses guarded bounded GET, refuses redirects, and does not send a refresh token", async () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  const auth = (await resolve()) as ResolvedUsageAuth;
  const guard = vi.fn(async () => {});
  const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetch);
  await assert.rejects(queryProviderUsage(adapter(), auth, new AbortController().signal, 1000), /revalidation/);
  const report = await queryProviderUsage(adapter(), auth, new AbortController().signal, 1000, guard);
  assert.equal(report.providerId, "anthropic");
  assert.equal(guard.mock.calls.length, 2);
  assert.equal(fetch.mock.calls.length, 1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.deepEqual(init.headers, { Authorization: `Bearer ${access}`, "User-Agent": "pi-usage" });
  assert.ok(init.signal);
  assert.doesNotMatch(JSON.stringify(init), new RegExp(refresh));
});

test("Anthropic query failures redact OAuth tokens and bound response bodies", async () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  const auth = (await resolve()) as ResolvedUsageAuth;
  const run = () => queryProviderUsage(adapter(), auth, new AbortController().signal, 1000, async () => {});
  vi.stubGlobal("fetch", async () => new Response(`${access} ${refresh}`, { status: 401 }));
  await assert.rejects(run(), (error: Error) => {
    assert.doesNotMatch(error.message, new RegExp(`${access}|${refresh}`));
    assert.match(error.message, /401.*redacted/);
    return true;
  });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ unused: "x".repeat(65536) })));
  await assert.rejects(run(), /exceeded 65536/);
  const redirected = new Response("{}");
  Object.defineProperty(redirected, "redirected", { value: true });
  vi.stubGlobal("fetch", async () => redirected);
  await assert.rejects(run(), /redirected/);
});
