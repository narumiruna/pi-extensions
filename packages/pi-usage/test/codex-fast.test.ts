import assert from "node:assert/strict";
import { test } from "vitest";
import {
  codexFastAvailability,
  codexFastRequestTier,
  codexFastStatusLabel,
  correctCodexFastMessageCost,
  rewriteCodexFastPayload,
} from "../src/codex-fast.js";

const supported = { kind: "supported" } as const;
const unsupported = { kind: "unsupported" } as const;
const unknown = { kind: "unknown", reason: "Model capability is unknown." } as const;

const model = (id = "gpt-5.6-sol", overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  ...overrides,
});

const usage = {
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 130,
  cost: { input: 0.00025, output: 0.0003, cacheRead: 0.0000025, cacheWrite: 0, total: 0.0005525 },
};

test("Fast availability follows advertised capabilities instead of model names", () => {
  for (const id of ["gpt-5.6-sol", "future-codex-model", "gpt-5.4-mini"]) {
    assert.deepEqual(codexFastAvailability(model(id) as never, true, supported), { kind: "available", enabled: true });
    assert.equal(codexFastAvailability(model(id) as never, true, unsupported).kind, "unavailable");
    assert.deepEqual(codexFastAvailability(model(id) as never, true, unknown), unknown);
    assert.equal(codexFastAvailability(model(id) as never, true).kind, "unknown");
  }
});

test("advertised Fast still requires the official Codex provider, API, and origin", () => {
  assert.equal(codexFastAvailability(model() as never, false, supported).kind, "available");
  assert.equal(
    codexFastAvailability(model("future-codex-model", { provider: "openai" }) as never, true, supported).kind,
    "not-codex",
  );
  for (const overrides of [{ api: "openai-responses" }, { baseUrl: "https://proxy.example.test" }]) {
    assert.equal(
      codexFastAvailability(model("future-codex-model", overrides) as never, true, supported).kind,
      "unavailable",
    );
  }
});

test("request tiers use priority only for enabled, advertised Fast", () => {
  assert.equal(codexFastRequestTier(model() as never, true, supported), "priority");
  assert.equal(codexFastRequestTier(model() as never, false, supported), "default");
  assert.equal(codexFastRequestTier(model() as never, true, unsupported), "default");
  assert.equal(codexFastRequestTier(model() as never, true, unknown), "default");
  assert.equal(codexFastRequestTier(model() as never, true), "default");
  assert.equal(
    codexFastRequestTier(model("future-codex-model", { provider: "openai" }) as never, true, supported),
    undefined,
  );
});

test("payload rewriting preserves fields and uses default when capability is unknown", () => {
  const payload = { model: "future-codex-model", input: [{ type: "message" }], service_tier: "flex" };
  const current = model(payload.model) as never;
  assert.deepEqual(rewriteCodexFastPayload(payload, current, true, supported), {
    ...payload,
    service_tier: "priority",
  });
  assert.equal(payload.service_tier, "flex");
  for (const capability of [unsupported, unknown]) {
    assert.deepEqual(rewriteCodexFastPayload(payload, current, true, capability), {
      ...payload,
      service_tier: "default",
    });
  }
  assert.deepEqual(rewriteCodexFastPayload(payload, current, false, supported), {
    ...payload,
    service_tier: "default",
  });
  assert.equal(
    rewriteCodexFastPayload(payload, model(payload.model, { provider: "openai" }) as never, true, supported),
    undefined,
  );
  assert.equal(rewriteCodexFastPayload([], current, true, supported), undefined);
});

test("captured priority capability preserves existing cost correction without double charging", () => {
  const message = { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage };
  const corrected = correctCodexFastMessageCost(message, model() as never, true, supported) as { usage: typeof usage };
  assert.ok(Math.abs(corrected.usage.cost.total - 0.001105) < 1e-12);
  assert.equal(message.usage.cost.total, usage.cost.total);
  assert.equal(correctCodexFastMessageCost(corrected, model() as never, true, supported), undefined);

  const gpt55 = model("gpt-5.5", { cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } });
  const gpt55Usage = {
    ...usage,
    cost: { input: 0.0005, output: 0.0006, cacheRead: 0.000005, cacheWrite: 0, total: 0.001105 },
  };
  const corrected55 = correctCodexFastMessageCost(
    { role: "assistant", provider: "openai-codex", model: "gpt-5.5", usage: gpt55Usage },
    gpt55 as never,
    true,
    supported,
  ) as { usage: typeof gpt55Usage };
  assert.ok(Math.abs(corrected55.usage.cost.total - 0.0027625) < 1e-12);

  for (const id of ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]) {
    const current = model(id, { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 } });
    const gpt6Usage = {
      ...usage,
      cost: { input: 0.0002, output: 0.0002, cacheRead: 0.000002, cacheWrite: 0, total: 0.000402 },
    };
    const corrected6 = correctCodexFastMessageCost(
      { role: "assistant", provider: "openai-codex", model: id, usage: gpt6Usage },
      current as never,
      true,
      supported,
    ) as { usage: typeof gpt6Usage };
    assert.ok(Math.abs(corrected6.usage.cost.total - 0.000804) < 1e-12);
  }
});

test("cost correction and labels stay scoped to effective Fast", () => {
  const message = { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage };
  assert.equal(correctCodexFastMessageCost(message, model() as never, false, supported), undefined);
  for (const capability of [unsupported, unknown]) {
    assert.equal(correctCodexFastMessageCost(message, model() as never, true, capability), undefined);
  }
  assert.equal(
    correctCodexFastMessageCost({ ...message, model: "other" }, model() as never, true, supported),
    undefined,
  );
  assert.equal(codexFastStatusLabel("codex 80% 5h", true), "codex fast 80% 5h");
  assert.equal(codexFastStatusLabel("codex credits available", false), "codex credits available");
  assert.equal(codexFastStatusLabel("openrouter $10 left", true), "openrouter $10 left");
  assert.equal(codexFastStatusLabel("codexical provider", true), "codexical provider");
});
