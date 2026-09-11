import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

test("TUI harness drives an async public factory without exposing its component", async () => {
  const inputs: string[] = [];
  let invalidations = 0;
  let disposals = 0;
  const harness = createTuiHarness({ width: 20, rows: 9 });
  const running = harness.custom<string>(async (tui, theme, keybindings, done) => {
    await Promise.resolve();
    return {
      focused: false,
      render(width: number) {
        return [theme.bold(`width=${width} rows=${tui.terminal.rows}`)];
      },
      invalidate() {
        invalidations += 1;
      },
      handleInput(data: string) {
        inputs.push(data);
        tui.requestRender();
        if (keybindings.matches(data, "tui.select.confirm")) done("accepted");
      },
      dispose() {
        disposals += 1;
      },
    };
  });

  assert.equal(await harness.waitForOpen(), 1);
  assert.equal(harness.openCount, 1);
  assert.equal(harness.isOpen, true);
  assert.equal(harness.isFocusable, true);
  assert.equal(harness.focused, false);
  assert.deepEqual(harness.render(), ["width=20 rows=9"]);
  assert.throws(() => harness.resize({ width: 10, rows: 0 }), /rows must be a positive integer/i);
  assert.deepEqual(harness.render(), ["width=20 rows=9"]);

  harness.setFocused(true);
  assert.equal(harness.focused, true);
  harness.press("tui.select.down");
  harness.press("home");
  harness.send("\u0015");
  harness.type("raw input");
  assert.deepEqual(inputs, ["\u001b[B", "\u001b[H", "\u0015", "raw input"]);
  assert.equal(harness.requestRenderCount, 4);

  assert.deepEqual(harness.resize({ width: 12, rows: 6 }), ["width=12 rows=6"]);
  harness.invalidate();
  assert.equal(invalidations, 1);

  const observedResult = harness.resultPromise;
  harness.press("tui.select.confirm");
  assert.equal(await observedResult, "accepted");
  assert.equal(await running, "accepted");
  assert.equal(harness.result, "accepted");
  assert.equal(harness.isOpen, false);
  assert.equal(disposals, 1);

  const inputCount = inputs.length;
  harness.type("ignored after close");
  harness.press("ctrl+c");
  assert.equal(inputs.length, inputCount);
});

test("TUI harness applies callback overrides and validates terminal dimensions", async () => {
  assert.throws(() => createTuiHarness({ width: 0 }), /width must be a positive integer/i);
  assert.throws(() => createTuiHarness({ rows: 1.5 }), /rows must be a positive integer/i);
  const unsupportedOptions = createTuiHarness();
  await assert.rejects(
    unsupportedOptions.custom(() => ({ render: () => [], invalidate() {} }), { overlay: true }),
    /does not support custom UI options or overlays/i,
  );
  const harness = createTuiHarness({
    theme: {
      fg: (color, text) => `${color}:${text}`,
      bold: (text) => `bold:${text}`,
    },
    keybindings: {
      matches: (data, binding) => data === "x" && binding === "tui.select.confirm",
      getKeys: (binding) => (binding === "tui.select.confirm" ? ["x"] : []),
    },
  });
  const running = harness.custom<string>((_tui, theme, keybindings, done) => ({
    render: () => [theme.fg("accent", theme.bold(keybindings.getKeys("tui.select.confirm")[0] ?? ""))],
    invalidate() {},
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.confirm")) done("custom-key");
    },
  }));
  await harness.waitForOpen();
  assert.deepEqual(harness.render(), ["accent:bold:x"]);
  assert.throws(() => harness.resize({ rows: 0 }), /rows must be a positive integer/i);
  harness.send("x");
  assert.equal(await running, "custom-key");
});

test("TUI harness rejects overlapping factories and advances sequential screen ownership", async () => {
  const harness = createTuiHarness();
  const first = harness.custom<string>((_tui, _theme, keybindings, done) => ({
    render: () => ["first"],
    invalidate() {},
    handleInput(data: string) {
      if (keybindings.matches(data, "tui.select.cancel")) done("first-result");
    },
  }));
  assert.equal(await harness.waitForOpen(), 1);
  assert.deepEqual(harness.render(), ["first"]);

  await assert.rejects(
    harness.custom(async () => ({ render: () => ["overlap"], invalidate() {} })),
    /already has an active custom component/i,
  );

  harness.press("tui.select.cancel");
  assert.equal(await first, "first-result");
  const second = harness.custom<string>(async (_tui, _theme, _keybindings, done) => {
    await Promise.resolve();
    return {
      render: () => ["second"],
      invalidate() {},
      handleInput() {
        done("second-result");
      },
    };
  });
  assert.equal(await harness.waitForOpen(), 2);
  assert.deepEqual(harness.render(), ["second"]);
  harness.send("finish");
  assert.equal(await second, "second-result");
  assert.equal(harness.result, "second-result");
  assert.equal(harness.openCount, 2);
});

test("TUI harness rejects failed or disposed asynchronous opens without stale ownership", async () => {
  const factoryError = new Error("factory failed");
  const failed = createTuiHarness();
  const failedOpen = failed.waitForOpen();
  const failedCustom = failed.custom(async () => {
    throw factoryError;
  });
  await assert.rejects(failedCustom, (error) => error === factoryError);
  await assert.rejects(failedOpen, (error) => error === factoryError);
  await assert.rejects(failed.waitForOpen(), (error) => error === factoryError);

  let releaseFactory: () => void = () => undefined;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  let disposals = 0;
  const disposed = createTuiHarness();
  const disposedCustom = disposed.custom(async () => {
    await factoryGate;
    return {
      render: () => ["late"],
      invalidate() {},
      dispose() {
        disposals += 1;
      },
    };
  });
  const disposedOpen = disposed.waitForOpen();
  let customSettled = false;
  void disposedCustom.then(() => {
    customSettled = true;
  });
  disposed.dispose();
  await assert.rejects(disposedOpen, /settled before opening/i);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(customSettled, true);
  await assert.rejects(disposed.waitForOpen(), /settled before opening/i);
  releaseFactory();
  assert.equal(await disposedCustom, undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(disposals, 1);
  assert.equal(disposed.isOpen, false);
});

test("TUI harness drains pending work and external disposal settles once", async () => {
  let releasePending: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let disposals = 0;
  let inputCalls = 0;
  const harness = createTuiHarness();
  const running = harness.custom(() => ({
    render: () => ["pending"],
    invalidate() {},
    handleInput() {
      inputCalls += 1;
    },
    waitForPending: () => pending,
    dispose() {
      disposals += 1;
    },
  }));
  await harness.waitForOpen();
  harness.send("start");
  const draining = harness.waitForPending();
  let drained = false;
  void draining.then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  releasePending();
  await draining;
  assert.equal(drained, true);

  harness.dispose();
  harness.dispose();
  assert.equal(await running, undefined);
  assert.equal(disposals, 1);
  harness.send("late");
  assert.equal(inputCalls, 1);
});

test("TUI harness external disposal wins over a racing component result", async () => {
  const harness = createTuiHarness();
  let doneOnDispose: (() => void) | undefined;
  const running = harness.custom<string>((_tui, _theme, _keybindings, done) => {
    doneOnDispose = () => done("late-component-result");
    return {
      render: () => ["open"],
      invalidate() {},
      dispose() {
        doneOnDispose?.();
      },
    };
  });
  await harness.waitForOpen();
  harness.dispose();
  assert.equal(await running, undefined);
  assert.equal(harness.result, undefined);
});

test("TUI harness preserves a rejected input draft before accepted completion", async () => {
  const values: string[] = [];
  const tui = createTuiHarness({ width: 40, rows: 12 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
  });
  const menu = defineMenu<undefined, "input", "submit">({
    start: "input",
    screens: {
      input: () => ({ kind: "input", title: "Value", action: "submit" }),
    },
    actions: {
      submit: async ({ value }) => {
        values.push(value ?? "");
        return value === "12" ? { kind: "close" } : { kind: "rejected" };
      },
    },
  });

  const running = runMenu(context.ctx, menu, { getState: () => undefined });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("bad");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  assert.match(tui.render().join("\n"), /bad/u);
  tui.send("\u0015");
  tui.type("12");
  tui.press("tui.input.submit");
  await tui.waitForPending();

  assert.deepEqual(await running, { kind: "closed", reason: "close" });
  assert.deepEqual(values, ["bad", "12"]);
});

test("TUI harness owner abort and external disposal remain distinct finite exits", async () => {
  function idleMenu() {
    return defineMenu<undefined, "main", "unused">({
      start: "main",
      screens: { main: () => ({ kind: "detail", title: "Idle", lines: ["waiting"] }) },
      actions: { unused: async () => ({ kind: "close" }) },
    });
  }

  const owner = new AbortController();
  const abortedTui = createTuiHarness();
  const abortedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: abortedTui.custom,
  });
  const aborted = runMenu(abortedContext.ctx, idleMenu(), {
    getState: () => undefined,
    signal: owner.signal,
  });
  await abortedTui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await aborted, { kind: "stale" });
  assert.equal(abortedTui.isOpen, false);

  const disposedTui = createTuiHarness();
  const disposedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: disposedTui.custom,
  });
  const disposed = runMenu(disposedContext.ctx, idleMenu(), { getState: () => undefined });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "closed", reason: "close" });
  assert.equal(disposedTui.isOpen, false);
});
