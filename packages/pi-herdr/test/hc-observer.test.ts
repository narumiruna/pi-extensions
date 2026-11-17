import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
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
function fixture() {
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
  };
  const subscriptions: Array<{ emit(frame: unknown): void; fail(): void; signal: AbortSignal }> = [];
  const observer = createHcWidgetObserver({
    environment: { terminalId: "t1", socketEndpoint: "/unused" },
    retryDelayMs: 0,
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
        snapshot: { seq: 0, terminals: structuredClone(state.terminals) },
        closed: finished.promise,
        async close() {
          state.closes += 1;
          signal.removeEventListener("abort", abort);
          finished.resolve(undefined);
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

test("hc clears before one bounded reconnect and hides after a second failure", async () => {
  const f = fixture();
  try {
    f.observer.start(f.ctx);
    await f.ready();
    f.subscriptions[0]?.fail();
    await until(() => f.state.attempts === 2);
    await f.ready();
    assert.equal(f.state.closes, 1);
    f.subscriptions[1]?.fail();
    await until(() => f.state.closes === 2);
    assert.equal(f.text(), "");
    assert.equal(f.state.attempts, 2);
  } finally {
    await f.observer.shutdown(f.ctx);
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
  assert.equal(f.text(), "");
  await f.observer.shutdown(f.ctx);
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
