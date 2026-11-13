import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { codexAllowanceBinding, normalizeCodexBackendPayload } from "../src/providers/codex.js";
import { queryOpenAICompanionUsage } from "../src/providers/openai-companion-usage.js";
import { adapterForProvider, queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import type { CodexBackendPayload, ResolvedUsageAuth, UsageReport } from "../src/types.js";
import { copyUsageReportForApi, registerUsageApi } from "../src/usage-api.js";
import type { UsageQueryResultV1 } from "../src/usage-api-types.js";
import { queryUsage } from "./fixtures/usage-client.js";

const NOW = 1_800_000_000_000;
const MODEL = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
};
function token(accountId: unknown = "synthetic-account") {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;
}
function auth(): ResolvedUsageAuth {
  const apiKey = token();
  return {
    apiKey,
    headers: { Authorization: `Bearer ${apiKey}` },
    fingerprint: "private",
    secrets: [apiKey],
    model: { ...MODEL } as ResolvedUsageAuth["model"],
  };
}
function window(used = 97) {
  return { used_percent: used, limit_window_seconds: 18_000, reset_at: NOW / 1_000 + 3_600 };
}
function payload(): CodexBackendPayload {
  return {
    rate_limit: { allowed: true, limit_reached: false, primary_window: window(), secondary_window: window(20) },
    additional_rate_limits: [],
    credits: { has_credits: true, balance: 500 },
  };
}
function report() {
  const result = normalizeCodexBackendPayload(payload(), NOW, MODEL.id);
  assert.ok(result.allowance);
  return { ...result, allowance: result.allowance };
}
function expectDisplayPreserved(input: CodexBackendPayload, result: UsageReport) {
  const display = normalizeCodexBackendPayload(input, NOW);
  const { allowance, ...withoutEvidence } = result;
  expect(withoutEvidence).toEqual(display);
  expect(display).not.toHaveProperty("allowance");
  expect(copyUsageReportForApi(result)).toEqual({ ...copyUsageReportForApi(display), allowance });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex ordinary included allowance", () => {
  it("proves exact base windows independently of paid credits and keeps display keys unchanged", () => {
    const result = report();
    expect(result.allowance).toEqual({
      kind: "included",
      scope: { kind: "models", modelIds: [MODEL.id] },
      coverage: "complete",
      bucketIds: ["codex:primary", "codex:secondary"],
      authBinding: "runtime",
    });
    expect(result.buckets[0]).toMatchObject({ used: 97, remaining: 3, modelKeys: ["codex", "Codex"] });
    expect(result.metrics).toContainEqual({ id: "credits", label: "Credits", value: 500, unit: "count" });
  });

  describe.each([
    { allowed: true, limit_reached: false, healthy: "complete", exhausted: "partial" },
    { allowed: false, limit_reached: true, healthy: "partial", exhausted: "complete" },
    { allowed: true, limit_reached: true, healthy: "partial", exhausted: "partial" },
    { allowed: false, limit_reached: false, healthy: "partial", exhausted: "partial" },
  ])("allowed=$allowed, limit_reached=$limit_reached", ({ allowed, limit_reached, healthy, exhausted }) => {
    it.each([
      { name: "unused", primary: 0, secondary: null, coverage: healthy },
      { name: "healthy", primary: 20, secondary: null, coverage: healthy },
      { name: "low", primary: 97, secondary: null, coverage: healthy },
      { name: "nearly exhausted", primary: 99.9, secondary: null, coverage: healthy },
      { name: "exhausted", primary: 100, secondary: null, coverage: exhausted },
      { name: "secondary only", primary: null, secondary: 20, coverage: healthy },
      { name: "healthy multiwindow", primary: 20, secondary: 10, coverage: healthy },
      { name: "low multiwindow", primary: 20, secondary: 97, coverage: healthy },
      { name: "exhausted primary", primary: 100, secondary: 20, coverage: exhausted },
      { name: "exhausted secondary", primary: 20, secondary: 100, coverage: exhausted },
      { name: "both exhausted", primary: 100, secondary: 100, coverage: exhausted },
    ])("keeps $name measurements with $coverage coverage", ({ primary, secondary, coverage }) => {
      const input = {
        rate_limit: {
          allowed,
          limit_reached,
          primary_window: primary === null ? null : window(primary),
          secondary_window: secondary === null ? null : window(secondary),
        },
      };
      const result = normalizeCodexBackendPayload(input, NOW, MODEL.id);
      expect(result.allowance).toMatchObject({
        coverage,
        bucketIds: [primary === null ? [] : ["codex:primary"], secondary === null ? [] : ["codex:secondary"]].flat(),
      });
      expect(result.buckets.map(({ used, remaining }) => ({ used, remaining }))).toEqual(
        [primary, secondary].filter((used) => used !== null).map((used) => ({ used, remaining: 100 - used })),
      );
      expectDisplayPreserved(input, result);
    });

    it.each([
      { name: "missing secondary", constraints: {} },
      {
        name: "expired exhausted secondary",
        constraints: { secondary_window: { ...window(100), reset_at: NOW / 1_000 } },
      },
      {
        name: "malformed exhausted secondary",
        constraints: { secondary_window: { ...window(100), used_percent: "100" } },
      },
      { name: "unknown constraint", constraints: { secondary_window: null, third_window: {} } },
      { name: "additional constraint", constraints: { secondary_window: null }, additional: [{}] },
      { name: "malformed additional constraint", constraints: { secondary_window: null }, additional: {} },
    ])("does not repair $name coverage with flags", ({ constraints, additional }) => {
      const input = {
        rate_limit: { allowed, limit_reached, primary_window: window(97), ...constraints },
        additional_rate_limits: additional,
      };
      const result = normalizeCodexBackendPayload(input, NOW, MODEL.id);
      expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:primary"] });
      expect(result.buckets[0]).toMatchObject({ used: 97, remaining: 3 });
      expectDisplayPreserved(input, result);
    });
  });

  describe.each(["allowed", "limit_reached"] as const)("required %s boolean", (flag) => {
    it.each([undefined, null, "true", "false", 0, 1, {}, []])("does not coerce %j into complete coverage", (value) => {
      for (const used of [20, 97, 100]) {
        const input = {
          rate_limit: {
            allowed: used !== 100,
            limit_reached: used === 100,
            [flag]: value,
            primary_window: window(used),
            secondary_window: null,
          },
        };
        const result = normalizeCodexBackendPayload(input, NOW, MODEL.id);
        expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:primary"] });
        expect(result.buckets[0]).toMatchObject({ used, remaining: 100 - used });
        expectDisplayPreserved(input, result);
      }
    });
  });

  it.each([{}, { allowed: true }, { allowed: false }, { limit_reached: false }, { limit_reached: true }])(
    "does not treat omitted flags as permission: %j",
    (flags) => {
      for (const used of [20, 97, 100]) {
        const input = { rate_limit: { ...flags, primary_window: window(used), secondary_window: null } };
        const result = normalizeCodexBackendPayload(input, NOW, MODEL.id);
        expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:primary"] });
        expectDisplayPreserved(input, result);
      }
    },
  );

  it.each([undefined, "gpt-reserve", "gpt-5.6-luna", "gpt-6.1-sol", "namespace/gpt-5.6-sol", "GPT-5.6 Sol"])(
    "does not invent exact applicability for %s",
    (modelId) => {
      expect(normalizeCodexBackendPayload(payload(), NOW, modelId)).not.toHaveProperty("allowance");
    },
  );

  it.each([undefined, null, []])("accepts absent additional constraints: %j", (additional) => {
    expect(
      normalizeCodexBackendPayload({ ...payload(), additional_rate_limits: additional }, NOW, MODEL.id).allowance
        ?.coverage,
    ).toBe("complete");
  });

  it.each([
    [{ metered_feature: MODEL.id, limit_name: MODEL.name, rate_limit: { primary_window: window(100) } }],
    [{ metered_feature: "opaque", limit_name: "Sol", rate_limit: { primary_window: window(0) } }],
    [{}],
    {},
    "unknown",
  ])("never infers additional constraint scope from model-like labels: %j", (additional) => {
    const result = normalizeCodexBackendPayload({ ...payload(), additional_rate_limits: additional }, NOW, MODEL.id);
    expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:primary", "codex:secondary"] });
  });

  it("distinguishes an explicit absent window from incomplete coverage", () => {
    const explicit = normalizeCodexBackendPayload(
      { rate_limit: { allowed: true, limit_reached: false, primary_window: window(), secondary_window: null } },
      NOW,
      MODEL.id,
    );
    expect(explicit.allowance).toMatchObject({ coverage: "complete", bucketIds: ["codex:primary"] });
    const missing = normalizeCodexBackendPayload(
      { rate_limit: { allowed: true, limit_reached: false, primary_window: window() } },
      NOW,
      MODEL.id,
    );
    expect(missing.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:primary"] });
    const future = normalizeCodexBackendPayload(
      {
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: window(),
          secondary_window: null,
          third_window: {},
        },
      },
      NOW,
      MODEL.id,
    );
    expect(future.allowance?.coverage).toBe("partial");
  });

  it.each([
    { used_percent: "97" },
    { used_percent: -1 },
    { used_percent: 101 },
    { used_percent: NaN },
    { used_percent: Infinity },
    { used_percent: undefined },
    { remaining_percent: 50 },
    { limit_window_seconds: 0 },
    { limit_window_seconds: "18000" },
    { limit_window_seconds: 0.5 },
    { reset_at: NOW / 1_000 },
    { reset_at: "1800003600" },
    { reset_at: Infinity },
    { reset_at: undefined },
  ])("keeps malformed/expired windows display-only: %j", (changes) => {
    const result = normalizeCodexBackendPayload(
      {
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { ...window(), ...changes },
          secondary_window: window(10),
        },
      },
      NOW,
      MODEL.id,
    );
    expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:secondary"] });
  });

  it("does not reference root IDs duplicated by unproven additional features", () => {
    const result = normalizeCodexBackendPayload(
      {
        ...payload(),
        additional_rate_limits: [{ metered_feature: "codex", rate_limit: { primary_window: window(100) } }],
      },
      NOW,
      MODEL.id,
    );
    expect(result.buckets.filter((bucket) => bucket.id === "codex:primary")).toHaveLength(2);
    expect(result.allowance).toMatchObject({ coverage: "partial", bucketIds: ["codex:secondary"] });
    expect(() => copyUsageReportForApi(result)).not.toThrow();
  });

  it.each([
    undefined,
    null,
    {},
    { primary_window: null, secondary_window: null },
    ...[true, false].flatMap((allowed) =>
      [true, false].map((limit_reached) => ({
        allowed,
        limit_reached,
        primary_window: null,
        secondary_window: null,
      })),
    ),
    {
      allowed: false,
      limit_reached: true,
      primary_window: { ...window(), used_percent: "100" },
      secondary_window: null,
    },
  ])("does not promote credits or flags without valid numeric windows: %j", (rate_limit) => {
    const input = { ...payload(), rate_limit };
    const result = normalizeCodexBackendPayload(input, NOW, MODEL.id);
    expect(result).not.toHaveProperty("allowance");
    expect(result).toEqual(normalizeCodexBackendPayload(input, NOW));
    expect(copyUsageReportForApi(result)).not.toHaveProperty("allowance");
  });
});

describe("runtime authentication binding", () => {
  it("binds only the exact official API/model token path", () => {
    expect(codexAllowanceBinding(auth())).toEqual({ modelId: MODEL.id, accountId: "synthetic-account" });
    const current = auth();
    current.headers["ChatGPT-Account-Id"] = "synthetic-account";
    expect(codexAllowanceBinding(current)?.modelId).toBe(MODEL.id);
  });

  it.each([
    (value: ResolvedUsageAuth) => {
      value.model.id = "gpt-reserve";
    },
    (value: ResolvedUsageAuth) => {
      value.model.id = "gpt-6.1-sol";
    },
    (value: ResolvedUsageAuth) => {
      value.model.provider = "openai";
    },
    (value: ResolvedUsageAuth) => {
      value.model.api = "openai-responses";
    },
    (value: ResolvedUsageAuth) => {
      value.model.baseUrl = "https://proxy.example/backend-api";
    },
    (value: ResolvedUsageAuth) => {
      value.effectiveBaseUrl = "https://proxy.example/backend-api";
    },
    (value: ResolvedUsageAuth) => {
      value.apiKey = undefined;
    },
    (value: ResolvedUsageAuth) => {
      value.apiKey = "not-an-oauth-jwt";
      value.headers.Authorization = "Bearer not-an-oauth-jwt";
    },
    (value: ResolvedUsageAuth) => {
      value.apiKey = token(null);
      value.headers.Authorization = `Bearer ${value.apiKey}`;
    },
    (value: ResolvedUsageAuth) => {
      value.apiKey = token("bad\r\naccount");
      value.headers.Authorization = `Bearer ${value.apiKey}`;
    },
    (value: ResolvedUsageAuth) => {
      value.headers.Authorization = `Bearer ${token("different-account")}`;
    },
    (value: ResolvedUsageAuth) => {
      delete value.headers.Authorization;
    },
    (value: ResolvedUsageAuth) => {
      value.headers.authorization = value.headers.Authorization as string;
    },
    (value: ResolvedUsageAuth) => {
      value.headers["chatgpt-account-id"] = "different-account";
    },
    (value: ResolvedUsageAuth) => {
      value.headers["chatgpt-account-id"] = "synthetic-account";
      value.headers["ChatGPT-Account-Id"] = "synthetic-account";
    },
  ])("keeps unproven auth/model paths display-only (%#)", (change) => {
    const value = auth();
    change(value);
    expect(codexAllowanceBinding(value)).toBeUndefined();
  });

  it("adds only the same runtime-derived account header to the existing official GET", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload())));
    const adapter = adapterForProvider("openai-codex");
    assert.ok(adapter);
    const model = { ...MODEL };
    const apiKey = token();
    const { ctx } = createMockContext({
      model,
      modelRegistry: {
        getAll: () => [model],
        getAvailable: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
        getProviderAuth: async () => ({ source: "runtime", auth: { apiKey } }),
      },
    });
    const resolved = await resolveUsageAuth(ctx, adapter);
    assert.ok(resolved);
    const result = await queryProviderUsage(adapter, resolved, new AbortController().signal, 5_000);
    expect(result.allowance?.authBinding).toBe("runtime");
    expect(fetch.mock.calls).toHaveLength(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      "https://chatgpt.com/backend-api/wham/usage",
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "chatgpt-account-id": "synthetic-account" } },
    ]);
    expect(resolved?.headers).not.toHaveProperty("chatgpt-account-id");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not duplicate an existing account header with different casing", async () => {
    const current = auth();
    current.headers["ChatGPT-Account-Id"] = "synthetic-account";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload())));
    const adapter = adapterForProvider("openai-codex");
    assert.ok(adapter);
    await queryProviderUsage(adapter, current, new AbortController().signal, 5_000);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("synthetic-account");
    expect(current.headers).toHaveProperty("ChatGPT-Account-Id");
  });

  it("leaves unsupported auth queries and their existing request headers unchanged", async () => {
    const current = auth();
    current.apiKey = "synthetic-key";
    current.headers.Authorization = "Bearer synthetic-key";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload())));
    const adapter = adapterForProvider("openai-codex");
    assert.ok(adapter);
    const result = await queryProviderUsage(adapter, current, new AbortController().signal, 5_000);
    expect(result).not.toHaveProperty("allowance");
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("chatgpt-account-id");
  });

  it.each(["rounded counters", "long model ID", "blank model ID"])(
    "preserves display-only companion reports with %s that cannot satisfy optional metadata",
    async (reason) => {
      const current = auth();
      current.model = {
        ...current.model,
        provider: "openai",
        id: reason === "long model ID" ? "x".repeat(513) : reason === "blank model ID" ? " " : "gpt-5.6-sol",
      };
      current.openaiClientId = "synthetic-app";
      current.openaiCompanion = { headers: { Authorization: "Bearer companion" } };
      const plan = reason === "rounded counters" ? { ...window(33.3), remaining_percent: 66.6 } : window();
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "synthetic-app", windows: [window()] }] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary_window: plan } })));
      const result = await queryOpenAICompanionUsage(current, new AbortController().signal, 5_000, async () => {});
      expect(result).not.toHaveProperty("allowance");
      const projected = copyUsageReportForApi(result);
      expect(projected).not.toHaveProperty("allowance");
      expect(projected.buckets[0]).toMatchObject(
        reason === "rounded counters" ? { used: 33.3, remaining: 66.6 } : { used: 97, remaining: 3 },
      );
    },
  );

  it("marks native OpenAI companion data explicitly unbound", async () => {
    const current = auth();
    current.model = { ...current.model, provider: "openai", id: "gpt-5.6-sol" };
    current.openaiClientId = "synthetic-app";
    current.openaiCompanion = { headers: { Authorization: "Bearer companion" } };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "synthetic-app", windows: [window()] }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    const result = await queryOpenAICompanionUsage(current, new AbortController().signal, 5_000, async () => {});
    expect(result.allowance).toMatchObject({ authBinding: "unbound", coverage: "partial" });
    expect(copyUsageReportForApi(result).allowance?.authBinding).toBe("unbound");
  });
});

describe("optional v1 allowance projection", () => {
  it("returns detached whitelisted metadata with millisecond reset times", () => {
    const input = report();
    Object.assign(input.allowance, { credential: "must-not-escape" });
    Object.assign(input.allowance.scope, { private: "must-not-escape" });
    const output = copyUsageReportForApi(input);
    expect(output.buckets[0]?.resetsAt).toBe(NOW + 3_600_000);
    expect(input.buckets[0]?.resetsAt).toBe(NOW / 1_000 + 3_600);
    expect(output.allowance).not.toHaveProperty("credential");
    expect(output.allowance?.scope).not.toHaveProperty("private");
    assert.ok(output.allowance);
    output.allowance.scope.modelIds.push("changed");
    output.allowance.bucketIds.splice(0);
    expect(input.allowance?.scope.modelIds).toEqual([MODEL.id]);
    expect(input.allowance?.bucketIds).toHaveLength(2);
  });

  it("captures metadata fields once before validating and copying", () => {
    const input = report();
    let reads = 0;
    Object.defineProperty(input.allowance, "authBinding", {
      get() {
        return reads++ === 0 ? "runtime" : "malformed";
      },
    });
    expect(copyUsageReportForApi(input).allowance?.authBinding).toBe("runtime");
    expect(reads).toBe(1);
  });

  it.each([
    null,
    [],
    "included",
    { kind: "hard-limit" },
    { scope: null },
    { scope: { kind: "provider" } },
    { scope: { kind: "models", modelIds: [] } },
    { scope: { kind: "models", modelIds: [MODEL.id, MODEL.id] } },
    { scope: { kind: "models", modelIds: [undefined] } },
    { coverage: "all" },
    { authBinding: "named-account" },
    { bucketIds: [] },
    { bucketIds: ["missing"] },
    { bucketIds: ["codex:primary", "codex:primary"] },
  ])("rejects malformed optional metadata: %j", (changes) => {
    const input: UsageReport = report();
    input.allowance = (
      changes && !Array.isArray(changes) && typeof changes === "object" ? { ...input.allowance, ...changes } : changes
    ) as UsageReport["allowance"];
    expect(() => copyUsageReportForApi(input)).toThrow();
  });

  it.each([{ unit: "usd" }, { remaining: 50 }, { limit: 500 }, { used: undefined }])(
    "rejects contradictory referenced buckets: %j",
    (changes) => {
      const input = report();
      assert.ok(input.buckets[0]);
      Object.assign(input.buckets[0], changes);
      expect(() => copyUsageReportForApi(input)).toThrow();
    },
  );

  it("rejects ambiguous referenced bucket IDs", () => {
    const input = report();
    assert.ok(input.buckets[0]);
    input.buckets.push({ ...input.buckets[0] });
    expect(() => copyUsageReportForApi(input)).toThrow();
  });

  it("rejects malformed callback metadata at the service boundary without leaking diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mock = createMockPi();
    const ctx = { model: MODEL, sessionManager: { getSessionId: () => "test" } } as unknown as ExtensionContext;
    const invalid = copyUsageReportForApi(report());
    Object.assign(invalid.allowance ?? {}, { coverage: "private-invalid-value" });
    const api = registerUsageApi(mock.pi, {
      policyIdentity: () => "test",
      refresh: async () => ({
        status: "ready",
        providerId: MODEL.provider,
        source: "refresh",
        expiresAt: NOW + 60_000,
        report: invalid,
      }),
    });
    api.start(ctx);
    api.ready(ctx);
    try {
      expect(await queryUsage(mock.pi, ctx, { refresh: true })).toEqual({
        status: "unavailable",
        providerId: MODEL.provider,
        reason: "query-failed",
      });
    } finally {
      api.stop(ctx);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps old reports valid and older structural clients unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mock = createMockPi();
    const ctx = { model: MODEL, sessionManager: { getSessionId: () => "test" } } as unknown as ExtensionContext;
    let input: UsageReport = report();
    const api = registerUsageApi(mock.pi, {
      policyIdentity: () => "test",
      refresh: async () => ({
        status: "ready",
        providerId: MODEL.provider,
        source: "refresh",
        expiresAt: NOW + 60_000,
        report: copyUsageReportForApi(input),
      }),
    });
    api.start(ctx);
    api.ready(ctx);
    try {
      const result = await queryUsage(mock.pi, ctx, { refresh: true });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected ready");
      const copied = result as UsageQueryResultV1 & { status: "ready" };
      expect(copied.report.allowance).toEqual(input.allowance);
      expect(copied.report.buckets[0]?.resetsAt).toBe(NOW + 3_600_000);
      assert.ok(copied.report.allowance);
      copied.report.allowance.scope.modelIds.push("detached");
      expect(input.allowance?.scope.modelIds).toEqual([MODEL.id]);
      input = normalizeCodexBackendPayload(payload(), NOW);
      const legacy = await queryUsage(mock.pi, ctx, { refresh: true });
      expect(legacy.status).toBe("ready");
      if (legacy.status === "ready") expect(legacy.report).not.toHaveProperty("allowance");
    } finally {
      api.stop(ctx);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
