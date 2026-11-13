import assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import type { AccountActivationResult } from "../src/accounts-protocol.js";
import { allowance, enabled, failoverFixture, keyFor, type UsageCall } from "./account-failover-fixture.js";

for (const phase of ["authentication", "quota"] as const) {
  for (const policy of ["disabled", "no-service"] as const) {
    test(`a fresh owner resumes the accepted account during ${phase} with ${policy}, without old-owner cleanup`, async () => {
      const f = await failoverFixture({ active: "primary", fallback: enabled() });
      await f.start();
      const entries = f.selectionEntries().length;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const quota = Promise.withResolvers<unknown>();
      const cleanup = f.adapter.invalidateConnections;
      assert.ok(cleanup);
      let held = false;
      f.adapter.invalidateConnections = async (session) => {
        await cleanup(session);
        if (phase !== "authentication" || held || (await f.key()) !== keyFor("backup")) return;
        held = true;
        entered.resolve();
        await release.promise;
      };
      f.offer((call) => {
        if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
        entered.resolve();
        return quota.promise;
      });
      const boundary = f.turn();
      await entered.promise;
      try {
        assert.equal(await f.key(), keyFor("backup"), "the trial authentication is active only in memory");
        assert.equal(f.selection(), "primary");
        assert.equal(f.selectionEntries().length, entries);
        const resumed = await failoverFixture({
          active: "primary",
          fallback: { ...enabled(), enabled: policy !== "disabled" },
          service: false,
        });
        // A new factory/runtime cannot use the old owner's memory or cleanup. It sees
        // only the shared SessionManager's durable entries, as a resumed process does.
        Object.assign(resumed.ctx, { sessionManager: f.ctx.sessionManager });
        await resumed.start();
        await resumed.turn();
        assert.equal(resumed.selection(), "primary");
        assert.equal(await resumed.key(), keyFor("primary"));
        assert.equal(resumed.queries.length, 0);
        assert.equal(resumed.requests(), policy === "disabled" ? 0 : 1);
        assert.equal(resumed.selectionEntries().length, entries);
        assert.equal((await resumed.store.readProviderAsync(resumed.id)).active, "primary");
      } finally {
        f.cancel();
        release.resolve();
        quota.resolve(undefined);
        await boundary;
      }
    });
  }
}

for (const boundaryName of ["reload", "shutdown"] as const) {
  test(`${boundaryName} discards a quota-pending trial and keeps the saved original`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entries = f.selectionEntries().length;
    const entered = Promise.withResolvers<UsageCall>();
    const release = Promise.withResolvers<unknown>();
    f.offer((call) => {
      if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
      entered.resolve(call);
      return release.promise;
    });
    const boundary = f.turn();
    const call = await entered.promise;
    try {
      assert.equal(await f.key(), keyFor("backup"));
      if (boundaryName === "shutdown") await f.emit("session_shutdown");
      f.stopService();
      f.newRun();
      f.setIdle(true);
      await f.start();
      await boundary;
      await f.turn();
      assert.equal(call.request.signal.aborted, true);
      assert.equal(f.selection(), "primary");
      assert.equal(await f.key(), keyFor("primary"));
      assert.equal(f.selectionEntries().length, entries);
      release.resolve(allowance(f.ctx, 50));
      await Promise.resolve();
      assert.equal(f.selection(), "primary", "late trial evidence must not become durable");
    } finally {
      release.resolve(undefined);
      await boundary;
    }
  });
}

async function quotaTrial() {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const entered = Promise.withResolvers<UsageCall>();
  const release = Promise.withResolvers<unknown>();
  f.offer((call) => {
    if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
    entered.resolve(call);
    return release.promise;
  });
  const entries = f.selectionEntries().length;
  const boundary = f.turn();
  const call = await entered.promise;
  return { f, entries, boundary, call, release };
}

test("a selection for another provider cannot save an unaccepted trial in its snapshot", async () => {
  const { f, entries, boundary, release } = await quotaTrial();
  try {
    await f.store.updateProvider("anthropic", (state) => ({
      ...state,
      accounts: { ...state.accounts, manual: { type: "api_key", key: keyFor("other-provider") } },
    }));
    const result = await new Promise<AccountActivationResult>((reply) => {
      f.mock.eventBus.emit("accounts:activation:v1", {
        session: f.ctx.sessionManager,
        provider: "anthropic",
        account: "manual",
        reply,
      });
    });
    assert.equal(result.status, "active");
    await boundary;
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.selectionEntries().length, entries + 1);
    const last = f.selectionEntries().at(-1);
    assert.ok(last?.type === "custom");
    const providers = (last.data as { providers: Record<string, string | null> }).providers;
    assert.equal(providers.anthropic, "manual");
    assert.equal(providers.openrouter, "primary");
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

test("the account menu can select the accepted original while a different trial is active", async () => {
  const { f, entries, boundary, call, release } = await quotaTrial();
  try {
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("backup"));
    await f.manual("primary");
    await boundary;
    assert.equal(call.request.signal.aborted, true);
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.selectionEntries().length, entries + 1, "only the user's explicit choice is recorded");
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

test("removing an active trial cancels it and restores the original without persisting a candidate", async () => {
  const { f, entries, boundary, call, release } = await quotaTrial();
  try {
    await f.remove("backup");
    await boundary;
    assert.equal(call.request.signal.aborted, true);
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.selectionEntries().length, entries);
    assert.equal((await f.store.readProviderAsync(f.id)).accounts.backup, undefined);
    assert.equal(f.queries.length, 2, "removal is not permission to try another backup");
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

test("failure to persist an adequate candidate restores the original and does not scan further", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const entries = f.selectionEntries().length;
  const manager = f.ctx.sessionManager as SessionManager;
  const append = manager.appendCustomEntry.bind(manager);
  vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
    if (
      type === "pi-accounts-selection" &&
      (data as { providers?: Record<string, unknown> }).providers?.[f.id] === "backup"
    )
      throw new Error("Synthetic accepted-selection write failure");
    return append(type, data);
  });
  f.offer(({ key }) => allowance(f.ctx, key === keyFor("primary") ? 0 : 50));
  await f.turn();
  assert.equal(f.selection(), "primary");
  assert.equal(await f.key(), keyFor("primary"));
  assert.equal(f.selectionEntries().length, entries);
  assert.deepEqual(
    f.queries.map((call) => call.key),
    [keyFor("primary"), keyFor("backup")],
  );
});
