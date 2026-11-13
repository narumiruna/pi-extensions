import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { UsageQueryResultV1 } from "../src/usage-api-types.js";
import { usageApiRuntime } from "./fixtures/usage-api-runtime.js";

const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
};
function token(account = "synthetic-account") {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
function response() {
  return new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 98,
          limit_window_seconds: 18_000,
          reset_at: Math.floor(Date.now() / 1_000) + 3_600,
        },
        secondary_window: null,
      },
      credits: { has_credits: true, balance: 1_000 },
    }),
  );
}

describe("fresh included allowance publication", () => {
  it("publishes detached runtime-bound evidence only after guarded refresh; cache reads stay network-free misses", async () => {
    const h = await usageApiRuntime({ model });
    try {
      h.ctx.model = { ...model } as ExtensionContext["model"];
      h.key(token());
      h.onFetch(async () => response());
      const initialAuthCalls = h.authCalls();
      expect(await h.query()).toMatchObject({ status: "unavailable", reason: "cache-miss" });
      expect(h.authCalls()).toBe(initialAuthCalls);
      expect(h.fetches).toHaveLength(0);
      const result = (await h.query({ refresh: true })) as UsageQueryResultV1;
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected fresh allowance evidence");
      expect(result).toMatchObject({ source: "refresh", providerId: model.provider });
      expect(result.report.allowance).toEqual({
        kind: "included",
        scope: { kind: "models", modelIds: [model.id] },
        coverage: "complete",
        bucketIds: ["codex:primary"],
        authBinding: "runtime",
      });
      expect(result.report.buckets[0]?.resetsAt).toBeGreaterThan(Date.now());
      expect(result.report.capturedAt).toBeGreaterThan(1_000_000_000_000);
      expect(JSON.stringify(result)).not.toContain(token());
      expect(JSON.stringify(result)).not.toContain("synthetic-account");
      expect(h.fetches).toHaveLength(1);
      expect(h.fetches[0]?.init.headers).toMatchObject({ "chatgpt-account-id": "synthetic-account" });
      const afterRefreshAuthCalls = h.authCalls();
      expect(await h.query()).toMatchObject({ status: "unavailable", reason: "cache-miss" });
      expect(h.authCalls()).toBe(afterRefreshAuthCalls);
      expect(h.fetches).toHaveLength(1);
      expect(h.context.notifications).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it.each(["auth", "model"])(
    "rejects a %s change during transport before publishing allowance evidence",
    async (change) => {
      const h = await usageApiRuntime({ model });
      try {
        h.ctx.model = { ...model } as ExtensionContext["model"];
        h.key(token());
        h.onFetch(async () => {
          if (change === "auth") h.key(token("new-account"));
          else h.ctx.model = { ...model, id: "gpt-reserve" } as ExtensionContext["model"];
          return response();
        });
        expect(await h.query({ refresh: true })).toMatchObject({ status: "unavailable", reason: "stale-context" });
        expect(h.changes.filter((event) => event.reason === "updated")).toHaveLength(0);
        expect(h.fetches).toHaveLength(1);
      } finally {
        await h.close();
      }
    },
  );
});
