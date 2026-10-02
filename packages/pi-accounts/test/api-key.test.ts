import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  AccountStore,
  InMemoryAccountStorageBackend,
  normalizeApiKeyCredential,
  parseAccountsData,
} from "../src/account-store.js";
import accountsExtension from "../src/accounts.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.js";
import { RUNTIME_FAIL_CLOSED_API_KEY, RuntimeAuthCoordinator } from "../src/runtime-auth.js";

const oauth = {
  type: "oauth" as const,
  access: "fixture-oauth",
  refresh: "fixture-refresh",
  expires: 2_000_000_000_000,
};

test("mixed API key and OAuth storage preserves unknown fields and rejects malformed keys without mutation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    future: { enabled: true },
    providers: {
      openai: {
        extra: "retained",
        accounts: { api: { type: "api_key", key: "sk-fixture", future: 42 }, subscription: oauth },
      },
      meta: { accounts: { muse: oauth } },
    },
  });
  await store.updateProvider("openai", (state) => ({ ...state, active: "api" }));
  assert.equal(store.read().providers.openai?.accounts.api?.future, 42);
  assert.equal(store.read().providers.openai?.extra, "retained");
  assert.deepEqual(store.read().future, { enabled: true });
  const previous = JSON.stringify(store.read());
  for (const key of ["", " ", "sk-fixture\n", "sk-fixture\u001b", "sk fixture"]) {
    assert.throws(() => normalizeApiKeyCredential(key), /API key/);
    await assert.rejects(
      store.updateProvider("openai", (state) => ({ ...state, accounts: { api: { type: "api_key", key } } })),
      /API key/,
    );
    assert.equal(JSON.stringify(store.read()), previous);
  }
  for (const value of [
    { type: "api_key" },
    { type: "api_key", key: 1 },
    { type: "api_key", key: "valid", access: "mixed" },
  ]) {
    assert.throws(
      () => parseAccountsData(JSON.stringify({ version: 1, providers: { openai: { accounts: { bad: value } } } })),
      /API key/,
    );
  }
});

for (const adapter of createBuiltinProviderAdapters().filter((provider) => provider.supportsApiKey)) {
  test(`${adapter.id} API key bypasses OAuth and restores Pi authentication`, async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const mock = createMockPi();
    const provider = {
      ...adapter,
      refreshModelCatalogAfterAuth: false,
      oauth: {
        login: async () => {
          throw new Error("unexpected OAuth login");
        },
        refresh: async () => {
          throw new Error("unexpected OAuth refresh");
        },
        toAuth: async () => {
          throw new Error("unexpected OAuth conversion");
        },
      },
    };
    const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider(adapter.id, () => ({ accounts: { api: { type: "api_key", key: "sk-fixture" } } }));
    const sessionManager = SessionManager.inMemory(process.cwd());
    const { ctx } = createMockContext({ modelRegistry: registry, sessionManager });
    const previous = registry.getRegisteredProviderConfig(adapter.id);
    const result = await coordinator.ensureActive(ctx, store, "api");
    assert.equal(result.status, "active");
    assert.equal(await registry.getApiKeyForProvider(adapter.id), "sk-fixture");
    assert.equal(registry.getRegisteredProviderConfig(adapter.id), previous);
    coordinator.publishCredentialOffer(ctx, result, coordinator.getAppliedAuthIdentity(ctx, result));
    let offered = false;
    coordinator.offerCredential({
      session: sessionManager,
      provider: adapter.id,
      offer: () => {
        offered = true;
      },
    });
    assert.equal(offered, false);
    assert.equal((await coordinator.ensureActive(ctx, store, null)).status, "inactive");
    assert.notEqual(await registry.getApiKeyForProvider(adapter.id), "sk-fixture");
    assert.equal(registry.getRegisteredProviderConfig(adapter.id), previous);
    await coordinator.clear(ctx);
  });
}

for (const id of ["openai", "meta", "kimi-coding"] as const) {
  test(`${id} supports OAuth → API key → OAuth transitions through Pi`, async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const adapter = createBuiltinProviderAdapters().find((provider) => provider.id === id);
    assert.ok(adapter);
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider(id, () => ({
      accounts: { subscription: oauth, api: { type: "api_key", key: "sk-fixture" } },
    }));
    const mock = createMockPi();
    const { ctx } = createMockContext({
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    const coordinator = new RuntimeAuthCoordinator(mock.pi, adapter);
    for (const name of ["subscription", "api", "subscription"]) {
      assert.equal((await coordinator.ensureActive(ctx, store, name)).status, "active");
      const model = registry.getAll().find((item) => item.provider === id);
      assert.ok(model);
      const resolved = await registry.getApiKeyAndHeaders(model);
      assert.equal(resolved.ok, true);
      if (!resolved.ok) continue;
      assert.equal(
        resolved.apiKey,
        name === "api" ? "sk-fixture" : id === "kimi-coding" ? "pi-accounts-header-auth" : "fixture-oauth",
      );
      assert.equal(
        resolved.headers?.Authorization,
        name !== "api" && id === "kimi-coding" ? "Bearer fixture-oauth" : undefined,
      );
    }
    await coordinator.clear(ctx);
    assert.equal(registry.getRegisteredProviderConfig(id), undefined);
  });
}

test("API key activation errors redact the exact key and fail closed; legacy Codex rejects keys", async () => {
  for (const id of ["openai", "openai-codex"] as const) {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider(id, () => ({ accounts: { api: { type: "api_key", key: "private-key-value" } } }));
    const setKey = runtime.setRuntimeApiKey.bind(runtime);
    runtime.setRuntimeApiKey = async (provider, key) => {
      if (key === "private-key-value") throw new Error(`rejected ${key}`);
      await setKey(provider, key);
    };
    const adapter = createBuiltinProviderAdapters().find((provider) => provider.id === id);
    assert.ok(adapter);
    const { ctx } = createMockContext({ modelRegistry: registry });
    const coordinator = new RuntimeAuthCoordinator(createMockPi().pi, adapter);
    const result = await coordinator.ensureActive(ctx, store, "api");
    assert.equal(result.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /private-key-value/);
    assert.equal(await registry.getApiKeyForProvider(id), RUNTIME_FAIL_CLOSED_API_KEY);
    await coordinator.clear(ctx);
  }
});

test("RPC API key manager adds, confirms replacement, removes, and cancels without exposing keys", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  const providers = createBuiltinProviderAdapters().filter((provider) =>
    ["openai", "openai-codex"].includes(provider.id),
  );
  accountsExtension(mock.pi, { store, providers });
  const sessionManager = SessionManager.inMemory(process.cwd());
  const model = registry.getAll().find((item) => item.provider === "openai");
  const run = async (choices: string[], inputs: Array<string | undefined>, confirm = true) => {
    const addingKey = choices[0] === "Add API key account";
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      hasUI: true,
      sessionManager,
      model,
      modelRegistry: registry,
      select: async (_title: string, options: string[]) => {
        const choice = choices.shift();
        if (choice) assert.ok(options.includes(choice), `Missing ${choice}`);
        if (addingKey && choice === "OpenAI") assert.equal(options.includes("OpenAI Codex"), false);
        return choice;
      },
      input: async () => inputs.shift(),
      confirm: async () => confirm,
    });
    await mock.commands.get("accounts")?.handler("", ctx);
    assert.doesNotMatch(JSON.stringify(notifications), /sk-fixture|sk-replacement/);
    return ctx;
  };
  const ctx = await run(["Add API key account", "OpenAI"], ["api", "sk-fixture"]);
  assert.equal(await registry.getApiKeyForProvider("openai"), "sk-fixture");
  assert.equal(store.read().providers.openai?.accounts.api?.type, "api_key");
  const offers: unknown[] = [];
  mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, {
    session: sessionManager,
    provider: "openai",
    offer: (value: unknown) => offers.push(value),
  });
  assert.deepEqual(offers, []);
  await run(["Add API key account", "OpenAI"], ["api", "sk-replacement"], false);
  assert.equal(await registry.getApiKeyForProvider("openai"), "sk-fixture");
  await run(["Add API key account", "OpenAI"], ["api", "sk-replacement"]);
  assert.equal(await registry.getApiKeyForProvider("openai"), "sk-replacement");
  await run(["Add API key account", "OpenAI"], ["invalid", "sk-fixture\n"]);
  assert.equal(store.read().providers.openai?.accounts.invalid, undefined);
  await run(["Set default account", "OpenAI", "api"], []);
  assert.equal(store.read().providers.openai?.active, "api");
  await run(["Add API key account", "OpenAI"], ["cancelled", undefined]);
  assert.equal(store.read().providers.openai?.accounts.cancelled, undefined);
  await run(["Remove account", "OpenAI · api"], []);
  assert.equal(store.read().providers.openai?.accounts.api, undefined);
  assert.notEqual(await registry.getApiKeyForProvider("openai"), "sk-replacement");
  assert.equal(store.read().providers.openai?.active, undefined);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("shutdown during API key entry discards a late response and cancels the input signal", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: createBuiltinProviderAdapters().filter((provider) => provider.id === "openai"),
  });
  let resolveKey: (key: string) => void = () => undefined;
  let ready: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let inputSignal: AbortSignal | undefined;
  const choices = ["Add API key account", "OpenAI"];
  const { ctx } = createMockContext({
    mode: "rpc",
    hasUI: true,
    modelRegistry: registry,
    sessionManager: SessionManager.inMemory(process.cwd()),
    select: async () => choices.shift(),
    input: async (title: string, _placeholder: string, options: { signal: AbortSignal }) => {
      if (title.startsWith("Name")) return "cancelled";
      inputSignal = options.signal;
      ready();
      return new Promise<string>((resolve) => {
        resolveKey = resolve;
      });
    },
  });
  const task = mock.commands.get("accounts")?.handler("", ctx);
  await entered;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(inputSignal?.aborted, true);
  resolveKey("sk-late-secret");
  await task;
  assert.equal(store.read().providers.openai?.accounts.cancelled, undefined);
  assert.notEqual(await registry.getApiKeyForProvider("openai"), "sk-late-secret");
});
