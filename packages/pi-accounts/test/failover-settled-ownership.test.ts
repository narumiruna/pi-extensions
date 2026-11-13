import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { allowance, enabled, FAIL_CLOSED_API_KEY, failoverFixture, keyFor } from "./account-failover-fixture.js";

for (const outcome of ["success", "failure", "timeout"] as const) {
  test(`settled recovery ${outcome} cannot change a new provider request`, async () => {
    if (outcome === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.store.updateProvider("anthropic", () => ({
      active: "primary",
      fallback: enabled(["backup"]),
      accounts: {
        primary: { type: "api_key", key: keyFor("other-primary") },
        backup: { type: "api_key", key: keyFor("other-backup") },
      },
    }));
    await f.start();
    const entered = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const candidate = Promise.withResolvers<void>();
    const releaseQuota = Promise.withResolvers<unknown>();
    let queries = 0;
    let restorations = 0;
    const cleanup = f.adapter.invalidateConnections;
    assert.ok(cleanup);
    f.adapter.invalidateConnections = async (session) => {
      if (queries >= 2 && (await f.key()) === keyFor("primary")) {
        restorations++;
        if (restorations === 1) throw new Error("Synthetic initial recovery failure");
        if (restorations === 2) {
          entered.resolve();
          await releaseRecovery.promise;
        }
      }
      await cleanup(session);
    };
    f.offer(({ request, key }) => {
      if (request.providerId === f.id) {
        queries++;
        return queries === 1
          ? allowance(f.ctx, 0)
          : { status: "unavailable", providerId: f.id, reason: "auth-unavailable" };
      }
      if (key === keyFor("other-primary")) return allowance(f.ctx, 0);
      candidate.resolve();
      return releaseQuota.promise;
    });
    await f.turn();
    assert.equal(f.ctx.signal?.aborted, true);
    f.setIdle(true);
    const settled = f.emit("agent_settled");
    await entered.promise;
    f.newRun();
    f.setModel("anthropic");
    await f.emit("model_select");
    await f.emit("before_agent_start");
    const next = f.turn();
    await candidate.promise;
    try {
      if (outcome === "failure") releaseRecovery.reject(new Error("Synthetic delayed recovery failure"));
      else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(14_000);
      else releaseRecovery.resolve();
      await settled;
      assert.equal(f.ctx.signal?.aborted, false, "another provider must not abort the new run");
      assert.equal(await f.key(), outcome === "success" ? keyFor("primary") : FAIL_CLOSED_API_KEY);
      assert.equal(await f.registry.getApiKeyForProvider("anthropic"), keyFor("other-backup"));
      releaseQuota.resolve(allowance(f.ctx, 50));
      await next;
      assert.equal(await f.registry.getApiKeyForProvider("anthropic"), keyFor("other-backup"));
      assert.equal(queries, 2);
    } finally {
      releaseRecovery.resolve();
      releaseQuota.resolve(undefined);
      await Promise.allSettled([settled, next]);
    }
  });
}

test("old settled recovery cannot replace authentication verified by a newer model sync", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let queries = 0;
  let restorations = 0;
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  f.adapter.invalidateConnections = async (session) => {
    if (queries >= 2 && (await f.key()) === keyFor("primary")) {
      restorations++;
      if (restorations === 1) throw new Error("Synthetic first recovery failure");
      if (restorations === 2) {
        entered.resolve();
        await release.promise;
      }
    }
    await cleanup(session);
  };
  f.offer(() => {
    queries++;
    return queries === 1
      ? allowance(f.ctx, 0)
      : { status: "unavailable", providerId: f.id, reason: "auth-unavailable" };
  });
  await f.turn();
  f.setIdle(true);
  const settled = f.emit("agent_settled");
  await entered.promise;
  try {
    const next = f.registry.getAll().find((model) => model.provider === f.id && model.id !== f.ctx.model?.id);
    assert.ok(next);
    Object.assign(f.ctx, { model: next });
    await f.emit("model_select");
    assert.equal(await f.key(), keyFor("primary"));
    await vi.advanceTimersByTimeAsync(14_000);
    await settled;
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(queries, 2);
  } finally {
    release.resolve();
    await settled;
  }
});
