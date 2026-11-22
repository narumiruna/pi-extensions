import assert from "node:assert/strict";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { Input, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { DraftPreview } from "../src/plan-draft.js";
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
    async set(side: "left" | "right" | "off", plan?: string | DraftPreview) {
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

function dividerColumn(frame: readonly string[]) {
  const index = frame[0]?.indexOf("│") ?? -1;
  return index + 1;
}

function mouse(f: ReturnType<typeof setup>, button: number, column: number, suffix = "M", row = 4) {
  f.send(`\u001b[<${button};${column};${row}${suffix}`);
}

test.each([
  { side: "right", initial: 67, wider: 55, min: 76, max: 49 },
  { side: "left", initial: 34, wider: 46, min: 25, max: 52 },
] as const)("dragging the $side divider reflows the plan and respects both width limits", async (layout) => {
  const f = setup();
  try {
    const plan = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const original = await f.set(layout.side, plan);
    assert.equal(dividerColumn(original), layout.initial);
    assert.doesNotMatch(original.join("\n"), /one two three four five six seven eight nine/u);

    mouse(f, 0, layout.initial);
    mouse(f, 32, layout.wider);
    assert.equal(dividerColumn(f.frame()), layout.wider, "the divider moves before release");
    assert.match(f.frame().join("\n"), /one two three four five six seven eight nine/u);
    mouse(f, 32, layout.side === "left" ? 1 : 100);
    assert.equal(dividerColumn(f.frame()), layout.min, "the pane keeps at least 24 columns");
    mouse(f, 32, layout.side === "left" ? 100 : 1);
    assert.equal(dividerColumn(f.frame()), layout.max, "the conversation keeps at least 48 columns");
    mouse(f, 0, layout.max, "m");
    mouse(f, 32, layout.wider);
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
    mouse(f, 0, 67);
    mouse(f, 32, 56);
    assert.equal(dividerColumn(f.frame()), 56);
    f.resize(100, 20);
    mouse(f, 32, 73);
    mouse(f, 0, 73, "m");
    assert.equal(dividerColumn(f.frame()), 56, "a row-only resize cancels the drag before the next paint");
    mouse(f, 0, 56);

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
    assert.equal(dividerColumn(await f.set("right")), 67);
  } finally {
    f.stop();
  }
});

test("only a left-button press on the visible divider enables a resize", async () => {
  const f = setup();
  try {
    await f.set("right");
    mouse(f, 1, 67);
    mouse(f, 33, 56);
    mouse(f, 1, 56, "m");
    mouse(f, 0, 60);
    mouse(f, 32, 67);
    mouse(f, 0, 67, "m");
    assert.equal(dividerColumn(f.frame()), 67);

    const input = new Input();
    const overlay = f.terminal.fullscreen.showOverlay(input, { width: 20, anchor: "top-right", offsetX: -25 });
    try {
      f.frame();
      mouse(f, 0, 67, "M", 1);
      mouse(f, 32, 56, "M", 1);
      mouse(f, 0, 56, "m", 1);
      f.send("z");
      assert.equal(input.getValue(), "z");
    } finally {
      overlay.hide();
    }
    assert.equal(dividerColumn(f.frame()), 67, "an overlay covering the divider gets the press");

    mouse(f, 0, 67);
    f.send("\u001b[O");
    mouse(f, 32, 67);
    mouse(f, 32, 56);
    assert.equal(dividerColumn(f.frame()), 67, "focus loss ends the gesture even without release");
    assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
    mouse(f, 0, 67);
    mouse(f, 32, 56);
    mouse(f, 0, 56, "m");
    assert.equal(dividerColumn(f.frame()), 56, "a new press starts a new gesture");
  } finally {
    f.stop();
  }
});

test("a replaced layout cannot receive further resize updates from its captured drag", async () => {
  const f = setup();
  try {
    const setter = vi.spyOn(f.terminal.fullscreen, "setLayoutRoot");
    await f.set("right");
    const originalSplit = setter.mock.calls[0]?.[0];
    assert.ok(originalSplit);
    mouse(f, 0, 67);
    mouse(f, 32, 56);
    assert.equal(dividerColumn(f.frame()), 56);
    f.terminal.fullscreen.setLayoutRoot(new Text("Foreign layout", 0, 0));
    mouse(f, 32, 70);
    mouse(f, 0, 70, "m");
    assert.match(f.frame().join("\n"), /Foreign layout/u);
    f.terminal.fullscreen.setLayoutRoot(originalSplit);
    assert.equal(dividerColumn(f.frame()), 56, "a detached split cannot change width");
    f.switchMode("regular");
    f.switchMode("fullscreen");
    await Promise.resolve();
    assert.equal(dividerColumn(f.frame()), 67, "a replacement renderer starts at the default width");
  } finally {
    f.stop();
  }
});

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

test.each([
  { side: "left", divider: 34, resized: 45, planColumn: 10, chatColumn: 90 },
  { side: "right", divider: 67, resized: 56, planColumn: 90, chatColumn: 10 },
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
    f.pane.clear();
    assert.equal(shows(), false);
  } finally {
    f.stop();
  }
});

function draft(text: string): DraftPreview {
  return { kind: "draft", text };
}

test("visible draft revisions compare with the immediately preceding preview", async () => {
  const f = setup();
  try {
    const first = await f.set("right", draft("# First draft\n\nKeep this.\n"));
    assert.match(first.join("\n"), /First draft/u);
    assert.doesNotMatch(first.join("\n"), /Show Markdown|@@|\+.*First draft/u);
    const second = await f.set("right", draft("# Second draft\n\nKeep this.\n"));
    assert.match(second.join("\n"), /-# First draft/u);
    assert.match(second.join("\n"), /\+# Second draft/u);
    assert.deepEqual(await f.set("right", draft("# Second draft\r\n\r\nKeep this.\r\n")), second);
    const third = await f.set("right", draft("# Third draft\n\nKeep this.\n"));
    assert.match(third.join("\n"), /-# Second draft/u);
    assert.match(third.join("\n"), /\+# Third draft/u);
    assert.doesNotMatch(third.join("\n"), /First draft/u);
    const completed = await f.set("right", "# Third draft\n\nKeep this.\n");
    assert.match(completed.join("\n"), /Plan · Ready/u);
    assert.doesNotMatch(completed.join("\n"), /Show Markdown|@@|Second draft/u);
  } finally {
    f.stop();
  }
});

test.each(["left", "right"] as const)(
  "the %s draft toggle stays reachable and never takes editor focus",
  async (side) => {
    const f = setup();
    const text = (word: string) =>
      `# ${word}\n\n${Array.from({ length: 45 }, (_, i) => `${word} line ${i}`).join("\n")}\n`;
    try {
      f.resize(80, 12);
      await f.set(side, draft(text("Original")));
      const changes = await f.set(side, draft(text("Revised")));
      const column = side === "left" ? 1 : dividerColumn(changes) + 1;
      const view = () => f.frame().join("\n");
      const click = () => {
        mouse(f, 0, column, "M", 1);
        mouse(f, 0, column, "m", 1);
      };
      assert.match(changes[0] ?? "", /\[Show Markdown\]/u);
      const transcript = f.transcript.scrollTop;
      for (let index = 0; index < 40; index += 1) mouse(f, 73, column, "M", 1);
      assert.match(view(), /\+Revised line 44/u);
      assert.match(f.frame()[0] ?? "", /\[Show Markdown\]/u);
      assert.equal(f.transcript.scrollTop, transcript);
      mouse(f, 0, column, "M", 1);
      mouse(f, 32, column + 1, "M", 1);
      mouse(f, 0, column, "m", 1);
      assert.match(view(), /Show Markdown/u);
      mouse(f, 0, column, "M", 1);
      f.resize(81, 12);
      f.frame();
      f.resize(80, 12);
      f.frame();
      mouse(f, 0, column, "m", 1);
      assert.match(view(), /Show Markdown/u);

      const overlay = f.terminal.fullscreen.showOverlay(new Input(), {
        anchor: side === "left" ? "top-left" : "top-right",
        width: 18,
      });
      try {
        f.frame();
        const overlayColumn = side === "left" ? column : column + 10;
        mouse(f, 0, overlayColumn, "M", 1);
        mouse(f, 0, overlayColumn, "m", 1);
      } finally {
        overlay.hide();
      }
      assert.match(view(), /Show Markdown/u);
      click();
      assert.match(view(), /Show changes/u);
      assert.match(view(), /Revised line 0/u);
      assert.doesNotMatch(view(), /Original|@@|\+Revised/u);
      mouse(f, 65, column, "M", 1);
      const scrolled = view();
      assert.deepEqual((await f.set(side, draft(text("Revised")))).join("\n"), scrolled);
      click();
      assert.match(view(), /-# Original/u);
      assert.match(view(), /\+# Revised/u);
      assert.equal(f.terminal.host.getFocusedComponent(), f.editor);
      assert.equal(f.transcript.scrollTop, transcript);
      f.send("\u001b[200~kept\neditor\u001b[201~");
      assert.equal(f.editor.getExpandedText(), "main draftkept\neditor");
      assert.ok(f.frame().every((line) => visibleWidth(line) <= 80));
    } finally {
      f.stop();
    }
  },
);

test("hidden updates and replacement renderers reopen on Markdown without replaying changes", async () => {
  const f = setup();
  try {
    await f.set("right", draft("# First"));
    assert.match((await f.set("right", draft("# Second"))).join("\n"), /Show Markdown/u);
    for (const [columns, rows] of [
      [79, 18],
      [100, 11],
    ] as const) {
      f.resize(columns, rows);
      assert.doesNotMatch(f.frame().join("\n"), /Show Markdown|Second/u);
      f.resize(100, 18);
      assert.match(f.frame().join("\n"), /Show Markdown/u);
    }
    f.resize(79, 18);
    await f.set("right", draft("# Unseen revision"));
    f.resize(100, 18);
    const latest = f.frame().join("\n");
    assert.match(latest, /Unseen revision/u);
    assert.doesNotMatch(latest, /Show Markdown|Second/u);
    const next = (await f.set("right", draft("# Visible revision"))).join("\n");
    assert.match(next, /-# Unseen revision/u);
    mouse(f, 0, dividerColumn(f.frame()) + 1, "M", 1);
    f.switchMode("regular");
    await f.set("right", draft("# Regular revision"));
    f.switchMode("fullscreen");
    await Promise.resolve();
    assert.match(f.frame().join("\n"), /Regular revision/u);
    assert.doesNotMatch(f.frame().join("\n"), /Show Markdown|Visible revision/u);
    assert.match((await f.set("right", draft("# Later revision"))).join("\n"), /-# Regular revision/u);
    f.switchMode("regular");
    f.switchMode("fullscreen");
    await Promise.resolve();
    assert.doesNotMatch(f.frame().join("\n"), /Show Markdown|Regular revision/u);
    assert.match(f.frame().join("\n"), /Later revision/u);
    await f.set("right", { kind: "error", reason: "Draft unavailable." });
    assert.match((await f.set("right", draft("# Recovered"))).join("\n"), /Recovered/u);
    assert.doesNotMatch(f.frame().join("\n"), /Show Markdown|Later revision/u);
    assert.match((await f.set("right", draft("# Next"))).join("\n"), /-# Recovered/u);
    assert.doesNotMatch((await f.set("left", draft("# Next"))).join("\n"), /Show Markdown|Recovered/u);
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
