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
  let ratio: number | undefined;
  const savedRatios: number[] = [];
  return {
    savedRatios,
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
      const onResize = (next: number) => {
        ratio = next;
        savedRatios.push(next);
        pane.update(ctx, side, plan, ratio, onResize);
      };
      pane.update(ctx, side, plan, ratio, onResize);
      await Promise.resolve();
      return terminal.render().map(stripTerminalSequences);
    },
    stop() {
      pane.reset();
      terminal.stop();
    },
  };
}

function dividerColumn(frame: readonly string[]) {
  const index = frame[0]?.indexOf("│") ?? -1;
  return index + 1;
}

function mouse(f: ReturnType<typeof setup>, button: number, column: number, suffix = "M", row = 4) {
  f.send(`\u001b[<${button};${column};${row}${suffix}`);
}

test.each([
  { side: "right", initial: 50, narrower: 65, min: 76, max: 49 },
  { side: "left", initial: 51, narrower: 36, min: 25, max: 52 },
] as const)("dragging the $side divider reflows the plan and respects both width limits", async (layout) => {
  const f = setup();
  try {
    const plan = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const original = await f.set(layout.side, plan);
    assert.equal(dividerColumn(original), layout.initial);
    assert.match(original.join("\n"), /one two three four five six seven eight nine/u);

    mouse(f, 0, layout.initial);
    mouse(f, 32, layout.narrower);
    assert.equal(dividerColumn(f.frame()), layout.narrower, "the divider moves before release");
    assert.doesNotMatch(f.frame().join("\n"), /one two three four five six seven eight nine/u);
    mouse(f, 32, layout.side === "left" ? 1 : 100);
    assert.equal(dividerColumn(f.frame()), layout.min, "the pane keeps at least 24 columns");
    mouse(f, 32, layout.side === "left" ? 100 : 1);
    assert.equal(dividerColumn(f.frame()), layout.max, "the conversation keeps at least 48 columns");
    assert.deepEqual(f.savedRatios, []);
    mouse(f, 0, layout.max, "m");
    assert.deepEqual(f.savedRatios, [51 / 99]);
    mouse(f, 32, layout.narrower);
    assert.equal(dividerColumn(f.frame()), layout.max, "motion after release cannot resize");
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
    f.send("\u001b[200~pasted\nline\u001b[201~");
    assert.equal(f.editor.getExpandedText(), "main draftpasted\nline");
    assert.ok(f.frame().every((row) => visibleWidth(row) <= 100));
  } finally {
    f.stop();
  }
});

test("terminal resize clamps the saved width without changing it or continuing an interrupted drag", async () => {
  const f = setup();
  try {
    await f.set("right", "# First plan");
    mouse(f, 0, 50);
    mouse(f, 32, 56);
    mouse(f, 0, 56, "m");
    mouse(f, 0, 56);
    mouse(f, 32, 60);
    assert.equal(dividerColumn(f.frame()), 60);
    f.resize(100, 20);
    mouse(f, 32, 73);
    mouse(f, 0, 73, "m");
    assert.equal(dividerColumn(f.frame()), 56, "a row-only resize cancels the drag before the next paint");
    f.resize(140, 18);
    assert.equal(dividerColumn(f.frame()), 78, "a wider terminal scales the saved proportion");
    f.resize(100, 11);
    assert.equal(dividerColumn(f.frame()), 0);
    f.resize(79, 12);
    assert.equal(dividerColumn(f.frame()), 0);
    f.resize(80, 12);
    assert.equal(dividerColumn(f.frame()), 49);
    f.resize(100, 18);
    assert.equal(dividerColumn(f.frame()), 56);
    mouse(f, 32, 73);
    mouse(f, 0, 73, "m");
    assert.equal(dividerColumn(await f.set("right", "# Revised plan")), 56);
    assert.equal(dividerColumn(await f.set("off")), 0);
    assert.equal(dividerColumn(await f.set("right", "# Reopened")), 56);
    assert.equal(dividerColumn(await f.set("left", "# Other side")), 45);
    assert.deepEqual(f.savedRatios, [44 / 99]);
  } finally {
    f.stop();
  }
});

test("only a left-button press on the visible divider enables a resize", async () => {
  const f = setup();
  try {
    await f.set("right", "# Plan");
    mouse(f, 1, 50);
    mouse(f, 33, 56);
    mouse(f, 1, 56, "m");
    mouse(f, 0, 60);
    mouse(f, 32, 50);
    mouse(f, 0, 50, "m");
    mouse(f, 0, 50);
    mouse(f, 0, 50, "m");
    mouse(f, 0, 50);
    mouse(f, 32, 56);
    mouse(f, 32, 50);
    mouse(f, 0, 50, "m");
    assert.equal(dividerColumn(f.frame()), 50);

    const input = new Input();
    const overlay = f.terminal.fullscreen.showOverlay(input, { width: 20, anchor: "top-right", offsetX: -40 });
    try {
      f.frame();
      mouse(f, 0, 50, "M", 1);
      mouse(f, 32, 56, "M", 1);
      mouse(f, 0, 56, "m", 1);
      f.send("z");
      assert.equal(input.getValue(), "z");
    } finally {
      overlay.hide();
    }
    assert.equal(dividerColumn(f.frame()), 50, "an overlay covering the divider gets the press");

    mouse(f, 0, 50);
    mouse(f, 32, 56);
    f.send("\u001b[O");
    mouse(f, 32, 60);
    mouse(f, 0, 60, "m");
    assert.equal(dividerColumn(f.frame()), 56, "focus loss ends the gesture even without release");
    assert.deepEqual(f.savedRatios, []);
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
    mouse(f, 0, 56);
    mouse(f, 32, 60);
    mouse(f, 0, 60, "m");
    assert.equal(dividerColumn(f.frame()), 60, "a new press starts a new gesture");
    assert.deepEqual(f.savedRatios, [40 / 99]);
  } finally {
    f.stop();
  }
});

test("a replaced layout cannot receive further resize updates from its captured drag", async () => {
  const f = setup();
  try {
    const setter = vi.spyOn(f.terminal.fullscreen, "setLayoutRoot");
    await f.set("right", "# Plan");
    const originalSplit = setter.mock.calls[0]?.[0];
    assert.ok(originalSplit);
    mouse(f, 0, 50);
    mouse(f, 32, 56);
    assert.equal(dividerColumn(f.frame()), 56);
    f.terminal.fullscreen.setLayoutRoot(new Text("Foreign layout", 0, 0));
    mouse(f, 32, 70);
    mouse(f, 0, 70, "m");
    assert.match(f.frame().join("\n"), /Foreign layout/u);
    f.terminal.fullscreen.setLayoutRoot(originalSplit);
    assert.equal(dividerColumn(f.frame()), 50, "a detached split discards its preview");
    assert.deepEqual(f.savedRatios, []);
    f.switchMode("regular");
    f.switchMode("fullscreen");
    await Promise.resolve();
    assert.equal(dividerColumn(f.frame()), 50, "a replacement renderer never inherits an interrupted drag");
  } finally {
    f.stop();
  }
});

test("fullscreen split reserves real columns and collapses below either resize threshold", async () => {
  const f = setup();
  try {
    const empty = await f.set("right");
    assert.doesNotMatch(empty.join("\n"), /│|No completed plan yet/u);
    const [first] = await f.set("right", "# Right pane");
    assert.match(first ?? "", /^history .*│Plan/u);
    assert.equal(first?.indexOf("│"), 49);
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

test.each([
  { side: "left", divider: 51, resized: 45, planColumn: 10, chatColumn: 90 },
  { side: "right", divider: 50, resized: 56, planColumn: 90, chatColumn: 10 },
] as const)("the resized $side pane preserves editor, overlay and transcript input", async (layout) => {
  const f = setup();
  const overlayInput = new Input();
  const overlay = f.terminal.fullscreen.showOverlay(overlayInput, { width: 20, anchor: "top-left" });
  try {
    const plan = Array.from({ length: 40 }, (_, index) => `\`plan line ${index}\``).join("\n\n");
    await f.set(layout.side, plan);
    assert.equal(f.terminal.host.getFocusedComponent(), overlayInput);
    f.send("z");
    assert.equal(overlayInput.getValue(), "z");
    overlay.hide();
    mouse(f, 0, layout.divider);
    mouse(f, 32, layout.resized);
    mouse(f, 0, layout.resized, "m");
    assert.equal(dividerColumn(f.frame()), layout.resized);
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
    const pasted = "first line\nsecond line";
    f.send(`\u001b[200~${pasted}\u001b[201~`);
    assert.equal(f.editor.getExpandedText(), `main draft${pasted}`);
    const transcriptBefore = f.transcript.scrollTop;
    for (let index = 0; index < 20; index += 1) mouse(f, 73, layout.planColumn);
    assert.match(f.frame().join("\n"), /plan line 39/u);
    assert.equal(f.transcript.scrollTop, transcriptBefore, "pane wheel at bottom must not scroll chat");
    for (let index = 0; index < 20; index += 1) mouse(f, 72, layout.planColumn);
    assert.match(f.frame().join("\n"), /plan line 0/u);
    assert.equal(f.transcript.scrollTop, transcriptBefore, "pane wheel at top must not scroll chat");
    f.send("\u001b[5~");
    assert.ok(f.transcript.scrollTop < transcriptBefore);
    assert.match(f.frame().join("\n"), /plan line 0/u);
    const afterPage = f.transcript.scrollTop;
    mouse(f, 64, layout.chatColumn);
    assert.ok(f.transcript.scrollTop < afterPage);
    for (let index = 0; index < 6; index += 1) mouse(f, 65, layout.planColumn);
    assert.doesNotMatch(f.frame().join("\n"), /plan line 0\b/u);
    assert.match((await f.set(layout.side, "# Replaced plan")).join("\n"), /Replaced plan/u);
    assert.equal(f.editor.getExpandedText(), `main draft${pasted}`);
  } finally {
    overlay.hide();
    f.stop();
  }
});

test("empty or failed previews do not mount a pane and invalidate a pending mount", async () => {
  const f = setup();
  try {
    const setter = vi.spyOn(f.terminal.fullscreen, "setLayoutRoot");
    for (const preview of [
      undefined,
      { kind: "waiting" },
      { kind: "error", reason: "Cannot read the Markdown draft." },
      { kind: "draft", text: " \n\t" },
      { kind: "draft", text: "\u202e\u001b]0;Example\u0007" },
    ] as const) {
      f.pane.update(f.ctx, "right", "# Pending plan");
      f.pane.update(f.ctx, "right", preview);
      await Promise.resolve();
      assert.doesNotMatch(f.frame().join("\n"), /│|Pending plan|Cannot read/u);
    }
    assert.equal(setter.mock.calls.length, 0);
    assert.equal(dividerColumn(await f.set("right", "# Recovered")), 50);
  } finally {
    f.stop();
  }
});

test("manual hiding survives content and placement changes, but only toggles in a usable viewport", async () => {
  const f = setup();
  const toggle = () => f.pane.toggle(f.ctx.sessionManager);
  try {
    assert.equal(dividerColumn(await f.set("right", "# First plan")), 50);
    mouse(f, 0, 50);
    mouse(f, 32, 56);
    mouse(f, 0, 56, "m");
    assert.equal(dividerColumn(f.frame()), 56);
    f.resize(79, 18);
    toggle();
    f.resize(100, 18);
    assert.equal(dividerColumn(f.frame()), 56, "a narrow viewport cannot change the preference");
    toggle();
    assert.equal(dividerColumn(f.frame()), 0);
    toggle();
    assert.equal(dividerColumn(f.frame()), 56, "manually reopening uses the saved proportion");
    toggle();
    assert.equal(dividerColumn(await f.set("left")), 0);
    assert.equal(dividerColumn(await f.set("off", "# Updated plan")), 0);
    toggle();
    assert.equal(dividerColumn(await f.set("left", "# Updated plan")), 0);
    f.switchMode("regular");
    toggle();
    f.switchMode("fullscreen");
    const foreign = new Text("Foreign layout", 0, 0);
    f.terminal.fullscreen.setLayoutRoot(foreign);
    toggle();
    assert.match(f.frame().join("\n"), /Foreign layout/u);
    f.terminal.fullscreen.setLayoutRoot(f.root);
    assert.equal(dividerColumn(f.frame()), 0, "ignored keys do not reopen the pane on a compatible renderer");
    toggle();
    assert.equal(dividerColumn(f.frame()), 45);
    assert.match(f.frame().join("\n"), /Updated plan/u);
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
  } finally {
    f.stop();
  }
});

test("pane visibility requires a mounted layout and an exact, displayable completed plan", async () => {
  const f = setup();
  try {
    const plan = "# Current plan";
    const shows = () => f.pane.showsCompletedPlan(f.ctx.sessionManager, plan);
    f.pane.update(f.ctx, "right", { kind: "draft", text: plan });
    await Promise.resolve();
    assert.equal(shows(), false);
    f.pane.update(f.ctx, "left", plan);
    assert.equal(shows(), false, "mount is still pending");
    await Promise.resolve();
    assert.equal(shows(), true);
    const other: ExtensionContext = createMockContext({ mode: "tui" }).ctx;
    assert.equal(f.pane.showsCompletedPlan(other.sessionManager, plan), false);
    f.resize(100, 11);
    assert.equal(shows(), false, "the check uses the new size before repainting");
    f.resize(100, 12);
    assert.equal(shows(), true);
    f.pane.update(f.ctx, "left", "\u202e");
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, "\u202e"), false);
    f.pane.reset();
    assert.equal(shows(), false);
  } finally {
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
    assert.match((await f.set("right", "# Plan")).join("\n"), /Foreign layout/u);
    assert.equal(setter.mock.calls.length, 0);
    await f.set("off");
    f.terminal.fullscreen.setLayoutRoot(f.root);
    assert.match((await f.set("right", "# Plan")).join("\n"), /│Plan/u);
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
    assert.doesNotMatch((await f.set("right", "# Plan")).join("\n"), /│/u);
    f.frame();
    f.frame();
    await Promise.resolve();
    assert.equal(setter.mock.calls.length, 2);
    assert.equal(setter.mock.calls.at(-1)?.[0], f.root);
    f.pane.reset();
    f.pane.reset();
    assert.equal(setter.mock.calls.length, 2);
  } finally {
    f.stop();
  }
});

test.each(["rpc", "print", "json"] as const)("%s never initializes the pane widget", (mode) => {
  const context = createMockContext({ mode });
  const pane = createPlanPaneController();
  pane.update(context.ctx, "right", "# Plan");
  pane.reset();
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
    f.pane.reset();
    assert.doesNotMatch(next.frame().join("\n"), /Current session/u);
  } finally {
    f.stop();
    next.stop();
  }
});
