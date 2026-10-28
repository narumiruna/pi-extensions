import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import accountsExtension, { AccountStore } from "../src/accounts.js";
import { ACCOUNTS_SELECTION_COMMITTED_CHANNEL } from "../src/accounts-protocol.js";
import type { AccountProviderAdapter } from "../src/oauth.js";
import { RUNTIME_FAIL_CLOSED_API_KEY } from "../src/runtime-auth.js";
import {
  type AccountStorageBackend,
  FileAccountStorageBackend,
  InMemoryAccountStorageBackend,
} from "../src/storage.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

isolateAccountEnvironment();
beforeAll(() => initTheme("dark", false));
const access = "fixture-access-secret";
const refresh = "fixture-refresh-secret";
const key = "fixture-api-secret";
const credential = { type: "oauth" as const, access, refresh, expires: Date.now() + 3_600_000 };
type Reply = { status: string; providerId: string; accountName?: string | null; code?: string; message?: string };
const provider: AccountProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  requiresApiKeyBridge: false,
  supportsApiKey: true,
  runtimeAuthMode: "api-key",
  oauth: {
    login: async () => credential,
    refresh: async () => credential,
    toAuth: async (value) => ({ apiKey: value.access }),
  },
};
async function fixture(adapter = provider, backend: AccountStorageBackend = new InMemoryAccountStorageBackend()) {
  const mock = createMockPi();
  const store = new AccountStore(backend);
  await store.updateProvider("openai", () => ({
    active: "beta",
    accounts: { alpha: credential, beta: { type: "api_key", key } },
  }));
  accountsExtension(mock.pi, { store, providers: [adapter] });
  async function session(model?: object) {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const manager = SessionManager.inMemory(process.cwd());
    const { ctx } = createMockContext({ sessionManager: manager, modelRegistry: registry, model });
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    return { registry, manager, ctx };
  }
  return { mock, store, session };
}
async function activate(
  mock: ReturnType<typeof createMockPi>,
  session: object,
  account: string | null,
  extra: object = {},
) {
  let pending: Promise<Reply> | undefined;
  pending = new Promise<Reply>((resolve) => {
    mock.rawPi.events.emit("accounts:activation:v1", {
      session,
      provider: "openai",
      account,
      ...extra,
      reply: resolve,
    });
  });
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("No activation reply")), 1000);
      void pending?.finally(() => clearTimeout(timer));
    }),
  ]);
}
function safe(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [access, refresh, key]) assert.ok(!text.includes(secret));
}

test("topology inventories both credential kinds and default without secrets", async () => {
  const { mock } = await fixture();
  const result = await new Promise<unknown>((resolve) => {
    mock.rawPi.events.emit("accounts:topology:v1", { reply: resolve });
  });
  assert.deepEqual(result, {
    providers: [
      {
        providerId: "openai",
        displayName: "OpenAI",
        accounts: [
          { name: "alpha", kind: "oauth" },
          { name: "beta", kind: "api-key" },
        ],
        defaultAccount: "beta",
      },
    ],
  });
  safe(result);
});
for (const account of ["alpha", "beta"] as const) {
  test(`${account} activation overrides NEW-session default before first auth resolution`, async () => {
    const { mock, session } = await fixture();
    const current = await session();
    const result = await activate(mock, current.manager, account);
    assert.deepEqual(result, { status: "active", providerId: "openai", accountName: account });
    const selection = current.manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-accounts-selection")
      .at(-1);
    assert.ok(selection?.type === "custom");
    assert.equal((selection.data as { providers: Record<string, string | null> }).providers.openai, account);
    assert.equal(await current.registry.getApiKeyForProvider("openai"), account === "alpha" ? access : key);
    safe(result);
    const restored = await activate(mock, current.manager, null);
    assert.deepEqual(restored, { status: "inactive", providerId: "openai", accountName: null });
    assert.notEqual(await current.registry.getApiKeyForProvider("openai"), account === "alpha" ? access : key);
  });
}
test("explicit selection emits a credential-free session notification", async () => {
  const { mock, session } = await fixture();
  const current = await session();
  const notifications: unknown[] = [];
  mock.rawPi.events.on(ACCOUNTS_SELECTION_COMMITTED_CHANNEL, (value) => notifications.push(value));

  const result = await activate(mock, current.manager, "alpha");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { status: "active", providerId: "openai", accountName: "alpha" });
  assert.deepEqual(notifications, [
    {
      session: current.manager,
      sessionId: current.manager.getSessionId(),
      providerId: "openai",
    },
  ]);
  safe(notifications);
});

test("PI_ACCOUNT rejects protocol activation and default restoration without changing session selection", async () => {
  process.env.PI_ACCOUNT = "alpha";
  const { mock, session } = await fixture();
  const current = await session({ provider: "openai", id: "gpt-4o" });
  await mock.events.get("before_agent_start")?.[0]?.({}, current.ctx);
  const entries = current.manager.getEntries().length;
  assert.equal(await current.registry.getApiKeyForProvider("openai"), access);
  for (const account of ["beta", "alpha", null]) {
    const result = await activate(mock, current.manager, account);
    assert.deepEqual(result, {
      status: "error",
      providerId: "openai",
      accountName: account,
      code: "activation_failed",
    });
    assert.equal(current.manager.getEntries().length, entries);
    assert.equal(await current.registry.getApiKeyForProvider("openai"), access);
  }
});
test("invalid PI_ACCOUNT also rejects protocol activation without restoring default auth", async () => {
  process.env.PI_ACCOUNT = "default";
  const { mock, session } = await fixture();
  const current = await session({ provider: "openai", id: "gpt-4o" });
  await mock.events.get("before_agent_start")?.[0]?.({}, current.ctx);
  const entries = current.manager.getEntries().length;
  assert.equal(await current.registry.getApiKeyForProvider("openai"), RUNTIME_FAIL_CLOSED_API_KEY);
  assert.equal((await activate(mock, current.manager, "beta")).code, "activation_failed");
  assert.equal(current.manager.getEntries().length, entries);
  assert.equal(await current.registry.getApiKeyForProvider("openai"), RUNTIME_FAIL_CLOSED_API_KEY);
});
test("two sessions use independent real ModelRuntime credentials", async () => {
  const { mock, session } = await fixture();
  const a = await session();
  const b = await session();
  const replies = await Promise.all([activate(mock, a.manager, "alpha"), activate(mock, b.manager, "beta")]);
  assert.ok(replies.every((reply) => reply.status === "active"));
  assert.equal(await a.registry.getApiKeyForProvider("openai"), access);
  assert.equal(await b.registry.getApiKeyForProvider("openai"), key);
});
test("typed errors do not publish raw provider exceptions", async () => {
  const { mock, store, session } = await fixture({
    ...provider,
    oauth: {
      ...provider.oauth,
      refresh: async () => {
        throw new Error(`raw ${refresh} and unrelated-secret`);
      },
    },
  });
  const current = await session();
  assert.equal((await activate(mock, current.manager, "ghost")).code, "account_not_found");
  assert.equal((await activate(mock, {}, "alpha")).code, "session_unavailable");
  assert.equal(
    (await activate(mock, current.manager, "alpha", { provider: "unsupported" })).code,
    "provider_unsupported",
  );
  await store.updateProvider("openai", (state) => ({
    ...state,
    accounts: { ...state.accounts, alpha: { ...credential, expires: 0 } },
  }));
  const failed = await activate(mock, current.manager, "alpha");
  assert.equal(failed.code, "authentication_failed");
  safe(failed);
  assert.ok(!JSON.stringify(failed).includes("unrelated-secret"));
});
test("pre-aborted request cannot change selection or runtime auth", async () => {
  const { mock, session } = await fixture();
  const current = await session();
  await activate(mock, current.manager, "beta");
  const before = current.manager.getEntries().length;
  const controller = new AbortController();
  controller.abort(new Error(key));
  const result = await activate(mock, current.manager, "alpha", { signal: controller.signal });
  assert.equal(result.code, "cancelled");
  assert.equal(current.manager.getEntries().length, before);
  assert.equal(await current.registry.getApiKeyForProvider("openai"), key);
  safe(result);
});
test("effective configured auth conflict is typed and fail-closed", async () => {
  const { mock, session } = await fixture();
  const current = await session();
  const original = current.registry.getApiKeyAndHeaders.bind(current.registry);
  current.registry.getApiKeyAndHeaders = async (model) => ({
    ...(await original(model)),
    headers: { Authorization: `Bearer ${refresh}` },
  });
  const result = await activate(mock, current.manager, "beta");
  assert.equal(result.code, "effective_auth_conflict");
  safe(result);
});
for (const scope of ["first", "later", "header-alias"] as const) {
  test(`Kimi ${scope} model header conflict returns effective_auth_conflict`, async () => {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("kimi-coding", () => ({ accounts: { subscription: credential } }));
    const kimi: AccountProviderAdapter = {
      ...provider,
      id: "kimi-coding",
      displayName: "Kimi",
      supportsApiKey: false,
      runtimeAuthMode: "authorization-header",
      oauth: { ...provider.oauth, toAuth: async (value) => ({ headers: { Authorization: `Bearer ${value.access}` } }) },
    };
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [kimi] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const models = registry.getAll().filter((model) => model.provider === "kimi-coding");
    assert.ok(models.length > 1);
    const target = scope === "later" ? models.at(-1) : models[0];
    assert.ok(target);
    const headers: Record<string, string> =
      scope === "header-alias"
        ? { Authorization: `Bearer ${access}`, authorization: `Bearer ${key}` }
        : { Authorization: `Bearer ${key}` };
    registry.registerProvider("kimi-coding", {
      models: models.map((model) => (model.id === target.id ? { ...model, headers } : model)),
    });
    const manager = SessionManager.inMemory(process.cwd());
    const { ctx } = createMockContext({ modelRegistry: registry, sessionManager: manager });
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    try {
      const result = await activate(mock, manager, "subscription", { provider: "kimi-coding", model: target.id });
      assert.equal(result.code, "effective_auth_conflict");
      safe(result);
      assert.equal(await registry.getApiKeyForProvider("kimi-coding"), RUNTIME_FAIL_CLOSED_API_KEY);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    }
  });
}

test("model endpoint override reports an effective auth conflict", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", () => ({ accounts: { subscription: credential } }));
  const adapter: AccountProviderAdapter = {
    ...provider,
    oauth: {
      ...provider.oauth,
      toAuth: async (value) => ({ apiKey: value.access, baseUrl: "https://selected.example.test/v1" }),
    },
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [adapter] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const models = registry.getAll().filter((model) => model.provider === "openai");
  const target = models.at(-1);
  assert.ok(target && models.length > 1);
  registry.registerProvider("openai", {
    models: models.map((model) =>
      model.id === target.id ? { ...model, baseUrl: "https://overridden.example.test/v1" } : model,
    ),
  });
  const manager = SessionManager.inMemory(process.cwd());
  const { ctx } = createMockContext({ modelRegistry: registry, sessionManager: manager });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  try {
    const result = await activate(mock, manager, "subscription", { model: target.id });
    assert.equal(result.code, "effective_auth_conflict");
    safe(result);
    assert.equal(await registry.getApiKeyForProvider("openai"), RUNTIME_FAIL_CLOSED_API_KEY);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  }
});

test("stale conversion cannot overwrite a newer selection", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { mock, session } = await fixture({
    ...provider,
    oauth: {
      ...provider.oauth,
      toAuth: async (value) => {
        entered();
        await gate;
        return { apiKey: value.access };
      },
    },
  });
  const current = await session();
  const stale = activate(mock, current.manager, "alpha");
  await started;
  const latest = await activate(mock, current.manager, "beta");
  release();
  const old = await stale;
  assert.equal(old.code, "activation_superseded");
  assert.equal(latest.status, "active");
  assert.equal(await current.registry.getApiKeyForProvider("openai"), key);
});
test("file-backed topology and activation wait for an in-process credential update", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-accounts-protocol-"));
  try {
    const { mock, store, session } = await fixture(
      provider,
      new FileAccountStorageBackend(join(directory, "pi-accounts.json")),
    );
    const current = await session();
    await activate(mock, current.manager, "beta");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const update = store.updateProviderAsync("openai", async (state) => {
      entered();
      await gate;
      return { ...state, accounts: { ...state.accounts, gamma: { type: "api_key", key: "synthetic-key" } } };
    });
    await started;
    try {
      const topology = new Promise<unknown>((resolve) => {
        mock.rawPi.events.emit("accounts:topology:v1", { reply: resolve });
      });
      const activation = activate(mock, current.manager, "alpha");
      release();
      await update;
      const inventory = await topology;
      assert.deepEqual((inventory as { providers: { accounts: { name: string }[] }[] }).providers[0]?.accounts, [
        { name: "alpha", kind: "oauth" },
        { name: "beta", kind: "api-key" },
        { name: "gamma", kind: "api-key" },
      ]);
      assert.deepEqual(await activation, { status: "active", providerId: "openai", accountName: "alpha" });
      assert.equal(await current.registry.getApiKeyForProvider("openai"), access);
    } finally {
      release();
      await update;
      await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a newer request wins while the older inventory read is queued", async () => {
  const { mock, store, session } = await fixture();
  const current = await session();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const update = store.updateProviderAsync("openai", async (state) => {
    entered();
    await gate;
    return state;
  });
  await started;
  try {
    const old = activate(mock, current.manager, "alpha");
    const latest = activate(mock, current.manager, "beta");
    release();
    assert.equal((await old).code, "activation_superseded");
    assert.equal((await latest).status, "active");
    assert.equal(await current.registry.getApiKeyForProvider("openai"), key);
    const selections = current.manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-accounts-selection");
    assert.ok(
      selections.every(
        (entry) =>
          entry.type !== "custom" ||
          (entry.data as { providers: Record<string, string | null> }).providers.openai !== "alpha",
      ),
    );
  } finally {
    release();
    await update;
  }
});

test("cancellation during inventory read does not publish a selection", async () => {
  const { mock, store, session } = await fixture();
  const current = await session();
  await activate(mock, current.manager, "beta");
  const before = current.manager.getEntries().length;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const update = store.updateProviderAsync("openai", async (state) => {
    entered();
    await gate;
    return state;
  });
  await started;
  try {
    const controller = new AbortController();
    const pending = activate(mock, current.manager, "alpha", { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).code, "cancelled");
    assert.equal(current.manager.getEntries().length, before);
    assert.equal(await current.registry.getApiKeyForProvider("openai"), key);
  } finally {
    release();
    await update;
  }
});

test("shutdown cancels an activation waiting for the credential store", async () => {
  const { mock, store, session } = await fixture();
  const current = await session();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const update = store.updateProviderAsync("openai", async (state) => {
    entered();
    await gate;
    return state;
  });
  await started;
  try {
    const pending = activate(mock, current.manager, "alpha");
    await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
    assert.equal((await pending).code, "session_unavailable");
    assert.ok(
      current.manager
        .getEntries()
        .every(
          (entry) =>
            entry.type !== "custom" ||
            entry.customType !== "pi-accounts-selection" ||
            (entry.data as { providers: Record<string, string | null> }).providers.openai !== "alpha",
        ),
    );
  } finally {
    release();
    await update;
  }
});

test("routine model sync of the same selection completes the activation barrier", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let conversions = 0;
  const { mock, session } = await fixture({
    ...provider,
    oauth: {
      ...provider.oauth,
      toAuth: async (value) => {
        if (++conversions === 1) {
          entered();
          await gate;
        }
        return { apiKey: value.access };
      },
    },
  });
  const current = await session();
  const pending = activate(mock, current.manager, "alpha");
  await started;
  try {
    await mock.events.get("model_select")?.[0]?.({ model: { provider: "openai", id: "gpt-4o" } }, current.ctx);
  } finally {
    release();
  }
  assert.deepEqual(await pending, { status: "active", providerId: "openai", accountName: "alpha" });
  assert.equal(await current.registry.getApiKeyForProvider("openai"), access);
});

for (const event of ["model_select", "before_agent_start"] as const) {
  test(`${event} replacement can finish after the requesting activation is cancelled`, async () => {
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => (enteredFirst = resolve));
    const secondStarted = new Promise<void>((resolve) => (enteredSecond = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let conversions = 0;
    const { mock, session } = await fixture({
      ...provider,
      oauth: {
        ...provider.oauth,
        toAuth: async (value) => {
          if (++conversions === 1) {
            enteredFirst();
            await firstGate;
          } else {
            enteredSecond();
            await secondGate;
          }
          return { apiKey: value.access };
        },
      },
    });
    const model = { provider: "openai", id: "gpt-4o" };
    const current = await session(model);
    if (event === "before_agent_start") await mock.events.get(event)?.[0]?.({}, current.ctx);
    const controller = new AbortController();
    const pending = activate(mock, current.manager, "alpha", { signal: controller.signal });
    await firstStarted;
    const sync = Promise.resolve(mock.events.get(event)?.[0]?.(event === "model_select" ? { model } : {}, current.ctx));
    try {
      await secondStarted;
      releaseFirst();
      // Let the original sync settle while the replacement stays blocked on its own conversion.
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      assert.equal((await pending).code, "cancelled");
    } finally {
      releaseFirst();
      releaseSecond();
      await sync;
    }
    assert.equal(await current.registry.getApiKeyForProvider("openai"), access);
  });
}

test("final credential reread failure is typed as store_unavailable and fails closed", async () => {
  const { mock, store, session } = await fixture();
  const current = await session();
  await activate(mock, current.manager, "beta");
  const read = store.readProviderAsync.bind(store);
  let reads = 0;
  store.readProviderAsync = async (providerId, signal) => {
    if (++reads === 3) throw new Error(`unreadable ${refresh}`);
    return read(providerId, signal);
  };
  const result = await activate(mock, current.manager, "alpha");
  assert.equal(reads, 3);
  assert.equal(result.code, "store_unavailable");
  safe(result);
  assert.notEqual(await current.registry.getApiKeyForProvider("openai"), access);
});

test("model unavailable result uses account capability, not a second catalog", async () => {
  const { mock, store, session } = await fixture();
  await store.updateProvider("openai", (state) => ({
    ...state,
    accounts: { ...state.accounts, alpha: { ...credential, availableModelIds: ["allowed"] } },
  }));
  const current = await session();
  assert.equal((await activate(mock, current.manager, "alpha", { model: "blocked" })).code, "model_unavailable");
});
test("malformed requests and absent responder produce no reply", () => {
  const mock = createMockPi();
  let replies = 0;
  mock.rawPi.events.emit("accounts:topology:v1", { reply: () => replies++ });
  mock.rawPi.events.emit("accounts:activation:v1", { reply: () => replies++ });
  assert.equal(replies, 0);
});
test("shutdown during conversion cannot publish late success", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { mock, session } = await fixture({
    ...provider,
    oauth: {
      ...provider.oauth,
      toAuth: async () => {
        entered();
        await gate;
        return { apiKey: access };
      },
    },
  });
  const current = await session();
  const pending = activate(mock, current.manager, "alpha");
  await started;
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
  release();
  assert.notEqual((await pending).status, "active");
});

test("cancellation during conversion stays fail-closed and returns no secret reason", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { mock, session } = await fixture({
    ...provider,
    oauth: {
      ...provider.oauth,
      toAuth: async () => {
        entered();
        await gate;
        return { apiKey: access };
      },
    },
  });
  const current = await session();
  const controller = new AbortController();
  const pending = activate(mock, current.manager, "alpha", { signal: controller.signal });
  await started;
  controller.abort(new Error(refresh));
  release();
  const result = await pending;
  assert.equal(result.code, "cancelled");
  safe(result);
  assert.notEqual(await current.registry.getApiKeyForProvider("openai"), access);
});

test("unexpected sync exception returns only activation_failed", async () => {
  const { mock, session } = await fixture();
  const current = await session();
  current.registry.getAll = () => {
    throw new Error(`unexpected ${key}`);
  };
  const result = await activate(mock, current.manager, "alpha");
  assert.equal(result.code, "activation_failed");
  safe(result);
});

test("installed protocol parsers ignore malformed envelopes and hostile getters", async () => {
  const { mock } = await fixture();
  let replies = 0;
  const reply = () => replies++;
  for (const data of [
    null,
    [],
    { reply },
    { session: {}, provider: "openai", account: 42, reply },
    { session: {}, provider: "openai", account: "alpha", signal: {}, reply },
    {
      get session() {
        throw new Error(key);
      },
      reply,
    },
  ]) {
    mock.rawPi.events.emit("accounts:activation:v1", data);
  }
  mock.rawPi.events.emit("accounts:topology:v1", { reply: "invalid" });
  assert.equal(replies, 0);
});

test("store failure is typed without exposing storage exception text", async () => {
  const { mock, store, session } = await fixture();
  const current = await session();
  await activate(mock, current.manager, "beta");
  store.readAsync = async () => {
    throw new Error(`unreadable ${refresh}`);
  };
  const result = await activate(mock, current.manager, "alpha");
  assert.equal(result.code, "store_unavailable");
  safe(result);
});
