import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { TemplateSnapshot } from "../src/storage.js";
import { showTemplateEditor } from "../src/template-editor.js";

function snapshot(content: string, relativePath = "draft.md"): TemplateSnapshot {
  return {
    relativePath,
    content,
    revision: "test-revision",
    size: Buffer.byteLength(content, "utf8"),
  };
}

function editorContext(tui: ReturnType<typeof createTuiHarness>) {
  return createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
}

test("template editor hides terminal controls and submits exact boundary whitespace", async () => {
  const content = " \tlead\u001b]52;c;QQ==\u0007\nbody\u001b[31m\u009b32m\u007f\u202e\u2028\n ";
  const tui = createTuiHarness({ width: 52, rows: 20 });
  const context = editorContext(tui);
  const controller = new AbortController();
  const editing = showTemplateEditor(context.ctx, snapshot(content, "unsafe\u001b]0;title\u0007.md"), {
    signal: controller.signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  const frame = tui.render();
  assert.ok(frame.every((line) => visibleWidth(line) <= 52));
  assert.equal(frame.join("\n").includes("\u001b]52"), false);
  assert.equal(frame.join("\n").includes("\u001b]0;title"), false);
  assert.equal(frame.join("\n").includes("QQ==\u0007"), false);
  for (const control of ["\u009b", "\u007f", "\u202e", "\u2028"]) {
    assert.equal(frame.join("\n").includes(control), false);
  }
  assert.match(stripVTControlCharacters(frame.join("\n")), /Terminal controls are hidden/iu);

  tui.press("tui.input.submit");
  assert.equal(await editing, content);
  assert.equal(tui.isOpen, false);
});

test("template editor preserves hidden raw content and boundary whitespace while editing and pasting", async () => {
  const content = "  start\nend\n";
  const pasted = `\tunsafe \u001b]52;c;QQ==\u0007 ${"p".repeat(1_100)} `;
  const streamed = "direct \u001b]0;title\u0007 text";
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot(content), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("x");
  tui.send(`${streamed}\u001b[200~${pasted}\u001b[201~`);
  await Promise.resolve();
  const frame = tui.render();
  assert.equal(frame.join("\n").includes("\u001b]52"), false);
  assert.equal(frame.join("\n").includes("QQ==\u0007"), false);
  assert.equal(frame.join("\n").includes("\u001b[201~"), false);
  tui.press("tui.input.submit");

  assert.equal(await editing, `${content}x${streamed}${pasted}`);
});

test("template editor accepts split paste chunks and a later distinct paste", async () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot("before "), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  for (const input of [`${start}first`, "-tail", end]) {
    tui.send(input);
    await nextEventLoopTurn();
  }
  await tui.waitForPending();
  tui.send(`${start}second${end}`);
  await tui.waitForPending();
  tui.press("tui.input.submit");

  assert.equal(await editing, "before first-tailsecond");
});

test("template editor rejects ambiguous literal paste terminators across later input callbacks", async () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  for (const inputs of [
    [`${start}a${end}b${end}`],
    [`${start}a${end}`, "\r", "b", end],
    [`${start}a${end}`, "\u0003", "b", end],
    [`${start}a${end}`, `${start}b${end}`],
  ]) {
    const tui = createTuiHarness({ width: 72, rows: 20 });
    const context = editorContext(tui);
    const editing = showTemplateEditor(context.ctx, snapshot("before "), {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await tui.waitForOpen();
    tui.setFocused(true);
    for (const input of inputs) {
      tui.send(input);
      await nextEventLoopTurn();
      assert.equal(tui.isOpen, true);
    }
    const frame = tui.render().join("\n");
    assert.equal(frame.includes(end), false);
    assert.match(stripVTControlCharacters(frame), /Paste rejected.*ambiguous/iu);
    tui.press("tui.input.submit");

    assert.equal(await editing, "before ");
  }
});

test("template editor undo after paste rejection cannot restore rejected content or private markers", async () => {
  const content = "before \u001b]0;title\u0007 ";
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot(content), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send(`${start}a${end}b${end}`);
  tui.type("x");
  tui.send("\u001f");
  tui.send("\u001f");
  const frame = tui.render().join("\n");
  assert.equal(frame.includes("\ue000"), false);
  assert.equal(stripVTControlCharacters(frame).includes("before a"), false);
  tui.press("tui.input.submit");

  assert.equal(await editing, "");
});

test("template editor honors configured submit and newline keys while Ctrl+C remains a hard cancel", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.input.newLine": "enter",
    "tui.input.submit": "ctrl+s",
    "tui.select.cancel": "ctrl+x",
  });
  setKeybindings(keybindings);

  const submitTui = createTuiHarness({ width: 60, rows: 20, keybindings });
  const submitContext = editorContext(submitTui);
  const submitted = showTemplateEditor(submitContext.ctx, snapshot("edge "), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await submitTui.waitForOpen();
  submitTui.send("\r");
  assert.equal(submitTui.isOpen, true);
  submitTui.send("\u0013");
  assert.equal(await submitted, "edge \n");

  for (const cancelInput of ["\u0018", "\u0003"]) {
    const cancelTui = createTuiHarness({ width: 60, rows: 20, keybindings });
    const cancelContext = editorContext(cancelTui);
    const cancelled = showTemplateEditor(cancelContext.ctx, snapshot("unchanged"), {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    await cancelTui.waitForOpen();
    cancelTui.send(cancelInput);
    assert.equal(await cancelled, undefined);
  }
});

test("template editor settles when ownership aborts or its host disposes it", async () => {
  for (const boundary of ["abort", "dispose"] as const) {
    const tui = createTuiHarness({ width: 60, rows: 20 });
    const context = editorContext(tui);
    const controller = new AbortController();
    const editing = showTemplateEditor(context.ctx, snapshot("unchanged"), {
      signal: controller.signal,
      isCurrent: () => true,
    });

    await tui.waitForOpen();
    tui.send("\u001b[200~pending\u001b[201~");
    tui.press("tui.input.submit");
    if (boundary === "abort") controller.abort(new DOMException("session replaced", "AbortError"));
    else tui.dispose();

    assert.equal(await editing, undefined);
    assert.equal(tui.isOpen, false);
  }
});
