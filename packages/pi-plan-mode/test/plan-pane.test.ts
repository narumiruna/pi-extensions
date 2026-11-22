import assert from "node:assert/strict";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { Input, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createPlanPaneController } from "../src/plan-pane.js";
import { createPlanPaneHost, PANE_KEY } from "./plan-pane-support.js";
import { createMockContext } from "./support.js";

function setup(mode?: "regular" | "fullscreen") {
  initTheme("dark");
  const terminal = createPlanPaneHost(mode);
  const ctx: ExtensionContext = createMockContext({ mode: "tui" }).ctx;
  ctx.ui.setWidget = terminal.setWidget;
  const pane = createPlanPaneController();
  return {
    editor: terminal.editor,
    transcript: terminal.transcript,
    root: terminal.root,
    resize: terminal.resize,
    send: terminal.send,
    render: terminal.render,
    changeTheme: terminal.changeTheme,
    switchMode: terminal.switchMode,
    terminal,
    ctx,
    pane,
    frame: () => terminal.render().map(stripTerminalSequences),
    async set(side: "left" | "right" | "off", plan?: string) {
      pane.update(ctx, side, plan);
      await Promise.resolve();
      return terminal.render().map(stripTerminalSequences);
    },
    stop() {
      pane.clear();
      terminal.stop();
    },
  };
}

test("fullscreen split reserves real columns and collapses below either resize threshold", async () => {
  const f = setup();
  try {
    const [first] = await f.set("right");
    assert.match(first ?? "", /^history .*│Plan/u);
    assert.equal(first?.indexOf("│"), 66);
    assert.match(f.frame().join("\n"), /No completed plan yet\./u);
    assert.match(f.frame().join("\n"), /main draft/u);
    assert.match((await f.set("left", "# Left pane"))[0] ?? "", /^Plan .*│history/u);
    for (const [width, height, visible] of [
      [79, 18, false],
      [80, 11, false],
      [80, 12, true],
      [140, 30, true],
    ] as const) {
      f.resize(width, height);
      const frame = f.frame();
      assert.equal(
        frame.some((row) => row.includes("│")),
        visible,
      );
      assert.equal(
        frame.some((row) => row.includes("Left pane")),
        visible,
      );
      assert.ok(frame.every((row) => visibleWidth(row) <= width));
    }
    assert.doesNotMatch((await f.set("off")).join("\n"), /Left pane|│/u);
    assert.equal(f.transcript.scrollTop > 0, true);
  } finally {
    f.stop();
  }
});

test("right pane stays passive while editor, overlay and transcript keep Pi input", async () => {
  const f = setup();
  const overlayInput = new Input();
  const overlay = f.terminal.fullscreen.showOverlay(overlayInput, { width: 20, anchor: "top-left" });
  try {
    const plan = Array.from({ length: 40 }, (_, index) => `\`plan line ${index}\``).join("\n\n");
    await f.set("right", plan);
    assert.equal(f.terminal.host.getFocusedComponent(), overlayInput);
    f.send("z");
    assert.equal(overlayInput.getValue(), "z");
    overlay.hide();
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
    const pasted = "first line\nsecond line";
    f.send(`\u001b[200~${pasted}\u001b[201~`);
    assert.equal(f.editor.getExpandedText(), `main draft${pasted}`);
    const transcriptBefore = f.transcript.scrollTop;
    for (let index = 0; index < 20; index += 1) f.send("\u001b[<73;90;5M");
    assert.match(f.frame().join("\n"), /plan line 39/u);
    assert.equal(f.transcript.scrollTop, transcriptBefore, "pane wheel at bottom must not scroll chat");
    for (let index = 0; index < 20; index += 1) f.send("\u001b[<72;90;5M");
    assert.match(f.frame().join("\n"), /plan line 0/u);
    assert.equal(f.transcript.scrollTop, transcriptBefore, "pane wheel at top must not scroll chat");
    f.send("\u001b[5~");
    assert.ok(f.transcript.scrollTop < transcriptBefore);
    assert.match(f.frame().join("\n"), /plan line 0/u);
    const afterPage = f.transcript.scrollTop;
    f.send("\u001b[<64;10;5M");
    assert.ok(f.transcript.scrollTop < afterPage);
    for (let index = 0; index < 6; index += 1) f.send("\u001b[<65;90;5M");
    assert.doesNotMatch(f.frame().join("\n"), /plan line 0\b/u);
    assert.match((await f.set("right", "# Replaced plan")).join("\n"), /Replaced plan/u);
    assert.equal(f.editor.getExpandedText(), `main draft${pasted}`);
  } finally {
    overlay.hide();
    f.stop();
  }
});

test("pane sanitizes Markdown without changing the passed plan and invalidates themed rows", async () => {
  const f = setup();
  try {
    f.resize(80, 18);
    const terminalSequence = "\u001b]0;NOT A WINDOW TITLE\u0007";
    const bidi = "\u202e";
    const plan = `# 計畫${bidi} ${terminalSequence}\n\n${"繁體中文 🧑‍💻 ".repeat(12)}\n\n- **Item**`;
    const frame = (await f.set("right", plan)).join("\n");
    assert.match(frame, /計畫/u);
    assert.match(frame, /繁體中文/u);
    assert.match(frame, /Item/u);
    assert.doesNotMatch(frame, /NOT A WINDOW TITLE|\u202e/u);
    assert.ok(plan.includes(terminalSequence));
    assert.ok(f.render().some((row) => row.includes("\u001b[31mPlan")));
    f.changeTheme();
    assert.ok(f.render().some((row) => row.includes("\u001b[32mPlan")));
  } finally {
    f.stop();
  }
});

test("pane follows native renderer replacements without switching renderer modes itself", async () => {
  const f = setup("regular");
  try {
    await f.set("right", "# First plan");
    assert.equal(f.terminal.host.mode, "regular");
    f.switchMode("fullscreen");
    assert.doesNotMatch(f.frame().join("\n"), /First plan/u);
    await Promise.resolve();
    assert.match(f.frame().join("\n"), /First plan/u);
    f.switchMode("regular");
    await f.set("right", "# New plan");
    assert.equal(f.terminal.host.mode, "regular");
    f.switchMode("fullscreen");
    await Promise.resolve();
    assert.match(f.frame().join("\n"), /New plan/u);
    assert.doesNotMatch(f.frame().join("\n"), /First plan/u);
  } finally {
    f.stop();
  }
});

test("incompatible and replaced roots are not overwritten during attachment or cleanup", async () => {
  const f = setup();
  try {
    const unsupported = new Text("Foreign layout", 0, 0);
    f.terminal.fullscreen.setLayoutRoot(unsupported);
    const setter = vi.spyOn(f.terminal.fullscreen, "setLayoutRoot");
    assert.match((await f.set("right")).join("\n"), /Foreign layout/u);
    assert.equal(setter.mock.calls.length, 0);
    await f.set("off");
    f.terminal.fullscreen.setLayoutRoot(f.root);
    assert.match((await f.set("right")).join("\n"), /No completed plan yet/u);
    f.terminal.fullscreen.setLayoutRoot(unsupported);
    assert.match((await f.set("off")).join("\n"), /Foreign layout/u);
    assert.match(f.frame().join("\n"), /Foreign layout/u);
  } finally {
    f.stop();
  }
});

test("failed attachment restores the original layout and is not retried every frame", async () => {
  const f = setup();
  try {
    const host = f.terminal.fullscreen;
    const setRoot = host.setLayoutRoot.bind(host);
    const setter = vi.spyOn(host, "setLayoutRoot").mockImplementationOnce((root) => {
      setRoot(root);
      throw new Error("incompatible layout setter");
    });
    assert.doesNotMatch((await f.set("right")).join("\n"), /│/u);
    f.frame();
    f.frame();
    await Promise.resolve();
    assert.equal(setter.mock.calls.length, 2);
    assert.equal(setter.mock.calls.at(-1)?.[0], f.root);
    f.pane.clear();
    f.pane.clear();
    assert.equal(setter.mock.calls.length, 2);
  } finally {
    f.stop();
  }
});

test.each(["rpc", "print", "json"] as const)("%s never initializes the pane widget", (mode) => {
  const context = createMockContext({ mode });
  const pane = createPlanPaneController();
  pane.update(context.ctx, "right", "# Plan");
  pane.clear();
  assert.equal(context.widgets.has(PANE_KEY), false);
});

test("widget disposal and session replacement invalidate queued mounts", async () => {
  const f = setup();
  const next = setup();
  try {
    const setter = vi.spyOn(f.terminal.fullscreen, "setLayoutRoot");
    f.pane.update(f.ctx, "right", "# Obsolete");
    f.terminal.setWidget(PANE_KEY, undefined);
    await Promise.resolve();
    assert.equal(setter.mock.calls.length, 0);
    f.pane.update(f.ctx, "right", "# Also obsolete");
    f.pane.update(next.ctx, "left", "# Current session");
    await Promise.resolve();
    assert.equal(setter.mock.calls.length, 0);
    assert.match(next.frame().join("\n"), /Current session/u);
    f.pane.clear();
    assert.doesNotMatch(next.frame().join("\n"), /Current session/u);
  } finally {
    f.stop();
    next.stop();
  }
});
