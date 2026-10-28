import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { OAuthCredentialCandidateReader } from "../src/oauth-credential-source.js";
import { OPENAI_CHATGPT_ADAPTER } from "../src/providers/openai-chatgpt.js";
import { queryProviderUsage, resolveUsageAuth } from "../src/query.js";
import { normalizeUsageSettings } from "../src/settings.js";

const model = { provider: "openai", id: "gpt-6.1-sol", name: "GPT", baseUrl: "https://api.openai.com/v1" };
const native = {
  type: "oauth",
  access: "native-account-a",
  refresh: "native-refresh",
  expires: Date.now() + 3_600_000,
  clientId: "fixture-client",
  scopes: ["chatgpt.tokens.use.direct"],
};
const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-b" } })).toString("base64url")}.sig`;
const companion = {
  type: "oauth",
  access,
  refresh: "companion-refresh",
  expires: native.expires,
  accountId: "account-b",
};

for (const grant of [companion, undefined, { ...companion, refresh: "" }]) {
  for (const enabled of [undefined, false]) {
    test(`native Off isolates Codex with ${grant ? (grant.refresh ? "different account" : "invalid grant") : "no grant"}, option ${enabled}`, async () => {
      const providers: string[] = [];
      const offered: string[] = [];
      const readiness: string[] = [];
      const stored: string[] = [];
      const ctx = createMockContext({
        model,
        modelRegistry: {
          getAll: () => [
            model,
            { ...model, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
          ],
          getAvailable: () => [model],
          getProviderAuth: async (id: string) => {
            providers.push(id);
            return id === "openai"
              ? { source: "OAuth", auth: { apiKey: native.access } }
              : grant
                ? { source: "OAuth", auth: { apiKey: grant.access } }
                : undefined;
          },
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: native.access }),
        },
      }).ctx;
      const reader: OAuthCredentialCandidateReader = (_ctx, id) => {
        offered.push(id);
        return { ok: true, candidates: (id === "openai" ? [native] : grant ? [grant] : []) as never[] };
      };
      reader.waitUntilReady = async (_ctx, id) => {
        readiness.push(id);
        return true;
      };
      const fetch = vi.fn(async () => {
        throw new Error("No companion traffic when disabled");
      });
      vi.stubGlobal("fetch", fetch);
      try {
        const auth = await resolveUsageAuth(
          ctx,
          OPENAI_CHATGPT_ADAPTER,
          new Uint8Array(32),
          (id) => {
            stored.push(id);
            return id === "openai" ? native : grant;
          },
          reader,
          true,
          { openaiUseCodexUsage: enabled },
        );
        assert.ok(auth);
        assert.equal(auth.openaiCompanion, undefined);
        const report = await queryProviderUsage(
          OPENAI_CHATGPT_ADAPTER,
          auth,
          new AbortController().signal,
          1000,
          async () => undefined,
        );
        assert.equal(report.source, "openai-chatgpt-auth");
        assert.deepEqual(report.buckets, []);
        assert.match(report.notes?.join("\n") ?? "", /disabled/i);
        assert.ok(providers.every((id) => id === "openai"));
        assert.ok(offered.every((id) => id === "openai"));
        assert.ok(readiness.every((id) => id === "openai"));
        assert.ok(!stored.includes("openai-codex"));
        assert.equal(fetch.mock.calls.length, 0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
}

for (const historical of [undefined, true, false, "obsolete"]) {
  test(`historical companion preference ${historical} cannot opt in`, () => {
    const settings = normalizeUsageSettings({ openaiCompanionUsage: historical });
    assert.equal(settings?.openaiUseCodexUsage, false);
  });
}

for (const invalid of [null, "true", 0, [], {}]) {
  test(`invalid companion preference ${JSON.stringify(invalid)} is rejected`, () => {
    assert.equal(normalizeUsageSettings({ openaiUseCodexUsage: invalid }), undefined);
  });
}
