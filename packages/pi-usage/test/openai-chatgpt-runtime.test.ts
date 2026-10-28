import assert from "node:assert/strict";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { codexFastAvailability, correctCodexFastMessageCost, rewriteCodexFastPayload } from "../src/codex-fast.js";
import { resolveCodexResetAuth } from "../src/codex-resets.js";
import { OAUTH_CREDENTIAL_READINESS_CHANNEL } from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER, UnsupportedOpenAIUsageAuthError } from "../src/providers/openai-chatgpt.js";
import { resolveUsageAuth } from "../src/query.js";
import usageExtension from "../src/usage.js";

initTheme("dark", false);

const credential: Credential = {
  type: "oauth",
  access: "synthetic-chatgpt-access",
  refresh: "synthetic-chatgpt-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "synthetic-native-client",
  scopes: ["chatgpt.tokens.use.direct"],
};

async function createRegistry(stored: Credential | null = credential) {
  const store: CredentialStore = {
    read: async (provider) => (provider === "openai" ? (stored ?? undefined) : undefined),
    list: async () => (stored ? [{ providerId: "openai", type: stored.type }] : []),
    modify: async () => {
      throw new Error("A fresh synthetic credential must not be refreshed.");
    },
    delete: async () => undefined,
  };
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });
  return { runtime, registry: new ModelRegistry(runtime) };
}

async function emit(mock: ReturnType<typeof createMockPi>, event: string, ctx: unknown) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
}

function runCommand(mock: ReturnType<typeof createMockPi>, name: "usage" | "fast", ctx: unknown) {
  const command = mock.commands.get(name);
  assert.ok(command);
  return command.handler("", ctx);
}

for (const mode of ["tui", "rpc"] as const) {
  test(`native ChatGPT OAuth shows plan status and usage settings in ${mode} without backend requests`, async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Native plan status must not query an unverified endpoint.");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { registry } = await createRegistry();
      const model = registry.find("openai", "gpt-6.1-sol");
      assert.ok(model);
      assert.equal((await registry.getProviderAuth("openai"))?.source, "OAuth");
      const mock = createMockPi();
      usageExtension(mock.pi, { credentialReader: () => credential });
      const menus: Array<{ title: string; options: string[] }> = [];
      const context = createMockContext({
        mode,
        model,
        modelRegistry: registry,
        ...(mode === "rpc"
          ? {
              select: async (title: string, options: string[]) => {
                menus.push({ title, options });
                return "Close";
              },
            }
          : {
              custom: async (factory: unknown) => {
                const harness = createCustomSelectorHarness(factory, 240, undefined, 40);
                try {
                  if (harness.isPiTuiKitScreen) {
                    const lines = harness.render();
                    menus.push({ title: lines.join("\n"), options: lines });
                    harness.handleInput("\u0003");
                  }
                  return await harness.resultPromise;
                } finally {
                  harness.dispose();
                }
              },
            }),
      });
      try {
        await runCommand(mock, "usage", context.ctx);
        assert.match(menus[0]?.title ?? "", /ChatGPT plan authentication/);
        assert.match(menus[0]?.title ?? "", /Codex companion usage is disabled/);
        assert.match(menus[0]?.title ?? "", /https:\/\/chatgpt\.com\/settings\/usage/);
        assert.doesNotMatch(menus[0]?.title ?? "", /Unsupported|[0-9]+%|synthetic-/);
        assert.equal(context.statuses.get("usage"), "chatgpt usage: web only");
        assert.ok(!menus[0]?.options.some((option) => /Turn Fast mode|Redeem usage limit reset/.test(option)));
        assert.equal(fetch.mock.calls.length, 0);
      } finally {
        await emit(mock, "session_shutdown", context.ctx);
      }
      assert.equal(context.statuses.get("usage"), undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}

test("real Pi without OpenAI credentials reports authentication unavailable rather than API-key unsupported", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const mock = createMockPi();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  let context: ReturnType<typeof createMockContext> | undefined;
  try {
    const { registry } = await createRegistry(null);
    const model = registry.find("openai", "gpt-6.1-sol");
    assert.ok(model);
    assert.equal(await registry.getProviderAuth("openai"), undefined);
    const resolved = await registry.getApiKeyAndHeaders(model);
    assert.ok(resolved.ok);
    assert.equal(resolved.apiKey, undefined);
    assert.equal(resolved.headers, undefined);
    usageExtension(mock.pi, { credentialReader: () => undefined });
    let title = "";
    context = createMockContext({
      mode: "rpc",
      model,
      modelRegistry: registry,
      select: async (value: string) => {
        title = value;
        return "Close";
      },
    });
    await runCommand(mock, "usage", context.ctx);
    assert.match(title, /Authentication unavailable: No runtime credential is configured for OpenAI/);
    assert.doesNotMatch(title, /API-key|Unsupported/);
    assert.equal(context.statuses.get("usage"), "auth unavailable");
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    if (context) await emit(mock, "session_shutdown", context.ctx);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

test("real Pi runtime API-key overrides never reuse stored native OAuth as plan authentication", async () => {
  const { runtime, registry } = await createRegistry();
  const model = registry.find("openai", "gpt-6.1-sol");
  assert.ok(model);
  const context = createMockContext({ model, modelRegistry: registry });
  assert.ok(await resolveUsageAuth(context.ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential));
  await runtime.setRuntimeApiKey("openai", "synthetic-runtime-api-key");
  assert.equal((await registry.getProviderAuth("openai"))?.source, "stored credential");
  await assert.rejects(
    () => resolveUsageAuth(context.ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential),
    UnsupportedOpenAIUsageAuthError,
  );
  await runtime.removeRuntimeApiKey("openai");
  assert.ok(await resolveUsageAuth(context.ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential));
});

test("real Pi configured model headers override native OAuth and cannot imply plan authentication", async () => {
  const { runtime, registry } = await createRegistry();
  const original = registry.find("openai", "gpt-6.1-sol");
  assert.ok(original);
  for (const authorization of ["Bearer synthetic-model-api-key", "", `Bearer ${credential.access}`]) {
    runtime.registerProvider("openai", {
      models: [{ ...original, headers: { authorization } }],
    });
    const model = registry.find("openai", original.id);
    assert.ok(model);
    const context = createMockContext({ model, modelRegistry: registry });
    assert.equal((await registry.getProviderAuth("openai"))?.source, "OAuth");
    const resolved = await registry.getApiKeyAndHeaders(model);
    assert.ok(resolved.ok);
    assert.equal(resolved.headers?.authorization, authorization);
    const resolving = resolveUsageAuth(context.ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => credential);
    if (authorization === `Bearer ${credential.access}`) assert.ok(await resolving);
    else await assert.rejects(() => resolving, /authorization.*match/);
  }
});

test("native /fast, provider payloads, pricing, and reset auth stay outside legacy Codex features", async () => {
  const { registry } = await createRegistry();
  const model = registry.find("openai", "gpt-6.1-sol");
  assert.ok(model);
  const mock = createMockPi();
  usageExtension(mock.pi, { credentialReader: () => credential });
  const context = createMockContext({ mode: "rpc", model, modelRegistry: registry });
  try {
    await runCommand(mock, "fast", context.ctx);
    assert.match(context.notifications[0]?.message ?? "", /only.*OpenAI Codex/);
    assert.deepEqual(codexFastAvailability(model, true), { kind: "not-codex" });
    const payload = { service_tier: "priority", input: "unchanged" };
    assert.equal(rewriteCodexFastPayload(payload, model, true), undefined);
    for (const handler of mock.events.get("before_provider_request") ?? []) {
      assert.equal(await handler({ payload }, context.ctx), undefined);
    }
    assert.deepEqual(payload, { service_tier: "priority", input: "unchanged" });
    assert.equal(
      correctCodexFastMessageCost({ role: "assistant", provider: model.provider, model: model.id }, model, true),
      undefined,
    );
    await assert.rejects(() => resolveCodexResetAuth(context.ctx), /current model.*OpenAI Codex/);
    assert.deepEqual(mock.sentMessages, []);
    assert.deepEqual(mock.sentUserMessages, []);
    assert.deepEqual(mock.entries, []);
    assert.deepEqual(mock.tools, []);
    assert.deepEqual(mock.providerRegistrations, []);
  } finally {
    await emit(mock, "session_shutdown", context.ctx);
  }
});

test("an API-key to native OAuth transition is revalidated before publishing the initial unsupported result", async () => {
  const mock = createMockPi();
  usageExtension(mock.pi, { credentialReader: () => credential });
  let reads = 0;
  let title = "";
  const model = { id: "gpt-6.1-sol", provider: "openai", name: "GPT-6.1 Sol", baseUrl: "https://api.openai.com/v1" };
  const context = createMockContext({
    mode: "rpc",
    model,
    select: async (value: string) => {
      title = value;
      return "Close";
    },
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: credential.access }),
      getProviderAuth: async () => ({
        source: ++reads === 1 ? "stored credential" : "OAuth",
        auth: { apiKey: credential.access },
      }),
    },
  });
  try {
    await runCommand(mock, "usage", context.ctx);
    assert.match(title, /Connected \(native OAuth\)/);
    assert.doesNotMatch(title, /Unsupported/);
    assert.equal(context.statuses.get("usage"), "chatgpt usage: web only");
  } finally {
    await emit(mock, "session_shutdown", context.ctx);
  }
});

test("native auth status refreshes locally, drops stale account status, and releases timers at shutdown", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const mock = createMockPi();
  let activeCredential = credential;
  const { runtime, registry } = await createRegistry();
  const model = registry.find("openai", "gpt-6.1-sol");
  assert.ok(model);
  usageExtension(mock.pi, { credentialReader: () => activeCredential });
  const context = createMockContext({ mode: "rpc", model, modelRegistry: registry, select: async () => "Close" });
  try {
    await emit(mock, "session_start", context.ctx);
    await vi.waitFor(() => assert.equal(context.statuses.get("usage"), "chatgpt usage: web only"));
    vi.useFakeTimers();
    await runCommand(mock, "usage", context.ctx);
    assert.equal(vi.getTimerCount(), 1); // Local five-minute auth refresh, no reset countdown.
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(context.statuses.get("usage"), "chatgpt usage: web only");
    activeCredential = { ...credential, access: "synthetic-different-account" };
    await emit(mock, "turn_start", context.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(context.statuses.get("usage"), "auth unavailable");
    activeCredential = credential;
    await runtime.setRuntimeApiKey("openai", "synthetic-runtime-api-key");
    await emit(mock, "turn_start", context.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(context.statuses.get("usage"), undefined);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    await emit(mock, "session_shutdown", context.ctx);
    assert.equal(vi.getTimerCount(), 0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("hard-cancelling the native readiness loader releases its UI without publishing a late report", async () => {
  const mock = createMockPi();
  const { registry } = await createRegistry();
  const model = registry.find("openai", "gpt-6.1-sol");
  assert.ok(model);
  usageExtension(mock.pi, { credentialReader: () => credential });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.eventBus.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
    (data as { waitUntil(value: Promise<unknown>): void }).waitUntil(pending);
  });
  let loaderCount = 0;
  let menuCount = 0;
  const context = createMockContext({
    mode: "tui",
    model,
    modelRegistry: registry,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 100);
      try {
        if (harness.isPiTuiKitScreen) menuCount += 1;
        else loaderCount += 1;
        harness.handleInput("\u0003");
        return await harness.resultPromise;
      } finally {
        harness.dispose();
      }
    },
  });
  try {
    await runCommand(mock, "usage", context.ctx);
    release();
    await Promise.resolve();
    assert.equal(loaderCount, 1);
    assert.equal(menuCount, 0);
    assert.notEqual(context.statuses.get("usage"), "chatgpt usage: web only");
  } finally {
    release();
    await emit(mock, "session_shutdown", context.ctx);
  }
});

for (const boundary of ["session_shutdown", "session_start", "model_select"] as const) {
  test(`pending native credential readiness cannot publish after ${boundary}`, async () => {
    const mock = createMockPi();
    const { registry } = await createRegistry();
    const model = registry.find("openai", "gpt-6.1-sol");
    assert.ok(model);
    usageExtension(mock.pi, { credentialReader: () => credential });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    mock.eventBus.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
      const request = data as { provider: string; waitUntil(value: Promise<unknown>): void };
      if (request.provider === "openai") {
        request.waitUntil(pending);
        ready();
      }
    });
    const select = vi.fn(async () => "Close");
    const context = createMockContext({ mode: "rpc", model, modelRegistry: registry, select });
    const querying = runCommand(mock, "usage", context.ctx);
    try {
      await entered;
      const replacementModel = { ...model, provider: "unsupported" };
      const replacement = createMockContext({ mode: "rpc", model: replacementModel });
      if (boundary === "model_select") {
        Object.assign(context.ctx, { model: replacementModel });
        for (const handler of mock.events.get("model_select") ?? [])
          await handler({ model: replacementModel }, context.ctx);
      } else {
        await emit(mock, boundary, boundary === "session_start" ? replacement.ctx : context.ctx);
      }
      release();
      await querying;
      assert.equal(select.mock.calls.length, 0);
      assert.notEqual(context.statuses.get("usage"), "chatgpt usage: web only");
    } finally {
      release();
      await querying;
      await emit(mock, "session_shutdown", context.ctx);
    }
  });
}
