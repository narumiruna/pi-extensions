import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { formatUsageReport, formatUsageStatusline } from "../src/format.js";
import {
  createOAuthCredentialCandidateReader,
  OAUTH_CREDENTIAL_READINESS_CHANNEL,
  OAUTH_CREDENTIAL_SOURCE_CHANNEL,
  type OAuthCredentialCandidateReader,
} from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER, UnsupportedOpenAIUsageAuthError } from "../src/providers/openai-chatgpt.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.js";

const model = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
};
const credential = {
  type: "oauth",
  access: "synthetic-native-access",
  refresh: "synthetic-native-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "synthetic-client",
  scopes: ["chatgpt.tokens.use.direct"],
};
type Auth = { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
function context(
  options: { source?: string; selectedAuth?: Auth; providerAuth?: Auth; modelUrl?: string; providerUrl?: string } = {},
): ExtensionContext {
  const selectedModel = { ...model, baseUrl: options.modelUrl ?? model.baseUrl };
  return createMockContext({
    model: selectedModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, ...(options.selectedAuth ?? { apiKey: credential.access }) }),
      getProviderAuth: async () => ({
        source: Object.hasOwn(options, "source") ? options.source : "OAuth",
        auth: options.providerAuth ?? { apiKey: credential.access },
      }),
      getProvider: () => ({ baseUrl: options.providerUrl ?? model.baseUrl }),
      getAvailable: () => [selectedModel],
      getAll: () => [selectedModel],
    },
  }).ctx;
}
function candidates(values: readonly unknown[]): OAuthCredentialCandidateReader {
  return () => ({ ok: true, candidates: values as never[] });
}
const resolve = (options: Parameters<typeof context>[0] = {}, values: readonly unknown[] = [credential]) =>
  resolveUsageAuth(context(options), OPENAI_CHATGPT_ADAPTER, new Uint8Array(32), () => undefined, candidates(values));

test("native OpenAI OAuth reports authentication only, with no quota, countdown, or HTTP request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    assert.equal(adapterForProvider("openai"), OPENAI_CHATGPT_ADAPTER);
    const auth = await resolve();
    assert.ok(auth);
    assert.deepEqual(auth.headers, { Authorization: `Bearer ${credential.access}` });
    assert.ok(auth.secrets.includes(credential.refresh));
    assert.doesNotMatch(auth.fingerprint, /synthetic/);
    const guard = vi.fn(async () => undefined);
    const report = await queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, new AbortController().signal, 1_000, guard);
    assert.equal(guard.mock.calls.length, 1);
    assert.deepEqual(report.buckets, []);
    assert.equal(report.source, "openai-chatgpt-auth");
    assert.equal(report.metrics[0]?.value, "Connected (native OAuth)");
    const text = formatUsageReport(report, "current");
    assert.match(text, /OpenAI ChatGPT Plan Status/);
    assert.match(text, /Codex companion usage is disabled/);
    assert.match(text, /https:\/\/chatgpt\.com\/settings\/usage/);
    assert.doesNotMatch(text, /synthetic|[0-9]+%/);
    assert.equal(formatUsageStatusline(report), "chatgpt usage: web only");
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});

for (const source of [
  undefined,
  "stored credential",
  "OPENAI_API_KEY",
  "runtime",
  "environment",
  "models_json_key",
  "models_json_command",
  "fallback",
  "API key",
]) {
  test(`OpenAI ${source ?? "unknown"} auth is unsupported even with a matching stored OAuth token`, async () => {
    const reader = vi.fn(() => ({ ok: false as const }));
    await assert.rejects(
      () => resolveUsageAuth(context({ source }), OPENAI_CHATGPT_ADAPTER, undefined, () => credential, reader),
      UnsupportedOpenAIUsageAuthError,
    );
    assert.equal(reader.mock.calls.length, 0);
  });
}

test("native auth honors effective model and provider Authorization, including removed and empty headers", async () => {
  const valid: Auth[] = [
    { apiKey: credential.access, headers: { authorization: `bEaReR ${credential.access}` } },
    { headers: { AUTHORIZATION: `Bearer ${credential.access}` } },
  ];
  for (const selectedAuth of valid) {
    assert.ok(await resolve({ selectedAuth }));
  }
  const invalid: Auth[] = [
    { apiKey: "other-runtime-key" },
    { apiKey: credential.access, headers: { authorization: "Bearer other-account" } },
    { apiKey: credential.access, headers: { Authorization: null } },
    { apiKey: credential.access, headers: { Authorization: "" } },
    { apiKey: credential.access, headers: { Authorization: "Basic other-key" } },
    { headers: { Authorization: null } },
    {},
    {
      apiKey: credential.access,
      headers: { Authorization: `Bearer ${credential.access}`, authorization: "Bearer other" },
    },
  ];
  for (const selectedAuth of invalid) {
    await assert.rejects(() => resolve({ selectedAuth }), /authorization.*match|ambiguous/);
  }
  for (const providerAuth of invalid) {
    await assert.rejects(() => resolve({ providerAuth }), /authorization.*match|ambiguous/);
  }
});

test("native grants require exact access, complete client metadata, direct scope, and unambiguous matches", async () => {
  assert.ok(await resolve({}, [credential, structuredClone(credential)]));
  assert.ok(await resolve({}, [null, [], { type: "api_key", key: credential.access }, credential]));
  for (const values of [
    [],
    [{ ...credential, access: "other-account" }],
    [
      {
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
        accountId: "legacy",
      },
    ],
    ...[
      { refresh: "" },
      { expires: Number.NaN },
      { clientId: undefined },
      { clientId: " " },
      { scopes: undefined },
      { scopes: [] },
      { scopes: ["openid"] },
      { scopes: ["chatgpt.tokens.use.direct", 7] },
    ].map((override) => [{ ...credential, ...override }]),
    [credential, { ...credential, scopes: [] }],
    [credential, { ...credential, refresh: "conflicting-refresh" }],
    [credential, { ...credential, clientId: "conflicting-client" }],
  ]) {
    await assert.rejects(() => resolve({}, values), /native ChatGPT|Conflicting/);
  }
});

test("native status rejects selected, provider, and resolved custom origins before credential discovery", async () => {
  const proxy = "https://proxy.example.test/v1";
  for (const options of [
    { modelUrl: proxy },
    { providerUrl: proxy },
    { providerAuth: { apiKey: credential.access, baseUrl: proxy } },
    { selectedAuth: { apiKey: credential.access, baseUrl: proxy } },
    { modelUrl: "https://api.openai.com.evil.test/v1" },
    { modelUrl: "http://api.openai.com/v1" },
    { modelUrl: "https://chatgpt.com/backend-api/codex" },
  ]) {
    const reader = vi.fn(candidates([credential]));
    await assert.rejects(
      () => resolveUsageAuth(context(options), OPENAI_CHATGPT_ADAPTER, undefined, () => undefined, reader),
      /official|proxy|base URL/,
    );
    assert.equal(reader.mock.calls.length, 0);
  }
});

test("native OAuth waits for provider-neutral readiness and accepts the exact synchronous offer", async () => {
  const mock = createMockPi();
  const ctx = context();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let offers = 0;
  mock.eventBus.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
    const request = data as { provider: string; session: unknown; waitUntil(value: Promise<unknown>): void };
    if (request.provider === "openai" && request.session === ctx.sessionManager) request.waitUntil(pending);
  });
  mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
    const request = data as { provider: string; offer(value: unknown): void };
    if (request.provider === "openai") {
      offers += 1;
      request.offer(credential);
    }
  });
  const reader = createOAuthCredentialCandidateReader(mock.pi, () => ({ ...credential, access: "inactive-account" }));
  const resolving = resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => undefined, reader);
  await Promise.resolve();
  assert.equal(offers, 0);
  release();
  assert.ok(await resolving);
  assert.equal(offers, 1);
  const unavailable = candidates([credential]);
  unavailable.waitUntilReady = async () => false;
  await assert.rejects(
    () => resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential, unavailable),
    /readiness failed closed/,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(
        ctx,
        OPENAI_CHATGPT_ADAPTER,
        undefined,
        () => credential,
        () => ({ ok: false }),
      ),
    /discovery failed closed/,
  );
});

test("native report requires revalidation and respects cancellation before and after its await", async () => {
  const auth = await resolve();
  assert.ok(auth);
  await assert.rejects(
    () => queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, new AbortController().signal, 1_000),
    /revalidation/,
  );
  const controller = new AbortController();
  await assert.rejects(
    () =>
      queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, controller.signal, 1_000, async () => {
        controller.abort();
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  const guard = vi.fn(async () => undefined);
  await assert.rejects(
    () => queryProviderUsage(OPENAI_CHATGPT_ADAPTER, auth, controller.signal, 1_000, guard),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(guard.mock.calls.length, 0);
});
