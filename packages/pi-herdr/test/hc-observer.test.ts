import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createHcWidgetObserver } from "../src/hc-observer.js";
import { HERDR_WIDGET_KEY } from "../src/herdr-widget.js";

const theme = { bold: (value: string) => value, fg: (_role: string, value: string) => value } as Theme;
function terminal(address: string, parent?: string) {
  return {
    address,
    parent,
    created_ms: 1,
    argv: ["/trusted/node", "/trusted/pi.js"],
    cwd: "/repo",
    labels: {},
    state: "live",
    reported: true,
    status: { app: "pi", state: "idle" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("hc observer did not reach the expected state");
}
function fixture(retryDelayMs = 0) {
  const context = createMockContext({ mode: "tui", hasUI: true, theme });
  const state = {
    terminals: [terminal("t1"), terminal("t2", "t1")],
    lists: 0,
    active: 0,
    maxActive: 0,
    closes: 0,
    attempts: 0,
    read: undefined as ((signal: AbortSignal) => Promise<unknown>) | undefined,
    subscribeGate: undefined as Promise<void> | undefined,
    subscribeError: undefined as Error | undefined,
    snapshot: undefined as unknown,
    closeError: undefined as Error | undefined,
  };
  const subscriptions: Array<{ emit(frame: unknown): void; fail(): void; signal: AbortSignal }> = [];
  const observer = createHcWidgetObserver({
    environment: { terminalId: "t1", socketEndpoint: "/unused" },
    retryDelayMs,
    async request(_endpoint, method, params, options) {
      assert.equal(method, "terminal.list");
      assert.deepEqual(params, { all: true }); // Retain finished ancestors, without a caller that marks news seen.
      state.lists += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        return await (state.read?.(options?.signal as AbortSignal) ?? { terminals: structuredClone(state.terminals) });
      } finally {
        state.active -= 1;
      }
    },
    async subscribe(_endpoint, options) {
      state.attempts += 1;
      if (state.subscribeError) throw state.subscribeError;
      const finished = deferred<Error | undefined>();
      const signal = options?.signal as AbortSignal;
      const abort = () => finished.resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
      subscriptions.push({
        emit: (frame) => options?.onEvent?.(frame),
        fail: () => finished.resolve(new Error("lost")),
        signal,
      });
      await state.subscribeGate;
      return {
        snapshot: state.snapshot ?? { seq: 0, terminals: structuredClone(state.terminals) },
        closed: finished.promise,
        async close() {
          state.closes += 1;
          signal.removeEventListener("abort", abort);
          finished.resolve(undefined);
          if (state.closeError) throw state.closeError;
        },
      };
    },
  });
  let seq = 0;
  return {
    ...context,
    state,
    subscriptions,
    observer,
    emit(method = "event", params: Record<string, unknown> = {}) {
      subscriptions
        .at(-1)
        ?.emit({ jsonrpc: "2.0", method, params: { seq: ++seq, type: "status", terminal: "t2", data: {}, ...params } });
    },
    text() {
      const factory = context.widgets.get(HERDR_WIDGET_KEY);
      if (typeof factory !== "function") return "";
      return factory({ terminal: { rows: 36 }, requestRender() {} }, theme)
        .render(120)
        .join("\n");
    },
    ready: () => until(() => typeof context.widgets.get(HERDR_WIDGET_KEY) === "function"),
  };
}

test("hc widget uses authoritative facts, native terminal ancestry and no seen-news mutation", async () => {
  const f = fixture();
  try {
    f.observer.start(f.ctx);
    await f.ready();
    assert.match(f.text(), /hc/u);
    assert.match(f.text(), /terminal spawned by you/u);
    const target = f.state.terminals[1];
    assert.ok(target);
    target.status.state = "error";
    const reads = f.state.lists;
    f.emit("event", { data: { status: { app: "pi", state: "blocked" } } });
    await until(() => f.state.lists > reads && f.state.active === 0);
    assert.match(f.text(), /! error/u);
    assert.doesNotMatch(f.text(), /blocked/u);
    assert.equal(f.state.maxActive, 1);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("hc authoritative reads retain named finished ancestors of outliving peers", async () => {
  const f = fixture();
  const ancestor = { ...terminal("t3"), name: "former-peer", state: "finished", status: { app: "pi", state: "done" } };
  f.state.terminals.push(ancestor);
  const target = f.state.terminals[1];
  assert.ok(target);
  target.parent = "t3";
  try {
    f.observer.start(f.ctx);
    await f.ready();
    assert.match(f.text(), /terminal spawned by former-peer\/t3/u);
    assert.doesNotMatch(f.text(), /unavailable/u);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("hc accepts global sequence gaps, ignores old frames/heartbeats, and refreshes missed snapshots", async () => {
  const f = fixture();
  try {
    f.observer.start(f.ctx);
    await f.ready();
    f.emit("event", { seq: 100 });
    await until(() => f.state.lists === 2 && f.state.active === 0);
    f.emit("event", { seq: 99 });
    f.emit("heartbeat", { seq: 101 });
    f.emit("event", { seq: 102, type: "doc", terminal: undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.lists, 2);
    const pending = deferred<unknown>();
    f.state.read = () => pending.promise;
    f.emit("missed", { seq: 200, terminals: f.state.terminals });
    await until(() => f.state.lists === 3);
    assert.equal(f.text(), "");
    f.emit("event", { seq: 150 });
    f.state.read = undefined;
    pending.resolve({ terminals: f.state.terminals });
    await f.ready();
    assert.equal(f.state.lists, 3);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("hc coalesces bursts into serialized reads and never publishes a held stale result", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  try {
    let held = true;
    f.state.read = () => (held ? pending.promise : Promise.resolve({ terminals: f.state.terminals }));
    f.observer.start(f.ctx);
    await until(() => f.state.active === 1);
    const old = structuredClone(f.state.terminals);
    const target = f.state.terminals[1];
    assert.ok(target);
    target.status.state = "working";
    for (let index = 0; index < 2000; index += 1) f.emit();
    held = false;
    pending.resolve({ terminals: old });
    await f.ready();
    assert.match(f.text(), /working/u);
    assert.equal(f.state.lists, 2);
    assert.equal(f.state.maxActive, 1);
  } finally {
    pending.resolve({ terminals: f.state.terminals });
    await f.observer.shutdown(f.ctx);
  }
});

for (const peers of [true, false]) {
  test(`hc renews its consecutive-failure budget after healthy snapshots (peers: ${peers})`, async () => {
    const f = fixture();
    if (!peers) f.state.terminals = [terminal("t1")];
    let pending: ReturnType<typeof deferred<unknown>> | undefined;
    try {
      f.observer.start(f.ctx);
      await until(() => f.state.lists === 1 && f.state.active === 0);
      for (let episode = 1; episode <= 3; episode += 1) {
        const held = deferred<unknown>();
        pending = held;
        f.state.read = () => held.promise;
        f.subscriptions.at(-1)?.fail();
        await until(() => f.state.attempts === episode + 1 && f.state.active === 1);
        assert.equal(f.text(), "");
        f.state.read = undefined;
        held.resolve({ terminals: f.state.terminals });
        await until(() => f.state.active === 0);
        assert.equal(f.state.closes, episode);
        if (peers) await f.ready();
        else assert.equal(f.text(), "");
      }
      assert.equal(f.state.attempts, 4);
    } finally {
      pending?.resolve({ terminals: f.state.terminals });
      await f.observer.shutdown(f.ctx);
    }
  });
}

for (const failure of ["subscription", "list", "invalid-list", "snapshot"] as const) {
  test(`hc stops and hides after two unhealthy ${failure} attempts`, async () => {
    const f = fixture();
    try {
      f.observer.start(f.ctx);
      await f.ready();
      if (failure === "subscription") f.state.subscribeError = new Error("unavailable");
      if (failure === "list")
        f.state.read = async () => {
          throw new Error("list unavailable");
        };
      if (failure === "invalid-list") f.state.read = async () => ({ terminals: [{}] });
      if (failure === "snapshot") f.state.snapshot = { seq: -1, terminals: [] };
      f.subscriptions[0]?.fail();
      // The healthy connection's disconnect starts the outage; one failed retry exhausts it.
      await until(() => f.state.attempts === 2 && f.state.closes === (failure === "subscription" ? 1 : 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.state.attempts, 2);
      assert.equal(f.text(), "");
    } finally {
      await f.observer.shutdown(f.ctx);
    }
  });
}

for (const failure of ["subscription", "list", "invalid-list", "snapshot"] as const) {
  test(`hc bounds initial ${failure} failures without treating acknowledgement as healthy`, async () => {
    const f = fixture();
    if (failure === "subscription") f.state.subscribeError = new Error("unavailable");
    if (failure === "list")
      f.state.read = async () => {
        throw new Error("list unavailable");
      };
    if (failure === "invalid-list") f.state.read = async () => ({ terminals: [{}] });
    if (failure === "snapshot") f.state.snapshot = { seq: -1, terminals: [] };
    try {
      f.observer.start(f.ctx);
      await until(() => f.state.attempts === 2 && (failure === "subscription" || f.state.closes === 2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.state.attempts, 2);
      assert.equal(f.state.lists, failure === "list" || failure === "invalid-list" ? 2 : 0);
      assert.equal(f.text(), "");
    } finally {
      await f.observer.shutdown(f.ctx);
    }
  });
}

test("hc waits 200ms per outage and shutdown cancels a pending retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture(200);
  try {
    f.observer.start(f.ctx);
    await f.ready();
    f.subscriptions[0]?.fail();
    await until(() => f.state.closes === 1 && vi.getTimerCount() === 1);
    assert.equal(f.text(), "");
    await vi.advanceTimersByTimeAsync(199);
    assert.equal(f.state.attempts, 1);
    await vi.advanceTimersByTimeAsync(1);
    await f.ready();
    assert.equal(f.state.attempts, 2);
    f.subscriptions[1]?.fail();
    await until(() => f.state.closes === 2 && vi.getTimerCount() === 1);
    await f.observer.shutdown(f.ctx);
    assert.equal(vi.getTimerCount(), 0);
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(f.state.attempts, 2);
  } finally {
    await f.observer.shutdown(f.ctx);
    vi.useRealTimers();
  }
});

test("hc shutdown aborts pending reads, drains late subscription acquisition, and is repeatable", async () => {
  const f = fixture();
  const gate = deferred<void>();
  f.state.subscribeGate = gate.promise;
  f.observer.start(f.ctx);
  await until(() => f.state.attempts === 1);
  let settled = false;
  const shutdown = f.observer.shutdown(f.ctx).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.subscriptions[0]?.signal.aborted, true);
  gate.resolve();
  await shutdown;
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.lists, 0);
  f.subscriptions[0]?.emit({ jsonrpc: "2.0", method: "event", params: { seq: 10, type: "status", terminal: "t2" } });
  assert.equal(f.text(), "");
  assert.equal(f.state.attempts, 1);
  await f.observer.shutdown(f.ctx);
});

test("hc drains a held stale read without reviving a replaced session", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  f.state.read = () => pending.promise;
  f.observer.start(f.ctx);
  await until(() => f.state.active === 1);
  const replacement = createMockContext({ mode: "tui", hasUI: true, theme });
  try {
    f.state.read = undefined;
    f.observer.start(replacement.ctx);
    await until(() => typeof replacement.widgets.get(HERDR_WIDGET_KEY) === "function");
    pending.resolve({ terminals: f.state.terminals });
    await until(() => f.state.active === 0 && f.state.closes === 1);
    f.subscriptions[0]?.emit({ jsonrpc: "2.0", method: "event", params: { seq: 100, type: "status", terminal: "t2" } });
    assert.equal(f.text(), "");
    assert.equal(f.state.attempts, 2);
    assert.equal(f.state.lists, 2);
    assert.equal(typeof replacement.widgets.get(HERDR_WIDGET_KEY), "function");
  } finally {
    pending.resolve({ terminals: f.state.terminals });
    await f.observer.shutdown(replacement.ctx);
  }
});

test("hc shutdown reports background task and subscription cleanup errors", async () => {
  const f = fixture();
  const taskError = new Error("widget clear failed");
  const closeError = new Error("subscription close failed");
  const ui = (f.ctx as ExtensionContext).ui;
  const setWidget = ui.setWidget;
  try {
    f.observer.start(f.ctx);
    await f.ready();
    f.state.closeError = closeError;
    ui.setWidget = () => {
      throw taskError;
    };
    f.subscriptions[0]?.fail();
    await until(() => f.state.closes === 1);
    // Restore UI cleanup so shutdown must report the retained background error itself.
    ui.setWidget = setWidget;
    await assert.rejects(f.observer.shutdown(f.ctx), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(taskError));
      assert.ok(error.errors.includes(closeError));
      return true;
    });
    assert.equal(f.text(), "");
    assert.equal(f.state.attempts, 1);
  } finally {
    ui.setWidget = setWidget;
    await f.observer.shutdown(f.ctx);
  }
});

test("hc pending read cancellation and replacement cannot publish through stale contexts", async () => {
  const f = fixture();
  const reading = deferred<void>();
  f.state.read = (signal) =>
    new Promise((_resolve, reject) => {
      reading.resolve();
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  f.observer.start(f.ctx);
  await reading.promise;
  const old = (f.ctx as ExtensionContext).sessionManager;
  await f.observer.shutdown(f.ctx);
  f.state.read = undefined;
  const replacement = createMockContext({ mode: "tui", hasUI: true, theme });
  f.observer.start(replacement.ctx);
  Object.defineProperty(f.ctx, "sessionManager", {
    get() {
      throw new Error("stale context access");
    },
  });
  f.subscriptions[0]?.emit({ jsonrpc: "2.0", method: "event", params: { seq: 100, type: "status", terminal: "t2" } });
  await until(() => typeof replacement.widgets.get(HERDR_WIDGET_KEY) === "function");
  Object.defineProperty(f.ctx, "sessionManager", { value: old });
  await f.observer.shutdown(replacement.ctx);
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`hc observer does not connect or mount a widget in ${mode} mode`, async () => {
    const f = fixture();
    Object.assign(f.ctx, { mode });
    f.observer.start(f.ctx);
    assert.equal(f.state.attempts, 0);
    assert.equal(f.text(), "");
    await f.observer.shutdown(f.ctx);
  });
}
