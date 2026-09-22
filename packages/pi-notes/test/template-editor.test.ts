import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  getKeybindings,
  type KeybindingsConfig,
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

async function confirmPasteAndSubmit(tui: ReturnType<typeof createTuiHarness>): Promise<void> {
  await tui.waitForPending();
  tui.press("tui.input.submit");
  assert.equal(tui.isOpen, true);
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /Paste boundary pending/iu);
  tui.press("tui.input.submit");
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
  await confirmPasteAndSubmit(tui);

  assert.equal(await editing, `${content}x${streamed}${pasted}`);
});

test("template editor decodes tmux CSI-u paste controls before preserving raw content", async () => {
  const cases = [
    { input: "\u001b[97;5u", expected: "\u0001" },
    { input: "\u001b[122;5u", expected: "\u001a" },
    { input: "\u001b[65;5u", expected: "\u0001" },
    { input: "\u001b[90;5u", expected: "\u001a" },
    { input: "\u001b[106;5u", expected: "\n" },
    { input: "\u001b[74;5u", expected: "\n" },
    { input: "\u001b[96;5u", expected: "\u001b[96;5u" },
    { input: "\u001b[123;5u", expected: "\u001b[123;5u" },
    { input: "\u001b[106;4u", expected: "\u001b[106;4u" },
  ];
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot(""), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send(`\u001b[200~${cases.map(({ input }) => input).join("|")}\u001b[201~`);
  const frame = tui.render().join("\n");
  assert.equal(frame.includes("\u0001"), false);
  assert.equal(frame.includes("\u001a"), false);
  await confirmPasteAndSubmit(tui);

  assert.equal(await editing, cases.map(({ expected }) => expected).join("|"));
});

test("template editor reserves literal private-use characters across normal undo history", async () => {
  const content = "\ue000";
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot(content), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send("\u007f");
  tui.send("\u202e");
  tui.send("\u001f");
  tui.send("\u001f");
  tui.press("tui.input.submit");

  assert.equal(await editing, content);
});

test("template editor preserves literal Pi paste-marker text around a large paste", async () => {
  const content = "[paste #1 1100 chars]";
  const pasted = "p".repeat(1_100);
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot(content), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  assert.equal(stripVTControlCharacters(tui.render().join("\n")).includes(content), true);
  tui.send(`\u001b[200~${pasted}\u001b[201~`);
  await tui.waitForPending();
  await confirmPasteAndSubmit(tui);

  assert.equal(await editing, `${content}${pasted}`);
});

test("template editor protects typed Pi paste-marker text for legacy and Kitty input", async () => {
  const literal = "[paste #1 1100 chars]";
  const pasted = "p".repeat(1_100);
  for (const hashInput of ["#", "\u001b[35u"]) {
    const tui = createTuiHarness({ width: 72, rows: 20 });
    const context = editorContext(tui);
    const editing = showTemplateEditor(context.ctx, snapshot(""), {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await tui.waitForOpen();
    tui.setFocused(true);
    for (const character of literal) tui.send(character === "#" ? hashInput : character);
    tui.send(`\u001b[200~${pasted}\u001b[201~`);
    await confirmPasteAndSubmit(tui);

    assert.equal(await editing, `${literal}${pasted}`);
  }
});

test("template editor preserves hash identity during Pi character jumps", async () => {
  const tui = createTuiHarness({ width: 72, rows: 20 });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot("# one # two"), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send("\u0001");
  tui.send("\u001d");
  tui.send("#");
  tui.type("X");
  tui.press("tui.input.submit");

  assert.equal(await editing, "# one X# two");
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
  await confirmPasteAndSubmit(tui);

  assert.equal(await editing, "before first-tailsecond");
});

test("template editor rejects a paste tail that arrives after the shortcut guard drains", async () => {
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
  tui.send(`${start}a${end}`);
  await tui.waitForPending();
  tui.send("\r");
  assert.equal(tui.isOpen, true);
  tui.send("b");
  await nextEventLoopTurn();
  tui.send(end);
  const frame = tui.render().join("\n");
  assert.match(stripVTControlCharacters(frame), /Paste rejected.*ambiguous/iu);
  tui.press("tui.input.submit");

  assert.equal(await editing, "before ");
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

test("template editor gives focused editing actions priority over a colliding cancel binding", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const bindings = {
    "tui.select.cancel": [
      "backspace",
      "shift+backspace",
      "shift+delete",
      "shift+space",
      "enter",
      "alt+enter",
      "shift+enter",
      "ctrl+j",
    ],
    "tui.input.newLine": "ctrl+n",
    "tui.editor.deleteWordBackward": "alt+enter",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keybindings);
  const tui = createTuiHarness({ width: 72, rows: 20, keybindings });
  const context = editorContext(tui);
  const editing = showTemplateEditor(context.ctx, snapshot("wrongxy"), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await tui.waitForOpen();
  tui.setFocused(true);
  const frame = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(frame, /ctrl\+c cancel/iu);
  assert.doesNotMatch(frame, /backspace.*cancel/iu);
  tui.send("\u007f");
  tui.send("\u001b[127;2u");
  tui.send("\u001b[32;2u");
  tui.type("x");
  tui.send("\u001b[D");
  tui.send("\u001b[3;2~");
  tui.send("\u007f");
  tui.send("\u000e");
  tui.type("second");
  tui.send("\u001b[13;2~");
  tui.type("third");
  tui.send("\n");
  tui.type("fourth");
  tui.send("\r");

  assert.equal(await editing, "wrong\nsecond\nthird\nfourth");
});

test("template editor resolves custom cancel bindings without preempting printable input", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const cases: Array<{
    name: string;
    cancel: KeybindingsConfig["tui.select.cancel"];
    input: string;
    expected?: string;
  }> = [
    { name: "modifier order", cancel: "shift+ctrl+x", input: "\u001b[120;6u" },
    {
      name: "first usable fallback",
      cancel: ["not-a-key", "ctrl+x"] as unknown as KeybindingsConfig["tui.select.cancel"],
      input: "\u0018",
    },
    {
      name: "hard-cancel fallback",
      cancel: "not-a-key" as unknown as KeybindingsConfig["tui.select.cancel"],
      input: "\u0003",
    },
    { name: "legacy printable collision", cancel: "x", input: "x", expected: "x" },
    { name: "Kitty printable collision", cancel: "x", input: "\u001b[120u", expected: "x" },
    { name: "modifyOtherKeys collision", cancel: "shift+x", input: "\u001b[27;2;88~", expected: "X" },
  ];

  for (const testCase of cases) {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.cancel": testCase.cancel,
    });
    setKeybindings(keybindings);
    const tui = createTuiHarness({ width: 72, rows: 20, keybindings });
    const context = editorContext(tui);
    const editing = showTemplateEditor(context.ctx, snapshot(""), {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await tui.waitForOpen();
    tui.setFocused(true);
    tui.send(testCase.input);
    if (testCase.expected !== undefined) tui.press("tui.input.submit");

    assert.equal(await editing, testCase.expected, testCase.name);
  }
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

  const pasteTui = createTuiHarness({ width: 60, rows: 20, keybindings });
  const pasteContext = editorContext(pasteTui);
  const pasteSubmitted = showTemplateEditor(pasteContext.ctx, snapshot("edge "), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await pasteTui.waitForOpen();
  pasteTui.send("\u001b[200~paste\u001b[201~");
  await pasteTui.waitForPending();
  pasteTui.send("\u0013");
  assert.equal(pasteTui.isOpen, true);
  pasteTui.send("\u0013");
  assert.equal(await pasteSubmitted, "edge paste");

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
