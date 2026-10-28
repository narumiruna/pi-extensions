import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageAuthGuard } from "../src/auth-resolution-guard.js";
import type { OAuthCredentialCandidateReader } from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER } from "../src/providers/openai-chatgpt.js";
import { adapterForProvider, resolveUsageAuth } from "../src/query.js";

const native = {
  type: "oauth",
  access: "synthetic-native",
  refresh: "native-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "fixture-client",
  scopes: ["chatgpt.tokens.use.direct"],
};
const codex = {
  type: "oauth",
  access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.sig`,
  refresh: "codex-refresh",
  expires: native.expires,
  accountId: "fixture-account",
};
const nativeModel = { provider: "openai", id: "gpt-6.1-sol", name: "GPT", baseUrl: "https://api.openai.com/v1" };
const codexModel = { ...nativeModel, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" };
const boundaries = [
  "native readiness",
  "native provider",
  "native model",
  "native candidates",
  "companion readiness",
  "companion provider",
  "companion model",
  "companion model recheck",
  "companion candidates",
] as const;

for (const boundary of boundaries) {
  for (const completion of ["success", "failure"] as const) {
    test(`cancel ${boundary} before late ${completion} prevents further auth work`, async () => {
      const controller = new AbortController();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const trace: string[] = [];
      let modelReads = 0;
      const step = async <T>(name: string, value: T): Promise<T> => {
        trace.push(name);
        if (name === boundary) {
          ready();
          await blocked;
          if (completion === "failure") throw new Error("late source failure");
        }
        return value;
      };
      const selectedCodex = boundary === "companion model" || boundary === "companion model recheck";
      const ctx = createMockContext({
        model: selectedCodex ? codexModel : nativeModel,
        modelRegistry: {
          getAll: () => [nativeModel, codexModel],
          getAvailable: () => [nativeModel, codexModel],
          getProviderAuth: (provider: string) =>
            step(provider === "openai" ? "native provider" : "companion provider", {
              source: "OAuth",
              auth: { apiKey: provider === "openai" ? native.access : codex.access },
            }),
          getApiKeyAndHeaders: () =>
            step(
              selectedCodex ? (++modelReads === 1 ? "companion model" : "companion model recheck") : "native model",
              {
                ok: true,
                apiKey: selectedCodex ? codex.access : native.access,
              },
            ),
        },
      }).ctx;
      const reader: OAuthCredentialCandidateReader = (_ctx, provider) =>
        step(provider === "openai" ? "native candidates" : "companion candidates", {
          ok: true as const,
          candidates: [provider === "openai" ? native : codex] as never[],
        });
      reader.waitUntilReady = (_ctx, provider) =>
        step(provider === "openai" ? "native readiness" : "companion readiness", true);
      let settled = false;
      let caught: unknown;
      const pending = resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => undefined, reader, undefined, {
        openaiUseCodexUsage: true,
        signal: controller.signal,
      }).then(
        () => {
          settled = true;
        },
        (error) => {
          caught = error;
          settled = true;
        },
      );
      try {
        await entered;
        const before = [...trace];
        controller.abort();
        await vi.waitFor(() => assert.equal(settled, true));
        assert.equal((caught as Error)?.name, "AbortError");
        release();
        await pending;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(trace, before);
      } finally {
        release();
        await pending;
      }
    });
  }
}

for (const model of [
  { provider: "openrouter", id: "fixture", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { provider: "openai-codex", id: "fixture", name: "Codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
  { provider: "kimi-coding", id: "fixture", name: "Kimi", baseUrl: "https://api.kimi.com/coding" },
]) {
  for (const completion of ["success", "cancel", "superseded", "not-ready"] as const) {
    test(`${model.provider} readiness handles ${completion} before resolving runtime auth`, async () => {
      const adapter = adapterForProvider(model.provider);
      assert.ok(adapter);
      const controller = new AbortController();
      let current = true;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const trace: string[] = [];
      const getProviderAuth = vi.fn(async () => {
        trace.push("provider auth");
        return { auth: { apiKey: "runtime-second" } };
      });
      const getApiKeyAndHeaders = vi.fn(async () => {
        trace.push("model auth");
        return { ok: true, apiKey: "runtime-second" };
      });
      const ctx = createMockContext({
        model,
        modelRegistry: {
          getAll: () => [model],
          getAvailable: () => [model],
          getProviderAuth,
          getApiKeyAndHeaders,
        },
      }).ctx;
      const reader: OAuthCredentialCandidateReader = () => ({ ok: true, candidates: [] });
      reader.waitUntilReady = async (_ctx, providerId) => {
        trace.push(`readiness:${providerId}`);
        await blocked;
        return completion !== "not-ready";
      };
      const pending = resolveUsageAuth(ctx, adapter, undefined, () => undefined, reader, undefined, {
        signal: controller.signal,
        checkCurrent() {
          if (!current) throw Object.assign(new Error("Selection superseded"), { name: "AbortError" });
        },
      }).then(
        (auth) => ({ auth, error: undefined }),
        (error: Error) => ({ auth: undefined, error }),
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(trace, [`readiness:${model.provider}`]);
        if (completion === "cancel") controller.abort();
        else {
          if (completion === "superseded") current = false;
          release();
        }
        // Cancellation must settle this waiter without releasing the shared activation.
        const result = await pending;
        if (completion === "success") {
          assert.equal(result.auth?.apiKey, "runtime-second");
          assert.equal(result.error, undefined);
          assert.equal(getProviderAuth.mock.calls.length, 1);
        } else {
          assert.equal(result.auth, undefined);
          assert.equal(getProviderAuth.mock.calls.length, 0);
          assert.equal(getApiKeyAndHeaders.mock.calls.length, 0);
          if (completion === "not-ready") assert.match(result.error?.message ?? "", /readiness failed closed/);
          else assert.equal(result.error?.name, "AbortError");
        }
        const settledTrace = [...trace];
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(trace, settledTrace, "late readiness must not resume stale auth work");
      } finally {
        release();
        await pending;
      }
    });
  }
}

test("a changed policy stops auth after readiness without an abort signal", async () => {
  let current = true;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const auth = vi.fn(async () => ({ source: "OAuth", auth: { apiKey: native.access } }));
  const ctx = createMockContext({
    model: nativeModel,
    modelRegistry: { getAll: () => [nativeModel], getAvailable: () => [nativeModel], getProviderAuth: auth },
  }).ctx;
  const reader: OAuthCredentialCandidateReader = () => ({ ok: true, candidates: [native] as never[] });
  reader.waitUntilReady = async () => {
    ready();
    await wait;
    return true;
  };
  const pending = resolveUsageAuth(ctx, OPENAI_CHATGPT_ADAPTER, undefined, () => undefined, reader, undefined, {
    openaiUseCodexUsage: true,
    checkCurrent: () => {
      if (!current) throw Object.assign(new Error("Policy changed"), { name: "AbortError" });
    },
  });
  try {
    await entered;
    current = false;
    release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(auth.mock.calls.length, 0);
  } finally {
    release();
    await pending.catch(() => undefined);
  }
});

for (const completion of ["success", "failure", "abort"] as const) {
  test(`auth guard releases its abort listener after ${completion}`, async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const guard = createUsageAuthGuard({ signal: controller.signal });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = guard.wait(async () => {
      entered();
      await blocked;
      if (completion === "failure") throw new Error("source failed");
      return 1;
    });
    try {
      await ready;
      if (completion === "abort") controller.abort();
      else release();
      if (completion === "success") assert.equal(await pending, 1);
      else await assert.rejects(pending, completion === "abort" ? { name: "AbortError" } : /source failed/);
      assert.equal(added.mock.calls.length, 1);
      assert.equal(removed.mock.calls.length, 1);
      assert.equal(removed.mock.calls[0]?.[1], added.mock.calls[0]?.[1]);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });
}

test("a pre-cancelled auth guard never starts the source operation", async () => {
  const controller = new AbortController();
  controller.abort();
  const operation = vi.fn(async () => 1);
  await assert.rejects(createUsageAuthGuard({ signal: controller.signal }).wait(operation), { name: "AbortError" });
  assert.equal(operation.mock.calls.length, 0);
});
