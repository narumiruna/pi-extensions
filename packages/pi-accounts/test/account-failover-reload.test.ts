import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  AccountFailover,
  allowance,
  enabled,
  failoverFixture,
  keyFor,
  type UsageCall,
} from "./account-failover-fixture.js";

async function fixture() {
  const reload = vi.spyOn(AccountFailover.prototype, "reload");
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const controller = reload.mock.contexts.at(-1) as InstanceType<typeof AccountFailover> | undefined;
  assert.ok(controller);
  f.offer(({ key }) => allowance(f.ctx, key === keyFor("primary") ? 0 : 50));
  return { f, controller };
}

test("a failed reload cannot keep a saved disabled policy enabled in memory", async () => {
  const { f, controller } = await fixture();
  await f.store.updateProvider(f.id, (state) => ({ ...state, fallback: { ...enabled(), enabled: false } }));
  vi.spyOn(f.store, "readAsync").mockRejectedValueOnce(new Error("Synthetic reload read failure"));
  await assert.rejects(controller.reload(), /Synthetic reload read failure/);
  assert.equal(controller.status(f.id), "Failover off.");
  await f.turn();
  assert.equal(f.requests(), 0);
  assert.equal(f.selection(), "primary");
  assert.equal(await f.key(), keyFor("primary"));

  await f.store.updateProvider(f.id, (state) => ({ ...state, fallback: enabled() }));
  await controller.reload();
  f.newRun();
  await f.turn();
  assert.equal(f.selection(), "backup", "a later successful reload can enable the policy again");
  assert.equal(f.requests(), 2);
});

test("a pending reload suspends automatic decisions until fresh settings arrive", async () => {
  const { f, controller } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.store.readAsync.bind(f.store);
  vi.spyOn(f.store, "readAsync").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const pending = controller.reload();
  await entered.promise;
  try {
    await f.turn();
    assert.equal(f.requests(), 0);
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(controller.status(f.id), "Failover off.");
  } finally {
    release.resolve();
    await pending;
  }
  f.newRun();
  await f.turn();
  assert.equal(f.selection(), "backup");
  assert.equal(f.requests(), 2);
});

test("a failed reload cancels candidate quota and verifies the original before the request gate opens", async () => {
  const { f, controller } = await fixture();
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
    await f.store.updateProvider(f.id, (state) => ({ ...state, fallback: { ...enabled(), enabled: false } }));
    vi.spyOn(f.store, "readAsync").mockRejectedValueOnce(new Error("Synthetic reload read failure"));
    await assert.rejects(controller.reload(), /Synthetic reload read failure/);
    assert.equal(call.request.signal.aborted, true);
    await boundary;
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.selection(), "primary");
    f.newRun();
    await f.turn();
    assert.equal(f.requests(), 2, "a failed reload cannot start another quota query");
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

for (const lateResult of ["success", "failure"] as const) {
  test(`an older reload ${lateResult} cannot replace a newer enabled policy`, async () => {
    const { f, controller } = await fixture();
    const oldData = await f.store.readAsync();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(f.store, "readAsync").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (lateResult === "failure") throw new Error("Synthetic old reload failure");
      return oldData;
    });
    const oldReload = controller.reload().then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await f.store.updateProvider(f.id, (state) => ({ ...state, fallback: enabled(["spare"]) }));
      await controller.reload();
    } finally {
      release.resolve();
      await oldReload;
    }
    assert.match(controller.status(f.id), /Backups: spare\./);
    await f.turn();
    assert.equal(f.selection(), "spare");
    assert.equal(f.requests(), 2);
  });
}
