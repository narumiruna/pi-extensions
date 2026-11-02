import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { onTestFinished, test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import type { OAuthCredentialCandidateReader } from "../src/oauth-credential-source.js";
import { queryProviderUsage, resolveUsageAuth, SUPPORTED_ADAPTERS } from "../src/query.js";
import type { PiModel, UsageProviderAdapter } from "../src/types.js";
import { queryUsage } from "./fixtures/usage-client.js";

const regions = [
  { id: "zai", origin: "https://api.z.ai" },
  { id: "zai-coding-cn", origin: "https://open.bigmodel.cn" },
] as const;
const providerKey = "synthetic-zai-provider-key";
const virtualKey = "synthetic-virtual-only-key";
const quota = {
  code: 200,
  success: true,
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 13 },
      { type: "TOKENS_LIMIT", unit: 6, percentage: 24 },
    ],
  },
};

type ProviderAuth = {
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
  source?: string;
  env?: Record<string, string>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(region: (typeof regions)[number] = regions[0]) {
  const model: PiModel = {
    id: "glm-auto",
    name: "GLM Auto",
    provider: region.id,
    api: "pi-virtual",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
  const state: {
    selected: PiModel | undefined;
    registered: PiModel | undefined;
    provider: { baseUrl?: string } | undefined;
    auth: ProviderAuth | undefined;
  } = {
    selected: model,
    registered: model,
    provider: { baseUrl: `${region.origin}/api/coding/paas/v4` },
    auth: { auth: { apiKey: providerKey }, source: "synthetic provider", env: { ACCOUNT: "provider-account" } },
  };
  const registry = {
    find: vi.fn(() => state.registered),
    getProvider: vi.fn(() => state.provider),
    getProviderAuth: vi.fn(async (): Promise<ProviderAuth | undefined> => state.auth),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true,
      apiKey: virtualKey,
      headers: { Authorization: `Bearer ${virtualKey}` },
    })),
    getAvailable: (): PiModel[] => [],
    getAll: (): PiModel[] => [],
    getProviderAuthStatus: (provider: string) => ({ configured: provider === region.id }),
    getProviderDisplayName: (provider: string) => provider,
  };
  const panels: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    model,
    modelRegistry: registry,
    select: async (title: string) => {
      panels.push(title);
      return "Close";
    },
  });
  Object.defineProperty(context.ctx, "model", { get: () => state.selected });
  const ctx = context.ctx as ExtensionContext;
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === region.id);
  assert.ok(adapter);
  return { ...context, ctx, state, model, registry, adapter, panels };
}

function mockQuota() {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json(url.endsWith("/subscription/list") ? { code: 200, success: true, data: [] } : quota);
  });
  onTestFinished(() => fetch.mockRestore());
  return { requests, fetch };
}

for (const region of regions) {
  test.each([undefined, "", `${region.origin}/request-time-path`])(
    `${region.id} virtual quota uses provider-only auth with resolved base URL %s and no physical sibling`,
    async (baseUrl) => {
      const h = harness(region);
      const provider = h.state.provider;
      assert.ok(h.state.auth);
      h.state.auth.auth.baseUrl = baseUrl;
      const { requests } = mockQuota();
      const before = JSON.stringify(h.model);
      const auth = await resolveUsageAuth(h.ctx, h.adapter);
      assert.ok(auth);
      assert.deepEqual(auth.headers, { Authorization: `Bearer ${providerKey}` });
      assert.equal(auth.effectiveBaseUrl, baseUrl || provider?.baseUrl);
      assert.equal(auth.model.baseUrl, auth.effectiveBaseUrl);
      assert.equal(auth.source, "synthetic provider");
      assert.deepEqual(auth.env, { ACCOUNT: "provider-account" });
      assert.ok(auth.secrets.includes(providerKey));
      assert.ok(!auth.secrets.includes(virtualKey));
      assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
      const report = await queryProviderUsage(h.adapter, auth, new AbortController().signal, 1_000, async () => {});
      assert.equal(report.buckets.find((bucket) => bucket.id === "five-hour")?.remaining, 87);
      assert.deepEqual(requests, [
        { url: `${region.origin}/api/monitor/usage/quota/limit`, authorization: providerKey },
        { url: `${region.origin}/api/biz/subscription/list`, authorization: providerKey },
      ]);
      assert.equal(JSON.stringify(h.model), before);
      assert.equal(h.state.registered, h.model);
      assert.equal(h.state.provider, provider);
    },
  );

  for (const mode of ["tui", "rpc"] as const) {
    test(`${region.id} registered virtual selection reports provider quota in ${mode}, the statusline, and the API`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pi-usage-zai-virtual-"));
      vi.stubEnv("PI_CODING_AGENT_DIR", root);
      t.onTestFinished(async () => {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      });
      // Import after setting the agent directory; settings must not use a real user path.
      const pi = await import("@earendil-works/pi-coding-agent");
      const { default: usage } = await import("../src/usage.js");
      pi.initTheme("dark", false);
      const modelsPath = join(root, "models.json");
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            [region.id]: {
              modelOverrides: { "glm-auto": { headers: { Authorization: `Bearer ${virtualKey}` } } },
            },
          },
        }),
      );
      const runtime = await pi.ModelRuntime.create({
        credentials: {
          read: async (provider) => (provider === region.id ? { type: "api_key", key: providerKey } : undefined),
          list: async () => [{ providerId: region.id, type: "api_key" }],
          modify: async () => {
            throw new Error("A quota query must not modify credentials.");
          },
          delete: async () => undefined,
        },
        modelsPath,
        modelsStorePath: join(root, "models-cache.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const registry = new pi.ModelRegistry(runtime);
      const physical = registry.getAll().find((model) => model.provider === region.id);
      assert.ok(physical);
      const route = vi.fn(() => ({ model: physical, thinkingLevel: "off" as const }));
      const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false }, defaultTools: [] });
      const bus = pi.createEventBus();
      let ctx: ExtensionContext | undefined;
      const loader = new pi.DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        eventBus: bus,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (api) => {
            api.registerVirtualModel({
              provider: region.id,
              id: "glm-auto",
              name: "GLM Auto",
              // Pi ignores an extra JavaScript baseUrl field on a virtual definition.
              ...{ baseUrl: physical.baseUrl },
              route,
            });
            api.on("session_start", (_event, context) => {
              ctx = context;
            });
          },
          usage,
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await pi.createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model: physical,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: pi.SessionManager.inMemory(root),
        tools: [],
      });
      const errors: unknown[] = [];
      const panels: string[] = [];
      const statuses = new Map<string, string | undefined>();
      const { requests } = mockQuota();
      try {
        await session.bindExtensions({
          mode,
          onError: (error) => errors.push(error),
          uiContext: {
            ...session.extensionRunner.getUIContext(),
            select: async (title) => {
              panels.push(title);
              return "Close";
            },
            custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
              const screen = createCustomSelectorHarness(factory, 150, undefined, 40);
              try {
                if (screen.isPiTuiKitScreen) {
                  panels.push(screen.render().map(stripVTControlCharacters).join("\n"));
                  screen.handleInput("\u0003");
                }
                // SAFETY: the harness settles only through this custom factory's done callback.
                return (await screen.resultPromise) as T;
              } finally {
                screen.dispose();
              }
            },
            setStatus: (key, value) => statuses.set(key, value),
          },
        });
        const virtual = registry.find(region.id, "glm-auto");
        assert.ok(virtual);
        assert.equal(virtual.api, "pi-virtual");
        assert.equal(virtual.baseUrl, "");
        const scoped = await registry.getApiKeyAndHeaders(virtual);
        assert.ok(scoped.ok);
        assert.equal(scoped.headers?.Authorization, `Bearer ${virtualKey}`);
        const modelAuth = vi.spyOn(pi.ModelRegistry.prototype, "getApiKeyAndHeaders");
        t.onTestFinished(() => modelAuth.mockRestore());
        await session.setModel(virtual);
        await session.prompt("/usage");
        assert.match(panels.at(-1) ?? "", /87% left/);
        assert.doesNotMatch(panels.at(-1) ?? "", /Authentication unavailable|synthetic-/);
        assert.match(statuses.get("usage") ?? "", /87%.*76%/);
        assert.equal(requests.length, 2);
        assert.ok(requests.every((request) => new URL(request.url).origin === region.origin));
        assert.ok(requests.every((request) => request.authorization === providerKey));
        assert.ok(ctx);
        assert.equal(
          (await queryUsage({ events: bus }, ctx, { providerId: region.id, refresh: true })).status,
          "ready",
        );
        assert.equal(requests.length, 4);
        assert.equal(route.mock.calls.length, 0);
        assert.equal(modelAuth.mock.calls.length, 0);
        assert.equal(session.model, virtual);
        assert.equal(registry.find(region.id, virtual.id), virtual);
        assert.equal(virtual.baseUrl, "");
        await session.setModel(physical);
        await session.prompt("/usage");
        assert.match(panels.at(-1) ?? "", /87% left/);
        assert.deepEqual(errors, []);
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      assert.equal(statuses.get("usage"), undefined);
    });
  }
}

const invalidOrigins = [undefined, "", "broken", "http://api.z.ai", "https://proxy.example.test/v1"];
for (const region of regions) {
  test.each([...invalidOrigins, regions.find((candidate) => candidate.id !== region.id)?.origin])(
    `${region.id} virtual selection refuses unverifiable configured provider origin %s`,
    async (baseUrl) => {
      const h = harness(region);
      h.state.provider = { baseUrl };
      h.registry.getAll = () => [{ ...h.model, id: "physical", api: "openai-completions", baseUrl: region.origin }];
      const { fetch } = mockQuota();
      await assert.rejects(() => resolveUsageAuth(h.ctx, h.adapter), /official|origin/iu);
      assert.equal(fetch.mock.calls.length, 0);
      assert.equal(h.registry.getProviderAuth.mock.calls.length, 0);
      assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
    },
  );

  test.each(["broken", "https://proxy.example.test", regions.find((candidate) => candidate.id !== region.id)?.origin])(
    `${region.id} virtual selection refuses resolved auth origin %s`,
    async (baseUrl) => {
      const h = harness(region);
      assert.ok(h.state.auth);
      h.state.auth.auth.baseUrl = baseUrl;
      const { fetch } = mockQuota();
      await assert.rejects(() => resolveUsageAuth(h.ctx, h.adapter), /proxy-resolved.*official/iu);
      assert.equal(fetch.mock.calls.length, 0);
      assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
    },
  );
}

test.each(["missing provider", "missing credential", "unregistered model", "blank physical model", "other adapter"])(
  "virtual quota does not infer auth for %s",
  async (failure) => {
    const h = harness();
    let adapter: UsageProviderAdapter = h.adapter;
    if (failure === "missing provider") h.state.provider = undefined;
    if (failure === "missing credential") h.state.auth = undefined;
    if (failure === "unregistered model") h.state.registered = undefined;
    if (failure === "blank physical model") h.model.api = "openai-completions";
    if (failure === "other adapter") {
      h.model.provider = "openrouter";
      const other = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
      assert.ok(other);
      adapter = other;
    }
    const { fetch } = mockQuota();
    if (failure === "missing credential") assert.equal(await resolveUsageAuth(h.ctx, adapter), undefined);
    else await assert.rejects(() => resolveUsageAuth(h.ctx, adapter));
    assert.equal(fetch.mock.calls.length, 0);
    assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
  },
);

test("virtual quota never resolves virtual-specific headers, including executable model auth", async () => {
  const h = harness();
  h.registry.getApiKeyAndHeaders.mockImplementation(async () => {
    throw new Error("Virtual-model auth must not execute.");
  });
  const auth = await resolveUsageAuth(h.ctx, h.adapter);
  assert.equal(auth?.apiKey, providerKey);
  assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
});

test("provider auth errors do not fall back to model credentials", async () => {
  const h = harness();
  h.registry.getProviderAuth.mockRejectedValue(new Error("Synthetic provider auth failed."));
  await assert.rejects(() => resolveUsageAuth(h.ctx, h.adapter), /Synthetic provider auth failed/);
  assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
});

test.each([
  "registration removed",
  "registration replaced",
  "selection replaced",
  "provider replaced",
  "provider origin changed",
])("virtual quota stops when %s during provider auth", async (change) => {
  const h = harness();
  const started = deferred<void>();
  const release = deferred<ProviderAuth | undefined>();
  const originalAuth = h.state.auth;
  h.registry.getProviderAuth.mockImplementation(async () => {
    started.resolve();
    return release.promise;
  });
  const pending = resolveUsageAuth(h.ctx, h.adapter);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await started.promise;
  if (change === "registration removed") h.state.registered = undefined;
  if (change === "registration replaced") h.state.registered = { ...h.model };
  if (change === "selection replaced") h.state.selected = { ...h.model };
  if (change === "provider replaced") h.state.provider = { baseUrl: "https://proxy.example.test" };
  if (change === "provider origin changed" && h.state.provider) h.state.provider.baseUrl = "https://proxy.example.test";
  release.resolve(originalAuth);
  await rejected;
  assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
});

test("virtual quota waits for credential readiness and fingerprints the activated provider auth", async () => {
  const h = harness();
  const before = await resolveUsageAuth(h.ctx, h.adapter);
  const waitUntilReady = vi.fn(async () => {
    h.state.auth = { auth: { apiKey: "synthetic-activated-provider-key" } };
    return true;
  });
  const reader: OAuthCredentialCandidateReader = Object.assign(
    () => ({ ok: true as const, candidates: [], offeredCount: 0 }),
    { waitUntilReady },
  );
  const after = await resolveUsageAuth(h.ctx, h.adapter, undefined, undefined, reader);
  assert.equal(waitUntilReady.mock.calls.length, 1);
  assert.notEqual(before?.fingerprint, after?.fingerprint);
  assert.equal(after?.apiKey, "synthetic-activated-provider-key");
  assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
});

test("virtual quota stops before auth when registration is replaced during readiness", async () => {
  const h = harness();
  const reader: OAuthCredentialCandidateReader = Object.assign(
    () => ({ ok: true as const, candidates: [], offeredCount: 0 }),
    {
      waitUntilReady: async () => {
        h.state.registered = { ...h.model };
        return true;
      },
    },
  );
  await assert.rejects(
    () => resolveUsageAuth(h.ctx, h.adapter, undefined, undefined, reader),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(h.registry.getProviderAuth.mock.calls.length, 0);
});

test.each(["not ready", "cancelled", "superseded"] as const)(
  "virtual quota stops at credential readiness when %s",
  async (completion) => {
    const h = harness();
    const controller = new AbortController();
    let current = true;
    const reader: OAuthCredentialCandidateReader = Object.assign(
      () => ({ ok: true as const, candidates: [], offeredCount: 0 }),
      {
        waitUntilReady: async () => {
          if (completion === "cancelled") controller.abort();
          if (completion === "superseded") current = false;
          return completion !== "not ready";
        },
      },
    );
    await assert.rejects(
      () =>
        resolveUsageAuth(h.ctx, h.adapter, undefined, undefined, reader, undefined, {
          signal: controller.signal,
          checkCurrent: () => {
            if (!current) throw Object.assign(new Error("Stale session"), { name: "AbortError" });
          },
        }),
      completion === "not ready" ? /readiness failed closed/ : { name: "AbortError" },
    );
    assert.equal(h.registry.getProviderAuth.mock.calls.length, 0);
    assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
  },
);

test("virtual provider credential rotation stops the plan request and stale report publication", async (t) => {
  const h = harness();
  const { default: usage } = await import("../src/usage.js");
  const mock = createMockPi();
  usage(mock.pi, { credentialReader: () => undefined });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    h.state.auth = { auth: { apiKey: "synthetic-rotated-key" } };
    return Response.json(quota);
  });
  t.onTestFinished(() => fetch.mockRestore());
  try {
    const command = mock.commands.get("usage");
    assert.ok(command);
    await command.handler("", h.ctx);
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(h.panels.length, 0);
    assert.equal(h.statuses.get("usage"), undefined);
  } finally {
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, h.ctx);
  }
});

test("session shutdown cancels pending virtual auth and clears the owned status", async () => {
  const h = harness();
  const { default: usage } = await import("../src/usage.js");
  const mock = createMockPi();
  usage(mock.pi, { credentialReader: () => undefined });
  const { requests } = mockQuota();
  const started = deferred<void>();
  const release = deferred<ProviderAuth | undefined>();
  let pending: Promise<unknown> | undefined;
  const shutdown = async () => {
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, h.ctx);
  };
  try {
    for (const handler of mock.events.get("session_start") ?? []) await handler({}, h.ctx);
    await vi.waitFor(() => assert.match(h.statuses.get("usage") ?? "", /87%/));
    assert.equal(requests.length, 2);
    h.registry.getProviderAuth.mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });
    const command = mock.commands.get("usage");
    assert.ok(command);
    pending = Promise.resolve(command.handler("", h.ctx));
    await started.promise;
    await shutdown();
    await pending;
    assert.equal(h.statuses.get("usage"), undefined);
    const panelCount = h.panels.length;
    release.resolve(h.state.auth);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(requests.length, 2);
    assert.equal(h.panels.length, panelCount);
    assert.equal(h.statuses.get("usage"), undefined);
  } finally {
    release.resolve(h.state.auth);
    await shutdown();
    await pending;
  }
});

test("cancelling virtual quota releases its auth continuation before shared provider auth finishes", async () => {
  const h = harness();
  const started = deferred<void>();
  const release = deferred<ProviderAuth | undefined>();
  const controller = new AbortController();
  h.registry.getProviderAuth.mockImplementation(async () => {
    started.resolve();
    return release.promise;
  });
  const pending = resolveUsageAuth(h.ctx, h.adapter, undefined, undefined, undefined, undefined, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await started.promise;
  controller.abort();
  await rejected;
  release.resolve(h.state.auth);
  assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
});
