import assert from "node:assert/strict";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { adapterForProvider, resolveUsageAuth } from "../src/query.js";

const access = "sk-ant-oat-synthetic-runtime";
const credential = () => ({
  type: "oauth" as const,
  access,
  refresh: "synthetic-runtime-refresh",
  expires: Date.now() + 3_600_000,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function registry(initial: Credential | undefined = credential()) {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("ANTHROPIC_LOG", "off");
  let stored: Credential | undefined = initial;
  const store: CredentialStore = {
    read: async (provider) => (provider === "anthropic" ? stored : undefined),
    list: async () => (stored ? [{ providerId: "anthropic", type: stored.type }] : []),
    modify: async (_provider, update) => {
      const next = await update(stored);
      if (next !== undefined) stored = next;
      return stored;
    },
    delete: async () => {
      stored = undefined;
    },
  };
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });
  const models = new ModelRegistry(runtime);
  const model = models.getAll().find((candidate) => candidate.provider === "anthropic");
  assert.ok(model);
  const adapter = adapterForProvider("anthropic");
  assert.ok(adapter);
  return { runtime, models, model, adapter, stored: () => stored };
}

for (const [name, headers, expected, apiKey] of [
  ["default", {}, `Bearer ${access}`, null],
  ["matching header", { Authorization: `Bearer ${access}` }, `Bearer ${access}`, null],
  ["replacement", { Authorization: "Bearer synthetic-other" }, "Bearer synthetic-other", null],
  ["null removal", { Authorization: null }, null, null],
  ["empty removal", { Authorization: "" }, undefined, null],
  [
    "later case replacement",
    { Authorization: `Bearer ${access}`, authorization: "Bearer synthetic-other" },
    "Bearer synthetic-other",
    null,
  ],
  [
    "later case match",
    { authorization: "Bearer synthetic-other", Authorization: `Bearer ${access}` },
    `Bearer ${access}`,
    null,
  ],
  ["dual auth", { "x-api-key": "synthetic-other" }, `Bearer ${access}`, "synthetic-other"],
  ["removed API key", { "x-api-key": null }, `Bearer ${access}`, null],
] as const) {
  test(`Anthropic usage auth agrees with real Pi/SDK request headers: ${name}`, async () => {
    const state = await registry();
    // Characterize SDK-supported null removals even though model metadata types allow strings only.
    const model = { ...state.model, headers } as typeof state.model;
    let observed: { bearer: string | null; apiKey: string | null } | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observed = { bearer: headers.get("authorization"), apiKey: headers.get("x-api-key") };
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Synthetic characterization only." },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    await state.runtime
      .streamSimple(
        model,
        { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] },
        { fetch, maxTokens: 1 },
      )
      .result();
    if (expected === undefined) assert.equal(observed, undefined);
    else assert.deepEqual(observed, { bearer: expected, apiKey });
    const ctx = createMockContext({ model, modelRegistry: state.models }).ctx;
    const resolve = () => resolveUsageAuth(ctx, state.adapter, undefined, state.stored);
    if (expected === `Bearer ${access}` && !apiKey) assert.ok(await resolve());
    else await assert.rejects(resolve(), /Anthropic|Claude/);
  });
}

for (const header of ["Authorization: Bearer synthetic-environment", "X-Api-Key: synthetic-environment"]) {
  test(`Anthropic SDK environment header ${header.split(":")[0]} cannot silently select a different account`, async () => {
    const state = await registry();
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", header);
    let observed: Headers | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observed = new Headers(init?.headers);
      return new Response("{}", { status: 400 });
    });
    await state.runtime
      .streamSimple(
        state.model,
        { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] },
        { fetch, maxTokens: 1 },
      )
      .result();
    assert.ok(observed);
    assert.ok(
      observed.get("authorization")?.includes("synthetic-environment") ||
        observed.get("x-api-key")?.includes("synthetic-environment"),
    );
    const ctx = createMockContext({ model: state.model, modelRegistry: state.models }).ctx;
    await assert.rejects(resolveUsageAuth(ctx, state.adapter, undefined, state.stored), /SDK custom headers/);
  });
}

test("real Pi runtime API-key overrides cannot reuse the stored Claude subscription grant", async () => {
  const state = await registry();
  const ctx = createMockContext({ model: state.model, modelRegistry: state.models }).ctx;
  assert.ok(await resolveUsageAuth(ctx, state.adapter, undefined, state.stored));
  await state.runtime.setRuntimeApiKey("anthropic", "synthetic-runtime-api-key");
  await assert.rejects(resolveUsageAuth(ctx, state.adapter, undefined, state.stored), /OAuth/);
  await state.runtime.removeRuntimeApiKey("anthropic");
  assert.ok(await resolveUsageAuth(ctx, state.adapter, undefined, state.stored));
});

for (const source of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "federation"] as const) {
  test(`real Pi ${source} cannot inherit a separate stored subscription candidate`, async () => {
    const state = await registry({ type: "api_key", key: "" });
    if (source === "federation") {
      vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "synthetic-rule");
      vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "synthetic-org");
      vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", "/synthetic-unread-identity");
    } else vi.stubEnv(source, "synthetic-environment-key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ctx = createMockContext({ model: state.model, modelRegistry: state.models }).ctx;
    await assert.rejects(
      resolveUsageAuth(ctx, state.adapter, undefined, () => credential()),
      /OAuth/,
    );
    assert.equal(fetch.mock.calls.length, 0);
  });
}

test("Pi owns Anthropic token refresh and the usage query matches the newly persisted access token", async () => {
  const state = await registry({ ...credential(), expires: 0 });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, "refresh_token");
    return new Response(
      JSON.stringify({
        access_token: "sk-ant-oat-synthetic-fresh",
        refresh_token: "synthetic-fresh-refresh",
        expires_in: 3600,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const ctx = createMockContext({ model: state.model, modelRegistry: state.models }).ctx;
  const auth = await resolveUsageAuth(ctx, state.adapter, undefined, state.stored);
  assert.equal(auth?.apiKey, "sk-ant-oat-synthetic-fresh");
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(state.stored()?.type, "oauth");
});

test("Anthropic auth resolver failures do not reflect provider token response text", async () => {
  const state = await registry({ ...credential(), expires: 0 });
  vi.stubGlobal("fetch", async () => new Response("synthetic-secret-must-not-reflect", { status: 401 }));
  const ctx = createMockContext({ model: state.model, modelRegistry: state.models }).ctx;
  await assert.rejects(resolveUsageAuth(ctx, state.adapter, undefined, state.stored), (error: Error) => {
    assert.doesNotMatch(error.message, /synthetic-secret/);
    assert.match(error.message, /authentication could not be resolved/);
    return true;
  });
});
