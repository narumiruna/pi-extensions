import assert from "node:assert/strict";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  Text,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { fullscreenMounted } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createPlanPaneController } from "../src/plan-pane.js";
import { createPlanPaneShortcut, floatingAdjustmentKey } from "../src/plan-pane-shortcut.js";
import { createPlanPaneHost } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

const F10 = "\x1b[21~";
const F11 = "\x1b[23~";
const F4 = "\x1bOS";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const SHIFT_LEFT = "\x1b[1;2D";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const lineText = Array.from({ length: 30 }, (_, index) => `DraftLine${String(index).padStart(2, "0")}`).join("\n\n");

const bindings = { ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Interrupt" } } as const;

function fixture(mode: "regular" | "fullscreen", keys = new KeybindingsManager(bindings)) {
  initTheme("dark");
  const previous = getKeybindings();
  setKeybindings(keys);
  const host = createPlanPaneHost(mode);
  const pane = createPlanPaneController();
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: host.custom,
    onTerminalInput: (listener: Parameters<typeof host.host.addInputListener>[0]) =>
      host.host.addInputListener(listener),
  }).ctx as ExtensionContext;
  const mock = createMockPi();
  const shortcut = createPlanPaneShortcut(
    mock.pi,
    (shortcutCtx) => pane.toggle(shortcutCtx.sessionManager),
    (shortcutCtx, data, canToggle) => pane.handleInput(shortcutCtx.sessionManager, data, canToggle),
  );
  shortcut.startSession(ctx);
  return {
    host,
    pane,
    ctx,
    frame: () => host.render().map(stripTerminalSequences).join("\n"),
    draft: (text = lineText) => pane.update(ctx, "floating", { kind: "draft", text }),
    toggle() {
      const inEditor = host.host.getFocusedComponent() === host.editor;
      host.send(F4);
      if (inEditor) mock.shortcuts.get("f4")?.handler(ctx);
    },
    async mounted(expected = 1) {
      await vi.waitFor(() => assert.equal(host.overlays.length, expected));
      host.render();
    },
    close() {
      shortcut.disposeSession();
      pane.reset();
      host.stop();
      setKeybindings(previous);
    },
  };
}

test.each([
  [{}, "regular", undefined, "f10"],
  [{ editor: ["invalid", "SHIFT+CTRL+F10"] }, "fullscreen", undefined, "f10"],
  [{ editor: ["invalid", "F10"] }, "regular", undefined, "f11"],
  [{ "tui.altScreen.search": "f10" }, "regular", undefined, "f10"],
  [{ "tui.altScreen.search": "f10" }, "fullscreen", "F11", "f12"],
  [{ "tui.altScreen.search": "CTRL+c" }, "fullscreen", undefined, undefined],
  [{ editor: ["F10", "f11", "f12"] }, "regular", undefined, undefined],
] as const)("selects the reachable adjustment key for %j in %s", (bindings, mode, shortcut, expected) => {
  assert.equal(floatingAdjustmentKey(bindings, mode, shortcut), expected);
});

test.each(["regular", "fullscreen"] as const)(
  "%s preview stays passive and temporarily adjusts with native input",
  async (mode) => {
    const f = fixture(
      mode,
      new KeybindingsManager(bindings, { "tui.editor.historyPrevious": "f10", "app.interrupt": "ctrl+x" }),
    );
    try {
      f.draft();
      await f.mounted();
      const handle = f.host.overlays[0];
      const before = handle.getBounds();
      assert.ok(before);
      assert.match(f.frame(), /Plan draft · F11 adjust/u);
      assert.match(f.frame(), /DraftLine00/u);
      assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
      f.host.send("x");
      assert.match(f.host.editor.getText(), /x/u);
      f.host.send("\x1b[200~");
      f.host.send(F11);
      f.host.send("\x1b[201~");
      f.host.send("\x1b[23;1:3~");
      f.host.send("\x1b[23;1:2~");
      assert.equal(handle.isFocused(), false);

      const peer = f.host.host.showOverlay(new Text("Other dialog"));
      f.host.send(F11);
      assert.equal(peer.isFocused(), true);
      assert.doesNotMatch(f.frame(), /F11 adjust/u);
      peer.hide();
      const editorAtMount = f.host.editor;
      f.host.replaceEditor();
      assert.notEqual(f.host.editor, editorAtMount);
      f.host.send(F11);
      assert.equal(handle.isFocused(), true);
      const transcriptTop = f.host.transcript.scrollTop;
      f.host.send(LEFT);
      f.host.send(DOWN);
      f.host.send(SHIFT_LEFT);
      assert.deepEqual(handle.getBounds(), {
        ...before,
        col: before.col - 1,
        row: before.row + 1,
        width: before.width - 1,
      });
      f.host.send(PAGE_DOWN);
      assert.doesNotMatch(f.frame(), /DraftLine00/u);
      assert.equal(f.host.transcript.scrollTop, transcriptTop);
      f.host.send(PAGE_UP);
      assert.match(f.frame(), /DraftLine00/u);
      f.host.send("\x1b");
      assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
      f.host.send(F11);
      f.host.send("\x18");
      assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
      f.host.send(F11);
      f.host.send("\x03");
      assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
      f.host.send("y");
      assert.match(f.host.editor.getText(), /y/u);
      assert.equal(f.host.overlays.length, 1);
    } finally {
      f.close();
    }
  },
);

test("fullscreen search keeps native precedence when remapped to F10", async () => {
  const f = fixture("fullscreen", new KeybindingsManager(bindings, { "tui.altScreen.search": "f10" }));
  try {
    f.draft();
    await f.mounted();
    const plan = f.host.overlays[0];
    assert.match(f.frame(), /F11 adjust/u);
    f.host.send(F10);
    assert.notEqual(f.host.host.getFocusedComponent(), f.host.editor);
    assert.equal(plan.isFocused(), false);
    f.host.send(F11);
    assert.equal(plan.isFocused(), false);
    f.host.send(F10);
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
    f.host.send(F11);
    assert.equal(plan.isFocused(), true);
    f.host.send("\x03");
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
  } finally {
    f.close();
  }
});

test("fullscreen drag and wheel never focus; refresh clamps and F4 keeps bounds but resets the scroll", async () => {
  const f = fixture("fullscreen");
  try {
    f.draft(`\u202e${lineText}`);
    await f.mounted();
    const handle = f.host.overlays[0];
    const before = handle.getBounds();
    assert.ok(before);
    const mouse = (code: number, col: number, row: number, suffix = "M") =>
      f.host.send(`\x1b[<${code};${col + 1};${row + 1}${suffix}`);
    mouse(0, before.col + 2, before.row);
    mouse(32, before.col - 2, before.row);
    mouse(0, before.col - 2, before.row, "m");
    const moved = handle.getBounds();
    assert.deepEqual(moved, { ...before, col: before.col - 4 });
    const gripCol = before.col - 4 + before.width - 1;
    const gripRow = before.row + before.height - 1;
    mouse(0, gripCol, gripRow);
    mouse(32, gripCol - 2, gripRow + 1);
    mouse(0, gripCol - 2, gripRow + 1, "m");
    const resized = handle.getBounds();
    assert.deepEqual(resized, { ...moved, width: before.width - 2, height: before.height + 1 });
    const history = f.host.transcript.scrollTop;
    mouse(65, before.col + 2, before.row + 2);
    assert.doesNotMatch(f.frame(), /DraftLine00|\u202e/u);
    assert.equal(f.host.transcript.scrollTop, history);
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
    f.draft(lineText.replaceAll("Draft", "Updated"));
    assert.doesNotMatch(f.frame(), /UpdatedLine00/u);
    assert.match(f.frame(), /UpdatedLine/u);
    f.draft("# Short revision 界");
    assert.match(f.frame(), /Short revision 界/u);
    f.draft();
    mouse(65, before.col + 2, before.row + 2);
    assert.doesNotMatch(f.frame(), /DraftLine00/u);
    f.host.send(F10);
    f.toggle();
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
    assert.equal(f.host.closes, 1);
    assert.doesNotMatch(f.frame(), /Plan draft/u);
    f.pane.update(f.ctx, "floating", lineText);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, lineText), false);
    f.toggle();
    await f.mounted(2);
    assert.deepEqual(f.host.overlays[1].getBounds(), resized);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, lineText), true);
    assert.match(f.frame(), /DraftLine00/u);
    const revision = `# New heading\n\n${lineText}`;
    f.pane.update(f.ctx, "floating", revision);
    assert.deepEqual(f.host.overlays[1].getBounds(), resized);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, revision), false);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, lineText), false);
    assert.match(f.frame(), /New heading/u);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, revision), true);
    f.host.send(F10);
    f.host.resize(27, 9);
    assert.doesNotMatch(f.frame(), /Plan · Ready/u);
    await fullscreenMounted();
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, revision), false);
    f.host.resize(100, 18);
    assert.match(f.frame(), /Plan · Ready/u);
    assert.equal(f.pane.showsCompletedPlan(f.ctx.sessionManager, revision), true);
    assert.ok(f.host.render().every((row) => visibleWidth(row) <= 100));
  } finally {
    f.close();
  }
});

test("changing placement closes only the Plan overlay; the latest choice wins", async () => {
  const f = fixture("fullscreen");
  try {
    f.draft("# First placement");
    await f.mounted();
    f.host.send(F10);
    assert.equal(f.host.overlays[0].isFocused(), true);
    const other = f.host.host.showOverlay(new Text("Other dialog"));
    f.pane.update(f.ctx, "off", undefined);
    assert.equal(f.host.closes, 1);
    assert.equal(other.isFocused(), true);
    f.draft("# Superseded placement");
    f.pane.update(f.ctx, "off", undefined);
    f.draft("# Latest placement");
    await f.mounted(2);
    assert.equal(other.isFocused(), true);
    assert.equal(f.host.overlays[1].isFocused(), false);
    other.hide();
    assert.equal(f.host.host.getFocusedComponent(), f.host.editor);
    assert.match(f.frame(), /Latest placement/u);
    assert.doesNotMatch(f.frame(), /First placement|Superseded placement/u);
  } finally {
    f.close();
  }
});

test("replacing the UI in the same session detaches the preview from the old renderer", async () => {
  const f = fixture("fullscreen");
  const replacement = createPlanPaneHost("regular");
  try {
    f.draft("# Original document");
    await f.mounted();
    const next = { ...f.ctx, ui: { ...f.ctx.ui, custom: replacement.custom } };
    f.pane.update(next, "floating", { kind: "draft", text: "# Revised document" });
    await vi.waitFor(() => assert.equal(replacement.overlays.length, 1));
    assert.equal(f.host.closes, 1);
    assert.doesNotMatch(f.frame(), /Original document/u);
    assert.match(replacement.render().map(stripTerminalSequences).join("\n"), /Revised document/u);
    assert.equal(replacement.host.getFocusedComponent(), replacement.editor);
  } finally {
    f.close();
    replacement.stop();
  }
});

test("late factories and stale questionnaire releases cannot affect the next workflow", async () => {
  const f = fixture("fullscreen");
  const delayed = Promise.withResolvers<void>();
  try {
    const custom = vi.spyOn(f.ctx.ui, "custom");
    f.host.delayNextFactory(delayed.promise);
    f.draft("# Stale draft");
    await vi.waitFor(() => assert.equal(custom.mock.calls.length, 1));
    const resumeStale = f.pane.pauseForQuestion();
    f.pane.reset();
    const resumeCurrent = f.pane.pauseForQuestion();
    f.draft("# Current draft");
    resumeStale();
    delayed.resolve();
    await fullscreenMounted();
    assert.equal(f.host.closes, 1);
    assert.equal(f.host.overlays.length, 0);
    resumeCurrent();
    await f.mounted();
    assert.match(f.frame(), /Current draft/u);
    assert.doesNotMatch(f.frame(), /Stale draft/u);
    f.host.resetCustomUi();
    assert.equal(f.host.closes, 2);
    f.pane.reset();
    assert.equal(f.host.closes, 2);
    assert.doesNotMatch(f.frame(), /Current draft/u);
  } finally {
    delayed.resolve();
    f.close();
  }
});
