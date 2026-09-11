import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createRpcHarness } from "../src/testing/index.js";

test("RPC harness scripts exact input/select calls and exposes immutable records", async () => {
  const rpc = createRpcHarness([
    { kind: "input", title: "Value", placeholder: "Positive integer", response: "12" },
    {
      kind: "select",
      title: "Apply?",
      options: ["Apply", "Back"],
      response: "Apply",
    },
  ]);
  assert.equal(await rpc.ui.input("Value", "Positive integer"), "12");
  assert.equal(await rpc.ui.select("Apply?", ["Apply", "Back"]), "Apply");
  rpc.assertConsumed();
  assert.equal(rpc.remainingSteps, 0);
  assert.deepEqual(rpc.dialogs, [
    {
      kind: "input",
      title: "Value",
      placeholder: "Positive integer",
      signalWasAborted: false,
    },
    {
      kind: "select",
      title: "Apply?",
      options: ["Apply", "Back"],
      signalWasAborted: false,
    },
  ]);
  assert.equal(Object.isFrozen(rpc.dialogs), true);
  assert.equal(Object.isFrozen(rpc.dialogs[1]?.options), true);
});

test("RPC harness fails on unexpected, exhausted, invalid, and incomplete scripts", async () => {
  const unexpected = createRpcHarness([{ kind: "select", response: "Back" }]);
  await assert.rejects(unexpected.ui.input("Value"), /expected select.*received input/i);

  const exhausted = createRpcHarness([]);
  await assert.rejects(exhausted.ui.select("Menu", ["Back"]), /unexpected select.*script is exhausted/i);

  const invalidChoice = createRpcHarness([{ kind: "select", response: "Missing" }]);
  await assert.rejects(
    invalidChoice.ui.select("Menu", ["Apply", "Back"]),
    /scripted select response.*not one of the offered options/i,
  );

  const expectedTitle = createRpcHarness([{ kind: "input", title: "Expected", response: "ok" }]);
  await assert.rejects(expectedTitle.ui.input("Wrong"), /expected input title.*received/i);
  assert.equal(expectedTitle.remainingSteps, 1);
  assert.equal(await expectedTitle.ui.input("Expected"), "ok");

  const incomplete = createRpcHarness([{ kind: "input", response: undefined }]);
  assert.throws(() => incomplete.assertConsumed(), /1 scripted RPC step remains/i);
  const missingSignal = createRpcHarness([{ kind: "input", waitForAbort: true }]);
  await assert.rejects(missingSignal.ui.input("Value"), /requires an AbortSignal/i);

  const custom = createRpcHarness([]);
  await assert.rejects(
    custom.ui.custom(() => ({ render: () => [], invalidate() {} })),
    /RPC harness does not support custom TUI/i,
  );
});

test("RPC harness models cancellation, pre-abort, and a pending owner abort finitely", async () => {
  const cancelled = createRpcHarness([{ kind: "input", response: undefined }]);
  assert.equal(await cancelled.ui.input("Value"), undefined);
  cancelled.assertConsumed();

  const preAbortedController = new AbortController();
  preAbortedController.abort(new DOMException("Already stale", "AbortError"));
  const preAborted = createRpcHarness([{ kind: "select", response: "Apply" }]);
  assert.equal(await preAborted.ui.select("Menu", ["Apply"], { signal: preAbortedController.signal }), undefined);
  assert.equal(preAborted.dialogs[0]?.signalWasAborted, true);
  preAborted.assertConsumed();

  const owner = new AbortController();
  let addedListeners = 0;
  let removedListeners = 0;
  const addEventListener = owner.signal.addEventListener.bind(owner.signal);
  const removeEventListener = owner.signal.removeEventListener.bind(owner.signal);
  Object.defineProperties(owner.signal, {
    addEventListener: {
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        addedListeners += 1;
        return addEventListener(...args);
      },
    },
    removeEventListener: {
      value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
        removedListeners += 1;
        return removeEventListener(...args);
      },
    },
  });
  const pending = createRpcHarness([{ kind: "input", waitForAbort: true }]);
  const response = pending.ui.input("Value", "", { signal: owner.signal });
  const record = await pending.waitForCall();
  assert.equal(record.kind, "input");
  assert.equal(record.signalWasAborted, false);
  assert.throws(() => pending.assertConsumed(), /1 scripted RPC call is still pending/i);
  owner.abort(new DOMException("Session replaced", "AbortError"));
  owner.abort();
  assert.equal(await response, undefined);
  assert.equal(addedListeners, 1);
  assert.equal(removedListeners, 1);
  pending.assertConsumed();
});

test("RPC harness drives rejected input retry and review pagination by exact identity", async () => {
  const inputRpc = createRpcHarness([
    { kind: "input", title: "Value", placeholder: "", response: "bad" },
    { kind: "input", title: "Value", placeholder: "", response: "12" },
  ]);
  const inputContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: inputRpc.ui.input,
    select: inputRpc.ui.select,
    custom: inputRpc.ui.custom,
  });
  const values: string[] = [];
  const inputMenu = defineMenu<undefined, "input", "submit">({
    start: "input",
    screens: { input: () => ({ kind: "input", title: "Value", action: "submit" }) },
    actions: {
      submit: async ({ value }) => {
        values.push(value ?? "");
        return value === "12" ? { kind: "close" } : { kind: "rejected" };
      },
    },
  });
  assert.deepEqual(await runMenu(inputContext.ctx, inputMenu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(values, ["bad", "12"]);
  inputRpc.assertConsumed();

  const reviewRpc = createRpcHarness([
    { kind: "select", options: ["Next", "Apply", "Back"], response: "Next" },
    { kind: "select", options: ["Previous", "Apply", "Back"], response: "Apply" },
  ]);
  const reviewContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: reviewRpc.ui.input,
    select: reviewRpc.ui.select,
    custom: reviewRpc.ui.custom,
  });
  let confirmedId = "";
  const reviewMenu = defineMenu<undefined, "review", "apply">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Review",
        content: Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n"),
        viewportSize: "adaptive",
        confirm: { id: "raw-apply", label: "Apply", action: "apply" },
      }),
    },
    actions: {
      apply: async ({ itemId }) => {
        confirmedId = itemId;
        return { kind: "close" };
      },
    },
  });
  assert.deepEqual(await runMenu(reviewContext.ctx, reviewMenu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(confirmedId, "raw-apply");
  assert.match(reviewRpc.dialogs[0]?.title ?? "", /row 1[\s\S]*row 8[\s\S]*Page 1\/2/u);
  assert.match(reviewRpc.dialogs[1]?.title ?? "", /row 9[\s\S]*row 10[\s\S]*Page 2\/2/u);
  reviewRpc.assertConsumed();
});

test("RPC harness pending dialog settles runMenu as stale on owner abort", async () => {
  const rpc = createRpcHarness([{ kind: "input", waitForAbort: true }]);
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: rpc.ui.input,
    select: rpc.ui.select,
    custom: rpc.ui.custom,
  });
  const owner = new AbortController();
  const menu = defineMenu<undefined, "input", "submit">({
    start: "input",
    screens: { input: () => ({ kind: "input", title: "Value", action: "submit" }) },
    actions: { submit: async () => ({ kind: "close" }) },
  });
  const running = runMenu(context.ctx, menu, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await rpc.waitForCall();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await running, { kind: "stale" });
  rpc.assertConsumed();
});
