import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runSecretInput } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

test("secret input masks plaintext, preserves paste payload, and supports mouse cursor placement", async () => {
  const secret = "私🙂👨‍👩‍👧‍👦-private-password";
  const tui = createTuiHarness({ width: 24 });
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const pending = runSecretInput(ctx, { title: "WebDAV password" });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send(`\u001b[200~${secret}\u001b[201~`);
  let frame = tui.render();
  assert.doesNotMatch(frame.join("\n"), new RegExp(secret));
  assert.match(frame.join("\n"), /•+/u);
  assert.equal(frame.join("\n").includes(CURSOR_MARKER), true);
  for (const width of [1, 2, 8, 24]) {
    frame = tui.resize({ width });
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
    assert.equal(frame.join("\n").includes(secret), false);
  }

  tui.press("tui.input.submit");
  assert.deepEqual(await pending, { kind: "submitted", value: secret });

  const mouseTui = createTuiHarness({ width: 24 });
  const mouseContext = createMockContext({ mode: "tui", hasUI: true, custom: mouseTui.custom });
  const mousePending = runSecretInput(mouseContext.ctx, { title: "Mouse secret" });
  await mouseTui.waitForOpen();
  mouseTui.type("ac");
  frame = mouseTui.render();
  const inputRow = frame.map(stripVTControlCharacters).findIndex((line) => line.startsWith("> "));
  mouseTui.mouse({ type: "press", x: 3, y: inputRow });
  mouseTui.type("b");
  mouseTui.press("tui.input.submit");
  assert.deepEqual(await mousePending, { kind: "submitted", value: "abc" });
});

test("secret input retries required and chunked pasted-control validation in one component", async () => {
  const mapping: Record<string, string> = {
    "tui.input.submit": "\r",
    "tui.select.cancel": "\u001b",
    "tui.editor.deleteCharBackward": "\u007f",
  };
  const tui = createTuiHarness({
    width: 32,
    keybindings: {
      matches: (data, binding) => data === mapping[binding],
      getKeys: (binding) =>
        binding === "tui.input.submit" ? ["enter"] : binding === "tui.select.cancel" ? ["escape"] : ["backspace"],
    },
  });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const pending = runSecretInput(ctx, { title: "Password" });
  await tui.waitForOpen();
  tui.press("tui.input.submit");
  assert.equal(tui.isOpen, true);
  assert.match(notifications[0]?.message ?? "", /required/u);
  tui.send("\u001b[200~value");
  tui.send("\u0003");
  assert.equal(tui.isOpen, true);
  tui.send("\u001b[201~\r");
  assert.equal(tui.isOpen, true);
  assert.match(notifications.at(-1)?.message ?? "", /control characters/u);
  tui.send("\u007f");
  tui.press("tui.input.submit");
  assert.deepEqual(await pending, { kind: "submitted", value: "value" });
  assert.equal(tui.openCount, 1);
});

test("secret input supports optional empty values and hard cancellation with remapped keys", async () => {
  const keybindings = {
    matches: (data: string, binding: string) =>
      (binding === "tui.input.submit" && data === "s") || (binding === "tui.select.cancel" && data === "q"),
    getKeys: (binding: string) =>
      binding === "tui.input.submit" ? (["s"] as never[]) : binding === "tui.select.cancel" ? (["q"] as never[]) : [],
  };
  const optionalTui = createTuiHarness({ width: 40, keybindings });
  const optionalContext = createMockContext({ mode: "tui", hasUI: true, custom: optionalTui.custom });
  const optional = runSecretInput(optionalContext.ctx, { title: "Optional secret", required: false });
  await optionalTui.waitForOpen();
  assert.match(optionalTui.render().join("\n"), /s continue • q\/ctrl\+c cancel/u);
  optionalTui.send("s");
  assert.deepEqual(await optional, { kind: "submitted", value: "" });

  const cancelTui = createTuiHarness({ keybindings });
  const cancelContext = createMockContext({ mode: "tui", hasUI: true, custom: cancelTui.custom });
  const cancelled = runSecretInput(cancelContext.ctx, { title: "Secret" });
  await cancelTui.waitForOpen();
  cancelTui.type("private");
  cancelTui.press("ctrl+c");
  assert.deepEqual(await cancelled, { kind: "closed", reason: "close" });
});

test("secret input preserves remapped word movement and deletion bindings", async () => {
  const mapping: Record<string, string> = {
    "tui.input.submit": "s",
    "tui.select.cancel": "q",
    "tui.editor.cursorWordLeft": "L",
    "tui.editor.cursorWordRight": "R",
    "tui.editor.deleteWordBackward": "B",
    "tui.editor.deleteWordForward": "D",
  };
  const keybindings = {
    matches: (data: string, binding: string) => mapping[binding] === data,
    getKeys: (binding: string): KeyId[] => {
      const key = mapping[binding];
      return key ? [key as KeyId] : [];
    },
  };
  const cases = [
    { initial: "alpha beta", inputs: ["L", "D"], expected: "alpha " },
    { initial: "alpha gamma delta", inputs: ["L", "B"], expected: "alpha delta" },
    { initial: "alpha beta,gamma", inputs: ["L", "L", "R", "X"], expected: "alpha beta,Xgamma" },
  ];

  for (const example of cases) {
    const tui = createTuiHarness({ keybindings });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const pending = runSecretInput(context.ctx, { title: "Word editing" });
    await tui.waitForOpen();
    tui.type(example.initial);
    for (const input of example.inputs) tui.send(input);
    tui.send("s");
    assert.deepEqual(await pending, { kind: "submitted", value: example.expected });
  }
});

test("secret input preserves remapped undo across typing, paste, and deletion", async () => {
  const mapping: Record<string, string> = {
    "tui.input.submit": "S",
    "tui.select.cancel": "Q",
    "tui.editor.undo": "U",
    "tui.editor.deleteCharBackward": "B",
    "tui.editor.deleteCharForward": "F",
    "tui.editor.deleteWordBackward": "W",
    "tui.editor.deleteWordForward": "D",
    "tui.editor.cursorLeft": "L",
    "tui.editor.cursorLineStart": "H",
    "tui.editor.deleteToLineStart": "A",
    "tui.editor.deleteToLineEnd": "E",
  };
  const keybindings = {
    matches: (data: string, binding: string) => mapping[binding] === data,
    getKeys: (binding: string): KeyId[] => {
      const key = mapping[binding];
      return key ? [key as KeyId] : [];
    },
  };
  const cases = [
    { initial: "alpha", inputs: ["U"], expected: "" },
    { initial: "alpha", inputs: ["\u001b[200~ beta\u001b[201~", "U"], expected: "alpha" },
    { initial: "alpha", inputs: ["B", "U"], expected: "alpha" },
    { initial: "alpha", inputs: ["L", "F", "U"], expected: "alpha" },
    { initial: "alpha beta", inputs: ["W", "U"], expected: "alpha beta" },
    { initial: "alpha beta", inputs: ["H", "D", "U"], expected: "alpha beta" },
    { initial: "alpha", inputs: ["A", "U"], expected: "alpha" },
    { initial: "alpha", inputs: ["H", "E", "U"], expected: "alpha" },
  ];

  for (const example of cases) {
    const tui = createTuiHarness({ keybindings });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const pending = runSecretInput(context.ctx, { title: "Undo editing", required: false });
    await tui.waitForOpen();
    tui.type(example.initial);
    for (const input of example.inputs) tui.send(input);
    tui.send("S");
    assert.deepEqual(await pending, { kind: "submitted", value: example.expected });
  }
});

test("secret input preserves remapped kill, yank, and yank-pop bindings", async () => {
  const mapping: Record<string, string> = {
    "tui.input.submit": "S",
    "tui.select.cancel": "Q",
    "tui.editor.cursorLineStart": "H",
    "tui.editor.deleteWordBackward": "W",
    "tui.editor.deleteWordForward": "D",
    "tui.editor.deleteToLineStart": "A",
    "tui.editor.deleteToLineEnd": "E",
    "tui.editor.yank": "Y",
    "tui.editor.yankPop": "P",
  };
  const keybindings = {
    matches: (data: string, binding: string) => mapping[binding] === data,
    getKeys: (binding: string): KeyId[] => {
      const key = mapping[binding];
      return key ? [key as KeyId] : [];
    },
  };
  const cases = [
    { initial: "alpha", inputs: ["A", "Y"], expected: "alpha" },
    { initial: "alpha", inputs: ["H", "E", "Y"], expected: "alpha" },
    { initial: "alpha beta", inputs: ["W", "Y"], expected: "alpha beta" },
    { initial: "alpha beta", inputs: ["H", "D", "Y"], expected: "alpha beta" },
    { initial: "alpha beta gamma", inputs: ["W", "W", "Y"], expected: "alpha beta gamma" },
    { initial: "alpha beta gamma", inputs: ["H", "D", "D", "Y"], expected: "alpha beta gamma" },
  ];

  for (const example of cases) {
    const tui = createTuiHarness({ keybindings });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const pending = runSecretInput(context.ctx, { title: "Yank editing" });
    await tui.waitForOpen();
    tui.type(example.initial);
    for (const input of example.inputs) tui.send(input);
    tui.send("S");
    assert.deepEqual(await pending, { kind: "submitted", value: example.expected });
  }

  const tui = createTuiHarness({ keybindings });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const pending = runSecretInput(context.ctx, { title: "Yank pop" });
  await tui.waitForOpen();
  tui.type("alpha beta");
  tui.send("W");
  tui.type("gamma");
  tui.send("W");
  tui.send("Y");
  tui.send("P");
  tui.send("S");
  assert.deepEqual(await pending, { kind: "submitted", value: "alpha beta" });
});

test("secret input reports unsupported modes without opening a plaintext dialog", async () => {
  let inputCalls = 0;
  const unsupportedModes: unknown[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: async () => {
      inputCalls += 1;
      return "plaintext";
    },
  });
  assert.deepEqual(
    await runSecretInput(context.ctx, {
      title: "Secret",
      onUnsupportedMode: (_ctx, mode) => {
        unsupportedModes.push(mode);
      },
    }),
    { kind: "unsupported", mode: "rpc" },
  );
  assert.deepEqual(unsupportedModes, ["rpc"]);
  assert.equal(inputCalls, 0);
});

test("secret input revalidates isCurrent ownership before input and mouse dispatch", async () => {
  for (const dispatch of ["input", "mouse"] as const) {
    let current = true;
    const tui = createTuiHarness();
    const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const pending = runSecretInput(ctx, { title: "Stale secret", isCurrent: () => current });
    await tui.waitForOpen();
    current = false;
    if (dispatch === "input") tui.press("tui.input.submit");
    else tui.mouse({ type: "press", x: 2, y: 0 });
    assert.deepEqual(await pending, { kind: "stale" });
    assert.equal(tui.isOpen, false);
    assert.deepEqual(notifications, []);
  }
});

test("secret input returns stale on owner abort or external disposal and clears owned state", async () => {
  const owner = new AbortController();
  const abortTui = createTuiHarness();
  const abortContext = createMockContext({ mode: "tui", hasUI: true, custom: abortTui.custom });
  const aborted = runSecretInput(abortContext.ctx, { title: "Secret", signal: owner.signal });
  await abortTui.waitForOpen();
  abortTui.type("private");
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await aborted, { kind: "stale" });

  const disposeTui = createTuiHarness();
  const disposeContext = createMockContext({ mode: "tui", hasUI: true, custom: disposeTui.custom });
  const disposed = runSecretInput(disposeContext.ctx, { title: "Secret" });
  await disposeTui.waitForOpen();
  disposeTui.type("private");
  disposeTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });
});
