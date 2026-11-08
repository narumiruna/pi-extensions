import assert from "node:assert/strict";
import { createEventBus, type EventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext as createContext, createMockPi } from "../../../test/support.js";
import {
  configureSyncStatus,
  createSyncStatusPublisher,
  type SyncStatusPresentation,
  setSyncStatus,
  syncStatusFailureReason,
} from "../src/ui/sync-status.js";

const UPDATE = "extension-status:v1:update";
const REQUEST = "extension-status:v1:request";

function createMockContext(options: Record<string, unknown>) {
  const mock = createContext(options);
  return { ...mock, ctx: mock.ctx as ExtensionContext };
}

function observe(bus: EventBus) {
  const updates: unknown[] = [];
  const stop = bus.on(UPDATE, (payload) => updates.push(payload));
  return { updates, stop };
}

function trackedBus() {
  const bus = createEventBus();
  const on = bus.on.bind(bus);
  const subscriptions = new Set<() => void>();
  bus.on = (channel, handler) => {
    const unsubscribe = on(channel, handler);
    if (channel !== REQUEST) return unsubscribe;
    const stop = () => {
      subscriptions.delete(stop);
      unsubscribe();
    };
    subscriptions.add(stop);
    return stop;
  };
  return {
    bus,
    get activeListeners() {
      return subscriptions.size;
    },
    dispose() {
      for (const stop of subscriptions) stop();
    },
  };
}

function record(
  ctx: ExtensionContext,
  value: string | undefined,
  presentation?: SyncStatusPresentation,
  requestId?: object,
) {
  return {
    version: 1,
    sessionManager: ctx.sessionManager,
    key: "sync",
    value,
    ...presentation,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

for (const action of ["bind", "start-same", "start-other", "new-factory"] as const) {
  test(`replacement bind ${action} reentry cannot orphan or replace a newer binding`, () => {
    const tracked = trackedBus();
    const { bus } = tracked;
    const mock = createMockContext({ mode: "rpc" });
    const other = createMockContext({ mode: "rpc" });
    const previous = createSyncStatusPublisher(bus);
    const publisher = createSyncStatusPublisher(bus);
    const newer = createSyncStatusPublisher(bus);
    previous.bind(mock.ctx);
    let reentered = false;
    const stop = bus.on(UPDATE, () => {
      if (reentered) return;
      reentered = true;
      if (action === "bind") publisher.bind(mock.ctx);
      else if (action === "start-same") publisher.start(mock.ctx);
      else if (action === "start-other") publisher.start(other.ctx);
      else newer.bind(mock.ctx);
    });
    try {
      const release = publisher.bind(mock.ctx);
      assert.equal(reentered, true);
      assert.equal(tracked.activeListeners, 1);
      release();
      assert.equal(tracked.activeListeners, action === "bind" ? 0 : 1);
    } finally {
      stop();
      previous.cleanupFor(mock.ctx)();
      publisher.cleanupFor(mock.ctx)();
      publisher.cleanupFor(other.ctx)();
      newer.cleanupFor(mock.ctx)();
      tracked.dispose();
    }
  });
}

for (const action of ["same-session", "other-session", "new-factory"] as const) {
  test(`an older start cannot claim ${action} binding created during its withdrawal`, () => {
    const tracked = trackedBus();
    const { bus } = tracked;
    const mock = createMockContext({ mode: "rpc" });
    const other = createMockContext({ mode: "rpc" });
    const publisher = createSyncStatusPublisher(bus);
    const newer = createSyncStatusPublisher(bus);
    publisher.bind(mock.ctx);
    const current = action === "other-session" ? other : mock;
    let reentered = false;
    const stop = bus.on(UPDATE, () => {
      if (reentered) return;
      reentered = true;
      if (action === "new-factory") newer.start(current.ctx);
      else publisher.start(current.ctx);
      setSyncStatus(current.ctx, "new review", { activity: "review" });
    });
    const observed = observe(bus);
    try {
      const release = publisher.start(mock.ctx);
      assert.equal(reentered, true);
      assert.equal(tracked.activeListeners, 1);
      observed.updates.length = 0;
      const requestId = {};
      bus.emit(REQUEST, { version: 1, sessionManager: current.ctx.sessionManager, requestId });
      assert.deepEqual(observed.updates, [record(current.ctx, "new review", { activity: "review" }, requestId)]);
      release();
      assert.equal(tracked.activeListeners, 1);
    } finally {
      stop();
      observed.stop();
      publisher.cleanupFor(mock.ctx)();
      publisher.cleanupFor(other.ctx)();
      newer.cleanupFor(mock.ctx)();
      tracked.dispose();
    }
  });
}

for (const action of ["update", "replace", "release"] as const) {
  test(`reentrant annotation ${action} cannot publish stale metadata`, () => {
    const bus = createEventBus();
    const mock = createMockContext({ mode: "rpc" });
    const publisher = createSyncStatusPublisher(bus);
    const release = publisher.bind(mock.ctx);
    const observed = observe(bus);
    const value = "same readable phase";
    try {
      setSyncStatus(mock.ctx, value, {
        get activity(): "idle" {
          if (action !== "update") release();
          if (action === "replace") publisher.start(mock.ctx);
          if (action !== "release") setSyncStatus(mock.ctx, value, { activity: "review" });
          return "idle";
        },
      });
      assert.deepEqual(
        observed.updates.at(-1),
        action === "release" ? record(mock.ctx, undefined) : record(mock.ctx, value, { activity: "review" }),
      );
    } finally {
      observed.stop();
      publisher.cleanupFor(mock.ctx)();
    }
  });
}

test("snapshot request identities are captured once before publication", () => {
  const bus = createEventBus();
  const mock = createMockContext({ mode: "rpc" });
  const publisher = createSyncStatusPublisher(bus);
  const release = publisher.bind(mock.ctx);
  const observed = observe(bus);
  const requestId = {};
  let reads = 0;
  try {
    setSyncStatus(mock.ctx, "review", { activity: "review" });
    observed.updates.length = 0;
    bus.emit(REQUEST, {
      version: 1,
      sessionManager: mock.ctx.sessionManager,
      get requestId() {
        return ++reads === 1 ? requestId : undefined;
      },
    });
    assert.equal(reads, 1);
    assert.deepEqual(observed.updates, [record(mock.ctx, "review", { activity: "review" }, requestId)]);
  } finally {
    observed.stop();
    release();
  }
});

test("a request getter cannot make a retired publisher reply for its replacement", () => {
  const bus = createEventBus();
  const mock = createMockContext({ mode: "rpc" });
  const publisher = createSyncStatusPublisher(bus);
  const release = publisher.bind(mock.ctx);
  const observed = observe(bus);
  try {
    bus.emit(REQUEST, {
      get version() {
        release();
        publisher.start(mock.ctx);
        setSyncStatus(mock.ctx, "review", { activity: "review" });
        return 1;
      },
      sessionManager: mock.ctx.sessionManager,
      requestId: {},
    });
    assert.deepEqual(observed.updates.at(-1), record(mock.ctx, "review", { activity: "review" }));
    assert.ok(observed.updates.every((entry) => !Object.hasOwn(entry as object, "requestId")));
  } finally {
    observed.stop();
    publisher.cleanupFor(mock.ctx)();
  }
});

test("withdrawal observers cannot revive first-use binding while release is in progress", () => {
  const bus = createEventBus();
  const mock = createMockContext({ mode: "rpc" });
  const publisher = createSyncStatusPublisher(bus);
  const release = publisher.bind(mock.ctx);
  const observed = observe(bus);
  let reentered = false;
  const stop = bus.on(UPDATE, (data) => {
    if ((data as { value?: unknown }).value === undefined && !reentered) {
      reentered = true;
      publisher.bind(mock.ctx);
    }
  });
  try {
    release();
    assert.equal(reentered, true);
    observed.updates.length = 0;
    bus.emit(REQUEST, { version: 1, sessionManager: mock.ctx.sessionManager, requestId: {} });
    assert.deepEqual(observed.updates, []);
  } finally {
    stop();
    observed.stop();
    publisher.cleanupFor(mock.ctx)();
  }
});

for (const [value, activity] of [
  ["sync waiting for changes", "idle"],
  ["sync waiting: another local owner", "idle"],
  ["sync ...", "checking"],
  ["sync checking", "checking"],
  ["checking home", "checking"],
  ["checking synced content for home", "checking"],
  ["sync syncing", "working"],
  ["pushing home", "pushing"],
  ["pulling home", "pulling"],
  ["sync resolving", "resolving"],
  ["sync ⇡", "local-change"],
  ["sync ⇣", "remote-change"],
  ["sync ⇕", "review"],
] as const) {
  test(`publisher preserves raw ${value} and supplies ${activity}`, () => {
    const bus = createEventBus();
    const mock = createMockContext({ mode: "rpc" });
    const publisher = createSyncStatusPublisher(bus);
    const release = publisher.bind(mock.ctx);
    const observed = observe(bus);
    const stopOrder = bus.on(UPDATE, (payload) => {
      observed.updates.push({ raw: mock.statuses.get("sync"), payload });
    });
    try {
      const presentation = { activity };
      setSyncStatus(mock.ctx, value, presentation);
      assert.equal(mock.statuses.get("sync"), value);
      assert.deepEqual(observed.updates, [
        record(mock.ctx, value, presentation),
        { raw: value, payload: record(mock.ctx, value, presentation) },
      ]);
    } finally {
      stopOrder();
      observed.stop();
      release();
    }
  });
}

for (const [kind, reason] of [
  ["transient", "temp"],
  ["contention", "busy"],
  ["stale", "stale"],
  ["authentication", "auth"],
  ["storage", "storage"],
  ["unsafe", "review"],
  ["model", "model"],
  ["budget", "limit"],
  ["unknown", "unknown"],
  [undefined, "unknown"],
] as const) {
  for (const activity of ["retry", "blocked"] as const) {
    test(`${activity} retains the Sync-owned ${String(kind)} reason as ${reason}`, () => {
      const mock = createMockContext({ mode: "tui" });
      const bus = createEventBus();
      const observed = observe(bus);
      const release = createSyncStatusPublisher(bus).bind(mock.ctx);
      try {
        assert.equal(syncStatusFailureReason(kind), reason);
        const value = activity === "retry" ? `sync retry scheduled: ${kind}` : `sync blocked: ${kind}`;
        const presentation = { activity, reason: syncStatusFailureReason(kind) };
        setSyncStatus(mock.ctx, value, presentation);
        assert.equal(mock.statuses.get("sync"), value);
        assert.deepEqual(observed.updates, [record(mock.ctx, value, presentation)]);
      } finally {
        release();
        observed.stop();
      }
    });
  }
}

test("runtime-unknown failure kinds cannot expose inherited labels or lose the safe unknown reason", () => {
  for (const kind of ["future-kind", "__proto__", "constructor", "toString", null, {}, 1])
    assert.equal(syncStatusFailureReason(kind as Parameters<typeof syncStatusFailureReason>[0]), "unknown");
});

test("repair is a presentation reason without changing a persistent failure category", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const observed = observe(bus);
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  try {
    const value = "sync blocked: private state or settings need repair";
    setSyncStatus(mock.ctx, value, { activity: "blocked", reason: "repair" });
    assert.deepEqual(observed.updates, [record(mock.ctx, value, { activity: "blocked", reason: "repair" })]);
  } finally {
    release();
    observed.stop();
  }
});

test("raw keys and values remain exact even when display sanitization is required", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const observed = observe(bus);
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  try {
    const value = "checking home\u001b[31m\n\u0007";
    setSyncStatus(mock.ctx, value, { activity: "checking" });
    assert.deepEqual([...mock.statuses], [["sync", value]]);
    assert.deepEqual(observed.updates, [record(mock.ctx, value, { activity: "checking" })]);
  } finally {
    release();
    observed.stop();
  }
});

test("same raw values can change activity, and snapshots echo only the current record", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const publisher = createSyncStatusPublisher(bus);
  const release = publisher.bind(mock.ctx);
  const observed = observe(bus);
  try {
    setSyncStatus(mock.ctx, "same raw", { activity: "checking" });
    setSyncStatus(mock.ctx, "same raw", { activity: "review" });
    const requestId = {};
    const request = Object.freeze({ version: 1, sessionManager: mock.ctx.sessionManager, requestId });
    const before = new Map(mock.statuses);
    bus.emit(REQUEST, request);
    assert.deepEqual(mock.statuses, before, "snapshot does not publish or clear raw status");
    assert.deepEqual(observed.updates, [
      record(mock.ctx, "same raw", { activity: "checking" }),
      record(mock.ctx, "same raw", { activity: "review" }),
      record(mock.ctx, "same raw", { activity: "review" }, requestId),
    ]);
    assert.equal((observed.updates.at(-1) as { requestId: object }).requestId, requestId);
  } finally {
    release();
    observed.stop();
  }
});

test("unannotated, empty, cleared and disabled statuses withdraw without stale enable replay", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const observed = observe(bus);
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  const request = () => {
    const requestId = {};
    bus.emit(REQUEST, { version: 1, sessionManager: mock.ctx.sessionManager, requestId });
    assert.deepEqual(observed.updates.at(-1), record(mock.ctx, undefined, undefined, requestId));
  };
  try {
    for (const value of ["unannotated", "", undefined]) {
      setSyncStatus(mock.ctx, "same", { activity: "working" });
      setSyncStatus(mock.ctx, value);
      assert.equal(mock.statuses.get("sync"), value);
      assert.deepEqual(observed.updates.at(-1), record(mock.ctx, undefined));
      request();
    }
    setSyncStatus(mock.ctx, "same", { activity: "working" });
    configureSyncStatus(mock.ctx, false);
    assert.equal(mock.statuses.get("sync"), undefined);
    assert.deepEqual(observed.updates.at(-1), record(mock.ctx, undefined));
    const count = observed.updates.length;
    setSyncStatus(mock.ctx, "suppressed", { activity: "review" });
    assert.equal(observed.updates.length, count);
    configureSyncStatus(mock.ctx, true);
    assert.equal(observed.updates.length, count);
    assert.equal(mock.statuses.get("sync"), undefined);
    request();
    setSyncStatus(mock.ctx, "fresh", { activity: "pulling" });
    assert.deepEqual(observed.updates.at(-1), record(mock.ctx, "fresh", { activity: "pulling" }));
  } finally {
    release();
    observed.stop();
  }
});

test("malformed snapshots are ignored and valid opaque request identities are echoed synchronously", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  const observed = observe(bus);
  try {
    setSyncStatus(mock.ctx, "sync checking", { activity: "checking" });
    const valid = { version: 1, sessionManager: mock.ctx.sessionManager, requestId: {} };
    const count = observed.updates.length;
    for (const request of [
      undefined,
      null,
      false,
      "request",
      [],
      {},
      { ...valid, version: 0 },
      { ...valid, version: "1" },
      { ...valid, sessionManager: {} },
      { ...valid, sessionManager: null },
      { ...valid, requestId: null },
      { ...valid, requestId: undefined },
      { ...valid, requestId: "id" },
      { ...valid, requestId: 1 },
      { ...valid, requestId: () => {} },
      Object.defineProperty({}, "version", {
        get() {
          throw new Error("malformed optional input");
        },
      }),
    ])
      bus.emit(REQUEST, request);
    assert.equal(observed.updates.length, count);
    for (const requestId of [{}, [], new Date(0)]) {
      bus.emit(REQUEST, Object.freeze({ ...valid, requestId }));
      assert.deepEqual(observed.updates.at(-1), record(mock.ctx, "sync checking", { activity: "checking" }, requestId));
      assert.equal((observed.updates.at(-1) as { requestId: object }).requestId, requestId);
    }
  } finally {
    release();
    observed.stop();
  }
});

test("invalid descriptors withdraw metadata without changing raw status or leaking fields", () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const observed = observe(bus);
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  try {
    for (const presentation of [
      { activity: "unknown" },
      { activity: "retry" },
      { activity: "blocked", reason: "" },
      { activity: "retry", reason: "Auth" },
      { activity: "retry", reason: "a".repeat(33) },
      ...["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0000", "\u001b"].map((suffix) => ({
        activity: "blocked",
        reason: `auth${suffix}`,
      })),
      { activity: "checking", reason: "auth" },
      Object.defineProperty({}, "activity", {
        get() {
          throw new Error("invalid annotation");
        },
      }),
    ]) {
      setSyncStatus(mock.ctx, "same raw", { activity: "review" });
      setSyncStatus(mock.ctx, "same raw", presentation as SyncStatusPresentation);
      assert.equal(mock.statuses.get("sync"), "same raw");
      assert.deepEqual(observed.updates.at(-1), record(mock.ctx, undefined));
    }
    setSyncStatus(mock.ctx, "same raw", { activity: "checking", secret: "not metadata" } as SyncStatusPresentation);
    assert.deepEqual(observed.updates.at(-1), record(mock.ctx, "same raw", { activity: "checking" }));
  } finally {
    release();
    observed.stop();
  }
});

test("raw status works outside the factory, without a bus, and without a consumer", () => {
  for (const events of [undefined, createEventBus(), createMockPi().eventBus]) {
    const mock = createMockContext({ mode: "rpc" });
    setSyncStatus(mock.ctx, "outside factory", { activity: "checking" });
    assert.equal(mock.statuses.get("sync"), "outside factory");
    const release = createSyncStatusPublisher(events).bind(mock.ctx);
    setSyncStatus(mock.ctx, "sync syncing", { activity: "working" });
    assert.equal(mock.statuses.get("sync"), "sync syncing");
    release();
    assert.equal(mock.statuses.get("sync"), "sync syncing", "metadata release does not change raw UI");
  }
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} does not publish raw or presentation values`, () => {
    const mock = createMockContext({ mode });
    const bus = createEventBus();
    const observed = observe(bus);
    const subscribe = vi.spyOn(bus, "on");
    const release = createSyncStatusPublisher(bus).bind(mock.ctx);
    try {
      setSyncStatus(mock.ctx, "not observable", { activity: "checking" });
      assert.equal(mock.statuses.size, 0);
      assert.deepEqual(observed.updates, []);
      assert.equal(subscribe.mock.calls.length, 0, "headless sessions need no snapshot listener");
    } finally {
      release();
      observed.stop();
      subscribe.mockRestore();
    }
  });
}

test("core event delivery starts synchronously and catches asynchronous observer failure", async () => {
  const mock = createMockContext({ mode: "rpc" });
  const bus = createEventBus();
  const release = createSyncStatusPublisher(bus).bind(mock.ctx);
  const failure = new Error("optional asynchronous consumer failed");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let entered = false;
  const stop = bus.on(UPDATE, async () => {
    entered = true;
    throw failure;
  });
  try {
    setSyncStatus(mock.ctx, "sync syncing", { activity: "working" });
    assert.equal(entered, true);
    assert.equal(mock.statuses.get("sync"), "sync syncing");
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(errors.mock.calls.some((args) => args[1] === failure));
  } finally {
    stop();
    release();
    errors.mockRestore();
  }
});

for (const failure of ["emit", "on", "unsubscribe"] as const) {
  test(`optional ${failure} failure cannot interrupt raw publication or cleanup`, () => {
    const mock = createMockContext({ mode: "rpc" });
    let listener: ((payload: unknown) => void) | undefined;
    let removals = 0;
    const bus: EventBus = {
      emit() {
        if (failure === "emit") throw new Error("delivery failed");
      },
      on(_channel, handler) {
        if (failure === "on") throw new Error("subscription failed");
        listener = handler;
        return () => {
          removals++;
          if (failure === "unsubscribe") throw new Error("unsubscribe failed");
        };
      },
    };
    const publisher = createSyncStatusPublisher(bus);
    const release = publisher.bind(mock.ctx);
    setSyncStatus(mock.ctx, "sync checking", { activity: "checking" });
    assert.equal(mock.statuses.get("sync"), "sync checking");
    listener?.({ version: 1, sessionManager: mock.ctx.sessionManager, requestId: {} });
    configureSyncStatus(mock.ctx, false);
    assert.equal(mock.statuses.get("sync"), undefined);
    release();
    release();
    assert.equal(removals, failure === "on" ? 0 : 1);
  });
}
