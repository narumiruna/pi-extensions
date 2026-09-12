import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runConfirmation } from "../src/index.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

const prompt = {
  title: "Delete local data?",
  message: "This cannot be undone.",
};

test("runConfirmation preserves TUI Confirm, Cancel, Back, and Close intent", async () => {
  async function drive(input: "confirm" | "cancel-row" | "tui.select.cancel" | "ctrl+c") {
    const tui = createTuiHarness({ width: 48, rows: 20 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = runConfirmation(context.ctx, prompt);
    await tui.waitForOpen();
    if (input === "cancel-row") {
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
    } else if (input === "confirm") {
      tui.press("tui.select.confirm");
    } else {
      tui.press(input);
    }
    return running;
  }

  assert.deepEqual(await drive("confirm"), { kind: "confirmed" });
  assert.deepEqual(await drive("cancel-row"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive("tui.select.cancel"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive("ctrl+c"), { kind: "closed", reason: "close" });
});

test("runConfirmation sanitizes and bounds its TUI frame", async () => {
  const tui = createTuiHarness({ width: 24, rows: 20 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runConfirmation(context.ctx, {
    title: "Delete\u001b[31m data?",
    message: "First line\n\nSecond\u0007 line with a long explanation",
    confirmLabel: "Apply\u001b[2J",
    cancelLabel: "Keep current data",
  });
  await tui.waitForOpen();
  const frame = tui.render();
  const plain = stripVTControlCharacters(frame.join("\n"));
  assert.equal(plain.includes("\u001b"), false);
  assert.equal(plain.includes("\u0007"), false);
  assert.match(plain, /Delete.*data\?/u);
  assert.match(plain, /First line/u);
  assert.match(plain, /Second.*line/u);
  for (const line of frame) assert.ok(visibleWidth(line) <= 24);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("runConfirmation uses deterministic RPC select semantics", async () => {
  async function drive(response: "Proceed" | "Keep" | undefined) {
    const rpc = createRpcHarness([
      {
        kind: "select",
        title: "Rotate link?\nCurrent link will stop working.\n\nOpen clients must reconnect.",
        options: ["Proceed", "Keep"],
        response,
      },
    ]);
    const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
      ui: Record<string, unknown>;
      [key: string]: unknown;
    };
    const ctx = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
    const result = await runConfirmation(ctx, {
      title: "Rotate link?",
      message: "Current link will stop working.\n\nOpen clients must reconnect.",
      confirmLabel: "Proceed",
      cancelLabel: "Keep",
    });
    rpc.assertConsumed();
    return result;
  }

  assert.deepEqual(await drive("Proceed"), { kind: "confirmed" });
  assert.deepEqual(await drive("Keep"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive(undefined), { kind: "closed", reason: "back" });
});

test("runConfirmation gives stale ownership precedence in TUI and RPC", async () => {
  const tuiOwner = new AbortController();
  const tui = createTuiHarness();
  const tuiContext = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const tuiRunning = runConfirmation(tuiContext.ctx, { ...prompt, signal: tuiOwner.signal });
  await tui.waitForOpen();
  tuiOwner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await tuiRunning, { kind: "stale" });

  const rpcOwner = new AbortController();
  const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const rpcContext = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  const rpcRunning = runConfirmation(rpcContext, { ...prompt, signal: rpcOwner.signal });
  await rpc.waitForCall();
  rpcOwner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await rpcRunning, { kind: "stale" });
  rpc.assertConsumed();
});

test("runConfirmation classifies external TUI disposal as stale", async () => {
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runConfirmation(context.ctx, prompt);
  await tui.waitForOpen();
  tui.dispose();
  assert.deepEqual(await running, { kind: "stale" });
});

test("runConfirmation reports unsupported modes and callback failures", async () => {
  let unsupportedMode = "";
  const printContext = createMockContext({ mode: "print", hasUI: false });
  assert.deepEqual(
    await runConfirmation(printContext.ctx, {
      ...prompt,
      onUnsupportedMode: (_ctx, mode) => {
        unsupportedMode = mode;
      },
    }),
    { kind: "unsupported", mode: "print" },
  );
  assert.equal(unsupportedMode, "print");

  const failure = new Error("Unsupported reporter failed");
  let reported: unknown;
  assert.deepEqual(
    await runConfirmation(printContext.ctx, {
      ...prompt,
      onUnsupportedMode: () => {
        throw failure;
      },
      onError: (_ctx, error) => {
        reported = error;
      },
    }),
    { kind: "error", error: failure },
  );
  assert.equal(reported, failure);
});

test("runConfirmation reports current UI errors and suppresses stale feedback", async () => {
  const failure = new Error("Dialog failed");
  let reports = 0;
  const report = (_ctx: unknown, error: unknown) => {
    reports += 1;
    assert.equal(error, failure);
  };
  const currentRpc = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      throw failure;
    },
  });
  assert.deepEqual(await runConfirmation(currentRpc.ctx, { ...prompt, onError: report }), {
    kind: "error",
    error: failure,
  });
  const currentTui = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async () => {
      throw failure;
    },
  });
  assert.deepEqual(await runConfirmation(currentTui.ctx, { ...prompt, onError: report }), {
    kind: "error",
    error: failure,
  });

  let isCurrent = true;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      await gate;
      throw failure;
    },
  });
  const running = runConfirmation(stale.ctx, {
    ...prompt,
    isCurrent: () => isCurrent,
    onError: () => {
      reports += 1;
    },
  });
  isCurrent = false;
  release();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(reports, 2);
});

test("runConfirmation rejects stale ownership before opening any UI", async () => {
  const owner = new AbortController();
  owner.abort(new DOMException("Session shut down", "AbortError"));
  let uiCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async () => {
      uiCalls += 1;
    },
  });
  assert.deepEqual(await runConfirmation(context.ctx, { ...prompt, signal: owner.signal }), {
    kind: "stale",
  });
  assert.equal(uiCalls, 0);
});
