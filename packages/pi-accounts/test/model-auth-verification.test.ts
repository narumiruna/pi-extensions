import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import accountsExtension from "../src/accounts.js";
import { type AccountProviderId, createBuiltinProviderAdapters } from "../src/oauth.js";
import { RUNTIME_FAIL_CLOSED_API_KEY, RuntimeAuthCoordinator } from "../src/runtime-auth.js";

const key = "sk-named-fixture";
const otherKey = "sk-other-fixture";
const oauth = { type: "oauth" as const, access: key, refresh: "refresh-fixture", expires: 2_000_000_000_000 };

async function fixture(id: AccountProviderId, api?: string) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const adapter = createBuiltinProviderAdapters().find((provider) => provider.id === id);
  assert.ok(adapter);
  const provider = { ...adapter, refreshModelCatalogAfterAuth: false };
  const model = registry.getAll().find((item) => item.provider === id && (!api || item.api === api));
  assert.ok(model);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider(id, () => ({
    active: "work",
    accounts: { work: { type: "api_key", key }, subscription: oauth },
  }));
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const context = (): ExtensionContext =>
    createMockContext({
      model: registry.find(id, model.id),
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(process.cwd()),
    }).ctx;
  return { registry, provider, model, store, mock, coordinator, context };
}

for (const id of [
  "openai",
  "meta",
  "anthropic",
  "github-copilot",
  "kimi-coding",
  "openrouter",
  "radius",
  "xai",
] as const) {
  for (const scope of ["provider", "model"] as const) {
    test(`${id} fails closed for conflicting ${scope} authentication without rewriting configuration`, async () => {
      const f = await fixture(id);
      const headers = { Authorization: `Bearer ${otherKey}`, "X-Unrelated": "preserved" };
      const config = scope === "provider" ? { headers } : { models: [{ ...f.model, headers }] };
      f.registry.registerProvider(id, config);
      const ctx = f.context();
      const result = await f.coordinator.ensureActive(ctx, f.store, "work");
      assert.equal(result.status, "error");
      if (result.status === "error") assert.match(result.message, /conflicting authentication header/);
      assert.doesNotMatch(JSON.stringify(result), /sk-named-fixture|sk-other-fixture/);
      assert.equal(await f.registry.getApiKeyForProvider(id), RUNTIME_FAIL_CLOSED_API_KEY);
      assert.deepEqual(f.registry.getRegisteredProviderConfig(id), config);
      let offered = false;
      f.coordinator.offerCredential({
        session: ctx.sessionManager,
        provider: id,
        offer: () => {
          offered = true;
        },
      });
      assert.equal(offered, false);
      assert.equal((await f.coordinator.ensureActive(ctx, f.store, null)).status, "inactive");
      assert.deepEqual(f.registry.getRegisteredProviderConfig(id), config);
      await f.coordinator.clear(ctx);
    });
  }
}

for (const [id, api, header] of [
  ["openai", "openai-responses", "api-key"],
  ["openrouter", "openai-completions", "api-key"],
  ["anthropic", "anthropic-messages", "x-api-key"],
  ["kimi-coding", "anthropic-messages", "x-api-key"],
] as const) {
  test(`${id} detects a case-insensitive ${header} override`, async () => {
    const f = await fixture(id, api);
    f.registry.registerProvider(id, { headers: { [header.toUpperCase()]: otherKey } });
    const result = await f.coordinator.ensureActive(f.context(), f.store, "work");
    assert.equal(result.status, "error");
    if (result.status === "error") assert.match(result.message, /conflicting authentication header/);
    await f.coordinator.clear(f.context());
  });
}

for (const account of ["work", "subscription"]) {
  test(`${account} verifies non-selected models as well as the first model`, async () => {
    const f = await fixture("openai");
    const models = f.registry.getAll().filter((model) => model.provider === "openai");
    const later = models.at(-1);
    assert.ok(later && later.id !== f.model.id);
    f.registry.registerProvider("openai", { models: [{ ...later, headers: { authorization: `Bearer ${otherKey}` } }] });
    const result = await f.coordinator.ensureActive(f.context(), f.store, account);
    assert.equal(result.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /sk-named-fixture|sk-other-fixture/);
    await f.coordinator.clear(f.context());
  });
}

for (const scope of ["provider", "model"] as const) {
  test(`models.json ${scope} authentication cannot silently displace a named key`, async () => {
    const root = await mkdtemp(join(tmpdir(), "accounts-auth-"));
    try {
      const modelsPath = join(root, "models.json");
      const headers = { Authorization: `Bearer ${otherKey}` };
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: { openai: scope === "provider" ? { headers } : { models: [{ id: "gpt-5.5", headers }] } },
        }),
      );
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        refreshOnCreate: false,
      });
      const registry = new ModelRegistry(runtime);
      const f = await fixture("openai");
      const ctx = createMockContext({
        modelRegistry: registry,
        sessionManager: SessionManager.inMemory(process.cwd()),
      }).ctx;
      const result = await f.coordinator.ensureActive(ctx, f.store, "work");
      assert.equal(result.status, "error");
      await f.coordinator.clear(ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [id, api] of [
  ["openai", "openai-responses"],
  ["openrouter", "openai-completions"],
  ["anthropic", "anthropic-messages"],
  ["radius", "pi-messages"],
] as const) {
  const headerCases: Record<string, string>[] = [
    { "X-Unrelated": "preserved" },
    { authorization: `Bearer ${key}`, "X-Unrelated": "preserved" },
  ];
  for (const headers of headerCases) {
    test(`${api} preserves the selected credential in an actual mocked request (${Object.keys(headers).join(",")})`, async () => {
      const f = await fixture(id, api);
      f.registry.registerProvider(id, { headers });
      const ctx = f.context();
      assert.equal((await f.coordinator.ensureActive(ctx, f.store, "work")).status, "active");
      let sent: Headers | undefined;
      const model = f.registry.find(id, f.model.id);
      assert.ok(model);
      await f.registry
        .streamSimple(
          model,
          { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
          {
            fetch: async (input, init) => {
              sent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
              return new Response(JSON.stringify({ error: { message: "mocked response; no network" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            },
          },
        )
        .result();
      assert.ok(sent);
      assert.equal(
        sent.get(api === "anthropic-messages" && !("authorization" in headers) ? "x-api-key" : "authorization"),
        api === "anthropic-messages" && !("authorization" in headers) ? key : `Bearer ${key}`,
      );
      assert.equal(sent.get("x-unrelated"), "preserved");
      await f.coordinator.clear(ctx);
    });
  }
}

test("SDK header aliases reject a conflicting effective last value", async () => {
  const f = await fixture("openai");
  f.registry.registerProvider("openai", {
    headers: { Authorization: `Bearer ${key}`, authorization: `Bearer ${otherKey}` },
  });
  assert.equal((await f.coordinator.ensureActive(f.context(), f.store, "work")).status, "error");
  await f.coordinator.clear(f.context());
});

test("pi-messages rejects a differently cased header even when its token matches", async () => {
  const f = await fixture("radius");
  f.registry.registerProvider("radius", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await f.coordinator.ensureActive(f.context(), f.store, "work")).status, "error");
  await f.coordinator.clear(f.context());
});

for (const authHeader of [false, true]) {
  test(`SDK aliases use their effective last value and generated authHeader (${authHeader})`, async () => {
    const f = await fixture("openai");
    f.registry.registerProvider("openai", {
      authHeader,
      headers: { authorization: `Bearer ${otherKey}`, Authorization: `Bearer ${key}` },
    });
    assert.equal((await f.coordinator.ensureActive(f.context(), f.store, "work")).status, "active");
    await f.coordinator.clear(f.context());
  });
}

for (const [id, header, rejected] of [
  ["openai", "Authorization", true],
  ["anthropic", "Authorization", false],
  ["radius", "Authorization", false],
  ["radius", "authorization", false],
] as const) {
  test(`${id} respects native null authentication-header semantics (${header})`, async () => {
    const f = await fixture(id);
    const getAuth = f.registry.getApiKeyAndHeaders.bind(f.registry);
    f.registry.getApiKeyAndHeaders = async (model) => {
      const result = await getAuth(model);
      return result.ok ? { ...result, headers: { ...result.headers, [header]: null } } : result;
    };
    assert.equal(
      (await f.coordinator.ensureActive(f.context(), f.store, "work")).status,
      rejected ? "error" : "active",
    );
    await f.coordinator.clear(f.context());
  });
}

test("Codex retains its generated Authorization instead of rejecting inert default headers", async () => {
  const f = await fixture("openai-codex");
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
  await f.store.updateProvider("openai-codex", () => ({ accounts: { subscription: { ...oauth, access: token } } }));
  f.registry.registerProvider("openai-codex", { headers: { Authorization: `Bearer ${otherKey}` } });
  const ctx = f.context();
  assert.equal((await f.coordinator.ensureActive(ctx, f.store, "subscription")).status, "active");
  let sent: Headers | undefined;
  const model = f.registry.find("openai-codex", f.model.id);
  assert.ok(model);
  await f.registry
    .streamSimple(
      model,
      { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
      {
        transport: "sse",
        fetch: async (input, init) => {
          sent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          return new Response("mocked response", { status: 400 });
        },
      },
    )
    .result();
  assert.equal(sent?.get("authorization"), `Bearer ${token}`);
  await f.coordinator.clear(ctx);
});

test("a conflicting non-selected model aborts the provider turn", async () => {
  const f = await fixture("openai");
  const later = f.registry
    .getAll()
    .filter((model) => model.provider === "openai")
    .at(-1);
  assert.ok(later);
  f.registry.registerProvider("openai", { models: [{ ...later, headers: { Authorization: `Bearer ${otherKey}` } }] });
  accountsExtension(f.mock.pi, { store: f.store, providers: [f.provider] });
  let aborted = false;
  const { ctx, notifications } = createMockContext({
    model: f.model,
    modelRegistry: f.registry,
    sessionManager: SessionManager.inMemory(process.cwd()),
    abort: () => {
      aborted = true;
    },
  });
  await f.mock.events.get("session_start")?.[0]?.({}, ctx);
  await f.mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  await f.mock.events.get("turn_start")?.[0]?.({}, ctx);
  assert.equal(aborted, true);
  assert.doesNotMatch(JSON.stringify(notifications), /sk-named-fixture|sk-other-fixture/);
  await f.mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("invalidation during model authentication resolution prevents late activation", async () => {
  const f = await fixture("openai");
  const ctx = f.context();
  let ready: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getAuth = f.registry.getApiKeyAndHeaders.bind(f.registry);
  f.registry.getApiKeyAndHeaders = async (model) => {
    ready();
    await pending;
    return getAuth(model);
  };
  const task = f.coordinator.ensureActive(ctx, f.store, "work");
  await entered;
  f.coordinator.invalidate(ctx);
  release();
  assert.equal((await task).status, "inactive");
  await f.coordinator.clear(ctx);
});
