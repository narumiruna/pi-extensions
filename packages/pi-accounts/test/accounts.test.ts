// Cohesion justification: this account-manager integration matrix shares credential/provider
// fixtures and cross-covers menus, OAuth, replacement, switching, persistence, and lifecycle safety.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore, type ModelAuth } from "@earendil-works/pi-ai";
import {
  type CustomEntry,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import {
  createMockContext as createBaseMockContext,
  createCustomSelectorHarness,
  createMockPi,
} from "../../../test/support.js";
import accountsExtension, {
  ACCOUNTS_STATUS_KEY,
  AccountStore,
  FAIL_CLOSED_API_KEY,
  parseAccountName,
  type StoredOAuthCredential,
} from "../src/accounts.js";
import {
  type AccountProviderAdapter,
  createBuiltinProviderAdapters,
  createOAuthInteraction,
  loginWithOAuthUI,
  resolveProviderOAuth,
} from "../src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.js";
import { RuntimeAuthCoordinator } from "../src/runtime-auth.js";
import { ACCOUNT_SELECTION_ENTRY_TYPE } from "../src/session-selection.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";

beforeAll(() => initTheme("dark", false));

const credential = (suffix: string, extra: Record<string, unknown> = {}): StoredOAuthCredential => ({
  type: "oauth",
  access: `access-${suffix}`,
  refresh: `refresh-${suffix}`,
  expires: Date.now() + 60 * 60 * 1000,
  ...extra,
});

function fakeProvider(
  id: AccountProviderAdapter["id"],
  options: {
    baseUrl?: string;
    headers?: Record<string, string>;
    requiresApiKeyBridge?: boolean;
  } = {},
): AccountProviderAdapter {
  const displayNames: Record<AccountProviderAdapter["id"], string> = {
    anthropic: "Anthropic",
    "github-copilot": "GitHub Copilot",
    "kimi-coding": "Kimi For Coding",
    "openai-codex": "OpenAI Codex",
    openrouter: "OpenRouter",
    radius: "Radius",
    xai: "xAI",
  };
  return {
    id,
    displayName: displayNames[id],
    requiresApiKeyBridge: options.requiresApiKeyBridge ?? id === "openai-codex",
    runtimeAuthMode: id === "kimi-coding" ? "authorization-header" : "api-key",
    refreshModelCatalogAfterAuth: id === "radius",
    oauth: {
      async login() {
        return credential(`login-${id}`, id === "github-copilot" ? { availableModelIds: ["allowed"] } : {});
      },
      async refresh(current) {
        return { ...current, access: `${current.access}-refreshed`, expires: Date.now() + 60_000 };
      },
      async toAuth(current) {
        return id === "kimi-coding"
          ? {
              baseUrl: options.baseUrl,
              headers: {
                Authorization: `Bearer ${current.access}`,
                ...options.headers,
              },
            }
          : { apiKey: current.access, baseUrl: options.baseUrl, headers: options.headers };
      },
    },
  };
}

function runtimeHarness(mock: ReturnType<typeof createMockPi>, options: { isolateProviders?: boolean } = {}) {
  const keys = new Map<string, string>();
  const providerConfigs = options.isolateProviders ? new Map(mock.providers) : mock.providers;
  const models = [
    { provider: "openai-codex", id: "codex", baseUrl: "https://codex.example" },
    { provider: "anthropic", id: "claude", baseUrl: "https://anthropic.example" },
    { provider: "github-copilot", id: "allowed", baseUrl: "https://default.copilot" },
    { provider: "github-copilot", id: "blocked", baseUrl: "https://default.copilot" },
    { provider: "kimi-coding", id: "k3", baseUrl: "https://api.kimi.com/coding" },
    { provider: "openrouter", id: "openrouter-model", baseUrl: "https://openrouter.ai/api/v1" },
    { provider: "radius", id: "radius-model", baseUrl: "https://radius.pi.dev" },
    { provider: "xai", id: "grok-4.3", baseUrl: "https://api.x.ai/v1" },
  ];
  const refreshCalls: Array<{ providers?: readonly string[]; allowNetwork?: boolean }> = [];
  const runtime = {
    async setRuntimeApiKey(provider: string, key: string) {
      keys.set(provider, key);
    },
    async removeRuntimeApiKey(provider: string) {
      keys.delete(provider);
    },
  };
  const registry = {
    runtime,
    getRegisteredProviderConfig: (provider: string) => providerConfigs.get(provider),
    registerProvider(provider: string, config: unknown) {
      if (!options.isolateProviders) {
        mock.rawPi.registerProvider(provider, config);
        return;
      }
      const previous = providerConfigs.get(provider);
      providerConfigs.set(
        provider,
        previous && typeof previous === "object" && config && typeof config === "object"
          ? { ...previous, ...config }
          : config,
      );
    },
    unregisterProvider(provider: string) {
      if (!options.isolateProviders) {
        mock.rawPi.unregisterProvider(provider);
        return;
      }
      providerConfigs.delete(provider);
    },
    getApiKeyForProvider: async (provider: string) => keys.get(provider),
    getAll: () =>
      models.map((model) => ({
        ...model,
        name: model.id,
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      })),
    find(provider: string, id: string) {
      const model = models.find((item) => item.provider === provider && item.id === id);
      if (!model) return undefined;
      const config = providerConfigs.get(provider) as { baseUrl?: string; models?: Array<{ id: string }> } | undefined;
      if (config?.models && !config.models.some((item) => item.id === id)) return undefined;
      return { ...model, baseUrl: config?.baseUrl ?? model.baseUrl };
    },
    async getApiKeyAndHeaders(model: { provider: string }) {
      const config = providerConfigs.get(model.provider) as { headers?: Record<string, string> } | undefined;
      return { ok: true as const, apiKey: keys.get(model.provider), headers: config?.headers };
    },
    async refresh(options: { providers?: readonly string[]; allowNetwork?: boolean; signal?: AbortSignal }) {
      refreshCalls.push(options);
      return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
    },
  };
  return { keys, models, providerConfigs, refreshCalls, registry, runtime };
}

function ensureStoredSelection(
  coordinator: RuntimeAuthCoordinator,
  ctx: Parameters<RuntimeAuthCoordinator["ensureActive"]>[0],
  store: AccountStore,
  now = Date.now(),
  ownerSignal?: AbortSignal,
) {
  const selectedAccount = store.read().providers[coordinator.provider.id]?.active ?? null;
  return coordinator.ensureActive(ctx, store, selectedAccount, now, ownerSignal);
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  return createBaseMockContext({
    sessionManager: SessionManager.inMemory(process.cwd(), { id: "test-session" }),
    ...overrides,
  });
}

function createTestSessionManager(sessionId?: string): SessionManager {
  return SessionManager.inMemory(process.cwd(), { id: sessionId ?? randomUUID() });
}

function latestSessionSelections(sessionManager: Pick<SessionManager, "getEntries">): Record<string, string | null> {
  const entry = sessionManager
    .getEntries()
    .filter(
      (candidate): candidate is CustomEntry =>
        candidate.type === "custom" && candidate.customType === ACCOUNT_SELECTION_ENTRY_TYPE,
    )
    .at(-1);
  const data = entry?.data as { providers?: Record<string, string | null> } | undefined;
  return data?.providers ?? {};
}

function collectCredentialOffers(
  mock: ReturnType<typeof createMockPi>,
  session: object,
  provider: string,
): StoredOAuthCredential[] {
  const offers: StoredOAuthCredential[] = [];
  mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, {
    session,
    provider,
    offer(candidate: StoredOAuthCredential) {
      offers.push(candidate);
    },
  });
  return offers;
}

function createInteractiveAccountContext(
  overrides: Record<string, unknown> = {},
  options: {
    selections?: string[];
    inputs?: Array<string | undefined>;
    confirms?: boolean[];
  } = {},
) {
  const selections = [...(options.selections ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    ...overrides,
    select: async (title: string, values: string[]) => {
      selectCalls.push({ title, options: values });
      const selected = selections.shift();
      if (selected !== undefined) assert.ok(values.includes(selected), `Missing option: ${selected}`);
      return selected;
    },
    input: async (title: string, placeholder?: string) => {
      inputCalls.push({ title, placeholder });
      return inputs.shift();
    },
    confirm: async (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return confirms.shift() ?? true;
    },
  });
  return { ...context, selectCalls, inputCalls, confirmCalls };
}

test("built-in provider adapters preserve each provider's complete OAuth auth shape", async () => {
  const adapters = createBuiltinProviderAdapters();
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const base = credential("contract");

  assert.equal(typeof byId.get("openai-codex")?.invalidateConnections, "function");
  assert.deepEqual(await byId.get("openai-codex")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("anthropic")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  const copilotCredential = credential("contract", {
    access: "tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=1",
    enterpriseUrl: "github.example.com",
    availableModelIds: ["allowed"],
  });
  assert.deepEqual(await byId.get("github-copilot")?.oauth.toAuth(copilotCredential), {
    apiKey: copilotCredential.access,
    baseUrl: "https://api.business.githubcopilot.com",
  });
  assert.deepEqual(await byId.get("xai")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("kimi-coding")?.oauth.toAuth(base), {
    headers: { Authorization: "Bearer access-contract" },
  });
  assert.deepEqual(await byId.get("openrouter")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.deepEqual(await byId.get("radius")?.oauth.toAuth(base), {
    apiKey: "access-contract",
  });
  assert.equal(byId.get("radius")?.refreshModelCatalogAfterAuth, true);
  assert.deepEqual([...byId.keys()].sort(), [
    "anthropic",
    "github-copilot",
    "kimi-coding",
    "openai-codex",
    "openrouter",
    "radius",
    "xai",
  ]);
  const radius = byId.get("radius");
  assert.ok(radius);
  const activeRadiusOAuth = fakeProvider("radius").oauth;
  assert.equal(
    resolveProviderOAuth(radius, {
      modelRegistry: {
        getProvider: () => ({ auth: { oauth: activeRadiusOAuth } }),
      } as never,
    }),
    activeRadiusOAuth,
  );
});

test("OAuth interaction preserves provider prompts, cancellation, and notifications", async () => {
  const dialogSignals: Array<AbortSignal | undefined> = [];
  const { ctx, notifications } = createMockContext({
    hasUI: true,
    input: async (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
      dialogSignals.push(options?.signal);
      return undefined;
    },
    select: async (_title: string, _options: string[], options?: { signal?: AbortSignal }) => {
      dialogSignals.push(options?.signal);
      return "Device login";
    },
  });
  const owner = new AbortController();
  const interaction = createOAuthInteraction(ctx, "Example", owner.signal);
  assert.equal(interaction.signal, owner.signal);
  assert.equal(
    await interaction.prompt({
      type: "select",
      message: "Method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device login" },
      ],
    }),
    "device",
  );
  await assert.rejects(interaction.prompt({ type: "manual_code", message: "Code" }), /Login cancelled/);
  assert.deepEqual(dialogSignals, [owner.signal, owner.signal]);
  interaction.notify({
    type: "device_code",
    userCode: "ABCD",
    verificationUri: "https://example.test/device",
  });
  assert.match(notifications.at(-1)?.message ?? "", /ABCD/);
});

test("TUI OAuth login uses Pi's native dialog across provider-owned steps", async () => {
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let continueToPrompt!: () => void;
  const authShown = new Promise<void>((resolve) => {
    continueToPrompt = resolve;
  });
  let selectedMethod: string | undefined;
  let manualCode: string | undefined;
  const provider = fakeProvider("github-copilot");
  provider.oauth.login = async (interaction) => {
    interaction.notify({
      type: "info",
      message: "Sign in with GitHub",
      links: [{ label: "Help", url: "https://example.test/help" }],
    });
    await authShown;
    selectedMethod = await interaction.prompt({
      type: "select",
      message: "Choose login method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device login" },
      ],
    });
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.test/device",
    });
    interaction.notify({ type: "progress", message: "Checking authorization..." });
    manualCode = await interaction.prompt({ type: "manual_code", message: "Paste callback:" });
    return credential("native-dialog", { availableModelIds: ["allowed"] });
  };
  const { ctx } = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 100);
      return harness.resultPromise;
    },
  });

  const login = loginWithOAuthUI(ctx, provider, new AbortController().signal);
  await waitForTest(() => harness !== undefined);
  assert.ok(harness);
  assert.equal(harness.isFocusable, true);
  assert.match(harness.render().join("\n"), /Login to GitHub Copilot/);
  assert.match(harness.render().join("\n"), /Sign in with GitHub/);
  assert.match(harness.render().join("\n"), /Help: https:\/\/example\.test\/help/);

  continueToPrompt();
  await waitForTest(() => harness?.render().join("\n").includes("Device login") ?? false);
  assert.match(harness.render().join("\n"), /Choose login method/);
  harness.handleInput("tui.select.down");
  harness.handleInput("tui.select.confirm");
  await waitForTest(() => harness?.render().join("\n").includes("ABCD-EFGH") ?? false);
  const loginScreen = harness.render().join("\n");
  assert.match(loginScreen, /https:\/\/example\.test\/device/);
  assert.match(loginScreen, /Enter code: ABCD-EFGH/);
  assert.match(loginScreen, /Waiting for authentication/);
  assert.match(loginScreen, /Checking authorization/);
  assert.match(loginScreen, /Paste callback/);

  harness.setFocused(true);
  harness.handleInput("callback-value");
  harness.handleInput("tui.input.submit");
  assert.equal((await login).access, "access-native-dialog");
  assert.equal(selectedMethod, "device");
  assert.equal(manualCode, "callback-value");
});

test("TUI OAuth login aborts provider work on Escape and component disposal", async () => {
  for (const cancellation of ["escape", "dispose"] as const) {
    let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider("anthropic");
    provider.oauth.login = async (interaction) => {
      providerSignal = interaction.signal;
      await new Promise<void>((resolve) => {
        if (interaction.signal.aborted) resolve();
        else interaction.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Login cancelled");
    };
    const { ctx } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        harness = createCustomSelectorHarness(factory, 100);
        return harness.resultPromise;
      },
    });

    const login = loginWithOAuthUI(ctx, provider, new AbortController().signal);
    await waitForTest(() => harness !== undefined && providerSignal !== undefined);
    assert.ok(harness);
    if (cancellation === "escape") harness.handleInput("tui.select.cancel");
    else harness.dispose();
    await assert.rejects(login, /Login cancelled/);
    assert.equal(providerSignal?.aborted, true);
  }
});

test("TUI OAuth login closes when its menu owner is cancelled", async () => {
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let providerSignal: AbortSignal | undefined;
  const provider = fakeProvider("openai-codex");
  provider.oauth.login = async (interaction) => {
    providerSignal = interaction.signal;
    await new Promise<void>((resolve) => {
      if (interaction.signal.aborted) resolve();
      else interaction.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("Login cancelled");
  };
  const owner = new AbortController();
  const { ctx } = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 100);
      return harness.resultPromise;
    },
  });

  const login = loginWithOAuthUI(ctx, provider, owner.signal);
  await waitForTest(() => harness !== undefined && providerSignal !== undefined);
  owner.abort();
  await assert.rejects(login, /Login cancelled/);
  assert.equal(providerSignal?.aborted, true);
});

async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test state");
}

test("accounts registers only the interactive /accounts command and lifecycle hooks", () => {
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });

  assert.deepEqual([...mock.commands.keys()].sort(), ["accounts"]);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "before_agent_start",
    "model_select",
    "session_shutdown",
    "session_start",
    "turn_start",
  ]);
});

test("account names reserve default for Pi login", () => {
  assert.equal(parseAccountName(" work-1 ").ok, true);
  assert.equal(parseAccountName("../secret").ok, false);
  assert.equal(parseAccountName("default").ok, true);
});

test("accounts command ignores arguments but requires interactive UI", async () => {
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { ctx, notifications } = createMockContext({ hasUI: false });

  await mock.commands.get("accounts")?.handler("switch anthropic work", ctx);

  assert.match(notifications.at(-1)?.message ?? "", /requires interactive UI/);
  assert.equal(notifications.at(-1)?.level, "error");
});

test("accounts empty state offers login and defaults and ignores command arguments", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: [] },
  );

  await mock.commands.get("accounts")?.handler("anything ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /No saved accounts yet/);
  assert.deepEqual(selectCalls[0]?.options, ["Login new account", "Set default account"]);
});

test("accounts menu summarizes all supported providers and prioritizes current provider switch", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
      "openai-codex": { accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [
      fakeProvider("openai-codex"),
      fakeProvider("anthropic"),
      fakeProvider("github-copilot"),
      fakeProvider("kimi-coding"),
      fakeProvider("openrouter"),
      fakeProvider("radius"),
      fakeProvider("xai"),
    ],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /Current model:\nAnthropic \/ claude/);
  assert.match(selectCalls[0]?.title ?? "", /Anthropic: work/);
  assert.match(selectCalls[0]?.title ?? "", /OpenAI Codex: default/);
  assert.match(selectCalls[0]?.title ?? "", /GitHub Copilot: default/);
  assert.match(selectCalls[0]?.title ?? "", /Kimi For Coding: default/);
  assert.match(selectCalls[0]?.title ?? "", /OpenRouter: default/);
  assert.match(selectCalls[0]?.title ?? "", /Radius: default/);
  assert.match(selectCalls[0]?.title ?? "", /xAI: default/);
  assert.deepEqual(selectCalls[0]?.options, [
    "Switch Anthropic account",
    "Login new account",
    "Remove account",
    "Switch another provider’s account",
    "Set default account",
  ]);
});

test("accounts menu prioritizes login when the current provider has no saved accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { "openai-codex": { accounts: { codex: credential("codex") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch another provider’s account",
    "Remove account",
    "Set default account",
  ]);
});

test("accounts recovery routes to the invalid provider without dead current-provider actions", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    providers: {
      anthropic: null,
      "github-copilot": null,
      "openai-codex": "missing",
    },
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /selected account is no longer available/iu);
  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch another provider’s account",
    "Set default account",
  ]);
});

test("accounts menu uses generic provider switch for unsupported current models", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { anthropic: { accounts: { work: credential("work") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, selectCalls } = createInteractiveAccountContext({
    model: { provider: "google\u202e", id: "gemini\u001b[31m" },
    modelRegistry: registry,
  });

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.match(selectCalls[0]?.title ?? "", /google \/ gemini/u);
  assert.equal((selectCalls[0]?.title ?? "").includes("\u001b"), false);
  assert.equal((selectCalls[0]?.title ?? "").includes("\u202e"), false);
  assert.deepEqual(selectCalls[0]?.options, [
    "Login new account",
    "Switch provider account",
    "Remove account",
    "Set default account",
  ]);
});

test("default account menu seeds new sessions but leaves current and resumed selections unchanged", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const mock = createMockPi();
  const providers = [fakeProvider("anthropic"), fakeProvider("openai-codex")];
  accountsExtension(mock.pi, { store, providers });
  const runtime = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const current = createInteractiveAccountContext(
    {
      sessionManager,
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: runtime.registry,
    },
    { selections: ["Set default account", "Anthropic", "beta"] },
  );
  await mock.events.get("session_start")?.[0]?.({}, current.ctx);
  const entriesBefore = sessionManager.getEntries().length;
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, "beta");
  assert.equal((await store.readProviderAsync("openai-codex")).active, "work");
  assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  assert.equal(sessionManager.getEntries().length, entriesBefore);
  assert.match(current.notifications.at(-1)?.message ?? "", /new sessions: beta.*unchanged/);

  for (const reason of ["reload", "resume"]) {
    await mock.events.get("session_shutdown")?.[0]?.({ reason }, current.ctx);
    await mock.events.get("session_start")?.[0]?.({ reason }, current.ctx);
    assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  }
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);

  // A fresh extension instance represents a restarted Pi process; copied entries model forks.
  for (const copiedEntries of [false, true]) {
    const restarted = createMockPi();
    accountsExtension(restarted.pi, { store, providers });
    const nextRuntime = runtimeHarness(restarted);
    const nextSession = createTestSessionManager();
    if (copiedEntries) {
      for (const entry of sessionManager.getEntries()) {
        if (entry.type === "custom") nextSession.appendCustomEntry(entry.customType, entry.data);
      }
    }
    const next = createMockContext({
      sessionManager: nextSession,
      modelRegistry: nextRuntime.registry,
    });
    await restarted.events.get("session_start")?.[0]?.({}, next.ctx);
    assert.equal(nextRuntime.keys.get("anthropic"), "access-beta");
    assert.equal(latestSessionSelections(nextSession).anthropic, "beta");
    await restarted.events.get("session_shutdown")?.[0]?.({}, next.ctx);
  }
});

test("clearing a startup default keeps the named account active only in the current session", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "work",
    accounts: { work: credential("work") },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
  const runtime = runtimeHarness(mock);
  const current = createInteractiveAccountContext(
    { modelRegistry: runtime.registry, model: { provider: "anthropic", id: "claude" } },
    { selections: ["Set default account", "Anthropic", "Pi built-in login"] },
  );
  await mock.events.get("session_start")?.[0]?.({}, current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.ok((await store.readProviderAsync("anthropic")).accounts.work);
  assert.equal(runtime.keys.get("anthropic"), "access-work");
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
  const nextSession = createTestSessionManager();
  const next = createMockContext({
    sessionManager: nextSession,
    modelRegistry: runtime.registry,
  });
  await mock.events.get("session_start")?.[0]?.({}, next.ctx);
  assert.equal(latestSessionSelections(nextSession).anthropic, null);
  assert.equal(runtime.keys.get("anthropic"), undefined);
  await mock.events.get("session_shutdown")?.[0]?.({}, next.ctx);
});

test("removing the configured default clears it without changing another session selection", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "alpha",
    accounts: { alpha: credential("alpha"), beta: credential("beta") },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("anthropic")] });
  const runtime = runtimeHarness(mock);
  const current = createInteractiveAccountContext(
    { modelRegistry: runtime.registry, model: { provider: "anthropic", id: "claude" } },
    {
      selections: ["Set default account", "Anthropic", "beta", "Remove account", "Anthropic · beta"],
      confirms: [true],
    },
  );
  await mock.events.get("session_start")?.[0]?.({}, current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  await mock.commands.get("accounts")?.handler("", current.ctx);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.equal(runtime.keys.get("anthropic"), "access-alpha");
  await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
});

test("switch another provider account selects provider before account", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { "openai-codex": { accounts: { work: credential("codex") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx, selectCalls } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch another provider’s account", "OpenAI Codex", "work"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal((await store.readProviderAsync("openai-codex")).active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "work");
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.deepEqual(selectCalls[1]?.options, ["OpenAI Codex"]);
});

test("provider accounts activate independently and default clears only one provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "personal", accounts: { personal: credential("codex") } },
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  const mock = createMockPi();
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  accountsExtension(mock.pi, { store, providers });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx, notifications } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  );

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(keys.get("anthropic"), "access-claude");

  await mock.commands.get("accounts")?.handler("ignored", ctx);
  const data = await store.readAsync();
  assert.equal(data.providers.anthropic?.active, "work");
  assert.equal(data.providers["openai-codex"]?.active, "personal");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "personal");
  assert.equal(keys.has("anthropic"), false);
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.match(notifications.at(-1)?.message ?? "", /default Pi Anthropic login/);
});

test("concurrent sessions keep independent provider account selections", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: {
          alpha: credential("alpha"),
          beta: { ...credential("beta"), expires: 1 },
        },
      },
    },
  });
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  const first = createMockPi();
  const second = createMockPi();
  accountsExtension(first.pi, { store, providers });
  accountsExtension(second.pi, { store, providers });
  const firstRuntime = runtimeHarness(first);
  const secondRuntime = runtimeHarness(second);
  const firstSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const secondSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager: firstSession,
  }).ctx;
  const secondContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: secondRuntime.registry,
    sessionManager: secondSession,
  }).ctx;

  await first.events.get("session_start")?.[0]?.({}, firstContext);
  await second.events.get("session_start")?.[0]?.({}, secondContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-alpha");

  const secondMenuContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await second.commands.get("accounts")?.handler("ignored", secondMenuContext);
  assert.equal(secondRuntime.keys.get("anthropic"), "access-beta-refreshed");
  const sharedState = await store.readProviderAsync("anthropic");
  assert.equal(sharedState.active, "alpha");
  assert.equal(sharedState.accounts.beta?.access, "access-beta-refreshed");

  await first.events.get("before_agent_start")?.[0]?.({}, firstContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");

  const secondDefaultContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await second.commands.get("accounts")?.handler("ignored", secondDefaultContext);
  assert.equal(secondRuntime.keys.has("anthropic"), false);
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
  await first.events.get("before_agent_start")?.[0]?.({}, firstContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
});

test("one extension instance isolates concurrent headless session owners", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const firstRuntime = runtimeHarness(mock);
  const secondRuntime = runtimeHarness(mock);
  const firstSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const secondSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager: firstSession,
  }).ctx;
  const secondContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: secondRuntime.registry,
    sessionManager: secondSession,
  }).ctx;

  await mock.events.get("session_start")?.[0]?.({}, firstContext);
  await mock.events.get("session_start")?.[0]?.({}, secondContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(latestSessionSelections(firstSession).anthropic, "alpha");
  assert.equal(latestSessionSelections(secondSession).anthropic, "alpha");

  const secondMenuContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: secondRuntime.registry,
      sessionManager: secondSession,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", secondMenuContext);
  await mock.events.get("before_agent_start")?.[0]?.({}, firstContext);

  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(secondRuntime.keys.get("anthropic"), "access-beta");
  assert.equal(latestSessionSelections(firstSession).anthropic, "alpha");
  assert.equal(latestSessionSelections(secondSession).anthropic, "beta");
  assert.equal(mock.entries.length, 0);
  assert.equal(collectCredentialOffers(mock, firstSession, "anthropic")[0]?.access, "access-alpha");
  assert.equal(collectCredentialOffers(mock, secondSession, "anthropic")[0]?.access, "access-beta");

  await mock.events.get("session_shutdown")?.[0]?.({}, secondContext);
  assert.equal(secondRuntime.keys.has("anthropic"), false);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-alpha");
  assert.equal(collectCredentialOffers(mock, firstSession, "anthropic")[0]?.access, "access-alpha");
});

test("one extension instance keeps provider overlays scoped to each headless session", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": {
        active: "work",
        accounts: { work: credential("work") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("kimi-coding")] });
  const namedRuntime = runtimeHarness(mock, { isolateProviders: true });
  const defaultRuntime = runtimeHarness(mock, { isolateProviders: true });
  const namedSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const defaultSession = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  namedSession.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: namedSession.getSessionId(),
    providers: { "kimi-coding": "work" },
  });
  defaultSession.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: defaultSession.getSessionId(),
    providers: { "kimi-coding": null },
  });
  const namedContext = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: namedRuntime.registry,
    sessionManager: namedSession,
  }).ctx;
  const defaultContext = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: defaultRuntime.registry,
    sessionManager: defaultSession,
  }).ctx;

  await mock.events.get("session_start")?.[0]?.({}, namedContext);
  await mock.events.get("session_start")?.[0]?.({}, defaultContext);
  await mock.events.get("before_agent_start")?.[0]?.({}, namedContext);

  assert.equal(namedRuntime.keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.equal(defaultRuntime.keys.has("kimi-coding"), false);
  assert.deepEqual(namedRuntime.providerConfigs.get("kimi-coding"), {
    headers: { Authorization: "Bearer access-work" },
  });
  assert.equal(defaultRuntime.providerConfigs.has("kimi-coding"), false);

  await mock.events.get("session_shutdown")?.[0]?.({}, defaultContext);
  assert.deepEqual(namedRuntime.providerConfigs.get("kimi-coding"), {
    headers: { Authorization: "Bearer access-work" },
  });
});

test("session-local account selection restores on resume and ignores tree position", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const providers = [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")];
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const first = createMockPi();
  accountsExtension(first.pi, { store, providers });
  const firstRuntime = runtimeHarness(first);
  const firstContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: firstRuntime.registry,
    sessionManager,
  }).ctx;
  await first.events.get("session_start")?.[0]?.({}, firstContext);
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: firstRuntime.registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  ).ctx;
  await first.commands.get("accounts")?.handler("ignored", switchContext);
  assert.equal(firstRuntime.keys.get("anthropic"), "access-beta");

  sessionManager.resetLeaf();
  sessionManager.appendCustomEntry("unrelated-state", { branch: true });
  const resumed = createMockPi();
  accountsExtension(resumed.pi, { store, providers });
  const resumedRuntime = runtimeHarness(resumed);
  const resumedContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: resumedRuntime.registry,
    sessionManager,
  }).ctx;
  await resumed.events.get("session_start")?.[0]?.({ reason: "resume" }, resumedContext);

  assert.equal(resumedRuntime.keys.get("anthropic"), "access-beta");
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
});

test("restored sessions seed newly supported providers from the compatibility default", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
      "openai-codex": { active: "codex", accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    providers: { anthropic: null },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  assert.equal(keys.has("anthropic"), false);
  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "codex");
  assert.equal(latestSessionSelections(sessionManager)["github-copilot"], null);
});

test("malformed session selection fails closed and /accounts can recover to default", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 2,
    sessionId: sessionManager.getSessionId(),
    providers: { anthropic: "work" },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx, notifications } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(notifications[0]?.message ?? "", /invalid.*\/accounts/iu);

  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
});

test("session selection append failure retains the previous account", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "alpha",
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  assert.equal(keys.get("anthropic"), "access-alpha");

  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "beta"] },
  );
  await mock.commands.get("accounts")?.handler("ignored", switchContext.ctx);
  assert.match(switchContext.notifications.at(-1)?.message ?? "", /could not save/iu);
  await mock.events.get("before_agent_start")?.[0]?.({}, context.ctx);
  assert.equal(keys.get("anthropic"), "access-alpha");
  assert.equal((await store.readProviderAsync("anthropic")).active, "alpha");
});

test("initial session selection append failure fails closed and remains recoverable", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(context.notifications[0]?.message ?? "", /could not persist/iu);

  sessionManager.appendCustomEntry = appendCustomEntry;
  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
});

test("removal persistence failure leaves the missing selection fail closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  sessionManager.appendCustomEntry = () => {
    throw new Error("session disk unavailable");
  };
  const removeContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  );
  await mock.commands.get("accounts")?.handler("ignored", removeContext.ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work, undefined);
  assert.match(removeContext.notifications.at(-1)?.message ?? "", /fail closed/iu);
});

test("credential mutation failure leaves the session selection and runtime unchanged", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const context = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  store.updateProvider = async () => {
    throw new Error("credential disk unavailable");
  };
  const removeContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", removeContext);
  assert.equal(keys.get("anthropic"), "access-work");
  assert.equal(latestSessionSelections(sessionManager).anthropic, "work");
});

test("a removed session-selected credential fails closed until explicit recovery", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const sessionManager = SessionManager.inMemory(process.cwd(), { id: randomUUID() });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await store.updateProvider("anthropic", (state) => ({
    ...state,
    accounts: {},
  }));
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");

  const recoveryContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", recoveryContext);
  assert.equal(keys.has("anthropic"), false);
});

test("session replacement prevents a stale switch menu from mutating accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
    },
  });
  const originalReadProvider = store.readProviderAsync.bind(store);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let reads = 0;
  store.readProviderAsync = async (providerId) => {
    reads += 1;
    if (reads === 1) {
      markReadStarted();
      await readReleased;
    }
    return originalReadProvider(providerId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const oldContext = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Switch Anthropic account", "personal"] },
  ).ctx;
  const newContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  }).ctx;

  const stale = mock.commands.get("accounts")?.handler("ignored", oldContext);
  await readStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseRead();
  await stale;
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");
  assert.equal(keys.get("anthropic"), "access-work");
});

test("session replacement prevents a stale remove menu from deleting accounts", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("work") } },
    },
  });
  const originalUpdate = store.updateProvider.bind(store);
  let markUpdateStarted!: () => void;
  const updateStarted = new Promise<void>((resolve) => {
    markUpdateStarted = resolve;
  });
  let releaseUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  store.updateProvider = async (providerId, mutator) => {
    markUpdateStarted();
    await updateReleased;
    return originalUpdate(providerId, mutator);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const oldContext = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  ).ctx;
  const newContext = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
  }).ctx;

  const stale = mock.commands.get("accounts")?.handler("ignored", oldContext);
  await updateStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseUpdate();
  await stale;
  const state = await store.readProviderAsync("anthropic");
  assert.equal(state.active, "work");
  assert.equal(state.accounts.work?.access, "access-work");
  assert.equal(keys.get("anthropic"), "access-work");
});

test("stale multi-provider startup stops before syncing later providers", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
      anthropic: { active: "work", accounts: { work: credential("anthropic") } },
    },
  });
  let releaseOld!: () => void;
  const oldBlocked = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let markOldStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    markOldStarted = resolve;
  });
  let codexConversions = 0;
  let anthropicConversions = 0;
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    codexConversions += 1;
    if (codexConversions === 1) {
      markOldStarted();
      await oldBlocked;
    }
    return { apiKey: current.access };
  };
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    anthropicConversions += 1;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, anthropic, fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const oldContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  const newContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;

  const stale = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await oldStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  releaseOld();
  await stale;

  assert.equal(codexConversions, 2);
  assert.equal(anthropicConversions, 1);
});

test("default Codex auth does not invalidate connections on first observation", async () => {
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store: new AccountStore(new InMemoryAccountStorageBackend()),
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.deepEqual(invalidations, []);
});

test("Codex connections invalidate only when the applied account identity changes", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager("test-session");
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.deepEqual(invalidations, ["test-session"]);
  const switchContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", switchContext);
  assert.deepEqual(invalidations, ["test-session", "test-session"]);
});

test("connection invalidation tracks the credential actually applied before a shared replacement", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("old") } },
    },
  });
  const originalRead = store.readProviderAsync.bind(store);
  let reads = 0;
  store.readProviderAsync = async (providerId) => {
    const snapshot = await originalRead(providerId);
    if (providerId === "openai-codex") {
      reads += 1;
      if (reads === 3) {
        await store.updateProvider("openai-codex", (state) => ({
          ...state,
          accounts: { work: credential("new") },
        }));
      }
    }
    return snapshot;
  };
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager("credential-race-session");
  const { ctx } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("openai-codex"), "access-old");
  assert.equal((await originalRead("openai-codex")).accounts.work?.access, "access-new");
  assert.deepEqual(invalidations, ["credential-race-session"]);

  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("openai-codex"), "access-new");
  assert.deepEqual(invalidations, ["credential-race-session", "credential-race-session"]);
});

test("an older overlapping provider sync cannot publish stale inactive state", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  let conversions = 0;
  const invalidations: Array<string | undefined> = [];
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    conversions += 1;
    if (conversions === 1) {
      signalFirst?.();
      await firstBlocked;
      throw new Error("obsolete conversion failed");
    }
    return { apiKey: current.access };
  };
  codex.invalidateConnections = (sessionId) => {
    invalidations.push(sessionId);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await firstStarted;
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  releaseFirst?.();
  await older;

  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
  assert.deepEqual(invalidations, ["test-session"]);
});

test("an obsolete invalidation failure cannot fail closed a newer successful sync", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const originalRead = store.readProviderAsync.bind(store);
  let reads = 0;
  let releaseObsoleteRead: (() => void) | undefined;
  const obsoleteReadBlocked = new Promise<void>((resolve) => {
    releaseObsoleteRead = resolve;
  });
  let signalObsoleteRead: (() => void) | undefined;
  const obsoleteReadStarted = new Promise<void>((resolve) => {
    signalObsoleteRead = resolve;
  });
  store.readProviderAsync = async (providerId) => {
    reads += 1;
    if (reads === 5) {
      signalObsoleteRead?.();
      await obsoleteReadBlocked;
    }
    return originalRead(providerId);
  };
  let invalidations = 0;
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = () => {
    invalidations += 1;
    if (invalidations === 1) throw new Error("obsolete cleanup failed");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await obsoleteReadStarted;
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  releaseObsoleteRead?.();
  await older;

  assert.equal(keys.get("openai-codex"), "access-codex");
  assert.equal(statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
});

test("connection invalidation failure replaces active Codex auth with fail-closed state", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": { active: "work", accounts: { work: credential("codex") } },
    },
  });
  const codex = fakeProvider("openai-codex");
  codex.invalidateConnections = () => {
    throw new Error("socket cleanup failed");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, statuses } = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
  assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
});

test("generic login stores the full provider-owned credential and activates it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Login new account", "GitHub Copilot"], inputs: ["personal"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);
  const stored = (await store.readAsync()).providers["github-copilot"];
  assert.equal(stored?.active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["github-copilot"], "personal");
  assert.deepEqual(stored?.accounts.personal?.availableModelIds, ["allowed"]);
  assert.equal(keys.get("github-copilot"), "access-login-github-copilot");
});

test("xAI, Kimi, OpenRouter, and Radius login routes activate named OAuth accounts", async () => {
  for (const providerId of ["xai", "kimi-coding", "openrouter", "radius"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    const provider = fakeProvider(providerId);
    const mock = createMockPi();
    accountsExtension(mock.pi, { store, providers: [provider] });
    const { registry, keys, refreshCalls } = runtimeHarness(mock);
    const sessionManager = createTestSessionManager();
    const modelIds = {
      "kimi-coding": "k3",
      openrouter: "openrouter-model",
      radius: "radius-model",
      xai: "grok-4.3",
    };
    const { ctx } = createInteractiveAccountContext(
      {
        model: { provider: providerId, id: modelIds[providerId] },
        modelRegistry: registry,
        sessionManager,
      },
      { selections: ["Login new account", provider.displayName], inputs: ["work"] },
    );

    await mock.commands.get("accounts")?.handler("ignored", ctx);
    const state = await store.readProviderAsync(providerId);
    assert.equal(state.active, undefined);
    assert.equal(latestSessionSelections(sessionManager)[providerId], "work");
    assert.equal(state.accounts.work?.access, `access-login-${providerId}`);
    assert.equal(
      keys.get(providerId),
      providerId === "kimi-coding" ? "pi-accounts-header-auth" : `access-login-${providerId}`,
    );
    assert.equal(refreshCalls.length, providerId === "radius" ? 1 : 0);
  }
});

test("session shutdown aborts idle OAuth login before stale credentials can publish", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let loginSignal: AbortSignal | undefined;
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.login = async (interaction) => {
    loginSignal = interaction.signal;
    loginStarted();
    if (!loginSignal) throw new Error("Missing OAuth login signal");
    await new Promise<void>((resolve) => {
      if (loginSignal?.aborted) resolve();
      else loginSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return credential("stale");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx } = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
    },
    { selections: ["Login new account", "GitHub Copilot"], inputs: ["personal"] },
  );

  const login = mock.commands.get("accounts")?.handler("ignored", ctx);
  await started;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await login;

  assert.ok(loginSignal);
  assert.equal(loginSignal.aborted, true);
  const state = await store.readProviderAsync("github-copilot");
  assert.equal(state.active, undefined);
  assert.deepEqual(Object.keys(state.accounts), []);
});

test("login rejects default as a reserved account name", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const { ctx, notifications } = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["default"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal((await store.readProviderAsync("anthropic")).accounts.default, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /reserved/);
});

test("login asks before replacing an existing account name", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { anthropic: { active: "work", accounts: { work: credential("old") } } },
  });
  let logins = 0;
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.login = async () => {
    logins += 1;
    return credential("new");
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const cancelled = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["work"], confirms: [false] },
  );

  await mock.commands.get("accounts")?.handler("ignored", cancelled.ctx);
  assert.equal(logins, 0);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-old");
  assert.match(cancelled.confirmCalls[0]?.message ?? "", /already exists/);

  const replaced = createInteractiveAccountContext(
    { model: { provider: "anthropic", id: "claude" }, modelRegistry: registry },
    { selections: ["Login new account", "Anthropic"], inputs: ["work"], confirms: [true] },
  );
  await mock.commands.get("accounts")?.handler("ignored", replaced.ctx);
  assert.equal(logins, 1);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-new");
});

test("login leaves concurrent session models unchanged without a session-scoped model action", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const codex = fakeProvider("openai-codex");
  codex.defaultModelId = "codex";
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { keys, registry } = runtimeHarness(mock);
  const firstModel = { provider: "anthropic", id: "claude" };
  const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" };
  const firstContext = createMockContext({
    model: firstModel,
    modelRegistry: registry,
    sessionManager: createTestSessionManager("first-onboarding-session"),
  }).ctx;
  await mock.events.get("session_start")?.[0]?.({}, firstContext);
  const { ctx } = createInteractiveAccountContext(
    {
      model: unknownModel,
      modelRegistry: registry,
      sessionManager: createTestSessionManager("second-onboarding-session"),
    },
    { selections: ["Login new account", "OpenAI Codex"], inputs: ["work"] },
  );

  await mock.commands.get("accounts")?.handler("ignored", ctx);

  assert.equal(keys.get("openai-codex"), "access-login-openai-codex");
  assert.equal(mock.setModels.length, 0);
  assert.deepEqual(firstModel, { provider: "anthropic", id: "claude" });
  assert.deepEqual(unknownModel, { provider: "unknown", id: "unknown", api: "unknown" });
});

test("credential source offers a refreshed active credential as defensive session-bound clones", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "work",
        accounts: {
          work: {
            ...credential("expired", { availableModelIds: ["allowed"] }),
            expires: 1,
          },
        },
      },
    },
  });
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.refresh = async (current) => ({
    ...current,
    access: "access-refreshed",
    expires: Date.now() + 60 * 60 * 1000,
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager,
  });

  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  const first = collectCredentialOffers(mock, sessionManager, "github-copilot");
  assert.equal(first.length, 1);
  const firstOffer = first[0];
  assert.ok(firstOffer);
  assert.equal(firstOffer.access, "access-refreshed");
  firstOffer.access = "caller-mutated";
  (firstOffer.availableModelIds as string[]).push("caller-mutated");
  const second = collectCredentialOffers(mock, sessionManager, "github-copilot");
  assert.equal(second[0]?.access, "access-refreshed");
  assert.deepEqual(second[0]?.availableModelIds, ["allowed"]);
  assert.deepEqual(collectCredentialOffers(mock, {}, "github-copilot"), []);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "anthropic"), []);

  assert.doesNotThrow(() => {
    mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, {
      session: sessionManager,
      provider: "github-copilot",
      offer() {
        throw new Error("consumer rejected offer");
      },
    });
  });
  const malformed = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(malformed, "session", {
    get() {
      throw new Error("malformed request");
    },
  });
  assert.doesNotThrow(() => mock.eventBus.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, malformed));

  const defaultContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "default"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", defaultContext);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
});

test("credential source suppresses pending, stale, failed-closed, and replaced activations", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "first",
        accounts: {
          first: credential("first", { availableModelIds: ["allowed"] }),
          second: credential("second", { availableModelIds: ["allowed"] }),
        },
      },
    },
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let notifyFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.toAuth = async (current) => {
    if (current.access === "access-first") {
      notifyFirst();
      await firstBlocked;
    }
    if (current.access === "access-failing") throw new Error("conversion failed");
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager,
  });

  const older = mock.events.get("session_start")?.[0]?.({}, ctx);
  await firstStarted;
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
  const secondContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "second"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", secondContext);
  assert.equal(collectCredentialOffers(mock, sessionManager, "github-copilot")[0]?.access, "access-second");
  releaseFirst();
  await older;
  assert.equal(collectCredentialOffers(mock, sessionManager, "github-copilot")[0]?.access, "access-second");

  await store.updateProvider("github-copilot", (state) => ({
    ...state,
    accounts: { ...state.accounts, failing: credential("failing") },
  }));
  const failingContext = createInteractiveAccountContext(
    {
      model: { provider: "github-copilot", id: "allowed" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch GitHub Copilot account", "failing"] },
  ).ctx;
  await mock.commands.get("accounts")?.handler("ignored", failingContext);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);

  const replacement = createMockContext({
    model: { provider: "github-copilot", id: "allowed" },
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await mock.events.get("session_start")?.[0]?.({}, replacement);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "github-copilot"), []);
});

test("session replacement invalidates a pending credential offer before old work resumes", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "work",
        accounts: { work: credential("work") },
      },
    },
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let notifyFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  let conversions = 0;
  const copilot = fakeProvider("github-copilot");
  copilot.oauth.toAuth = async (current) => {
    conversions += 1;
    if (conversions === 1) {
      notifyFirst();
      await firstBlocked;
    }
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), copilot],
  });
  const { registry } = runtimeHarness(mock);
  const oldSession = createTestSessionManager();
  const newSession = createTestSessionManager();
  const oldContext = createMockContext({ modelRegistry: registry, sessionManager: oldSession }).ctx;
  const newContext = createMockContext({ modelRegistry: registry, sessionManager: newSession }).ctx;

  const oldStart = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await firstStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  assert.deepEqual(collectCredentialOffers(mock, oldSession, "github-copilot"), []);
  assert.equal(collectCredentialOffers(mock, newSession, "github-copilot")[0]?.access, "access-work");
  releaseFirst();
  await oldStart;
  assert.deepEqual(collectCredentialOffers(mock, oldSession, "github-copilot"), []);
  assert.equal(collectCredentialOffers(mock, newSession, "github-copilot")[0]?.access, "access-work");
});

test("xAI named OAuth applies its access token and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { xai: { active: "work", accounts: { work: credential("xai") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "xai", id: "grok-4.3" },
    modelRegistry: registry,
    sessionManager,
  });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("xai"));

  const active = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(active, {
    status: "active",
    providerId: "xai",
    accountName: "work",
  });
  coordinator.publishCredentialOffer(ctx, active, "work:access-xai");
  assert.equal(keys.get("xai"), "access-xai");
  const offers: StoredOAuthCredential[] = [];
  coordinator.offerCredential({
    session: sessionManager,
    provider: "xai",
    offer: (candidate: StoredOAuthCredential) => offers.push(candidate),
  });
  assert.equal(offers[0]?.access, "access-xai");

  await store.updateProvider("xai", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "xai",
  });
  assert.equal(keys.has("xai"), false);
});

test("OpenRouter named OAuth applies its access token and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      openrouter: {
        active: "work",
        accounts: { work: credential("openrouter", { refresh: "" }) },
      },
    },
  });
  const mock = createMockPi();
  const { keys, refreshCalls, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "openrouter", id: "openrouter-model" },
    modelRegistry: registry,
    sessionManager,
  });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("openrouter"));

  const active = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(active, {
    status: "active",
    providerId: "openrouter",
    accountName: "work",
  });
  coordinator.publishCredentialOffer(ctx, active, "work:access-openrouter");
  const offers: StoredOAuthCredential[] = [];
  coordinator.offerCredential({
    session: sessionManager,
    provider: "openrouter",
    offer: (candidate: StoredOAuthCredential) => offers.push(candidate),
  });
  assert.equal(offers[0]?.refresh, "");
  assert.equal(keys.get("openrouter"), "access-openrouter");
  assert.deepEqual(refreshCalls, []);

  await store.updateProvider("openrouter", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "openrouter",
  });
  assert.equal(keys.has("openrouter"), false);
  assert.deepEqual(refreshCalls, []);
});

test("OpenRouter activation observes an already cancelled menu operation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      openrouter: { active: "work", accounts: { work: credential("openrouter") } },
    },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("openrouter"));
  const owner = new AbortController();
  owner.abort(new DOMException("Menu cancelled", "AbortError"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store, Date.now(), owner.signal)).status, "error");
  assert.equal(keys.get("openrouter"), FAIL_CLOSED_API_KEY);
});

test("Radius resolves OAuth from Pi's active gateway provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const radius = createBuiltinProviderAdapters().find((provider) => provider.id === "radius");
  assert.ok(radius);
  const activeOAuth = fakeProvider("radius").oauth;
  activeOAuth.toAuth = async (current) => ({ apiKey: `gateway:${current.access}` });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  const modelRegistry = {
    ...registry,
    getProvider: () => ({ auth: { oauth: activeOAuth } }),
  };
  const { ctx } = createMockContext({ modelRegistry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, radius);

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(keys.get("radius"), "gateway:access-radius");
});

test("Radius refreshes its dynamic catalog for named and restored default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, models, registry } = runtimeHarness(mock);
  const refreshKeys: Array<string | undefined> = [];
  registry.refresh = async (options) => {
    refreshKeys.push(keys.get("radius"));
    assert.deepEqual(options.providers, ["radius"]);
    assert.equal(options.allowNetwork, true);
    assert.equal(options.signal?.aborted, false);
    models.splice(
      models.findIndex((model) => model.provider === "radius"),
      1,
      {
        provider: "radius",
        id: keys.has("radius") ? "named-radius-model" : "default-radius-model",
        baseUrl: "https://radius.pi.dev",
      },
    );
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "radius",
    accountName: "work",
  });
  assert.equal(keys.get("radius"), "access-radius");
  assert.equal(
    models.some((model) => model.id === "named-radius-model"),
    true,
  );
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.deepEqual(refreshKeys, ["access-radius"]);

  await store.updateProvider("radius", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "radius",
  });
  assert.equal(keys.has("radius"), false);
  assert.equal(
    models.some((model) => model.id === "default-radius-model"),
    true,
  );
  assert.deepEqual(refreshKeys, ["access-radius", undefined]);
});

test("Radius rebinds a retained selected model to its refreshed endpoint", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { models, registry } = runtimeHarness(mock);
  const selected = registry.find("radius", "radius-model");
  assert.ok(selected);
  registry.refresh = async () => {
    const radius = models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://account.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ model: selected, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(mock.setModels.length, 0);
  assert.equal(selected.baseUrl, "https://account.radius.example");
});

test("Radius model rebinding stays scoped to each concurrent session context", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const first = runtimeHarness(mock, { isolateProviders: true });
  const second = runtimeHarness(mock, { isolateProviders: true });
  const firstSelected = first.registry.find("radius", "radius-model");
  const secondSelected = second.registry.find("radius", "radius-model");
  assert.ok(firstSelected);
  assert.ok(secondSelected);
  first.registry.refresh = async () => {
    const radius = first.models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://first.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  second.registry.refresh = async () => {
    const radius = second.models.find((model) => model.provider === "radius");
    assert.ok(radius);
    radius.baseUrl = "https://second.radius.example";
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const firstContext = createMockContext({
    model: firstSelected,
    modelRegistry: first.registry,
    sessionManager: createTestSessionManager("first-radius-session"),
  }).ctx;
  const secondContext = createMockContext({
    model: secondSelected,
    modelRegistry: second.registry,
    sessionManager: createTestSessionManager("second-radius-session"),
  }).ctx;
  const firstCoordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));
  const secondCoordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  assert.equal((await ensureStoredSelection(firstCoordinator, firstContext, store)).status, "active");
  assert.equal((await ensureStoredSelection(secondCoordinator, secondContext, store)).status, "active");
  assert.equal(firstSelected.baseUrl, "https://first.radius.example");
  assert.equal(secondSelected.baseUrl, "https://second.radius.example");
  assert.equal(mock.setModels.length, 0);
});

test("Radius fails closed when the selected model disappears from the refreshed catalog", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, models, registry } = runtimeHarness(mock);
  const selected = registry.find("radius", "radius-model");
  assert.ok(selected);
  registry.refresh = async () => {
    models.splice(
      models.findIndex((model) => model.provider === "radius"),
      1,
    );
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ model: selected, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.message, /model radius-model is unavailable/);
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});

test("Radius catalog refresh errors fail closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  registry.refresh = async () => ({
    aborted: false,
    errors: new Map([["radius", new Error("catalog unavailable")]]),
  });
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.message, /catalog unavailable/);
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});

test("a newer Radius account operation aborts stale catalog refresh work", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius-old") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let firstSignal: AbortSignal | undefined;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let refreshes = 0;
  registry.refresh = async (options) => {
    refreshes += 1;
    if (refreshes === 1) {
      firstSignal = options.signal;
      markFirstStarted();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  const stale = ensureStoredSelection(coordinator, ctx, store);
  await firstStarted;
  await store.updateProvider("radius", (state) => ({
    ...state,
    accounts: { work: credential("radius-new") },
  }));
  const current = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(current, {
    status: "active",
    providerId: "radius",
    accountName: "work",
  });
  assert.deepEqual(await stale, { status: "inactive", providerId: "radius" });
  assert.equal(firstSignal?.aborted, true);
  assert.equal(keys.get("radius"), "access-radius-new");
});

test("stale Radius default restoration cannot fail close a newer named activation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      radius: {
        active: "alpha",
        accounts: { alpha: credential("radius-alpha"), beta: credential("radius-beta") },
      },
    },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let markDefaultStarted!: () => void;
  const defaultStarted = new Promise<void>((resolve) => {
    markDefaultStarted = resolve;
  });
  let refreshes = 0;
  registry.refresh = async (options) => {
    refreshes += 1;
    if (refreshes === 2) {
      markDefaultStarted();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");

  await store.updateProvider("radius", (state) => ({ ...state, active: undefined }));
  const staleDefault = ensureStoredSelection(coordinator, ctx, store);
  await defaultStarted;
  await store.updateProvider("radius", (state) => ({ ...state, active: "beta" }));
  const current = await ensureStoredSelection(coordinator, ctx, store);

  assert.equal(current.status, "active");
  assert.deepEqual(await staleDefault, { status: "inactive", providerId: "radius" });
  assert.equal(keys.get("radius"), "access-radius-beta");
  assert.equal(refreshes, 3);
});

test("Radius keeps the explicit session account when the global default changes", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      radius: {
        active: "alpha",
        accounts: { alpha: credential("radius-alpha"), beta: credential("radius-beta") },
      },
    },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let refreshes = 0;
  registry.refresh = async () => {
    refreshes += 1;
    if (refreshes === 1) {
      await store.updateProvider("radius", (state) => ({ ...state, active: "beta" }));
    }
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "radius",
    accountName: "alpha",
  });
  assert.equal(keys.get("radius"), "access-radius-alpha");
  assert.equal((await store.readProviderAsync("radius")).active, "beta");
  assert.equal(refreshes, 1);
});

test("Radius menu cancellation aborts post-login catalog work and fails closed", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  const { keys, registry } = runtimeHarness(mock);
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  registry.refresh = async (options) => {
    markRefreshStarted();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("radius"));
  const owner = new AbortController();

  const activation = ensureStoredSelection(coordinator, ctx, store, Date.now(), owner.signal);
  await refreshStarted;
  owner.abort(new DOMException("Menu cancelled", "AbortError"));
  assert.equal((await activation).status, "error");
  assert.equal(keys.get("radius"), FAIL_CLOSED_API_KEY);
});

test("Radius session replacement aborts the stale catalog refresh", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
  const { keys, registry } = runtimeHarness(mock);
  let firstSignal: AbortSignal | undefined;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let refreshes = 0;
  registry.refresh = async (options) => {
    refreshes += 1;
    if (refreshes === 1) {
      firstSignal = options.signal;
      markFirstStarted();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const oldContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;
  const newContext = createMockContext({
    modelRegistry: registry,
    sessionManager: createTestSessionManager(),
  }).ctx;

  const oldStart = mock.events.get("session_start")?.[0]?.({}, oldContext);
  await firstStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, oldContext);
  await mock.events.get("session_start")?.[0]?.({}, newContext);
  await oldStart;
  assert.equal(firstSignal?.aborted, true);
  assert.equal(refreshes, 2);
  assert.equal(keys.get("radius"), "access-radius");
});

test("Radius session shutdown aborts a pending catalog refresh and removes runtime auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
  const { keys, registry } = runtimeHarness(mock);
  let refreshSignal: AbortSignal | undefined;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  registry.refresh = async (options) => {
    refreshSignal = options.signal;
    markRefreshStarted();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { aborted: options.signal?.aborted ?? false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  const start = mock.events.get("session_start")?.[0]?.({}, ctx);
  await refreshStarted;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await start;
  assert.equal(refreshSignal?.aborted, true);
  assert.equal(keys.has("radius"), false);
});

test("Radius session shutdown restores the default catalog after clearing named auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: { radius: { active: "work", accounts: { work: credential("radius") } } },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [fakeProvider("radius")] });
  const { keys, registry } = runtimeHarness(mock);
  const refreshKeys: Array<string | undefined> = [];
  registry.refresh = async () => {
    refreshKeys.push(keys.get("radius"));
    return { aborted: false, errors: new Map<string, Error>() };
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("radius"), "access-radius");
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(keys.has("radius"), false);
  assert.deepEqual(refreshKeys, ["access-radius", undefined]);
});

test("new provider adapters refresh expiring named credentials before activation", async () => {
  for (const providerId of ["xai", "kimi-coding", "openrouter", "radius"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        [providerId]: {
          active: "work",
          accounts: { work: { ...credential(providerId), expires: 0 } },
        },
      },
    });
    const mock = createMockPi();
    const { keys, registry } = runtimeHarness(mock);
    const { ctx } = createMockContext({ modelRegistry: registry });
    const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider(providerId));

    assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
    assert.equal((await store.readProviderAsync(providerId)).accounts.work?.access, `access-${providerId}-refreshed`);
    assert.equal(
      keys.get(providerId),
      providerId === "kimi-coding" ? "pi-accounts-header-auth" : `access-${providerId}-refreshed`,
    );
  }
});

test("Kimi named OAuth displaces default auth with its Bearer header and restores it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("kimi-coding", {
    headers: { authorization: "Bearer default", Existing: "yes" },
  });
  const { keys, registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: registry,
  });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("kimi-coding"));

  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "active",
    providerId: "kimi-coding",
    accountName: "work",
  });
  assert.equal(keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { Existing: "yes", Authorization: "Bearer access-kimi" },
  });

  await store.updateProvider("kimi-coding", (state) => ({ ...state, active: undefined }));
  assert.deepEqual(await ensureStoredSelection(coordinator, ctx, store), {
    status: "inactive",
    providerId: "kimi-coding",
  });
  assert.equal(keys.has("kimi-coding"), false);
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { authorization: "Bearer default", Existing: "yes" },
  });
});

test("Kimi named auth resolves through Pi with the selector and Bearer header", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const pi = {
    registerProvider: registry.registerProvider.bind(registry),
    unregisterProvider: registry.unregisterProvider.bind(registry),
  };
  const model = registry.find("kimi-coding", "k3");
  assert.ok(model);
  const { ctx } = createMockContext({ model, modelRegistry: registry });
  const coordinator = new RuntimeAuthCoordinator(pi as never, fakeProvider("kimi-coding"));

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: true,
    apiKey: "pi-accounts-header-auth",
    headers: { Authorization: "Bearer access-kimi" },
    env: undefined,
  });

  await store.updateProvider("kimi-coding", (state) => ({ ...state, active: undefined }));
  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "inactive");
  assert.equal(registry.getRegisteredProviderConfig("kimi-coding"), undefined);
});

test("Kimi session shutdown cancels ownership and restores default auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("kimi-coding", { headers: { Existing: "yes" } });
  accountsExtension(mock.pi, { store, providers: [fakeProvider("kimi-coding")] });
  const { keys, registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "kimi-coding", id: "k3" },
    modelRegistry: registry,
    sessionManager,
  });

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("kimi-coding"), "pi-accounts-header-auth");
  assert.equal(collectCredentialOffers(mock, sessionManager, "kimi-coding")[0]?.access, "access-kimi");
  assert.deepEqual(mock.providers.get("kimi-coding"), {
    headers: { Existing: "yes", Authorization: "Bearer access-kimi" },
  });

  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(keys.has("kimi-coding"), false);
  assert.deepEqual(collectCredentialOffers(mock, sessionManager, "kimi-coding"), []);
  assert.deepEqual(mock.providers.get("kimi-coding"), { headers: { Existing: "yes" } });
});

test("Kimi malformed header auth fails closed without retaining a named Bearer token", async () => {
  const invalidAuth: ModelAuth[] = [
    {},
    { headers: { Authorization: "" } },
    { headers: { Authorization: "Bearer token\r\nInjected: yes" } },
    { headers: { Authorization: "Bearer first", authorization: "Bearer second" } },
    { apiKey: "unexpected", headers: { Authorization: "Bearer token" } },
  ];
  for (const auth of invalidAuth) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        "kimi-coding": { active: "work", accounts: { work: credential("kimi") } },
      },
    });
    const mock = createMockPi();
    const { keys, registry } = runtimeHarness(mock);
    const { ctx } = createMockContext({
      model: { provider: "kimi-coding", id: "k3" },
      modelRegistry: registry,
    });
    const kimi = fakeProvider("kimi-coding");
    kimi.oauth.toAuth = async () => auth;
    const coordinator = new RuntimeAuthCoordinator(mock.pi, kimi);

    const result = await ensureStoredSelection(coordinator, ctx, store);
    assert.equal(result.status, "error");
    assert.equal(keys.get("kimi-coding"), FAIL_CLOSED_API_KEY);
    assert.equal(JSON.stringify(mock.providers.get("kimi-coding") ?? {}).includes("Bearer access-kimi"), false);
  }
});

test("providers without account-specific overlays leave existing registrations untouched", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("anthropic", { headers: { Existing: "yes" } });
  const registrationsBefore = mock.providerRegistrations.length;
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("anthropic"));
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "active");
  assert.equal(mock.providerRegistrations.length, registrationsBefore);
  assert.deepEqual(mock.providers.get("anthropic"), { headers: { Existing: "yes" } });
});

test("GitHub Copilot activation applies its endpoint and available model projection, then restores config", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "enterprise",
        accounts: {
          enterprise: credential("copilot", {
            enterpriseUrl: "github.example.com",
            availableModelIds: ["allowed"],
          }),
        },
      },
    },
  });
  const mock = createMockPi();
  mock.rawPi.registerProvider("github-copilot", { headers: { Existing: "yes" } });
  const provider = fakeProvider("github-copilot", {
    baseUrl: "https://copilot-api.github.example.com",
    headers: { Account: "enterprise" },
  });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(result, {
    status: "active",
    providerId: "github-copilot",
    accountName: "enterprise",
  });
  assert.equal(keys.get("github-copilot"), "access-copilot");
  const projected = mock.providers.get("github-copilot") as {
    headers: Record<string, string>;
    baseUrl: string;
    models: Array<{ id: string }>;
  };
  assert.deepEqual(projected.headers, { Existing: "yes", Account: "enterprise" });
  assert.equal(projected.baseUrl, "https://copilot-api.github.example.com");
  assert.deepEqual(
    projected.models.map((model) => model.id),
    ["allowed"],
  );

  await store.updateProvider("github-copilot", (state) => ({ ...state, active: undefined }));
  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(mock.providers.get("github-copilot"), { headers: { Existing: "yes" } });
  assert.equal(keys.has("github-copilot"), false);
});

test("Copilot account switches rebuild model filtering from the complete pre-overlay catalog", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "github-copilot": {
        active: "first",
        accounts: {
          first: credential("first", { availableModelIds: ["allowed"] }),
          second: credential("second", { availableModelIds: ["blocked"] }),
        },
      },
    },
  });
  const mock = createMockPi();
  const provider = fakeProvider("github-copilot", { baseUrl: "https://api.copilot.example" });
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const { registry } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(
    (mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ["allowed"],
  );
  await store.updateProvider("github-copilot", (state) => ({ ...state, active: "second" }));
  await ensureStoredSelection(coordinator, ctx, store);
  assert.deepEqual(
    (mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ["blocked"],
  );
});

test("unsafe provider endpoints and malformed model metadata fail closed", async () => {
  for (const mode of ["endpoint", "models"] as const) {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        "github-copilot": {
          active: "work",
          accounts: {
            work: credential("copilot", {
              ...(mode === "models" ? { availableModelIds: [1] } : {}),
            }),
          },
        },
      },
    });
    const provider = fakeProvider("github-copilot", {
      baseUrl: mode === "endpoint" ? "http://token-stealer.invalid" : undefined,
    });
    const mock = createMockPi();
    const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
    const { registry, keys } = runtimeHarness(mock);
    const { ctx } = createMockContext({ modelRegistry: registry });

    assert.equal((await ensureStoredSelection(coordinator, ctx, store)).status, "error");
    assert.equal(keys.get("github-copilot"), FAIL_CLOSED_API_KEY);
  }
});

test("expired credentials refresh with a concrete signal and activate", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  const provider = fakeProvider("anthropic");
  let refreshSignal: AbortSignal | undefined;
  provider.oauth.refresh = async (current, signal) => {
    refreshSignal = signal;
    if (!signal) throw new Error("Missing OAuth refresh signal");
    return {
      ...current,
      access: "access-refreshed",
      expires: Date.now() + 60 * 60 * 1000,
    };
  };
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);

  assert.deepEqual(result, {
    status: "active",
    providerId: "anthropic",
    accountName: "work",
  });
  assert.ok(refreshSignal instanceof AbortSignal);
  assert.equal(refreshSignal.aborted, false);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-refreshed");
  assert.equal(keys.get("anthropic"), "access-refreshed");
});

test("refresh invalidation rejects stale credentials and rotates the signal", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const signals: Array<AbortSignal | undefined> = [];
  const provider = fakeProvider("anthropic");
  provider.oauth.refresh = async (current, signal) => {
    signals.push(signal);
    if (signals.length === 1) {
      notifyStarted();
      await firstRelease;
      return {
        ...current,
        access: "access-stale",
        expires: Date.now() + 60 * 60 * 1000,
      };
    }
    return {
      ...current,
      access: "access-fresh",
      expires: Date.now() + 60 * 60 * 1000,
    };
  };
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const staleActivation = ensureStoredSelection(coordinator, ctx, store);
  await started;
  coordinator.invalidate(ctx);
  releaseFirst();
  const staleResult = await staleActivation;
  const freshResult = await ensureStoredSelection(coordinator, ctx, store);

  assert.equal(staleResult.status, "inactive");
  assert.deepEqual(freshResult, {
    status: "active",
    providerId: "anthropic",
    accountName: "work",
  });
  assert.equal(signals.length, 2);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0].aborted, true);
  assert.ok(signals[1] instanceof AbortSignal);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-fresh");
  assert.equal(keys.get("anthropic"), "access-fresh");
});

test("invalid refreshed credentials fail closed instead of escaping storage validation", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { work: { ...credential("expired"), expires: 1 } },
      },
    },
  });
  const provider = fakeProvider("anthropic");
  provider.oauth.refresh = async () => ({
    type: "oauth",
    access: "",
    refresh: "rotated-secret",
    expires: Date.now() + 60_000,
  });
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
  const { registry, keys } = runtimeHarness(mock);
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.equal((await store.readProviderAsync("anthropic")).accounts.work?.access, "access-expired");
});

test("fail-closed runtime keys are attempted even when a provider overlay is rejected", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": {
        active: "work",
        accounts: { work: credential("codex") },
      },
    },
  });
  const mock = createMockPi();
  const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("openai-codex"));
  const { registry, keys } = runtimeHarness(mock);
  registry.registerProvider = () => {
    throw new Error("overlay rejected");
  };
  const { ctx } = createMockContext({ modelRegistry: registry });

  const result = await ensureStoredSelection(coordinator, ctx, store);
  assert.equal(result.status, "error");
  assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
});

test("refresh and auth derivation failures fail closed, redact secrets, and abort only the affected provider", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("secret") } },
    },
  });
  const failing = fakeProvider("anthropic");
  failing.oauth.toAuth = async (current) => {
    throw new Error(`bad ${current.access} and ${current.refresh}`);
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), failing, fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  let aborts = 0;
  const { ctx, statuses } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    abort: () => {
      aborts += 1;
    },
  });

  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
  assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
  assert.doesNotMatch(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /access-secret|refresh-secret/);
  await mock.events.get("turn_start")?.[0]?.({}, ctx);
  assert.equal(aborts, 1);

  const other = createMockContext({
    model: { provider: "openai-codex", id: "codex" },
    modelRegistry: registry,
    abort: () => {
      aborts += 1;
    },
  }).ctx;
  await mock.events.get("turn_start")?.[0]?.({}, other);
  assert.equal(aborts, 1);
});

test("account reset during OAuth conversion cannot restore a stale runtime override", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: { active: "work", accounts: { work: credential("claude") } },
    },
  });
  let releaseConversion: (() => void) | undefined;
  const conversionBlocked = new Promise<void>((resolve) => {
    releaseConversion = resolve;
  });
  let signalConversion: (() => void) | undefined;
  const conversionStarted = new Promise<void>((resolve) => {
    signalConversion = resolve;
  });
  const anthropic = fakeProvider("anthropic");
  anthropic.oauth.toAuth = async (current) => {
    signalConversion?.();
    await conversionBlocked;
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const { ctx } = createMockContext({
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: registry,
    sessionManager,
  });

  const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
  await conversionStarted;
  const resetContext = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch Anthropic account", "default"] },
  ).ctx;
  const reset = mock.commands.get("accounts")?.handler("ignored", resetContext);
  releaseConversion?.();
  await Promise.all([startup, reset]);
  assert.equal((await store.readProviderAsync("anthropic")).active, "work");
  assert.equal(latestSessionSelections(sessionManager).anthropic, null);
  assert.equal(keys.has("anthropic"), false);
});

test("an overlapping account switch reports when its requested account was superseded", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      "openai-codex": {
        accounts: { alpha: credential("alpha"), beta: credential("beta") },
      },
    },
  });
  let releaseAlpha: (() => void) | undefined;
  const alphaBlocked = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  let signalAlpha: (() => void) | undefined;
  const alphaStarted = new Promise<void>((resolve) => {
    signalAlpha = resolve;
  });
  const codex = fakeProvider("openai-codex");
  codex.oauth.toAuth = async (current) => {
    if (current.access === "access-alpha") {
      signalAlpha?.();
      await alphaBlocked;
    }
    return { apiKey: current.access };
  };
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry } = runtimeHarness(mock);
  const sessionManager = createTestSessionManager();
  const olderContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "alpha"] },
  );
  const newerContext = createInteractiveAccountContext(
    {
      model: { provider: "openai-codex", id: "codex" },
      modelRegistry: registry,
      sessionManager,
    },
    { selections: ["Switch OpenAI Codex account", "beta"] },
  );

  const older = mock.commands.get("accounts")?.handler("ignored", olderContext.ctx);
  await alphaStarted;
  await mock.commands.get("accounts")?.handler("ignored", newerContext.ctx);
  releaseAlpha?.();
  await older;

  assert.equal((await store.readProviderAsync("openai-codex")).active, undefined);
  assert.equal(latestSessionSelections(sessionManager)["openai-codex"], "beta");
  assert.match(olderContext.notifications.at(-1)?.message ?? "", /alpha.*superseded/);
});

test("remove account confirms and active removal restores default provider auth", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: { personal: credential("personal"), work: credential("work") },
      },
      "openai-codex": { accounts: { codex: credential("codex") } },
    },
  });
  const mock = createMockPi();
  accountsExtension(mock.pi, {
    store,
    providers: [fakeProvider("openai-codex"), fakeProvider("anthropic"), fakeProvider("github-copilot")],
  });
  const { registry, keys } = runtimeHarness(mock);
  const { ctx, confirmCalls } = createInteractiveAccountContext(
    {
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: registry,
    },
    { selections: ["Remove account", "Anthropic · work"], confirms: [true] },
  );

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(keys.get("anthropic"), "access-work");
  await mock.commands.get("accounts")?.handler("ignored", ctx);

  const state = await store.readProviderAsync("anthropic");
  assert.equal(state.active, undefined);
  assert.equal(state.accounts.work, undefined);
  assert.equal(state.accounts.personal?.access, "access-personal");
  assert.equal(keys.has("anthropic"), false);
  assert.match(confirmCalls[0]?.message ?? "", /Remove Anthropic account "work"/);
});
