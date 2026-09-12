import assert from "node:assert/strict";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { runCustomInteraction } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

test("runCustomInteraction completes with undefined only after owned work drains", async () => {
  let releasePending: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let interactionSignal: AbortSignal | undefined;
  let disposals = 0;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction<undefined>(context.ctx, {
    create: ({ keybindings, signal, complete }) => {
      interactionSignal = signal;
      return {
        render: () => ["open"],
        invalidate() {},
        handleInput(data) {
          if (keybindings.matches(data, "tui.select.confirm")) complete(undefined);
        },
        waitForPending: () => pending,
        dispose() {
          disposals += 1;
        },
      };
    },
  });
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(interactionSignal?.aborted, true);
  releasePending();
  assert.deepEqual(await running, { kind: "completed", value: undefined });
  assert.equal(disposals, 1);
});

test("runCustomInteraction preserves focus and input on the wrapped component", async () => {
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction<string>(context.ctx, {
    create: ({ keybindings, complete }) => {
      const component = {
        focused: false,
        wantsKeyRelease: true,
        render() {
          return [component.focused ? "focused" : "unfocused"];
        },
        invalidate() {},
        handleInput(data: string) {
          if (keybindings.matches(data, "tui.select.confirm")) complete("done");
        },
      };
      return component;
    },
  });
  await tui.waitForOpen();
  assert.equal(tui.isFocusable, true);
  tui.setFocused(true);
  assert.deepEqual(tui.render(), ["focused"]);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "completed", value: "done" });
});

test("runCustomInteraction forwards normalized mouse events through the outer component", async () => {
  const observed: Array<{ type: string; x: number; y: number }> = [];
  const tui = createTuiHarness({ width: 30, rows: 10 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction<string>(context.ctx, {
    create: ({ complete }) => ({
      render: () => ["click"],
      invalidate() {},
      handleMouse(event) {
        observed.push({ type: event.type, x: event.x, y: event.y });
        complete("clicked");
        return { handled: true, focus: true };
      },
    }),
  });
  await tui.waitForOpen();
  tui.mouse({ type: "press", x: 3, y: 0 });
  assert.deepEqual(await running, { kind: "completed", value: "clicked" });
  assert.deepEqual(observed, [{ type: "press", x: 3, y: 0 }]);
});

test("runCustomInteraction returns stale after owner abort and drains the disposed component", async () => {
  const owner = new AbortController();
  let releasePending: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let observedAbort = false;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction(context.ctx, {
    signal: owner.signal,
    create: ({ signal }) => ({
      render: () => ["waiting"],
      invalidate() {},
      waitForPending: () => pending,
      dispose() {
        observedAbort = signal.aborted;
      },
    }),
  });
  await tui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  releasePending();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedAbort, true);
  assert.equal(tui.isOpen, false);
});

test("runCustomInteraction classifies external disposal as stale and aborts ownership", async () => {
  let observedAbort = false;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction(context.ctx, {
    create: ({ signal }) => ({
      render: () => ["waiting"],
      invalidate() {},
      dispose() {
        observedAbort = signal.aborted;
      },
    }),
  });
  await tui.waitForOpen();
  tui.dispose();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedAbort, true);
});

test("runCustomInteraction cleans a custom UI that closes without component disposal", async () => {
  let observedAbort = false;
  let disposals = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      createCustomSelectorHarness(factory, 40);
      return undefined;
    },
  });
  const result = await runCustomInteraction(context.ctx, {
    create: ({ signal }) => ({
      render: () => ["waiting"],
      invalidate() {},
      dispose() {
        disposals += 1;
        observedAbort = signal.aborted;
      },
    }),
  });
  assert.deepEqual(result, { kind: "stale" });
  assert.equal(disposals, 1);
  assert.equal(observedAbort, true);
});

test("runCustomInteraction skips creation when ownership expires before the host factory runs", async () => {
  let isCurrent = true;
  let createCalls = 0;
  let reportCustomStarted: () => void = () => undefined;
  const customStarted = new Promise<void>((resolve) => {
    reportCustomStarted = resolve;
  });
  let releaseCustom: () => void = () => undefined;
  const customGate = new Promise<void>((resolve) => {
    releaseCustom = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      reportCustomStarted();
      await customGate;
      const harness = createCustomSelectorHarness(factory, 40);
      return harness.resultPromise;
    },
  });
  const running = runCustomInteraction(context.ctx, {
    isCurrent: () => isCurrent,
    create: () => {
      createCalls += 1;
      return { render: () => ["late"], invalidate() {} };
    },
  });
  await customStarted;
  isCurrent = false;
  releaseCustom();

  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(createCalls, 0);
});

test("runCustomInteraction settles an owner abort that races an async factory", async () => {
  const owner = new AbortController();
  let reportStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  let releaseFactory: () => void = () => undefined;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  let observedAbort = false;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runCustomInteraction(context.ctx, {
    signal: owner.signal,
    create: async ({ signal }) => {
      reportStarted();
      await factoryGate;
      observedAbort = signal.aborted;
      return { render: () => ["late"], invalidate() {} };
    },
  });
  await started;
  owner.abort(new DOMException("Reloaded", "AbortError"));
  releaseFactory();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedAbort, true);
});

test("runCustomInteraction rejects unsupported modes without opening custom UI", async () => {
  let customCalls = 0;
  let unsupportedMode = "";
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    custom: async () => {
      customCalls += 1;
    },
  });
  const result = await runCustomInteraction(context.ctx, {
    create: () => ({ render: () => [], invalidate() {} }),
    onUnsupportedMode: (_ctx, mode) => {
      unsupportedMode = mode;
    },
  });
  assert.deepEqual(result, { kind: "unsupported", mode: "rpc" });
  assert.equal(unsupportedMode, "rpc");
  assert.equal(customCalls, 0);
});

test("runCustomInteraction revalidates ownership after unsupported-mode callbacks", async () => {
  const owner = new AbortController();
  let reportStarted: () => void = () => undefined;
  let releaseReport: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const reportGate = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  const context = createMockContext({ mode: "rpc", hasUI: true });
  const running = runCustomInteraction(context.ctx, {
    signal: owner.signal,
    create: () => ({ render: () => [], invalidate() {} }),
    onUnsupportedMode: async () => {
      reportStarted();
      await reportGate;
    },
  });
  await started;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  releaseReport();
  assert.deepEqual(await running, { kind: "stale" });
});

test("runCustomInteraction reports current UI failures but suppresses stale failures", async () => {
  const failure = new Error("Factory failed");
  let reports = 0;
  const currentTui = createTuiHarness();
  const current = createMockContext({ mode: "tui", hasUI: true, custom: currentTui.custom });
  const failed = await runCustomInteraction(current.ctx, {
    create: async () => {
      throw failure;
    },
    onError: (_ctx, error) => {
      reports += 1;
      assert.equal(error, failure);
    },
  });
  assert.deepEqual(failed, { kind: "error", error: failure });
  assert.equal(reports, 1);

  let isCurrent = true;
  let releaseFactory: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const tui = createTuiHarness();
  const staleContext = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const stale = runCustomInteraction(staleContext.ctx, {
    isCurrent: () => isCurrent,
    create: async () => {
      await gate;
      throw failure;
    },
    onError: () => {
      reports += 1;
    },
  });
  isCurrent = false;
  releaseFactory();
  assert.deepEqual(await stale, { kind: "stale" });
  assert.equal(reports, 1);
});

test("runCustomInteraction reports a UI rejection after component creation", async () => {
  const failure = new Error("Custom host failed");
  let reports = 0;
  let disposals = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      createCustomSelectorHarness(factory, 40);
      throw failure;
    },
  });
  const result = await runCustomInteraction(context.ctx, {
    create: () => ({
      render: () => ["open"],
      invalidate() {},
      dispose() {
        disposals += 1;
      },
    }),
    onError: (_ctx, error) => {
      reports += 1;
      assert.equal(error, failure);
    },
  });
  assert.deepEqual(result, { kind: "error", error: failure });
  assert.equal(reports, 1);
  assert.equal(disposals, 1);
});

test("runCustomInteraction pre-abort is stale without opening custom UI", async () => {
  const owner = new AbortController();
  owner.abort(new DOMException("Already replaced", "AbortError"));
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async () => {
      customCalls += 1;
    },
  });
  assert.deepEqual(
    await runCustomInteraction(context.ctx, {
      signal: owner.signal,
      create: () => ({ render: () => [], invalidate() {} }),
    }),
    { kind: "stale" },
  );
  assert.equal(customCalls, 0);
});
