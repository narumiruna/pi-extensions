import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { deferred, routerResponse, usageApiRuntime } from "./fixtures/usage-api-runtime.js";

type Runtime = Awaited<ReturnType<typeof usageApiRuntime>>;

async function scheduled(runtime: Runtime) {
  const published = deferred<void>();
  const setStatus = runtime.ctx.ui.setStatus;
  runtime.ctx.ui.setStatus = (key, value) => {
    setStatus(key, value);
    if (key === "usage" && value !== undefined && value !== "checking") published.resolve();
  };
  try {
    await runtime.emit("turn_start");
    await published.promise;
  } finally {
    runtime.ctx.ui.setStatus = setStatus;
  }
}

for (const trigger of ["turn", "timer"] as const) {
  test(`API refresh preserves an in-flight ${trigger} status query and its next timer`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc" });
    const entered = deferred<void>();
    const response = deferred<Response>();
    vi.useFakeTimers();
    try {
      Object.assign(runtime.currentModel, runtime.providerModel);
      if (trigger === "timer") await scheduled(runtime);
      const initialFetches = runtime.fetches.length;
      let first = true;
      runtime.onFetch(async () => {
        if (first) {
          first = false;
          entered.resolve();
          return response.promise;
        }
        return routerResponse();
      });
      if (trigger === "timer") await vi.advanceTimersByTimeAsync(5 * 60_000);
      else await runtime.emit("turn_start");
      await entered.promise;
      let apiSettled = false;
      const pending = runtime.query({ refresh: true }).then((result) => {
        apiSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(runtime.fetches.length, initialFetches + 1, "API must not supersede the presentation query");
      assert.equal(apiSettled, false);
      response.resolve(routerResponse());
      assert.equal((await pending).status, "ready");
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
      assert.equal(vi.getTimerCount(), 1, "only the presentation refresh timer remains");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      assert.equal(runtime.fetches.length, initialFetches + 3);
      assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
      assert.equal(vi.getTimerCount(), 1);
    } finally {
      response.resolve(routerResponse());
      vi.useRealTimers();
      await runtime.close();
    }
  });
}

for (const view of ["current", "configured", "all"] as const) {
  test(`API refresh waits for a ${view} menu query without closing the menu`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc" });
    const entered = deferred<void>();
    const response = deferred<Response>();
    let menu: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      if (view === "current") Object.assign(runtime.currentModel, runtime.providerModel);
      const choices =
        view === "current"
          ? ["Close"]
          : view === "all"
            ? ["View all configured providers…", "Close"]
            : ["View another configured provider…", "openrouter", "Close"];
      const titles: string[] = [];
      runtime.ctx.ui.select = async (title) => {
        titles.push(title);
        return choices.shift();
      };
      let first = true;
      runtime.onFetch(async () => {
        if (first) {
          first = false;
          entered.resolve();
          return response.promise;
        }
        return routerResponse();
      });
      const command = runtime.mock.commands.get("usage");
      assert.ok(command);
      menu = command.handler("", runtime.ctx) as Promise<unknown>;
      await entered.promise;
      const pending = runtime.query({ refresh: true });
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(runtime.fetches.length, 1);
      response.resolve(routerResponse());
      assert.equal((await pending).status, "ready");
      await menu;
      assert.ok(
        titles.some((title) => title.includes("75.00")),
        "the usage review must still open",
      );
      assert.equal(runtime.fetches.length, 2, "API must still fetch a new report after waiting");
    } finally {
      response.resolve(routerResponse());
      await menu;
      vi.useRealTimers();
      await runtime.close();
    }
  });
}

test("an API request for another provider does not wait for the presentation query", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const entered = deferred<void>();
  const response = deferred<Response>();
  vi.useFakeTimers();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    const models = [
      runtime.currentModel,
      { id: "deepseek", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com" },
    ];
    runtime.ctx.modelRegistry.getAll = () => models as ReturnType<typeof runtime.ctx.modelRegistry.getAll>;
    runtime.ctx.modelRegistry.getAvailable = () => models as ReturnType<typeof runtime.ctx.modelRegistry.getAvailable>;
    runtime.onFetch(async (url) => {
      if (url.includes("openrouter")) {
        entered.resolve();
        return response.promise;
      }
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "8", granted_balance: "0", topped_up_balance: "8" }],
        }),
      );
    });
    await runtime.emit("turn_start");
    await entered.promise;
    assert.equal((await runtime.query({ providerId: "deepseek", refresh: true })).status, "ready");
    assert.equal(runtime.fetches.length, 2);
    assert.equal(runtime.fetches[0]?.init.signal?.aborted, false);
    response.resolve(routerResponse());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    response.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});

test("cancelling an API waiter leaves the presentation transport and timer owned by the status flow", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const entered = deferred<void>();
  const response = deferred<Response>();
  const controller = new AbortController();
  vi.useFakeTimers();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    runtime.onFetch(async () => {
      entered.resolve();
      return response.promise;
    });
    await runtime.emit("turn_start");
    await entered.promise;
    const pending = runtime.query({ refresh: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "cancelled" });
    assert.equal(runtime.fetches[0]?.init.signal?.aborted, false);
    response.resolve(routerResponse());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 1);
    assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    response.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});

test("time waiting for presentation uses the original API deadline rather than a fresh budget", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const entered = deferred<void>();
  const releaseAuth = deferred<void>();
  const apiEntered = deferred<void>();
  const apiResponse = deferred<Response>();
  vi.useFakeTimers();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    let firstAuth = true;
    runtime.onAuth(async () => {
      if (firstAuth) {
        firstAuth = false;
        entered.resolve();
        await releaseAuth.promise;
      }
    });
    runtime.onFetch(async () => {
      if (runtime.fetches.length === 1) return routerResponse();
      apiEntered.resolve();
      return apiResponse.promise;
    });
    await runtime.emit("turn_start");
    await entered.promise;
    const pending = runtime.query({ refresh: true, timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(14_000);
    assert.equal(runtime.fetches.length, 0, "API must still be waiting for the presentation auth query");
    releaseAuth.resolve();
    await apiEntered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "timeout" });
    assert.equal(runtime.fetches[1]?.init.signal?.aborted, true);
    apiResponse.resolve(routerResponse());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    releaseAuth.resolve();
    apiResponse.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});

for (const replacement of ["model", "session", "shutdown"] as const) {
  test(`${replacement} replacement cancels the API waiter without starting late transport`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc" });
    const entered = deferred<void>();
    const response = deferred<Response>();
    vi.useFakeTimers();
    try {
      Object.assign(runtime.currentModel, runtime.providerModel);
      runtime.onFetch(async () => {
        entered.resolve();
        return response.promise;
      });
      await runtime.emit("turn_start");
      await entered.promise;
      const pending = runtime.query({ refresh: true });
      await vi.advanceTimersByTimeAsync(0);
      if (replacement === "shutdown") await runtime.emit("session_shutdown", { reason: "quit" });
      else {
        Object.assign(runtime.currentModel, { provider: "unsupported", id: "other", baseUrl: "https://other.invalid" });
        if (replacement === "session") {
          runtime.sessionId("replacement");
          await runtime.emit("session_start");
        } else await runtime.emit("model_select", { model: runtime.currentModel });
      }
      assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
      response.resolve(routerResponse());
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(runtime.fetches.length, 1);
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(runtime.context.statuses.get("usage"), undefined);
    } finally {
      response.resolve(routerResponse());
      vi.useRealTimers();
      await runtime.close();
    }
  });
}

test("old session cleanup cannot remove replacement-session presentation tracking", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const oldEntered = deferred<void>();
  const nextEntered = deferred<void>();
  const oldResponse = deferred<Response>();
  const nextResponse = deferred<Response>();
  vi.useFakeTimers();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    runtime.onFetch(async () => {
      if (runtime.fetches.length === 1) {
        oldEntered.resolve();
        return oldResponse.promise;
      }
      if (runtime.fetches.length === 2) {
        nextEntered.resolve();
        return nextResponse.promise;
      }
      return routerResponse();
    });
    await runtime.emit("turn_start");
    await oldEntered.promise;
    const oldApi = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    runtime.sessionId("replacement");
    await runtime.emit("session_start");
    await nextEntered.promise;
    assert.deepEqual(await oldApi, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    const firstNewApi = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    oldResponse.resolve(routerResponse());
    await vi.advanceTimersByTimeAsync(0);
    const latestApi = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(await firstNewApi, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.fetches.length, 2, "old cleanup must not let API bypass replacement-session presentation");
    nextResponse.resolve(routerResponse());
    assert.equal((await latestApi).status, "ready");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 3);
    assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    oldResponse.resolve(routerResponse());
    nextResponse.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});

for (const [provider, baseUrl] of [
  ["deepseek", "https://api.deepseek.com"],
  ["minimax", "https://api.minimax.io/anthropic"],
] as const) {
  test(`API waiting across ${provider} auth retry cannot deadlock the recursive presentation query`, async () => {
    const runtime = await usageApiRuntime({ mode: "rpc", model: { id: "test", name: "Test", provider, baseUrl } });
    const entered = deferred<void>();
    const releaseAuth = deferred<void>();
    vi.useFakeTimers();
    try {
      Object.assign(runtime.currentModel, runtime.providerModel);
      runtime.key("sk-api-old");
      runtime.onAuth(async () => {
        if (runtime.authCalls() === 1) {
          entered.resolve();
          await releaseAuth.promise;
        } else if (runtime.authCalls() === 2) runtime.key("sk-api-new");
      });
      runtime.onFetch(async () => {
        return new Response(
          JSON.stringify(
            provider === "deepseek"
              ? {
                  is_available: true,
                  balance_infos: [
                    { currency: "USD", total_balance: "8", granted_balance: "0", topped_up_balance: "8" },
                  ],
                }
              : {
                  base_resp: { status_code: 0 },
                  available_amount: "8",
                  cash_balance: "8",
                  voucher_balance: "0",
                  credit_balance: "0",
                  owed_amount: "0",
                },
          ),
        );
      });
      const presentation = scheduled(runtime);
      await entered.promise;
      const pending = runtime.query({ refresh: true });
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(runtime.authCalls(), 1);
      releaseAuth.resolve();
      await presentation;
      assert.equal((await pending).status, "ready");
      assert.equal(runtime.fetches.length, 2);
      for (const request of runtime.fetches)
        assert.equal((request.init.headers as Record<string, string>).Authorization, "Bearer sk-api-new");
      assert.notEqual(runtime.context.statuses.get("usage"), "checking");
      assert.equal(vi.getTimerCount(), 1);
    } finally {
      releaseAuth.resolve();
      vi.useRealTimers();
      await runtime.close();
    }
  });
}

test("API waits again when a newer presentation query starts before the first settles", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  vi.useFakeTimers();
  try {
    Object.assign(runtime.currentModel, runtime.providerModel);
    runtime.onFetch(async () => {
      if (runtime.fetches.length === 1) {
        firstEntered.resolve();
        return firstResponse.promise;
      }
      if (runtime.fetches.length === 2) {
        secondEntered.resolve();
        return secondResponse.promise;
      }
      return routerResponse();
    });
    await runtime.emit("turn_start");
    await firstEntered.promise;
    const pending = runtime.query({ refresh: true });
    await vi.advanceTimersByTimeAsync(0);
    await runtime.emit("turn_start");
    await secondEntered.promise;
    firstResponse.resolve(routerResponse());
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 2, "waiting on one snapshot must not supersede a newer presentation");
    secondResponse.resolve(routerResponse());
    assert.equal((await pending).status, "ready");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(runtime.fetches.length, 3);
    assert.equal(runtime.context.statuses.get("usage"), "openrouter $75.00 left");
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    firstResponse.resolve(routerResponse());
    secondResponse.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});
