import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { deferred, routerResponse, usageApiRuntime } from "./fixtures/usage-api-runtime.js";

type Runtime = Awaited<ReturnType<typeof usageApiRuntime>>;

function routerUsage(used: number) {
  return new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 100 - used, usage: used } }));
}

function manualConfigured(runtime: Runtime, label: string, titles: string[] = []) {
  runtime.ctx.modelRegistry.getProviderDisplayName = (id) => (id === runtime.providerModel.provider ? label : id);
  const choices = ["View another configured provider…", label, "Close"];
  runtime.ctx.ui.select = async (title) => {
    titles.push(title);
    return choices.shift();
  };
  const command = runtime.mock.commands.get("usage");
  assert.ok(command);
  return command.handler("", runtime.ctx);
}

async function scheduled(runtime: Runtime) {
  const published = deferred<void>();
  const setStatus = runtime.ctx.ui.setStatus;
  runtime.ctx.ui.setStatus = (key, value) => {
    setStatus(key, value);
    if (key === "usage" && value !== undefined && value !== "checking") published.resolve();
  };
  try {
    await runtime.emit("turn_start");
    // Unlike the updated event, status publication follows scheduled auth revalidation.
    await published.promise;
  } finally {
    runtime.ctx.ui.setStatus = setStatus;
  }
}

for (const successor of ["report", "failure"] as const) {
  test(`obsolete API transport cannot erase a scheduled successor's ${successor}`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc" });
    const entered = deferred<void>();
    const oldResponse = deferred<Response>();
    try {
      Object.assign(runtime.currentModel, runtime.providerModel);
      runtime.onFetch(async () => {
        if (runtime.fetches.length === 1) {
          entered.resolve();
          return oldResponse.promise;
        }
        return successor === "report" ? routerUsage(36) : new Response("unavailable", { status: 503 });
      });
      const old = runtime.query({ refresh: true });
      await entered.promise;
      runtime.key("successor-key");
      await scheduled(runtime);
      assert.equal(runtime.fetches.length, 2);
      assert.equal(
        runtime.changes.filter((event) => event.reason === (successor === "report" ? "updated" : "query-failed"))
          .length,
        1,
      );
      const notifications = [...runtime.changes];
      const status = runtime.context.statuses.get("usage");
      oldResponse.resolve(routerUsage(90));
      assert.deepEqual(await old, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
      assert.deepEqual(runtime.changes, notifications, "obsolete auth must not invalidate or fail the successor");
      assert.equal(runtime.context.statuses.get("usage"), status);
      runtime.onFetch(async () => {
        throw new Error("successor cache or backoff was erased");
      });
      if (successor === "report") {
        await scheduled(runtime);
        assert.match(runtime.context.statuses.get("usage") ?? "", /64\.00/);
      } else {
        assert.deepEqual(await runtime.query({ refresh: true }), {
          status: "unavailable",
          providerId: "openrouter",
          reason: "query-failed",
        });
      }
      assert.equal(runtime.fetches.length, 2, "successor state must prevent another HTTP request");
      assert.deepEqual(runtime.changes, notifications);
    } finally {
      oldResponse.resolve(routerResponse());
      await runtime.close();
    }
  });
}

test("API waits for captured manual auth before publishing the new account report", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const entered = deferred<void>();
  const resume = deferred<void>();
  let manual: ReturnType<typeof manualConfigured> | undefined;
  vi.useFakeTimers();
  try {
    let key = "old-account-key";
    let first = true;
    // Capture the resolved credential before waiting. The fixture's onAuth hook
    // reads its key after the wait and cannot represent this race.
    runtime.ctx.modelRegistry.getProviderAuth = async () => {
      const captured = key;
      if (first) {
        first = false;
        entered.resolve();
        await resume.promise;
      }
      return { source: "API key", auth: { apiKey: captured } };
    };
    runtime.onFetch(async (_url, init) =>
      routerUsage((init.headers as Record<string, string>).Authorization === "Bearer old-account-key" ? 90 : 36),
    );
    manual = manualConfigured(runtime, "OpenRouter");
    await entered.promise;
    key = "new-account-key";
    runtime.key(key);
    const pending = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 0, "API must not take ownership while manual auth is pending");
    resume.resolve();
    const successor = await pending;
    await manual;
    assert.equal(successor.status, "ready");
    if (successor.status === "ready")
      assert.equal(successor.report.metrics.find((metric) => metric.id === "usage-total")?.value, 36);
    assert.equal(runtime.fetches.length, 2, "API must validate and query the new account after the presentation");
    const titles: string[] = [];
    await manualConfigured(runtime, "OpenRouter", titles);
    assert.equal(runtime.fetches.length, 2, "the API successor report must remain cached");
    assert.ok(
      titles.some((title) => title.includes("64.00")),
      "the configured view must show the successor report",
    );
    key = "old-account-key";
    runtime.key(key);
    await manualConfigured(runtime, "OpenRouter");
    assert.equal(runtime.fetches.length, 3, "the old account must not have a stale cached report");
  } finally {
    resume.resolve();
    await manual;
    vi.useRealTimers();
    await runtime.close();
  }
});

for (const authOutcome of ["resolved", "rejected"] as const) {
  for (const successor of ["report", "failure"] as const) {
    test(`late current-provider auth ${authOutcome} cannot erase another provider's ${successor}`, async () => {
      const runtime = await usageApiRuntime({ mode: "rpc" });
      const entered = deferred<void>();
      const resume = deferred<void>();
      let manual: Promise<unknown> | undefined;
      try {
        Object.assign(runtime.currentModel, runtime.providerModel);
        runtime.ctx.ui.select = async () => "Close";
        let blocked = false;
        runtime.ctx.modelRegistry.getProviderAuth = async (providerId) => {
          if (providerId === "openrouter" && !blocked) {
            blocked = true;
            entered.resolve();
            await resume.promise;
            if (authOutcome === "rejected") throw new Error("old auth failed");
          }
          return { source: "API key", auth: { apiKey: "synthetic-api-key" } };
        };
        runtime.onFetch(async (input) => {
          assert.ok(input.includes("deepseek"), "obsolete current-provider auth must never reach transport");
          return successor === "failure"
            ? new Response("unavailable", { status: 503 })
            : new Response(
                JSON.stringify({
                  is_available: true,
                  balance_infos: [
                    { currency: "USD", total_balance: "8", granted_balance: "0", topped_up_balance: "8" },
                  ],
                }),
              );
        });
        const command = runtime.mock.commands.get("usage");
        assert.ok(command);
        manual = command.handler("", runtime.ctx) as Promise<unknown>;
        await entered.promise;
        Object.assign(runtime.ctx, {
          model: { id: "deepseek", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com" },
        });
        await scheduled(runtime);
        const notifications = [...runtime.changes];
        const status = runtime.context.statuses.get("usage");
        assert.equal(runtime.fetches.length, 1);
        resume.resolve();
        await manual;
        assert.deepEqual(runtime.changes, notifications, "obsolete current identity must not invalidate the successor");
        assert.equal(runtime.context.statuses.get("usage"), status);
        if (successor === "report") await scheduled(runtime);
        else
          assert.deepEqual(await runtime.query({ providerId: "deepseek", refresh: true }), {
            status: "unavailable",
            providerId: "deepseek",
            reason: "query-failed",
          });
        assert.equal(runtime.fetches.length, 1, "successor report or failure backoff must survive");
      } finally {
        resume.resolve();
        await manual;
        await runtime.close();
      }
    });
  }
}

const fireworksModel = {
  id: "accounts/fireworks/models/example",
  name: "Example",
  provider: "fireworks",
  baseUrl: "https://api.fireworks.ai/inference",
};

function fireworksResponse(url: string) {
  return new Response(
    JSON.stringify(
      url.includes("/billing/summary")
        ? {
            lineItems: [
              {
                category: "Serverless",
                series: "SERVERLESS",
                totalCost: { currencyCode: "USD", units: "12", nanos: 0 },
              },
            ],
          }
        : { accounts: [{ name: "accounts/acme" }] },
    ),
  );
}

for (const successor of ["scheduled", "manual"] as const) {
  test(`an old Fireworks discovery failure cannot install backoff after ${successor} success`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc", model: fireworksModel });
    const entered = deferred<void>();
    const oldResponse = deferred<Response>();
    let old: ReturnType<typeof manualConfigured> | undefined;
    try {
      runtime.onFetch(async (url) => {
        if (runtime.fetches.length === 1) {
          assert.ok(url.includes("/v1/accounts?"));
          entered.resolve();
          return oldResponse.promise;
        }
        return fireworksResponse(url);
      });
      old = manualConfigured(runtime, "Fireworks");
      await entered.promise;
      if (successor === "scheduled") {
        Object.assign(runtime.currentModel, runtime.providerModel);
        await scheduled(runtime);
      } else {
        await manualConfigured(runtime, "Fireworks");
      }
      assert.equal(runtime.fetches.length, 3);
      assert.equal(runtime.changes.filter((event) => event.reason === "updated").length, 1);
      const notifications = [...runtime.changes];
      oldResponse.resolve(new Response("old account discovery failed", { status: 503 }));
      await old;
      assert.deepEqual(runtime.changes, notifications, "obsolete discovery must not publish a failure or invalidation");
      const result = await runtime.query({ refresh: true });
      assert.equal(result.status, "ready", "obsolete unresolved-target backoff must not block refresh");
      assert.equal(runtime.fetches.length, 5);
      assert.ok(runtime.fetches[3]?.input.includes("/v1/accounts?"));
      assert.ok(runtime.fetches[4]?.input.includes("/accounts/acme/billing/summary?"));
      assert.equal(runtime.changes.filter((event) => event.reason === "query-failed").length, 0);
    } finally {
      oldResponse.resolve(new Response("{}", { status: 503 }));
      await old;
      await runtime.close();
    }
  });
}

test("API waits for target discovery failure and preserves its backoff before retrying", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc", model: fireworksModel });
  const entered = deferred<void>();
  const response = deferred<Response>();
  let manual: ReturnType<typeof manualConfigured> | undefined;
  vi.useFakeTimers();
  try {
    runtime.onFetch(async (url) => {
      if (runtime.fetches.length === 1) {
        entered.resolve();
        return response.promise;
      }
      return fireworksResponse(url);
    });
    manual = manualConfigured(runtime, "Fireworks");
    await entered.promise;
    const pending = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 1);
    response.resolve(new Response("discovery unavailable", { status: 503 }));
    assert.deepEqual(await pending, { status: "unavailable", providerId: "fireworks", reason: "query-failed" });
    await manual;
    assert.equal(runtime.fetches.length, 1, "API must respect the presentation's discovery backoff");
    assert.equal(runtime.changes.filter((event) => event.reason === "query-failed").length, 1);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await runtime.query({ refresh: true });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.report.accountLabel, "acme");
    assert.equal(runtime.fetches.length, 3);
  } finally {
    response.resolve(new Response("{}", { status: 503 }));
    await manual;
    vi.useRealTimers();
    await runtime.close();
  }
});

const guardedModels = [
  ["baseten", "https://inference.baseten.co/v1"],
  ["vercel-ai-gateway", "https://ai-gateway.vercel.sh"],
  ["command-code", "https://api.commandcode.ai/provider"],
  ["minimax", "https://api.minimax.io/anthropic"],
  ["minimax-cn", "https://api.minimaxi.com/anthropic"],
  ["moonshotai", "https://api.moonshot.ai/v1"],
  ["moonshotai-cn", "https://api.moonshot.cn/v1"],
  ["zai", "https://api.z.ai/api/coding/paas/v4"],
  ["zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
] as const;

for (const [provider, baseUrl] of guardedModels) {
  test(`${provider} post-fetch auth rotation preserves stale-context through the adapter guard`, async () => {
    const runtime = await usageApiRuntime({ model: { id: "test-model", name: "Test", provider, baseUrl } });
    const entered = deferred<void>();
    const resume = deferred<void>();
    try {
      // Moonshot's configured-provider policy requires an explicit source proof.
      runtime.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
      runtime.onFetch(async () => {
        entered.resolve();
        await resume.promise;
        return new Response("{}");
      });
      const pending = runtime.query({ refresh: true });
      await entered.promise;
      runtime.key("rotated-after-fetch");
      resume.resolve();
      assert.deepEqual(await pending, { status: "unavailable", providerId: provider, reason: "stale-context" });
      assert.equal(runtime.fetches.length, 1, "the internal guard must stop optional or subsequent requests");
      assert.ok(!runtime.changes.some((event) => event.reason === "updated" || event.reason === "query-failed"));
    } finally {
      resume.resolve();
      await runtime.close();
    }
  });
}

test("1000 unknown provider IDs in query and capability requests do not expand invalidation notifications", async () => {
  const runtime = await usageApiRuntime();
  try {
    for (let index = 0; index < 1000; index++) {
      const providerId = `unknown-${index}`;
      assert.deepEqual(await runtime.query({ providerId, refresh: true }), {
        status: "unavailable",
        providerId,
        reason: "unsupported",
      });
      let offered: Promise<unknown> | undefined;
      runtime.pi.events.emit("usage:capabilities:v1", {
        session: runtime.ctx.sessionManager,
        sessionId: runtime.ctx.sessionManager.getSessionId(),
        providerId,
        signal: new AbortController().signal,
        respond(result: Promise<unknown>) {
          offered = result;
          return true;
        },
      });
      assert.ok(offered);
      assert.deepEqual(await offered, {
        status: "ready",
        providerId,
        supported: false,
        measurements: [],
        supportsRefresh: false,
      });
    }
    assert.deepEqual(runtime.changes, []);
    assert.equal(runtime.authCalls(), 0);
    assert.equal(runtime.fetches.length, 0);
    await runtime.query(); // Expose one supported provider as a notification control.
    runtime.currentModel.id = "changed-model";
    await runtime.emit("model_select", { model: runtime.currentModel });
    assert.deepEqual(
      runtime.changes.map(({ providerId, reason }) => [providerId, reason]),
      [["openrouter", "invalidated"]],
    );
    await runtime.query();
    await runtime.emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(
      runtime.changes.map(({ providerId, reason }) => [providerId, reason]),
      [
        ["openrouter", "invalidated"],
        ["openrouter", "invalidated"],
      ],
    );
    assert.equal(runtime.authCalls(), 0);
    assert.equal(runtime.fetches.length, 0);
  } finally {
    await runtime.close();
  }
});
