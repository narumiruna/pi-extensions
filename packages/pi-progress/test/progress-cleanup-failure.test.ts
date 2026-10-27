import assert from "node:assert/strict";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createProgressPresentation } from "../src/progress-presentation.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettingsLoadResult } from "../src/settings.js";
import { createContext, createHarness, defaultSettingsResult, setProgress } from "./progress-harness.js";

const interactions = vi.hoisted(() => ({
  settings: undefined as typeof import("../src/progress-settings-ui.js").showProgressSettings | undefined,
  menu: undefined as typeof import("../src/progress-menu.js").showProgressMenu | undefined,
}));
vi.mock("../src/progress-settings-ui.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/progress-settings-ui.js")>();
  return {
    ...original,
    showProgressSettings: (...args: Parameters<typeof original.showProgressSettings>) =>
      (interactions.settings ?? original.showProgressSettings)(...args),
  };
});
vi.mock("../src/progress-menu.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/progress-menu.js")>();
  return {
    ...original,
    showProgressMenu: (...args: Parameters<typeof original.showProgressMenu>) =>
      (interactions.menu ?? original.showProgressMenu)(...args),
  };
});

afterEach(() => {
  interactions.settings = undefined;
  interactions.menu = undefined;
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function rejectClear(current: ReturnType<typeof createContext>, error: Error, beforeClear = () => {}) {
  const setWidget = current.ctx.ui.setWidget.bind(current.ctx.ui);
  let attempts = 0;
  current.ctx.ui.setWidget = (key, content, options) => {
    if (content === undefined) {
      attempts++;
      beforeClear();
      throw error;
    }
    if (Array.isArray(content)) setWidget(key, content, options);
    else setWidget(key, content, options);
  };
  return () => attempts;
}

function staleContext(ctx: ExtensionContext) {
  let reads = 0;
  for (const key of ["sessionManager", "ui", "mode", "hasUI", "isIdle"] as const) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        reads++;
        throw new Error(`Stale context read: ${key}`);
      },
    });
  }
  return () => reads;
}

for (const mode of ["tui", "rpc"] as const) {
  test(`${mode}: failed presentation disposal invalidates timers, view, items, and repeated cleanup`, () => {
    vi.useFakeTimers();
    const current = createContext({ mode });
    let ownerChecks = 0;
    let stale = false;
    const callbacks: Array<() => void> = [];
    const presentation = createProgressPresentation({
      context: current.ctx,
      isCurrent: () => {
        ownerChecks++;
        assert.equal(stale, false, "Disposed presentation must not check its stale owner");
        return true;
      },
      settings: DEFAULT_PROGRESS_SETTINGS,
      setTimeout: ((callback: () => void, delay: number) => {
        callbacks.push(callback);
        return globalThis.setTimeout(callback, delay);
      }) as typeof setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    presentation.reset([{ text: "work", status: "pending" }]);
    const item = presentation.items()[0];
    assert.ok(item);
    const handle = presentation.item(item.id);
    presentation.update([{ text: "work", status: "completed" }], DEFAULT_PROGRESS_SETTINGS, true);
    const failure = new Error("clear failed");
    const attempts = rejectClear(current, failure);
    assert.throws(
      () => presentation.dispose(),
      (error) => error === failure,
    );
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(handle?.remove(), false);
    const checks = ownerChecks;
    stale = true;
    const staleReads = staleContext(current.ctx);
    presentation.dispose();
    presentation.refresh();
    presentation.clear();
    presentation.show("expanded");
    presentation.showOnUpdate();
    presentation.reset([]);
    presentation.update([], DEFAULT_PROGRESS_SETTINGS);
    presentation.view.setPinned(true);
    presentation.view.setTrigger("user-message");
    presentation.view.userMessage();
    for (const callback of callbacks) callback();
    assert.equal(attempts(), 1);
    assert.equal(ownerChecks, checks);
    assert.equal(staleReads(), 0);
    assert.equal(vi.getTimerCount(), 0);
  });
}

for (const route of ["settings", ""] as const) {
  test(`${route || "menu"}: failed shutdown drains an ignored-signal task before reporting all failures`, async () => {
    const gate = deferred<void>();
    const opened = deferred<void>();
    const current = createContext();
    const sessionManager = current.ctx.sessionManager;
    const cleanupFailure = new Error("display cleanup failed");
    const taskFailure = new Error("pending interaction failed");
    let signal: AbortSignal | undefined;
    const currentChecks: boolean[] = [];
    if (route === "settings") {
      interactions.settings = async (_ctx, options) => {
        signal = options.signal;
        opened.resolve();
        await gate.promise; // Deliberately ignore cancellation until explicitly released.
        currentChecks.push(options.isCurrent());
        options.apply({ ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
        throw taskFailure;
      };
    } else {
      interactions.menu = async (_ctx, options) => {
        signal = options.signal;
        opened.resolve();
        await gate.promise;
        currentChecks.push(options.isCurrent());
        options.setView("expanded");
        options.setPinned(true);
        options.setTrigger("user-message");
        options.hideWidget();
        options.refresh();
        assert.equal(options.item("missing"), undefined);
        throw taskFailure;
      };
    }
    const harness = createHarness();
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
    const command = harness.commands.get("progress");
    assert.ok(command);
    const running = command.handler(route, current.ctx as ExtensionCommandContext);
    const commandResult = Promise.resolve(running).then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.promise;
    const attempts = rejectClear(current, cleanupFailure);
    let settled = false;
    const shutdown = harness.emit("session_shutdown", current.ctx);
    const shutdownResult = shutdown
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    assert.equal(signal?.aborted, true);
    const publications = current.widgets.length;
    const staleReads = staleContext(current.ctx);
    await Promise.resolve();
    assert.equal(settled, false, "Display failure must not skip the pending-task drain");
    gate.resolve();
    assert.equal(await commandResult, taskFailure, "The root command must preserve its task failure");
    const result = await shutdownResult;
    assert.ok(result instanceof AggregateError);
    assert.deepEqual(result.errors, [cleanupFailure, taskFailure]);
    assert.deepEqual(currentChecks, [false]);
    assert.equal(staleReads(), 0);
    assert.equal(current.widgets.length, publications);
    assert.deepEqual(current.notifications, []);
    assert.deepEqual(harness.entries, []);
    const repeated = createContext();
    Object.assign(repeated.ctx, { sessionManager });
    await harness.emit("session_shutdown", repeated.ctx);
    assert.equal(attempts(), 1);
  });
}

for (const result of ["resolved", "rejected"] as const) {
  test(`failed replacement cleanup invalidates an old ${result} settings read without acquiring new UI`, async () => {
    const read = deferred<ProgressSettingsLoadResult>();
    let signal: AbortSignal | undefined;
    let loads = 0;
    const harness = createHarness({
      loadSettings: async (_path, ownedSignal) => {
        signal = ownedSignal;
        loads++;
        return loads === 1 ? read.promise : defaultSettingsResult();
      },
    });
    const current = createContext();
    const starting = harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
    const failure = new Error("old display clear failed");
    const attempts = rejectClear(current, failure);
    const replacement = createContext();
    const replacementReads = staleContext(replacement.ctx);
    await assert.rejects(harness.emit("session_start", replacement.ctx), (error) => error === failure);
    assert.equal(signal?.aborted, true);
    assert.equal(loads, 1);
    assert.equal(replacementReads(), 0);
    assert.deepEqual(replacement.widgets, []);
    const publications = current.widgets.length;
    const staleReads = staleContext(current.ctx);
    if (result === "resolved") read.resolve(defaultSettingsResult());
    else read.reject(new Error("late read failed"));
    await starting;
    assert.equal(staleReads(), 0);
    assert.equal(current.widgets.length, publications);
    assert.deepEqual(current.notifications, []);
    const next = createContext();
    await harness.emit("session_start", next.ctx);
    const updated = await setProgress(harness, next.ctx, [{ text: "new", status: "pending" }]);
    assert.equal(updated.details.steps[0]?.text, "new");
    assert.equal(attempts(), 1);
    await harness.emit("session_shutdown", next.ctx);
    await harness.emit("session_shutdown", next.ctx);
  });
}

test("failed tree cleanup aborts menus before invalidating handles and prevents stale continuation", async () => {
  const gate = deferred<void>();
  const opened = deferred<void>();
  let signal: AbortSignal | undefined;
  let handle: ReturnType<Parameters<NonNullable<typeof interactions.menu>>[1]["item"]>;
  let liveAtAbort = false;
  let currentAfterDrain = true;
  interactions.menu = async (_ctx, options) => {
    signal = options.signal;
    const item = options.getState().items[0];
    assert.ok(item);
    handle = options.item(item.id);
    signal.addEventListener("abort", () => {
      liveAtAbort = handle?.compact() === true;
    });
    opened.resolve();
    await gate.promise;
    currentAfterDrain = options.isCurrent();
    options.setView("hidden");
    options.refresh();
  };
  const harness = createHarness();
  const current = createContext();
  const sessionManager = current.ctx.sessionManager;
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
  const command = harness.commands.get("progress");
  assert.ok(command);
  const running = command.handler("", current.ctx as ExtensionCommandContext);
  await opened.promise;
  const failure = new Error("tree display clear failed");
  const attempts = rejectClear(current, failure, () => assert.equal(signal?.aborted, true));
  await assert.rejects(harness.emit("session_tree", current.ctx), (error) => error === failure);
  assert.equal(liveAtAbort, true, "Menu abort must precede handle invalidation");
  assert.equal(handle?.remove(), false);
  const publications = current.widgets.length;
  const staleReads = staleContext(current.ctx);
  gate.resolve();
  await running;
  assert.equal(currentAfterDrain, false);
  assert.equal(staleReads(), 0);
  assert.equal(current.widgets.length, publications);
  const next = createContext();
  Object.assign(next.ctx, { sessionManager });
  await harness.emit("session_tree", next.ctx);
  await setProgress(harness, next.ctx, [{ text: "new branch", status: "pending" }]);
  assert.match(next.renderWidget().join("\n"), /new branch/u);
  assert.equal(attempts(), 1);
  await harness.emit("session_shutdown", next.ctx);
});

for (const result of ["resolved", "rejected"] as const) {
  test(`failed tree cleanup invalidates a pending ${result} startup settings read`, async () => {
    const read = deferred<ProgressSettingsLoadResult>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      loadSettings: async (_path, ownedSignal) => {
        signal = ownedSignal;
        return read.promise;
      },
    });
    const current = createContext();
    const sessionManager = current.ctx.sessionManager;
    const starting = harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
    const failure = new Error("tree display clear failed");
    const attempts = rejectClear(current, failure);
    await assert.rejects(harness.emit("session_tree", current.ctx), (error) => error === failure);
    assert.equal(signal?.aborted, true);
    const publications = current.widgets.length;
    const staleReads = staleContext(current.ctx);
    if (result === "resolved") read.resolve(defaultSettingsResult());
    else read.reject(new Error("late read failed"));
    await starting;
    assert.equal(staleReads(), 0);
    assert.equal(current.widgets.length, publications);
    assert.deepEqual(current.notifications, []);
    const next = createContext();
    Object.assign(next.ctx, { sessionManager });
    await harness.emit("session_shutdown", next.ctx);
    assert.equal(attempts(), 1);
  });
}

test("direct clear reports UI failure and retains saved progress", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  const steps = [{ text: "saved", status: "pending" as const }];
  await setProgress(harness, current.ctx, steps);
  const setWidget = current.ctx.ui.setWidget;
  const failure = new Error("command clear failed");
  rejectClear(current, failure);
  const command = harness.commands.get("progress");
  assert.ok(command);
  await assert.rejects(
    Promise.resolve(command.handler("clear", current.ctx as ExtensionCommandContext)),
    (error) => error === failure,
  );
  assert.deepEqual(current.notifications, []);
  current.ctx.ui.setWidget = setWidget;
  const result = await setProgress(harness, current.ctx, steps);
  assert.deepEqual(result.details.steps, steps);
  assert.match(current.renderWidget().join("\n"), /saved/u);
  await harness.emit("session_shutdown", current.ctx);
});
