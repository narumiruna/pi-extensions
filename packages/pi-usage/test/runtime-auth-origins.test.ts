import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { resolveUsageAuth, SUPPORTED_ADAPTERS } from "../src/index.js";

// Explicit fixtures must not inherit the production origin allowlist.
const cases = [
  {
    model: {
      id: "zai-org/GLM-5.2",
      name: "GLM-5.2",
      provider: "baseten",
      baseUrl: "https://inference.baseten.co/v1",
    },
    proxyModelUrl: "https://proxy.example.test/v1",
  },
  {
    model: {
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      provider: "vercel-ai-gateway",
      baseUrl: "https://ai-gateway.vercel.sh",
    },
    proxyModelUrl: "https://proxy.example.test/v1",
  },
  {
    model: {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
    },
    proxyModelUrl: "https://proxy.example.test/v1",
  },
  {
    model: {
      id: "accounts/fireworks/models/kimi-k2p6",
      name: "Kimi K2.6",
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference",
    },
    proxyModelUrl: "https://proxy.example.test/inference",
  },
  {
    model: {
      id: "codestral-2508",
      name: "Codestral 25.08",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai",
    },
    proxyModelUrl: "https://proxy.example.test/v1",
  },
] as const;

for (const { model: officialModel, proxyModelUrl } of cases) {
  test(`${officialModel.provider} rejects custom model and resolved-auth origins before fetching`, async () => {
    const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === officialModel.provider);
    assert.ok(adapter);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      for (const [modelBaseUrl, authBaseUrl, pattern] of [
        [proxyModelUrl, undefined, /custom.*official/iu],
        [officialModel.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
      ] as const) {
        const model = { ...officialModel, baseUrl: modelBaseUrl };
        const { ctx } = createMockContext({
          model,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
            getProviderAuth: async () => ({
              auth: {
                apiKey: "must-not-send",
                ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
              },
            }),
            getAvailable: () => [model],
            getAll: () => [model],
          },
        });
        await assert.rejects(() => resolveUsageAuth(ctx, adapter), pattern);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    } finally {
      fetchMock.mockRestore();
    }
  });
}
