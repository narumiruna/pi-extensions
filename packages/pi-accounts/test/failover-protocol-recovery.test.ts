import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { AccountActivationResult } from "../src/accounts-protocol.js";
import { allowance, enabled, failoverFixture, keyFor, type UsageCall } from "./account-failover-fixture.js";

for (const failure of ["missing", "cancelled", "store"] as const) {
  test(`an explicit request that fails before commit (${failure}) cannot discard candidate recovery`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    await f.ready("anthropic");
    await f.ready();
    const entered = Promise.withResolvers<UsageCall>();
    const quota = Promise.withResolvers<unknown>();
    f.offer((call) => {
      if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
      entered.resolve(call);
      return quota.promise;
    });
    const boundary = f.turn();
    await entered.promise;
    assert.equal(f.selection(), "backup");
    const read = f.store.readAsync.bind(f.store);
    const lookup = Promise.withResolvers<void>();
    const controller = new AbortController();
    let first = true;
    if (failure !== "missing") {
      f.store.readAsync = async (signal) => {
        if (!first) return read(signal);
        first = false;
        lookup.resolve();
        if (failure === "store") throw new Error("Synthetic store failure");
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
        return read(signal);
      };
    }
    try {
      const result = new Promise<AccountActivationResult>((reply) => {
        f.mock.eventBus.emit("accounts:activation:v1", {
          session: f.ctx.sessionManager,
          provider: f.id,
          account: failure === "missing" ? "missing" : "manual",
          signal: controller.signal,
          reply,
        });
      });
      if (failure !== "missing") await lookup.promise;
      if (failure === "cancelled") controller.abort();
      assert.deepEqual(await result, {
        status: "error",
        providerId: f.id,
        accountName: failure === "missing" ? "missing" : "manual",
        code: failure === "missing" ? "account_not_found" : failure === "cancelled" ? "cancelled" : "store_unavailable",
      });
      quota.resolve(allowance(f.ctx, 50));
      await boundary;
      assert.equal(f.selection(), "primary");
      assert.equal(await f.key(), keyFor("primary"));
      assert.equal((await f.store.readProviderAsync(f.id)).active, "primary");
      f.newRun();
      await f.turn();
      assert.equal(f.selection(), "primary", "an unaccepted candidate must not become the next request's selection");
    } finally {
      controller.abort();
      quota.resolve(undefined);
      await boundary;
      f.store.readAsync = read;
    }
  });
}

test("pending explicit lookup defers recovery with a bounded blocked gate, then failed lookup permits restoration", async () => {
  vi.useFakeTimers();
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  await f.ready("anthropic");
  await f.ready();
  const entered = Promise.withResolvers<UsageCall>();
  const quota = Promise.withResolvers<unknown>();
  f.offer((call) => {
    if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
    entered.resolve(call);
    return quota.promise;
  });
  const boundary = f.turn();
  await entered.promise;
  const read = f.store.readAsync.bind(f.store);
  const lookup = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  f.store.readAsync = async (signal) => {
    if (first) {
      first = false;
      lookup.resolve();
      await release.promise;
    }
    return read(signal);
  };
  const request = f.activate("missing");
  await lookup.promise;
  try {
    quota.resolve(allowance(f.ctx, 50));
    await vi.advanceTimersByTimeAsync(14_000);
    await boundary;
    assert.equal(f.ctx.signal?.aborted, true);
    assert.notEqual(await f.key(), keyFor("backup"), "the gate cannot publish unaccepted candidate auth");
    release.resolve();
    assert.equal((await request).status, "error");
    f.setIdle(true);
    await f.emit("agent_settled");
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    release.resolve();
    quota.resolve(undefined);
    await request;
    await boundary;
    f.store.readAsync = read;
  }
});
