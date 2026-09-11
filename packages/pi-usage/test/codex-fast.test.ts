import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CODEX_FAST_MODEL_IDS,
  codexFastAvailability,
  codexFastRequestTier,
  codexFastStatusLabel,
  correctCodexFastMessageCost,
  rewriteCodexFastPayload,
} from "../src/codex-fast.js";

const model = (id = "gpt-5.4", overrides: Record<string, unknown> = {}) => ({
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

test("the supported model set matches the inspected Codex catalog", () => {
  assert.deepEqual([...CODEX_FAST_MODEL_IDS].sort(), [
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);
  for (const id of CODEX_FAST_MODEL_IDS) {
    assert.deepEqual(codexFastAvailability(model(id) as never, true), {
      kind: "available",
      enabled: true,
    });
  }
  for (const id of ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.2"]) {
    assert.equal(codexFastAvailability(model(id) as never, true).kind, "unavailable");
  }
});

test("eligibility requires the official Codex provider, API, and origin", () => {
  assert.equal(codexFastAvailability(model() as never, false).kind, "available");
  assert.equal(codexFastAvailability(model("gpt-5.4", { provider: "openai" }) as never, true).kind, "not-codex");
  assert.equal(codexFastAvailability(model("gpt-5.4", { api: "openai-responses" }) as never, true).kind, "unavailable");
  assert.equal(
    codexFastAvailability(model("gpt-5.4", { baseUrl: "https://proxy.example.test" }) as never, true).kind,
    "unavailable",
  );
});

test("request tiers use priority for supported Fast and explicit default otherwise", () => {
  assert.equal(codexFastRequestTier(model() as never, true), "priority");
  assert.equal(codexFastRequestTier(model() as never, false), "default");
  assert.equal(codexFastRequestTier(model("gpt-5.4-mini") as never, true), "default");
  assert.equal(codexFastRequestTier(model("gpt-5.4", { provider: "openai" }) as never, true), undefined);
});

test("payload rewriting is immutable, preserves fields, and ignores foreign payloads", () => {
  const payload = { model: "gpt-5.4", input: [{ type: "message" }], service_tier: "flex" };
  const rewritten = rewriteCodexFastPayload(payload, model() as never, true);
  assert.deepEqual(rewritten, { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, "flex");
  assert.deepEqual(rewriteCodexFastPayload(payload, model() as never, false), {
    ...payload,
    service_tier: "default",
  });
  assert.equal(rewriteCodexFastPayload(payload, model("gpt-5.4", { provider: "openai" }) as never, true), undefined);
  assert.equal(rewriteCodexFastPayload([], model() as never, true), undefined);
});

test("priority cost correction repairs Pi's default-tier echo fallback without double charging", () => {
  const message = { role: "assistant", provider: "openai-codex", model: "gpt-5.4", usage };
  const corrected = correctCodexFastMessageCost(message, model() as never, true) as {
    usage: typeof usage;
  };
  assert.equal(corrected.usage.cost.total, usage.cost.total * 2);
  assert.equal(message.usage.cost.total, usage.cost.total);
  assert.equal(
    correctCodexFastMessageCost(corrected, model() as never, true),
    undefined,
    "already-corrected cost remains unchanged",
  );

  const gpt55 = model("gpt-5.5", {
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  });
  const gpt55Usage = {
    ...usage,
    cost: { input: 0.0005, output: 0.0006, cacheRead: 0.000005, cacheWrite: 0, total: 0.001105 },
  };
  const corrected55 = correctCodexFastMessageCost(
    { role: "assistant", provider: "openai-codex", model: "gpt-5.5", usage: gpt55Usage },
    gpt55 as never,
    true,
  ) as { usage: typeof gpt55Usage };
  assert.equal(corrected55.usage.cost.total, gpt55Usage.cost.total * 2.5);
});

test("cost correction and status labels stay scoped to effective Fast", () => {
  assert.equal(
    correctCodexFastMessageCost(
      { role: "assistant", provider: "openai-codex", model: "gpt-5.4", usage },
      model() as never,
      false,
    ),
    undefined,
  );
  assert.equal(
    correctCodexFastMessageCost(
      {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        usage,
      },
      model("gpt-5.4-mini") as never,
      true,
    ),
    undefined,
  );
  assert.equal(
    correctCodexFastMessageCost(
      { role: "assistant", provider: "openai-codex", model: "other", usage },
      model() as never,
      true,
    ),
    undefined,
  );
  assert.equal(codexFastStatusLabel("codex 80% 5h", true), "codex fast 80% 5h");
  assert.equal(codexFastStatusLabel("codex credits available", false), "codex credits available");
  assert.equal(codexFastStatusLabel("openrouter $10 left", true), "openrouter $10 left");
  assert.equal(codexFastStatusLabel("codexical provider", true), "codexical provider");
});
