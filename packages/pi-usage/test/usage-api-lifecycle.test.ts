import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { deferred, routerResponse, usageApiRuntime } from "./fixtures/usage-api-runtime.js";

for (const phase of ["auth", "provider"] as const) {
  test(`cancellation during ${phase} releases the API task and prevents late publication`, async () => {
    const runtime = await usageApiRuntime();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const controller = new AbortController();
    try {
      if (phase === "auth")
        runtime.onAuth(async () => {
          entered.resolve();
          await resume.promise;
        });
      else
        runtime.onFetch(async () => {
          entered.resolve();
          await resume.promise;
          return routerResponse();
        });
      const pending = runtime.query({ refresh: true, signal: controller.signal });
      await entered.promise;
      controller.abort();
      assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "cancelled" });
      if (phase === "provider") assert.equal(runtime.fetches[0]?.init.signal?.aborted, true);
      resume.resolve();
      await runtime.settings.flush();
      // Stop is a lifecycle barrier, not a timing sleep. Any obsolete continuation must
      // remain unable to publish even if the Pi-owned auth operation resolves later.
      await runtime.emit("session_shutdown", { reason: "quit" });
      assert.ok(!runtime.changes.some((event) => event.reason === "updated"));
      if (phase === "auth") assert.equal(runtime.fetches.length, 0);
    } finally {
      resume.resolve();
      await runtime.close();
    }
  });
}

for (const change of ["session", "model", "headers", "policy", "target", "origin", "auth"] as const) {
  test(`${change} replacement during provider transport cannot publish the old report`, async () => {
    const runtime = await usageApiRuntime();
    const entered = deferred<void>();
    const response = deferred<Response>();
    try {
      assert.equal((await runtime.query({ refresh: true })).status, "ready");
      runtime.changes.length = 0;
      runtime.onFetch(async () => {
        entered.resolve();
        return response.promise;
      });
      const pending = runtime.query({ refresh: true });
      await entered.promise;
      if (change === "session") runtime.sessionId("replacement-session");
      if (change === "model") runtime.currentModel.id = "replacement-model";
      if (change === "headers") Object.assign(runtime.currentModel, { headers: { Authorization: "replaced" } });
      if (change === "policy") await runtime.settings.update({ openaiUseCodexUsage: true });
      if (change === "target") await runtime.settings.update({ selectedTargets: { fireworks: "accounts/replaced" } });
      if (change === "origin") runtime.providerModel.baseUrl = "https://proxy.invalid/v1";
      if (change === "auth") runtime.key("replacement-synthetic-key");
      response.resolve(routerResponse());
      const result = await pending;
      assert.deepEqual(result, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
      assert.ok(!runtime.changes.some((event) => event.reason === "updated"));
      assert.ok(runtime.changes.some((event) => event.reason === "invalidated"));
    } finally {
      response.resolve(routerResponse());
      await runtime.close();
    }
  });
}

test("a newer API refresh supersedes an older request without sharing cancellation", async () => {
  const runtime = await usageApiRuntime();
  const entered = deferred<void>();
  const firstResponse = deferred<Response>();
  let count = 0;
  try {
    runtime.onFetch(async () => {
      if (++count === 1) {
        entered.resolve();
        return firstResponse.promise;
      }
      return routerResponse();
    });
    const first = runtime.query({ refresh: true });
    await entered.promise;
    const second = await runtime.query({ refresh: true });
    assert.equal(second.status, "ready");
    assert.deepEqual(await first, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.fetches[0]?.init.signal?.aborted, true);
    firstResponse.resolve(routerResponse());
    assert.equal(runtime.changes.filter((event) => event.reason === "updated").length, 1);
  } finally {
    firstResponse.resolve(routerResponse());
    await runtime.close();
  }
});

test("session replacement with the same manager invalidates the old scope and permits new requests", async () => {
  const runtime = await usageApiRuntime();
  const entered = deferred<void>();
  const oldResponse = deferred<Response>();
  try {
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    runtime.onFetch(async () => {
      entered.resolve();
      return oldResponse.promise;
    });
    const old = runtime.query({ refresh: true });
    await entered.promise;
    runtime.sessionId("replacement");
    await runtime.emit("session_start");
    assert.deepEqual(await old, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.fetches[1]?.init.signal?.aborted, true);
    const invalidations = runtime.changes.filter((event) => event.reason === "invalidated");
    assert.ok(invalidations.some((event) => event.sessionId === "api-session"));
    runtime.onFetch(undefined);
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    oldResponse.resolve(routerResponse());
    assert.equal(
      runtime.changes.filter((event) => event.reason === "updated" && event.sessionId === "replacement").length,
      1,
    );
  } finally {
    oldResponse.resolve(routerResponse());
    await runtime.close();
  }
});

test("shutdown removes listeners, aborts transport, and restart registers only one service", async () => {
  const runtime = await usageApiRuntime();
  const entered = deferred<void>();
  const response = deferred<Response>();
  try {
    runtime.onFetch(async () => {
      entered.resolve();
      return response.promise;
    });
    const pending = runtime.query({ refresh: true });
    await entered.promise;
    await runtime.emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.fetches[0]?.init.signal?.aborted, true);
    assert.deepEqual(await runtime.query(), { status: "unavailable", providerId: "openrouter", reason: "no-service" });
    await runtime.emit("session_shutdown", { reason: "quit" });
    await runtime.emit("session_start");
    runtime.onFetch(undefined);
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.equal(runtime.fetches.length, 2);
  } finally {
    response.resolve(routerResponse());
    await runtime.close();
  }
});

test("a target change during Fireworks discovery prevents billing reads and settings rewrites", async () => {
  const runtime = await usageApiRuntime({
    model: {
      id: "accounts/fireworks/models/example",
      name: "Example",
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference",
    },
  });
  const entered = deferred<void>();
  const accounts = deferred<Response>();
  try {
    runtime.onFetch(async () => {
      entered.resolve();
      return accounts.promise;
    });
    const pending = runtime.query({ refresh: true });
    await entered.promise;
    await runtime.settings.update({ selectedTargets: { fireworks: "accounts/beta" } });
    accounts.resolve(
      new Response(JSON.stringify({ accounts: [{ name: "accounts/alpha" }, { name: "accounts/beta" }] })),
    );
    assert.deepEqual(await pending, { status: "unavailable", providerId: "fireworks", reason: "stale-context" });
    assert.equal(runtime.fetches.length, 1);
    assert.deepEqual(runtime.settings.get().settings.selectedTargets, { fireworks: "accounts/beta" });
  } finally {
    accounts.resolve(new Response("{}"));
    await runtime.close();
  }
});

test("a later scheduled query supersedes API publication without returning the older result", async () => {
  const runtime = await usageApiRuntime();
  const entered = deferred<void>();
  const response = deferred<Response>();
  let count = 0;
  try {
    // Select the provider before acceptance without starting a scheduled query yet.
    Object.assign(runtime.currentModel, runtime.providerModel);
    runtime.onFetch(async () => {
      if (++count === 1) {
        entered.resolve();
        return response.promise;
      }
      return routerResponse();
    });
    const api = runtime.query({ refresh: true });
    await entered.promise;
    const published = deferred<void>();
    runtime.pi.events.on("usage:changed:v1", (event) => {
      if ((event as { reason: string }).reason === "updated") published.resolve();
    });
    await runtime.emit("turn_start");
    await published.promise;
    response.resolve(routerResponse());
    assert.deepEqual(await api, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.changes.filter((event) => event.reason === "updated").length, 1);
  } finally {
    response.resolve(routerResponse());
    await runtime.close();
  }
});

test("provider request timeout leaves no API-owned timer or late cache publication", async () => {
  const runtime = await usageApiRuntime();
  const entered = deferred<void>();
  const response = deferred<Response>();
  runtime.onFetch(async () => {
    entered.resolve();
    return response.promise;
  });
  vi.useFakeTimers();
  try {
    const pending = runtime.query({ refresh: true, timeoutMs: 20_000 });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "timeout" });
    assert.equal(runtime.fetches[0]?.init.signal?.aborted, true);
    response.resolve(routerResponse());
    await vi.runAllTimersAsync();
    assert.equal(vi.getTimerCount(), 0);
    assert.ok(!runtime.changes.some((event) => event.reason === "updated"));
  } finally {
    response.resolve(routerResponse());
    vi.useRealTimers();
    await runtime.close();
  }
});
