import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import accountsExtension, { AccountStore, type StoredOAuthCredential } from "../packages/pi-accounts/src/accounts.js";
import type { AccountProviderAdapter } from "../packages/pi-accounts/src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../packages/pi-accounts/src/oauth-credential-source.js";
import { InMemoryAccountStorageBackend } from "../packages/pi-accounts/src/storage.js";
import { isolateAccountEnvironment } from "../packages/pi-accounts/test/isolate-account-environment.js";
import usageExtension from "../packages/pi-usage/src/usage.js";
import { createMockContext, createMockPi } from "./support.js";

isolateAccountEnvironment();
initTheme("dark", false);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const copilotModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "github-copilot",
  baseUrl: "https://api.individual.githubcopilot.com",
};

function credential(suffix: string): StoredOAuthCredential {
  return {
    type: "oauth",
    access: `runtime-${suffix}`,
    refresh: `github-${suffix}`,
    expires: Date.now() + 60 * 60 * 1000,
  };
}

function provider(id: AccountProviderAdapter["id"]): AccountProviderAdapter {
  const displayNames: Record<AccountProviderAdapter["id"], string> = {
    anthropic: "Anthropic",
    "github-copilot": "GitHub Copilot",
    "kimi-coding": "Kimi For Coding",
    meta: "Meta",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    openrouter: "OpenRouter",
    radius: "Radius",
    xai: "xAI",
  };
  return {
    id,
    displayName: displayNames[id],
    requiresApiKeyBridge: id === "openai-codex",
    runtimeAuthMode: id === "kimi-coding" ? "authorization-header" : "api-key",
    oauth: {
      async login() {
        return credential(id);
      },
      async refresh(current) {
        return current;
      },
      async toAuth(current) {
        return id === "kimi-coding"
          ? { headers: { Authorization: `Bearer ${current.access}` } }
          : { apiKey: current.access };
      },
    },
  };
}

function runtimeRegistry(mock: ReturnType<typeof createMockPi>, model = copilotModel) {
  const keys = new Map<string, string>();
  const runtime = {
    async setRuntimeApiKey(providerId: string, apiKey: string) {
      keys.set(providerId, apiKey);
    },
    async removeRuntimeApiKey(providerId: string) {
      keys.delete(providerId);
    },
  };
  return {
    keys,
    registry: {
      runtime,
      getRegisteredProviderConfig: (providerId: string) => mock.providers.get(providerId),
      registerProvider: mock.rawPi.registerProvider,
      unregisterProvider: mock.rawPi.unregisterProvider,
      getApiKeyForProvider: async (providerId: string) => keys.get(providerId),
      getApiKeyAndHeaders: async (selected: { provider: string }) => ({
        ok: true as const,
        apiKey: keys.get(selected.provider),
        headers: (mock.providers.get(selected.provider) as { headers?: Record<string, string> } | undefined)?.headers,
      }),
      getProviderAuth: async (providerId: string) => {
        const apiKey = keys.get(providerId);
        const config = mock.providers.get(providerId) as { headers?: Record<string, string> } | undefined;
        return apiKey
          ? {
              auth: {
                apiKey,
                headers: config?.headers,
                ...(providerId === "github-copilot" ? { baseUrl: copilotModel.baseUrl } : {}),
              },
            }
          : undefined;
      },
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: (providerId: string) => ({
        configured: keys.has(providerId),
      }),
      getProviderDisplayName: (providerId: string) => providerId,
      find: (providerId: string, modelId: string) =>
        providerId === model.provider && modelId === model.id ? model : undefined,
    },
  };
}

async function createStore() {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "first",
        accounts: { first: credential("first"), second: credential("second") },
      },
    },
  });
  return store;
}

function registerAccounts(
  mock: ReturnType<typeof createMockPi>,
  store: AccountStore,
  providers: AccountProviderAdapter[] = [provider("openai-codex"), provider("anthropic"), provider("github-copilot")],
) {
  const sessionStartIndex = mock.events.get("session_start")?.length ?? 0;
  accountsExtension(mock.pi, { store, providers });
  return {
    sessionStart: mock.events.get("session_start")?.[sessionStartIndex],
  };
}

function registerUsage(mock: ReturnType<typeof createMockPi>): void {
  usageExtension(mock.pi, {
    credentialReader: () => ({
      ...credential("default"),
      access: "unrelated-default-runtime",
    }),
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function installUsageFetch(requests: Array<{ url: string; authorization: string | null }>): void {
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), authorization: headers.get("authorization") });
    return new Response(
      JSON.stringify({
        quota_snapshots: {
          premium_interactions: { entitlement: 10, remaining: 7 },
        },
        login: "named-account",
      }),
      { status: 200 },
    );
  };
}

test.each(["accounts-first", "usage-first"] as const)(
  "source extensions coexist in %s order across named usage and account switching",
  async (order) => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    installUsageFetch(requests);
    const store = await createStore();
    const mock = createMockPi();
    let accountHooks: ReturnType<typeof registerAccounts>;
    if (order === "accounts-first") {
      accountHooks = registerAccounts(mock, store);
      registerUsage(mock);
    } else {
      registerUsage(mock);
      accountHooks = registerAccounts(mock, store);
    }
    const { keys, registry } = runtimeRegistry(mock);
    const titles: string[] = [];
    const accountSelections = ["Switch GitHub Copilot account", "second"];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model: copilotModel,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(),
      select: async (title: string, options: string[]) => {
        titles.push(title);
        const accountSelection = accountSelections[0];
        if (accountSelection && options.includes(accountSelection)) {
          accountSelections.shift();
          return accountSelection;
        }
        return "Close";
      },
    });

    await accountHooks.sessionStart?.({}, ctx);
    await mock.commands.get("usage")?.handler("", ctx);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      url: "https://api.github.com/copilot_internal/user",
      authorization: "Bearer github-first",
    });
    assert.match(titles.at(-1) ?? "", /named-account/iu);

    await mock.commands.get("accounts")?.handler("", ctx);
    assert.deepEqual(accountSelections, []);
    await mock.commands.get("usage")?.handler("", ctx);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.authorization, "Bearer github-second");

    keys.set("github-copilot", "runtime-with-no-matching-oauth");
    await mock.commands.get("usage")?.handler("", ctx);
    assert.equal(keys.get("github-copilot"), "runtime-second");
    assert.equal(requests.length, 2);
    assert.match(titles.at(-1) ?? "", /named-account/iu);
  },
);

test("usage-first model selection waits for the latest account activation", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  installUsageFetch(requests);
  const store = await createStore();
  const mock = createMockPi();
  registerUsage(mock);

  let blockNextConversion = false;
  let markConversionStarted!: () => void;
  const conversionStarted = new Promise<void>((resolve) => {
    markConversionStarted = resolve;
  });
  let releaseConversion!: () => void;
  const conversionReleased = new Promise<void>((resolve) => {
    releaseConversion = resolve;
  });
  const copilot = provider("github-copilot");
  copilot.oauth.toAuth = async (current) => {
    if (blockNextConversion) {
      blockNextConversion = false;
      markConversionStarted();
      await conversionReleased;
    }
    return { apiKey: current.access };
  };
  registerAccounts(mock, store, [provider("openai-codex"), provider("anthropic"), copilot]);

  const { registry } = runtimeRegistry(mock);
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "rpc",
    model: copilotModel,
    modelRegistry: registry,
    sessionManager: SessionManager.inMemory(),
    select: async () => "Close",
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
  await mock.commands.get("usage")?.handler("", ctx);
  assert.equal(requests.at(-1)?.authorization, "Bearer github-first");
  requests.length = 0;

  await store.updateProvider("github-copilot", (state) => ({
    ...state,
    accounts: { ...state.accounts, first: credential("second") },
  }));
  blockNextConversion = true;
  const selection = (async () => {
    for (const handler of mock.events.get("model_select") ?? []) {
      await handler({ model: copilotModel }, ctx);
    }
  })();

  await conversionStarted;
  await settle();
  assert.equal(requests.length, 0);

  releaseConversion();
  await selection;
  for (let attempt = 0; attempt < 20 && requests.length === 0; attempt += 1) await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.authorization, "Bearer github-second");
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
});

test("built generated entries complete a representative named-account usage boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-accounts-usage-generated-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const requests: Array<{ url: string; authorization: string | null }> = [];
  installUsageFetch(requests);
  try {
    const [{ default: generatedAccounts }, { default: generatedUsage }] = await Promise.all([
      import("../packages/pi-accounts/dist/index.js"),
      import("../packages/pi-usage/dist/index.js"),
    ]);
    const store = await createStore();
    const mock = createMockPi();
    const sessionStartIndex = mock.events.get("session_start")?.length ?? 0;
    generatedAccounts(mock.pi, {
      store,
      providers: [provider("openai-codex"), provider("anthropic"), provider("github-copilot")],
    });
    const accountSessionStart = mock.events.get("session_start")?.[sessionStartIndex];
    generatedUsage(mock.pi, {
      credentialReader: () => ({
        ...credential("default"),
        access: "unrelated-default-runtime",
      }),
    });
    const { registry } = runtimeRegistry(mock);
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model: copilotModel,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(),
      select: async () => "Close",
    });

    await accountSessionStart?.({}, ctx);
    await mock.commands.get("usage")?.handler("", ctx);
    assert.deepEqual(requests, [
      {
        url: "https://api.github.com/copilot_internal/user",
        authorization: "Bearer github-first",
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});

const pendingUsageProviders = [
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    usageUrl: "https://openrouter.ai/api/v1/key",
    before: "openrouter $75.00 left",
    after: "openrouter $40.00 left",
  },
  {
    id: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    usageUrl: "https://chatgpt.com/backend-api/wham/usage",
    before: "codex 5h:75%",
    after: "codex 5h:40%",
  },
  {
    id: "kimi-coding",
    baseUrl: "https://api.kimi.com/coding",
    usageUrl: "https://api.kimi.com/coding/v1/usages",
    before: "kimi wk:75%",
    after: "kimi wk:40%",
  },
] as const;

for (const configuration of pendingUsageProviders) {
  test.each(["accounts-first", "usage-first"] as const)(
    `${configuration.id} selection waits for activation before querying usage in %s order`,
    async (order) => {
      const mock = createMockPi();
      const adapter = provider(configuration.id);
      const model = { ...copilotModel, provider: configuration.id, baseUrl: configuration.baseUrl };
      const store = new AccountStore(new InMemoryAccountStorageBackend());
      await store.write({
        version: 1,
        providers: {
          [configuration.id]: {
            active: "first",
            accounts: { first: credential("first"), second: credential("second") },
          },
        },
      });
      let conversionStarted!: () => void;
      const entered = new Promise<void>((resolve) => {
        conversionStarted = resolve;
      });
      let releaseConversion!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseConversion = resolve;
      });
      const toAuth = adapter.oauth.toAuth;
      adapter.oauth.toAuth = async (current) => {
        if (current.access === "runtime-second") {
          conversionStarted();
          await blocked;
        }
        return toAuth(current);
      };
      if (order === "accounts-first") {
        registerAccounts(mock, store, [adapter]);
        registerUsage(mock);
      } else {
        registerUsage(mock);
        registerAccounts(mock, store, [adapter]);
      }
      const { registry } = runtimeRegistry(mock, model);
      const choices = [`Switch ${adapter.displayName} account`, "second"];
      const sessionManager = SessionManager.inMemory();
      const { ctx, statuses } = createMockContext({
        hasUI: true,
        mode: "rpc",
        model,
        modelRegistry: registry,
        sessionManager,
        select: async (_title: string, options: string[]) => {
          const next = choices[0];
          if (next && options.includes(next)) return choices.shift();
          return "Close";
        },
      });
      const requests: Array<{ url: string; authorization: string | null }> = [];
      globalThis.fetch = async (input, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        requests.push({ url: String(input), authorization });
        const remaining = authorization === "Bearer runtime-first" ? 75 : 40;
        return Response.json(
          configuration.id === "openrouter"
            ? { data: { limit: 100, limit_remaining: remaining, usage: 100 - remaining } }
            : configuration.id === "openai-codex"
              ? { rate_limit: { primary_window: { used_percent: 100 - remaining, limit_window_seconds: 18_000 } } }
              : { usage: { name: "Weekly limit", used: 100 - remaining, limit: 100 } },
        );
      };
      let selection: Promise<unknown> | undefined;
      try {
        for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
        await settle();
        assert.equal(statuses.get("usage"), configuration.before);
        assert.deepEqual(requests, [{ url: configuration.usageUrl, authorization: "Bearer runtime-first" }]);

        const command = mock.commands.get("accounts");
        assert.ok(command);
        selection = Promise.resolve(command.handler("", ctx));
        await entered;
        await settle();
        assert.equal(statuses.get("usage"), "checking");
        assert.equal(requests.length, 1, "pending activation must not query the previous account");

        releaseConversion();
        await selection;
        await settle();
        assert.deepEqual(choices, []);
        assert.equal(statuses.get("usage"), configuration.after);
        assert.deepEqual(requests, [
          { url: configuration.usageUrl, authorization: "Bearer runtime-first" },
          { url: configuration.usageUrl, authorization: "Bearer runtime-second" },
        ]);
        assert.equal(store.read().providers[configuration.id]?.active, "first");
        const snapshot = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom")
          .at(-1);
        assert.ok(snapshot);
        assert.equal((snapshot.data as { providers: Record<string, string> }).providers[configuration.id], "second");
        assert.deepEqual(mock.sentMessages, []);
      } finally {
        releaseConversion();
        await selection;
        for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
      }
    },
  );
}

test.each(["conflict-first", "conflict-last"] as const)(
  "conflicting matching credential fails closed with %s listener order",
  async (order) => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("{}", { status: 200 });
    };
    const store = await createStore();
    const mock = createMockPi();
    const registerConflict = () => {
      mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
        const request = data as {
          session: object;
          provider: string;
          offer(candidate: unknown): void;
        };
        if (request.provider !== "github-copilot") return;
        request.offer({ ...credential("first"), refresh: "conflicting-refresh" });
      });
    };
    if (order === "conflict-first") registerConflict();
    registerAccounts(mock, store);
    registerUsage(mock);
    if (order === "conflict-last") registerConflict();
    const { registry } = runtimeRegistry(mock);
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "rpc",
      model: copilotModel,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(),
      select: async () => "Close",
    });

    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await mock.commands.get("usage")?.handler("", ctx);
    assert.equal(requests, 0);
  },
);
