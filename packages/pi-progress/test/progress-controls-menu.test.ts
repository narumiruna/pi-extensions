import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createContext, createHarness, setProgress } from "./progress-harness.js";

initTheme("dark");

function open(harness: ReturnType<typeof createHarness>, current: ReturnType<typeof createContext>) {
  const command = harness.commands.get("progress");
  assert.ok(command);
  return command.handler("", current.ctx as ExtensionCommandContext);
}

function frame(tui: ReturnType<typeof createTuiHarness>) {
  return stripVTControlCharacters(tui.render().join("\n"));
}

test("TUI view controls use non-default keys, sticky hide/show, pin, and hard cancellation", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+x",
  });
  const harness = createHarness();
  const current = createContext();
  const tui = createTuiHarness({ keybindings });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  await harness.emit("session_start", current.ctx);
  const result = await setProgress(harness, current.ctx, [{ text: "saved work", status: "pending" }]);
  const running = open(harness, current);
  const evidence: string[] = [];
  try {
    await tui.waitForOpen();
    for (let index = 0; index < 4; index++) tui.send("\u000e");
    tui.send("\u0019");
    await tui.waitForOpen();
    evidence.push(frame(tui));
    for (let index = 0; index < 2; index++) tui.send("\u000e");
    tui.send("\u0019");
    await tui.waitForOpen();
    evidence.push(current.renderWidget().join("\n"));
    tui.send("\u000e");
    tui.send("\u0019");
    await tui.waitForOpen();
    evidence.push(frame(tui));
    await setProgress(harness, current.ctx, [{ text: "new work", status: "pending" }]);
    evidence.push(current.renderWidget().join("\n"));
    tui.send("\u0019");
    await tui.waitForOpen();
    evidence.push(current.renderWidget().join("\n"));
    tui.send("\u000e");
    tui.send("\u0019");
    await tui.waitForOpen();
    evidence.push(frame(tui));
    tui.send("\u0018");
    await tui.waitForOpen();
    evidence.push(frame(tui));
    tui.send("\u0003");
    await running;
    assert.match(evidence[0] ?? "", /Progress Widget View/u);
    assert.match(evidence[1] ?? "", /Progress · 0\/1 complete/u);
    assert.doesNotMatch(evidence[1] ?? "", /○ saved work/u);
    assert.match(evidence[2] ?? "", /View: hidden/u);
    assert.equal(evidence[3], "");
    assert.match(evidence[4] ?? "", /○ new work/u);
    assert.match(evidence[5] ?? "", /default · pinned/u);
    assert.match(evidence[6] ?? "", /Widget: visible/u);
    assert.deepEqual(result.details.steps, [{ text: "saved work", status: "pending" }]);
    assert.deepEqual(harness.entries, []);
    assert.deepEqual(current.notifications, []);
    assert.equal(tui.isOpen, false);
  } finally {
    tui.dispose();
    await running;
    await harness.emit("session_shutdown", current.ctx);
  }
});

test("RPC item controls change only display and expose sanitized duplicate labels", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  const rpc = createRpcHarness([
    { kind: "select", response: "Task items" },
    { kind: "select", response: "1. same" },
    { kind: "select", response: "Compact item" },
    { kind: "select", response: "Expand item" },
    { kind: "select", response: "Remove item from display" },
    { kind: "select", response: undefined },
    { kind: "select", response: "Status" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Close" },
  ]);
  Object.assign(current.ctx.ui, rpc.ui);
  await harness.emit("session_start", current.ctx);
  const steps = [
    { text: "same\u001b[0m", status: "pending" as const },
    { text: "same", status: "blocked" as const },
  ];
  const result = await setProgress(harness, current.ctx, steps);
  await open(harness, current);
  rpc.assertConsumed();
  assert.deepEqual(rpc.dialogs[1]?.options, ["1. same", "2. same", "Back"]);
  assert.deepEqual(rpc.dialogs[5]?.options, ["1. same", "Back"]);
  assert.match(rpc.dialogs[7]?.title ?? "", /Display items: 1 · removed: 1/u);
  assert.ok(rpc.dialogs.every(({ title }) => !title.includes("\u001b")));
  assert.deepEqual(result.details.steps, steps);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(current.notifications, []);
  assert.ok(current.widgets.filter(({ lines }) => lines).every(({ content }) => content === undefined));
  await harness.emit("session_shutdown", current.ctx);
});
