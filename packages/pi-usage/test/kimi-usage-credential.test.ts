import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  KIMI_CODING_USAGE_API_KEY_ENV,
  kimiUsageCredentialLabel,
  readKimiUsageCredential,
} from "../src/kimi-usage-credential.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.js";

const proxyModel = { id: "kimi-k2", name: "Kimi", provider: "kimi-coding", baseUrl: "http://127.0.0.1:8712/v1" };
const officialModel = { ...proxyModel, baseUrl: "https://api.kimi.com/coding" };
const adapter = adapterForProvider("kimi-coding");
assert.ok(adapter);
const salt = new Uint8Array(32);
const payload = { usage: { used: 2, limit: 10, window: { duration: 7, timeUnit: "TIME_UNIT_DAY" } } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  const provider = { baseUrl: proxyModel.baseUrl };
  const registry = {
    getProvider: () => provider,
    getAll: () => [proxyModel],
    getAvailable: () => [proxyModel],
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "proxy-caller-fixture" })),
    getProviderAuth: vi.fn(async () => ({ auth: { apiKey: "proxy-caller-fixture" } })),
  };
  const { ctx } = createMockContext({ model: proxyModel, modelRegistry: registry });
  let key: string | undefined = "settings-fixture-key";
  const env: Record<string, string | undefined> = {};
  const options = { envReader: () => env, kimiCodingUsageApiKeyReader: () => key };
  return {
    ctx,
    registry,
    env,
    options,
    key: (value: string | undefined) => {
      key = value;
    },
  };
}

for (const [name, envValue, settingsKey, expected] of [
  ["absent", undefined, undefined, undefined],
  ["settings", undefined, " saved-key ", { apiKey: "saved-key", source: "settings file" }],
  ["empty environment", "", "saved-key", { apiKey: "saved-key", source: "settings file" }],
  ["blank environment", " \t\n ", "saved-key", { apiKey: "saved-key", source: "settings file" }],
  ["override", " env-key ", "saved-key", { apiKey: "env-key", source: "environment" }],
] as const) {
  test(`Kimi credential selection handles ${name}`, () => {
    assert.deepEqual(readKimiUsageCredential(settingsKey, { [KIMI_CODING_USAGE_API_KEY_ENV]: envValue }), expected);
  });
}

for (const invalid of ["two tokens", "bad\0key", "bad\x1bkey", "non-ASCII-é"]) {
  test(`an invalid nonblank environment override fails closed without revealing the value (${JSON.stringify(invalid)})`, () => {
    assert.throws(
      () => readKimiUsageCredential("valid-settings-key", { [KIMI_CODING_USAGE_API_KEY_ENV]: invalid }),
      (error: unknown) =>
        error instanceof Error && /printable ASCII/u.test(error.message) && !error.message.includes(invalid),
    );
  });
}

test("Kimi source labels reveal no stored or environment credential", () => {
  vi.stubEnv(KIMI_CODING_USAGE_API_KEY_ENV, "");
  assert.equal(kimiUsageCredentialLabel(undefined), "Missing");
  assert.equal(kimiUsageCredentialLabel("settings-secret"), "Settings file");
  vi.stubEnv(KIMI_CODING_USAGE_API_KEY_ENV, "environment-secret");
  assert.equal(kimiUsageCredentialLabel("settings-secret"), "Environment");
  vi.stubEnv(KIMI_CODING_USAGE_API_KEY_ENV, "invalid secret");
  assert.equal(kimiUsageCredentialLabel("settings-secret"), "Environment (invalid)");
});

test("a settings key authorizes only the fixed official endpoint without reading proxy auth or mutating inference", async () => {
  const state = setup();
  const fetch = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(payload)),
  );
  vi.stubGlobal("fetch", fetch);
  const auth = await resolveUsageAuth(state.ctx, adapter, salt, undefined, undefined, undefined, state.options);
  assert.ok(auth);
  assert.equal(auth.source, "kimi-proxy-usage-settings");
  assert.equal(auth.env, undefined);
  assert.equal(auth.effectiveBaseUrl, officialModel.baseUrl);
  assert.equal(auth.model.baseUrl, officialModel.baseUrl);
  assert.deepEqual(auth.headers, { Authorization: "Bearer settings-fixture-key" });
  assert.ok(auth.secrets.includes("settings-fixture-key"));
  assert.ok(auth.secrets.includes("Bearer settings-fixture-key"));
  assert.equal(state.registry.getApiKeyAndHeaders.mock.calls.length, 0);
  assert.equal(state.registry.getProviderAuth.mock.calls.length, 0);
  const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1000);
  assert.equal(report.providerId, "kimi-coding");
  assert.equal(fetch.mock.calls.length, 1);
  const request = fetch.mock.calls[0];
  assert.ok(request);
  const [url, init] = request;
  assert.ok(init);
  assert.equal(url, "https://api.kimi.com/coding/v1/usages");
  assert.deepEqual(init.headers, { Authorization: "Bearer settings-fixture-key", "User-Agent": "pi-usage" });
  assert.equal(init.redirect, "error");
  assert.equal(proxyModel.baseUrl, "http://127.0.0.1:8712/v1");
});

test("environment and file credentials fingerprint the effective key and source, not a shadowed file key", async () => {
  const state = setup();
  const resolve = () => resolveUsageAuth(state.ctx, adapter, salt, undefined, undefined, undefined, state.options);
  const saved = await resolve();
  state.env[KIMI_CODING_USAGE_API_KEY_ENV] = "settings-fixture-key";
  const sameKeyOverride = await resolve();
  assert.ok(saved && sameKeyOverride);
  assert.notEqual(saved.fingerprint, sameKeyOverride.fingerprint);
  state.key("shadowed-file-key");
  assert.equal((await resolve())?.fingerprint, sameKeyOverride.fingerprint);
  state.env[KIMI_CODING_USAGE_API_KEY_ENV] = "rotated-env-key";
  assert.notEqual((await resolve())?.fingerprint, sameKeyOverride.fingerprint);
  state.env[KIMI_CODING_USAGE_API_KEY_ENV] = " \t ";
  const fallback = await resolve();
  assert.equal(fallback?.headers.Authorization, "Bearer shadowed-file-key");
  state.key(undefined);
  await assert.rejects(resolve, /custom provider base URL credential/u);
});

for (const transition of ["rotate-file", "clear-file", "add-environment", "remove-environment"] as const) {
  test(`Kimi readiness re-reads both credential sources after ${transition}`, async () => {
    const state = setup();
    if (transition === "remove-environment") state.env[KIMI_CODING_USAGE_API_KEY_ENV] = "old-env-key";
    const reader = Object.assign(async () => ({ ok: true as const, candidates: [] }), {
      waitUntilReady: async () => {
        if (transition === "rotate-file") state.key("new-file-key");
        if (transition === "clear-file") state.key(undefined);
        if (transition === "add-environment") state.env[KIMI_CODING_USAGE_API_KEY_ENV] = "new-env-key";
        if (transition === "remove-environment") delete state.env[KIMI_CODING_USAGE_API_KEY_ENV];
        return true;
      },
    });
    const pending = resolveUsageAuth(state.ctx, adapter, salt, undefined, reader, undefined, state.options);
    if (transition === "clear-file") await assert.rejects(pending, /custom provider base URL credential/u);
    else {
      const expected =
        transition === "rotate-file"
          ? "new-file-key"
          : transition === "add-environment"
            ? "new-env-key"
            : "settings-fixture-key";
      assert.equal((await pending)?.headers.Authorization, `Bearer ${expected}`);
    }
    assert.equal(state.registry.getApiKeyAndHeaders.mock.calls.length, 0);
    assert.equal(state.registry.getProviderAuth.mock.calls.length, 0);
  });
}

test("official Kimi selections do not consult the dedicated environment or settings readers", async () => {
  const registry = {
    getProviderAuth: async () => ({ auth: { apiKey: "official-runtime-key", baseUrl: officialModel.baseUrl } }),
    getAvailable: () => [officialModel],
    getAll: () => [officialModel],
  };
  const { ctx } = createMockContext({ model: officialModel, modelRegistry: registry });
  const ignored = vi.fn((): never => {
    throw new Error("Dedicated sources must not be read");
  });
  const auth = await resolveUsageAuth(ctx, adapter, salt, undefined, undefined, undefined, {
    envReader: ignored,
    kimiCodingUsageApiKeyReader: ignored,
  });
  assert.equal(auth?.headers.Authorization, "Bearer official-runtime-key");
  assert.equal(ignored.mock.calls.length, 0);
});

for (const boundary of ["before-send", "after-response"] as const) {
  test(`Kimi usage rejects credential rotation ${boundary}`, async () => {
    const state = setup();
    const resolve = () => resolveUsageAuth(state.ctx, adapter, salt, undefined, undefined, undefined, state.options);
    const auth = await resolve();
    assert.ok(auth);
    const fetch = vi.fn(async () => {
      if (boundary === "after-response") state.key("rotated-file-key");
      return new Response(JSON.stringify(payload));
    });
    vi.stubGlobal("fetch", fetch);
    if (boundary === "before-send") state.key("rotated-file-key");
    await assert.rejects(
      queryProviderUsage(adapter, auth, new AbortController().signal, 1000, async () => {
        if ((await resolve())?.fingerprint !== auth.fingerprint)
          throw Object.assign(new Error("Credential changed"), { name: "AbortError" });
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(fetch.mock.calls.length, boundary === "before-send" ? 0 : 1);
  });
}

test("Kimi settings credentials are redacted from provider and transport errors", async () => {
  const state = setup();
  const auth = await resolveUsageAuth(state.ctx, adapter, salt, undefined, undefined, undefined, state.options);
  assert.ok(auth);
  vi.stubGlobal("fetch", async () => new Response("Bearer settings-fixture-key rejected", { status: 401 }));
  await assert.rejects(
    queryProviderUsage(adapter, auth, new AbortController().signal, 1000),
    (error: unknown) => error instanceof Error && !error.message.includes("settings-fixture-key"),
  );
});
