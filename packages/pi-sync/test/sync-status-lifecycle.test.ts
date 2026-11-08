import assert from "node:assert/strict";
import { createEventBus, type EventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createSyncStatusPublisher, setSyncStatus } from "../src/ui/sync-status.js";
import { withTempHome } from "./helpers.js";
import { deferred } from "./startup-check-helpers.js";

const UPDATE = "extension-status:v1:update";
const REQUEST = "extension-status:v1:request";

function capture(bus: EventBus) {
  const updates: Array<{ sessionManager: object; value: string | undefined; activity?: string; requestId?: object }> =
    [];
  const stop = bus.on(UPDATE, (payload) => {
    updates.push(payload as (typeof updates)[number]);
  });
  function snapshot(ctx: ExtensionContext) {
    const requestId = {};
    const count = updates.length;
    bus.emit(REQUEST, { version: 1, sessionManager: ctx.sessionManager, requestId });
    return updates.slice(count).filter((update) => update.requestId === requestId);
  }
  return { updates, snapshot, stop };
}

test("initial and reload snapshots work in either load order without replaying a retired record", () => {
  const bus = createEventBus();
  const mock = createMockContext({ mode: "rpc" });
  const observed = capture(bus);
  const publisher = createSyncStatusPublisher(bus);
  assert.deepEqual(observed.snapshot(mock.ctx), []);
  const oldRelease = publisher.bind(mock.ctx);
  assert.equal(observed.snapshot(mock.ctx)[0]?.value, undefined);
  setSyncStatus(mock.ctx, "sync checking", { activity: "checking" });
  observed.stop();

  // A later consumer, or a reloaded consumer, gets current state without a producer update.
  const late = capture(bus);
  const release = publisher.bind(mock.ctx);
  assert.equal(release, oldRelease, "first-use binding does not replace its active session");
  assert.equal(late.snapshot(mock.ctx)[0]?.activity, "checking");
  oldRelease();
  assert.deepEqual(late.snapshot(mock.ctx), []);
  const reloaded = createSyncStatusPublisher(bus);
  const reloadedRelease = reloaded.bind(mock.ctx);
  try {
    assert.equal(late.snapshot(mock.ctx)[0]?.value, undefined);
    setSyncStatus(mock.ctx, "sync resolving", { activity: "resolving" });
    oldRelease();
    assert.equal(late.snapshot(mock.ctx)[0]?.activity, "resolving");
    assert.equal(mock.statuses.get("sync"), "sync resolving");
  } finally {
    reloadedRelease();
    late.stop();
  }
});

test("replacement and late release are keyed by session manager even when sessions share one UI", () => {
  const bus = createEventBus();
  const first = createMockContext({ mode: "rpc" });
  const second = createMockContext({ mode: "rpc", ui: (first.ctx as ExtensionContext).ui });
  const publisher = createSyncStatusPublisher(bus);
  const observed = capture(bus);
  const oldRelease = publisher.start(first.ctx);
  setSyncStatus(first.ctx, "old", { activity: "checking" });
  const release = publisher.start(second.ctx);
  try {
    assert.deepEqual(observed.snapshot(first.ctx), []);
    assert.equal(observed.snapshot(second.ctx)[0]?.value, undefined);
    setSyncStatus(second.ctx, "new", { activity: "review" });
    oldRelease();
    assert.equal(first.statuses.get("sync"), "new", "old metadata release must not clear shared raw UI");
    assert.equal(observed.snapshot(second.ctx)[0]?.activity, "review");
    publisher.cleanupFor(first.ctx)();
    assert.equal(observed.snapshot(second.ctx)[0]?.activity, "review");
  } finally {
    release();
    observed.stop();
  }
});

test("stale first-use binding cannot replace or annotate the current manager", () => {
  const bus = createEventBus();
  const first = createMockContext({ mode: "rpc" });
  const second = createMockContext({ mode: "rpc" });
  const publisher = createSyncStatusPublisher(bus);
  const observed = capture(bus);
  const oldRelease = publisher.start(first.ctx);
  const release = publisher.start(second.ctx);
  try {
    setSyncStatus(second.ctx, "current", { activity: "review" });
    const staleRelease = publisher.bind(first.ctx);
    setSyncStatus(first.ctx, "stale", { activity: "checking" });
    staleRelease();
    oldRelease();
    assert.deepEqual(observed.snapshot(first.ctx), []);
    assert.equal(observed.snapshot(second.ctx)[0]?.activity, "review");
    assert.equal(second.statuses.get("sync"), "current");
  } finally {
    release();
    observed.stop();
  }
});

for (const replacement of ["same factory", "new factory"] as const) {
  test(`late release cannot withdraw newer metadata for the same manager (${replacement})`, () => {
    const bus = createEventBus();
    const mock = createMockContext({ mode: "rpc" });
    const publisher = createSyncStatusPublisher(bus);
    const observed = capture(bus);
    const oldRelease = publisher.start(mock.ctx);
    const capturedCleanup = publisher.cleanupFor(mock.ctx);
    setSyncStatus(mock.ctx, "same raw", { activity: "checking" });
    const replacementPublisher = replacement === "same factory" ? publisher : createSyncStatusPublisher(bus);
    const release = replacementPublisher.start(mock.ctx);
    try {
      setSyncStatus(mock.ctx, "same raw", { activity: "review" });
      const before = observed.updates.length;
      oldRelease();
      capturedCleanup();
      if (replacement === "new factory") publisher.bind(mock.ctx)();
      assert.equal(observed.updates.length, before);
      const replies = observed.snapshot(mock.ctx);
      assert.equal(replies.length, 1, "only the current listener responds");
      assert.equal(replies[0]?.activity, "review");
      assert.equal(mock.statuses.get("sync"), "same raw");
    } finally {
      release();
      release();
      assert.deepEqual(observed.snapshot(mock.ctx), []);
      observed.stop();
    }
  });
}

test("independent publishers do not share current metadata through a shared no-op UI", () => {
  const bus = createEventBus();
  const first = createMockContext({ mode: "rpc" });
  const second = createMockContext({ mode: "rpc", ui: (first.ctx as ExtensionContext).ui });
  const firstPublisher = createSyncStatusPublisher(bus);
  const secondPublisher = createSyncStatusPublisher(bus);
  const observed = capture(bus);
  const releaseFirst = firstPublisher.bind(first.ctx);
  const releaseSecond = secondPublisher.bind(second.ctx);
  try {
    setSyncStatus(first.ctx, "first raw", { activity: "checking" });
    setSyncStatus(second.ctx, "second raw", { activity: "review" });
    assert.equal(observed.snapshot(first.ctx)[0]?.activity, "checking");
    assert.equal(observed.snapshot(second.ctx)[0]?.activity, "review");
    releaseFirst();
    assert.deepEqual(observed.snapshot(first.ctx), []);
    assert.equal(observed.snapshot(second.ctx)[0]?.activity, "review");
  } finally {
    releaseFirst();
    releaseSecond();
    observed.stop();
  }
});

for (const boundary of ["failed initialization", "reload", "shutdown", "aborted shutdown", "first use"] as const) {
  test(`factory releases its optional listener at ${boundary}`, async () =>
    withTempHome(async () => {
      vi.resetModules();
      const pausedShutdown = deferred();
      const enteredShutdown = deferred();
      let initializations = 0;
      vi.doMock("../src/sync/automatic-sync.js", () => ({
        startSession: async () => {
          if (boundary === "failed initialization" && initializations++ === 0) throw new Error("local recovery failed");
          return { debug: false };
        },
        autoPushSessions: async () => {
          if (boundary === "aborted shutdown") {
            enteredShutdown.resolve();
            await pausedShutdown.promise;
          }
        },
      }));
      try {
        const { default: extension } = await import("../src/sync-extension.js");
        const status = await import("../src/ui/sync-status.js");
        const mock = createMockPi();
        const context = createMockContext({ mode: "rpc" });
        const observed = capture(mock.eventBus);
        extension(mock.pi, { loadCommandHandler: async () => ({ handleCommand: async () => {} }) });
        const start = mock.events.get("session_start")?.[0];
        const shutdown = mock.events.get("session_shutdown")?.[0];
        assert.ok(start);
        assert.ok(shutdown);
        if (boundary === "first use") await mock.commands.get("sync")?.handler("help", context.ctx);
        else await start({ reason: "startup" }, context.ctx);
        if (boundary === "failed initialization") {
          assert.deepEqual(observed.snapshot(context.ctx), [], "partial initialization retains no listener");
          assert.ok(
            context.notifications.some((notification) => notification.message.includes("local recovery failed")),
          );
          await mock.commands.get("sync")?.handler("help", context.ctx);
          status.setSyncStatus(context.ctx, "readable fallback", { activity: "checking" });
          assert.equal(context.statuses.get("sync"), "readable fallback");
          assert.deepEqual(observed.snapshot(context.ctx), [], "Help cannot re-subscribe a failed publisher");
          await start({ reason: "reload" }, context.ctx);
          assert.equal(observed.snapshot(context.ctx).length, 1, "explicit start reactivates publication");
        } else {
          status.setSyncStatus(context.ctx, "sync checking", { activity: "checking" });
          assert.equal(observed.snapshot(context.ctx)[0]?.activity, "checking");
        }
        if (boundary === "aborted shutdown") {
          const pending = shutdown({ reason: "exit" }, context.ctx);
          await enteredShutdown.promise;
          // Starting a replacement aborts the old shutdown while preserving its captured cleanup.
          const replacement = createMockContext({ mode: "rpc" });
          const replacing = start({ reason: "new" }, replacement.ctx);
          pausedShutdown.resolve();
          await pending;
          await replacing;
          assert.deepEqual(observed.snapshot(context.ctx), []);
          status.setSyncStatus(replacement.ctx, "new", { activity: "review" });
          assert.equal(observed.snapshot(replacement.ctx)[0]?.activity, "review");
          await shutdown({ reason: "reload" }, replacement.ctx);
        } else {
          await shutdown({ reason: boundary === "shutdown" ? "exit" : "reload" }, context.ctx);
          await shutdown({ reason: "reload" }, context.ctx);
          assert.deepEqual(observed.snapshot(context.ctx), []);
        }
        observed.stop();
      } finally {
        pausedShutdown.resolve();
        vi.doUnmock("../src/sync/automatic-sync.js");
        vi.resetModules();
      }
    }));
}
