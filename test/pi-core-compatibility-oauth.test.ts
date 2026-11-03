import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxProvider,
  type OAuthCredential,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { test } from "vitest";
import { withCoreCompatibilityFixture } from "./pi-core-compatibility-fixture.js";

for (const operation of ["compact", "tree"] as const) {
  test(`SDK-created stream keeps native ${operation} summaries on stored OAuth auth`, async () => {
    await withCoreCompatibilityFixture(async (fixture) => {
      const faux = fauxProvider({ provider: `compat-oauth-${operation}`, tokensPerSecond: Infinity });
      const credential: OAuthCredential = {
        type: "oauth",
        access: "compat-stored-oauth-access",
        refresh: "compat-stored-oauth-refresh",
        expires: Number.MAX_SAFE_INTEGER,
      };
      await fixture.credentials.modify(faux.provider.id, async () => ({ ...credential }));
      let apiKeyResolutions = 0;
      let oauthDerivations = 0;
      let refreshes = 0;
      let logins = 0;
      const provider: Provider = {
        ...faux.provider,
        auth: {
          apiKey: {
            name: "Fixture API-key trap",
            async resolve() {
              apiKeyResolutions += 1;
              throw new Error("Stored OAuth must not re-enter API-key resolution");
            },
          },
          oauth: {
            name: "Fixture OAuth",
            async login() {
              logins += 1;
              throw new Error("The fixture must not log in");
            },
            async refresh() {
              refreshes += 1;
              throw new Error("The unexpired fixture must not refresh");
            },
            async toAuth(stored) {
              oauthDerivations += 1;
              return {
                apiKey: `oauth-derived:${stored.access}`,
                headers: { "X-Compat-Auth": "oauth-only" },
                baseUrl: "https://oauth-fixture.invalid/v1",
              };
            },
          },
        },
      };
      let phase = "ordinary-before";
      const calls: Array<{
        phase: string;
        apiKey: string | undefined;
        headers: SimpleStreamOptions["headers"];
        baseUrl: string;
      }> = [];
      const respond = (
        _context: Parameters<typeof provider.streamSimple>[1],
        options: SimpleStreamOptions | undefined,
        _state: unknown,
        model: Parameters<typeof provider.streamSimple>[0],
      ) => {
        calls.push({ phase, apiKey: options?.apiKey, headers: options?.headers, baseUrl: model.baseUrl });
        return fauxAssistantMessage(`${phase} fixture response`);
      };
      faux.setResponses(Array.from({ length: 8 }, () => respond));
      const session = await fixture.createSession({
        provider,
        settings: { compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 1024 } },
      });
      // Do not wrap or replace session.agent.streamFunction: Pi identifies the
      // SDK stream by function identity to avoid resolving OAuth as an API key.
      const sdkStream = session.agent.streamFunction;
      await session.prompt(`First ordinary OAuth control. ${"Earlier branch details. ".repeat(64)}`);
      assert.equal(session.getLastAssistantText(), "ordinary-before fixture response");
      assert.equal(calls.length, 1);
      const targetId = session.sessionManager.getLeafId();
      assert.ok(targetId);
      await session.prompt(`Second ordinary OAuth control. ${"Recent context. ".repeat(16)}`);
      assert.equal(calls.length, 2);
      assert.equal(apiKeyResolutions, 0);
      assert.ok(oauthDerivations >= calls.length);

      phase = operation;
      if (operation === "compact") {
        const result = await session.compact();
        assert.match(result.summary, /compact fixture response/u);
        const entry = session.sessionManager.getLeafEntry();
        assert.equal(entry?.type, "compaction");
        if (entry?.type === "compaction") assert.notEqual(entry.fromHook, true);
      } else {
        const result = await session.navigateTree(targetId, { summarize: true });
        assert.equal(result.cancelled, false);
        assert.ok(result.summaryEntry);
        assert.match(result.summaryEntry.summary, /tree fixture response/u);
        assert.notEqual(result.summaryEntry.fromHook, true);
      }
      assert.ok(
        calls.some((call) => call.phase === operation),
        "the native summarizer must call the provider",
      );
      phase = "ordinary-after";
      await session.prompt("Ordinary OAuth control after native summarization.");
      assert.equal(session.getLastAssistantText(), "ordinary-after fixture response");
      assert.equal(calls.filter((call) => call.phase === "ordinary-after").length, 1);
      assert.equal(session.agent.streamFunction, sdkStream);
      for (const call of calls) {
        assert.equal(call.apiKey, `oauth-derived:${credential.access}`);
        assert.equal(call.headers?.["X-Compat-Auth"], "oauth-only");
        assert.equal(call.baseUrl, "https://oauth-fixture.invalid/v1");
      }
      assert.equal(apiKeyResolutions, 0);
      assert.equal(refreshes, 0);
      assert.equal(logins, 0);
      assert.ok(oauthDerivations >= calls.length);
      assert.deepEqual(await fixture.credentials.read(provider.id), credential);
    });
  });
}
