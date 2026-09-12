import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  CURSOR_MARKER,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type QuestionnaireQuestion, runQuestionnaire } from "../src/questionnaire.js";
import { createTuiHarness } from "../src/testing/index.js";

const questions = [
  {
    id: "scope",
    header: "Scope",
    prompt: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  },
  {
    id: "tests",
    header: "Tests",
    prompt: "Which checks?",
    options: [
      { label: "Focused", description: "Run focused checks." },
      { label: "Full", description: "Run all checks." },
    ],
  },
] as const satisfies readonly QuestionnaireQuestion[];

const MAX_TEXT_LENGTH = 4_000;

function tuiRun(customQuestions: readonly QuestionnaireQuestion[] = questions, width = 60) {
  const tui = createTuiHarness({
    width,
    rows: 30,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, {
    questions: customQuestions,
    allowNotes: true,
    maxTextLength: MAX_TEXT_LENGTH,
  });
  return { tui, context, running };
}

function paste(tui: ReturnType<typeof createTuiHarness>, text: string) {
  tui.send(`\u001b[200~${text}\u001b[201~`);
}

test("runQuestionnaire validates generic input and unsupported modes", async () => {
  const invalidContext = createMockContext({ mode: "tui", hasUI: true });
  const invalid = await runQuestionnaire(invalidContext.ctx, { questions: [] });
  assert.equal(invalid.kind, "error");
  assert.match(invalidContext.notifications[0]?.message ?? "", /at least one question/u);

  const duplicate = await runQuestionnaire(invalidContext.ctx, {
    questions: [questions[0], questions[0]],
  });
  assert.equal(duplicate.kind, "error");
  assert.match(invalidContext.notifications.at(-1)?.message ?? "", /Duplicate questionnaire/u);

  const invisible = await runQuestionnaire(invalidContext.ctx, {
    questions: [{ ...questions[0], prompt: "\u001b[31m" }],
  });
  assert.equal(invisible.kind, "error");
  assert.match(invalidContext.notifications.at(-1)?.message ?? "", /displayable prompt/u);

  const modes: string[] = [];
  const printContext = createMockContext({ mode: "print", hasUI: false });
  assert.deepEqual(
    await runQuestionnaire(printContext.ctx, {
      questions,
      onUnsupportedMode: (_ctx, mode) => {
        modes.push(mode);
      },
    }),
    { kind: "unsupported", mode: "print" },
  );
  assert.deepEqual(modes, ["print"]);
});

test("runQuestionnaire preserves select framing, theme hierarchy, and read-only review", async () => {
  const foreground: Array<{ color: string; text: string }> = [];
  const bold: string[] = [];
  const tui = createTuiHarness({
    width: 60,
    rows: 30,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    theme: {
      fg: (color, text) => {
        foreground.push({ color: String(color), text });
        return text;
      },
      bold: (text) => {
        bold.push(text);
        return text;
      },
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, {
    questions,
    allowNotes: true,
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  const questionFrame = tui.render();
  assert.equal(questionFrame[0], "─".repeat(60));
  assert.equal(questionFrame.at(-1), "─".repeat(60));
  assert.ok(foreground.some(({ color, text }) => color === "accent" && text === "→ 1. Small — Only the bug."));
  assert.ok(foreground.some(({ color, text }) => color === "muted" && text === " — Include cleanup."));
  assert.ok(bold.includes("How broad?"));
  assert.match(questionFrame.join("\n"), /↑↓ navigate {2}enter select {2}escape\/ctrl\+c cancel/u);
  assert.match(questionFrame.join("\n"), /tab\/shift\+tab\/←→ questions {2}n note/u);
  assert.doesNotMatch(questionFrame.join("\n"), /[○●]/u);
  tui.invalidate();
  assert.deepEqual(tui.render(), questionFrame);

  tui.send("\u001b[C");
  tui.send("\u001b[C");
  foreground.length = 0;
  bold.length = 0;
  const review = tui.render().join("\n");
  assert.match(review, /\n 1\. Scope — Unanswered\n 2\. Tests — Unanswered/u);
  assert.doesNotMatch(review, /→ [12]\./u);
  assert.match(review, /enter submit/u);
  assert.doesNotMatch(review, /n note/u);
  assert.ok(bold.includes("Review answers"));
  const unchanged = tui.render().join("\n");
  tui.press("tui.select.down");
  assert.equal(tui.render().join("\n"), unchanged);
  tui.dispose();
  assert.deepEqual(await running, { kind: "stale" });
});

test("runQuestionnaire renders and submits a single question without review chrome", async () => {
  const singleQuestion = { ...questions[0], header: "Scope\u001b[31m" };
  const foreground: Array<{ color: string; text: string }> = [];
  const bold: string[] = [];
  const presetTui = createTuiHarness({
    width: 60,
    rows: 30,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    theme: {
      fg: (color, text) => {
        foreground.push({ color: String(color), text });
        return text;
      },
      bold: (text) => {
        bold.push(text);
        return text;
      },
    },
  });
  const presetContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: presetTui.custom,
  });
  const presetRunning = runQuestionnaire(presetContext.ctx, {
    questions: [singleQuestion],
    allowNotes: true,
    maxTextLength: MAX_TEXT_LENGTH,
  });
  await presetTui.waitForOpen();
  presetTui.setFocused(true);
  for (const width of [1, 8, 60]) {
    for (const line of presetTui.resize({ width })) assert.ok(visibleWidth(line) <= width);
  }
  const frame = presetTui.render().join("\n");
  assert.match(frame, /\n Scope\n/u);
  assert.equal(frame.includes("\u001b"), false);
  assert.match(frame, /enter submit/u);
  assert.doesNotMatch(frame, /\[Scope\]|✓ Scope|Review| questions/u);
  assert.ok(foreground.some(({ color, text }) => color === "muted" && text === "Scope"));
  assert.ok(foreground.some(({ color, text }) => color === "accent" && text === "How broad?"));
  assert.ok(bold.includes("How broad?"));
  presetTui.press("tui.select.down");
  presetTui.type("n");
  presetTui.type("keep focused");
  presetTui.press("tui.input.submit");
  presetTui.press("tui.select.confirm");
  assert.deepEqual(await presetRunning, {
    kind: "submitted",
    answers: [
      {
        questionId: "scope",
        answer: "Broad",
        wasCustom: false,
        optionIndex: 2,
        note: "keep focused",
      },
    ],
  });

  const custom = tuiRun([questions[0]]);
  await custom.tui.waitForOpen();
  custom.tui.setFocused(true);
  custom.tui.press("tui.select.up");
  custom.tui.press("tui.select.confirm");
  assert.match(custom.tui.render().join("\n"), /enter submit/u);
  custom.tui.type("custom scope");
  custom.tui.press("tui.input.submit");
  assert.deepEqual(await custom.running, {
    kind: "submitted",
    answers: [{ questionId: "scope", answer: "custom scope", wasCustom: true }],
  });
});

test("runQuestionnaire retains tabbed review for three questions", async () => {
  const thirdQuestion = {
    id: "risk",
    header: "Risk",
    prompt: "Which risk level?",
    options: [
      { label: "Low", description: "Keep the change narrow." },
      { label: "High", description: "Accept broader impact." },
    ],
  } as const satisfies QuestionnaireQuestion;
  const { tui, running } = tuiRun([...questions, thirdQuestion], 80);
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /\[Scope\] {2}Tests {2}Risk {2}Review/u);
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /1\. Scope — Small\n 2\. Tests — Focused\n 3\. Risk — Low/u);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      { questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1 },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
      { questionId: "risk", answer: "Low", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire uses configured standard actions before additive shortcuts", async () => {
  const bindings = {
    "tui.input.newLine": { data: "\u001b[13;3u", key: "alt+enter" },
    "tui.input.submit": { data: "\u0013", key: "ctrl+s" },
    "tui.input.tab": { data: "t", key: "t" },
    "tui.select.cancel": { data: "q", key: "q" },
    "tui.select.confirm": { data: "x", key: "x" },
    "tui.select.down": { data: "s", key: "s" },
    "tui.select.up": { data: "w", key: "w" },
  } as const;
  const tui = createTuiHarness({
    width: 120,
    rows: 30,
    keybindings: {
      matches: (data, binding) => bindings[binding as keyof typeof bindings]?.data === data,
      getKeys: (binding) => {
        const configured = bindings[binding as keyof typeof bindings];
        return configured ? [configured.key] : [];
      },
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, { questions, allowNotes: true });
  await tui.waitForOpen();
  tui.setFocused(true);
  assert.match(
    tui.render().join("\n"),
    /w\/s navigate {2}x select {2}q\/ctrl\+c cancel {2}t\/shift\+tab\/←→ questions {2}n note/u,
  );
  tui.send("j");
  assert.match(tui.render().join("\n"), /→ 2\. Broad/u);
  tui.send("k");
  assert.match(tui.render().join("\n"), /→ 1\. Small/u);
  tui.send("s");
  tui.send("t");
  assert.match(tui.render().join("\n"), /\[Tests\]/u);
  tui.send("\u001b[D");
  tui.send("x");
  tui.send("x");
  assert.match(tui.render().join("\n"), /x submit {2}q\/ctrl\+c cancel/u);
  tui.send("\n");
  assert.equal(tui.isOpen, true);
  tui.send("q");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("runQuestionnaire omits additive page keys that conflict with standard actions", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "right",
  });
  const tui = createTuiHarness({ width: 80, rows: 30, keybindings });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, { questions });
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  assert.match(frame, /right select/u);
  assert.match(frame, /tab\/shift\+tab\/← questions/u);
  assert.doesNotMatch(frame, /←→ questions/u);

  tui.send("\u001b[C");
  assert.match(tui.render().join("\n"), /✓ Scope {2}\[Tests\]/u);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runQuestionnaire omits question navigation when every additive key conflicts", async () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": ["tab", "shift+tab", "left", "right"],
  });
  const tui = createTuiHarness({ width: 120, rows: 30, keybindings });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, { questions });
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  assert.match(frame, /tab\/shift\+tab\/left\/right select/u);
  assert.doesNotMatch(frame, / questions/u);

  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runQuestionnaire gives configured standard actions priority over additive shortcuts", async () => {
  const bindings = {
    "tui.input.tab": { data: "j", key: "j" },
    "tui.select.cancel": { data: "q", key: "q" },
    "tui.select.confirm": { data: "x", key: "x" },
    "tui.select.down": { data: "n", key: "n" },
    "tui.select.up": { data: "w", key: "w" },
  } as const;
  const tui = createTuiHarness({
    keybindings: {
      matches: (data, binding) => bindings[binding as keyof typeof bindings]?.data === data,
      getKeys: (binding) => {
        const configured = bindings[binding as keyof typeof bindings];
        return configured ? [configured.key] : [];
      },
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, { questions, allowNotes: true });
  await tui.waitForOpen();
  assert.doesNotMatch(tui.render().join("\n"), /n note/u);
  tui.send("j");
  assert.match(tui.render().join("\n"), /\[Tests\]/u);
  tui.send("\u001b[D");
  tui.send("n");
  assert.match(tui.render().join("\n"), /→ 2\. Broad/u);
  assert.doesNotMatch(tui.render().join("\n"), /Optional note/u);
  tui.send("q");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("runQuestionnaire forwards passive hover and stable option mouse clicks through the outer wrapper", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  let frame = tui.render();
  let row = frame.findIndex((line) => line.includes("2. Broad"));
  assert.notEqual(row, -1);
  tui.mouse({ type: "move", x: 4, y: row });
  assert.match(tui.render().join("\n"), /→ 1\. Small/u);
  tui.mouse({ type: "press", x: 4, y: row });
  frame = tui.render();
  row = frame.findIndex((line) => line.includes("2. Broad"));
  tui.mouse({ type: "click", x: 4, y: row });
  assert.match(tui.render().join("\n"), /\[Tests\]/u);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runQuestionnaire forwards Editor mouse positioning without changing raw draft semantics", async () => {
  const { tui, running } = tuiRun([questions[0]]);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.type("ac");
  const frame = tui.render();
  const editorRow = frame
    .map(stripVTControlCharacters)
    .findIndex((line) => line.includes("ac") && !line.includes("Custom answer"));
  assert.notEqual(editorRow, -1);
  tui.mouse({ type: "click", x: 2, y: editorRow });
  tui.type("b");
  tui.press("tui.input.submit");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [{ questionId: "scope", answer: "abc", wasCustom: true }],
  });
});

test("runQuestionnaire distinguishes Back, Close, owner abort, disposal, and stale owners", async () => {
  async function drive(exit: "tui.select.cancel" | "ctrl+c") {
    const { tui, running } = tuiRun([questions[0]]);
    await tui.waitForOpen();
    tui.press(exit);
    return running;
  }
  assert.deepEqual(await drive("tui.select.cancel"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive("ctrl+c"), { kind: "closed", reason: "close" });

  const owner = new AbortController();
  const abortTui = createTuiHarness();
  const abortContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: abortTui.custom,
  });
  const aborted = runQuestionnaire(abortContext.ctx, {
    questions,
    signal: owner.signal,
  });
  await abortTui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await aborted, { kind: "stale" });
  assert.equal(abortTui.isOpen, false);

  const disposedTui = createTuiHarness();
  const disposedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: disposedTui.custom,
  });
  const disposed = runQuestionnaire(disposedContext.ctx, { questions });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });

  let current = true;
  const staleTui = createTuiHarness();
  const staleContext = createMockContext({ mode: "tui", hasUI: true, custom: staleTui.custom });
  const stale = runQuestionnaire(staleContext.ctx, {
    questions,
    isCurrent: () => current,
  });
  await staleTui.waitForOpen();
  current = false;
  staleTui.press("tui.select.confirm");
  assert.deepEqual(await stale, { kind: "stale" });
});

test("runQuestionnaire replaces answers, edits notes, accepts custom text, and submits in order", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  tui.setFocused(true);

  tui.type("n");
  paste(tui, "initial note");
  tui.press("tui.input.submit");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.send("\u001b[D");
  assert.doesNotMatch(tui.render().join("\n"), /initial note/u);
  tui.send("\u001b[C");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  paste(tui, "  custom answer  ");
  tui.press("tui.input.submit");
  tui.send("\u001b[D");
  tui.send("\u001b[D");
  tui.type("n");
  paste(tui, "final note");
  tui.press("tui.input.submit");
  tui.send("\u001b[C");
  tui.send("\u001b[C");
  assert.match(tui.render().join("\n"), /1\. Scope — Broad · Note: final note/u);
  tui.press("tui.select.confirm");

  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      {
        questionId: "scope",
        answer: "Broad",
        wasCustom: false,
        optionIndex: 2,
        note: "final note",
      },
      { questionId: "tests", answer: "  custom answer  ", wasCustom: true },
    ],
  });
});

test("runQuestionnaire restores the recorded answer cursor when revisiting a question", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.send("\u001b[D");
  assert.match(tui.render().join("\n"), /→ 2\. Broad ✓/u);
  tui.press("tui.select.up");
  tui.send("\u001b[C");
  tui.send("\u001b[D");
  assert.match(tui.render().join("\n"), /→ 2\. Broad ✓/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("runQuestionnaire preserves a custom answer note while editing the answer", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  paste(tui, "first answer");
  tui.press("tui.input.submit");
  tui.send("\u001b[D");
  tui.type("n");
  paste(tui, "keep this note");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");
  tui.send("\u0015");
  paste(tui, "edited answer");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      {
        questionId: "scope",
        answer: "edited answer",
        wasCustom: true,
        note: "keep this note",
      },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire blocks incomplete review submission and keeps note edits on questions", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  tui.send("\u001b[C");
  tui.send("\u001b[C");
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /Answer every question before submitting/u);
  tui.type("n");
  assert.match(tui.render().join("\n"), /Return to a question to add or edit its note/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("runQuestionnaire preserves raw pasted text while sanitizing every rendered width", async () => {
  const unsafeAnswer = "raw\u007f\u001b]8;;https://evil.example\u0007text\u202ereversed";
  const unsafeNote = "note\u009bcontrol\u202aspoofed";
  const malicious = [
    {
      id: "unsafe",
      header: "Head\u001b[31m",
      prompt: "Prompt\u001b]8;;https://evil.example\u0007text",
      options: [
        { label: "safe", description: "first" },
        { label: "other", description: "second" },
      ],
    },
    questions[1],
  ] as const;
  const { tui, running } = tuiRun(malicious, 16);
  await tui.waitForOpen();
  tui.setFocused(true);
  for (const width of [1, 8, 16, 24]) {
    const frame = tui.resize({ width });
    for (const line of frame) assert.ok(visibleWidth(line) <= width);
    assert.equal(stripVTControlCharacters(frame.join("\n")).includes("evil.example"), false);
  }
  tui.resize({ width: 40 });
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  paste(tui, unsafeAnswer);
  assert.equal(tui.render().join("\n").includes("\u202e"), false);
  for (const width of [1, 8, 16]) {
    for (const line of tui.resize({ width })) assert.ok(visibleWidth(line) <= width);
  }
  tui.resize({ width: 40 });
  tui.press("tui.input.submit");
  for (const width of [1, 8, 16]) {
    for (const line of tui.resize({ width })) assert.ok(visibleWidth(line) <= width);
  }
  tui.resize({ width: 40 });
  tui.send("\u001b[D");
  tui.type("n");
  paste(tui, unsafeNote);
  assert.equal(tui.render().join("\n").includes("\u202a"), false);
  tui.press("tui.input.submit");
  tui.send("\u001b[C");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      {
        questionId: "unsafe",
        answer: unsafeAnswer,
        wasCustom: true,
        note: unsafeNote,
      },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire keeps Backspace as editing and forwards Editor focus", async () => {
  const { tui, running } = tuiRun();
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
  tui.type("wrongx");
  tui.send("\u007f");
  tui.press("tui.input.submit");
  tui.send("\u001b[D");
  tui.type("n");
  tui.type("note!");
  tui.send("\u007f");
  tui.press("tui.input.submit");
  tui.send("\u001b[C");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      { questionId: "scope", answer: "wrong", wasCustom: true, note: "note" },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire keeps configured newline distinct from submit", async (t) => {
  const previous = getKeybindings();
  t.onTestFinished(() => setKeybindings(previous));
  const userBindings = {
    "tui.input.newLine": "alt+enter",
    "tui.input.submit": "ctrl+s",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, userBindings);
  setKeybindings(keybindings);
  const tui = createTuiHarness({ keybindings });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, { questions });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.type("first");
  tui.send("\u001b\r");
  tui.type("second");
  tui.send("\u0013");
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /first ↵ second/u);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      { questionId: "scope", answer: "first\nsecond", wasCustom: true },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire rejects empty and oversized custom text without closing", async () => {
  const { tui, running } = tuiRun([questions[0]]);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.type("   ");
  tui.press("tui.input.submit");
  assert.match(tui.render().join("\n"), /cannot be empty/u);
  tui.send("\u0015");
  paste(tui, "x".repeat(MAX_TEXT_LENGTH + 1));
  tui.press("tui.input.submit");
  assert.match(tui.render().join("\n"), /4,000 characters or fewer/u);
  assert.equal(tui.isOpen, true);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runQuestionnaire rejects oversized optional notes without closing", async () => {
  const { tui, running } = tuiRun([questions[0]]);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("n");
  paste(tui, "x".repeat(MAX_TEXT_LENGTH + 1));
  tui.press("tui.input.submit");
  assert.match(tui.render().join("\n"), /Note must be 4,000 characters or fewer/u);
  assert.equal(tui.isOpen, true);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runQuestionnaire applies a custom note label to editing and review", async () => {
  const tui = createTuiHarness({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS) });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, {
    questions,
    allowNotes: true,
    labels: { note: "Context", optionalNote: "Optional context" },
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("n");
  assert.match(tui.render().join("\n"), /Optional context/u);
  tui.type("why");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /Context: why/u);
  tui.press("tui.select.confirm");
  assert.equal((await running).kind, "submitted");
});

test("runQuestionnaire can disable custom answers and notes while applying generic labels", async () => {
  const tui = createTuiHarness({ keybindings: new KeybindingsManager(TUI_KEYBINDINGS) });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runQuestionnaire(context.ctx, {
    questions,
    allowCustomAnswer: false,
    allowNotes: false,
    labels: { reviewTab: "Check", reviewTitle: "Check response" },
  });
  await tui.waitForOpen();
  const questionFrame = tui.render().join("\n");
  assert.match(questionFrame, /Check/u);
  assert.doesNotMatch(questionFrame, /Other|n note/u);
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /Check response/u);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, {
    kind: "submitted",
    answers: [
      { questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1 },
      { questionId: "tests", answer: "Focused", wasCustom: false, optionIndex: 1 },
    ],
  });
});

test("runQuestionnaire preserves the sequential RPC fallback and retries custom answers", async () => {
  const selections = ["1. Small — Only the bug.", "3. Other (free-form)"];
  const editorAnswers = ["x".repeat(MAX_TEXT_LENGTH + 1), "rpc custom"];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => selections.shift(),
    editor: async () => editorAnswers.shift(),
    custom: async () => assert.fail("RPC must not open custom TUI"),
  });
  const result = await runQuestionnaire(context.ctx, {
    questions,
    allowNotes: true,
    maxTextLength: MAX_TEXT_LENGTH,
  });
  assert.deepEqual(result, {
    kind: "submitted",
    answers: [
      { questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1 },
      { questionId: "tests", answer: "rpc custom", wasCustom: true },
    ],
  });
  assert.ok(context.notifications.some(({ message }) => message.includes("4,000")));
});

test("runQuestionnaire preserves an empty custom answer returned by the RPC editor", async () => {
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "3. Other (free-form)",
    editor: async () => "",
  });
  assert.deepEqual(
    await runQuestionnaire(context.ctx, {
      questions: [questions[0]],
      maxTextLength: MAX_TEXT_LENGTH,
    }),
    {
      kind: "submitted",
      answers: [{ questionId: "scope", answer: "", wasCustom: true }],
    },
  );
});

test("runQuestionnaire aborts an owned pending RPC selector", async () => {
  const owner = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, _options: string[], dialog?: { signal?: AbortSignal }) => {
      observedSignal = dialog?.signal;
      await new Promise<void>((resolve) => {
        if (dialog?.signal?.aborted) resolve();
        else dialog?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return undefined;
    },
  });
  const running = runQuestionnaire(context.ctx, { questions, signal: owner.signal });
  await Promise.resolve();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedSignal, owner.signal);
});

test("runQuestionnaire handles RPC cancellation, stale awaits, dialog errors, and invalid responses", async () => {
  const cancelledContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => undefined,
  });
  assert.deepEqual(await runQuestionnaire(cancelledContext.ctx, { questions }), {
    kind: "closed",
    reason: "back",
  });

  let current = true;
  const staleContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      current = false;
      return "1. Small — Only the bug.";
    },
  });
  assert.deepEqual(await runQuestionnaire(staleContext.ctx, { questions, isCurrent: () => current }), {
    kind: "stale",
  });

  let editorCurrent = true;
  const staleEditorContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "3. Other (free-form)",
    editor: async () => {
      editorCurrent = false;
      return "late answer";
    },
  });
  assert.deepEqual(
    await runQuestionnaire(staleEditorContext.ctx, {
      questions: [questions[0]],
      isCurrent: () => editorCurrent,
    }),
    { kind: "stale" },
  );

  const failedContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      throw new Error("dialog unavailable");
    },
  });
  const failed = await runQuestionnaire(failedContext.ctx, { questions });
  assert.equal(failed.kind, "error");
  assert.match(failedContext.notifications[0]?.message ?? "", /dialog unavailable/u);

  const invalidContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "not offered",
  });
  const invalid = await runQuestionnaire(invalidContext.ctx, { questions });
  assert.equal(invalid.kind, "error");
  assert.match(invalidContext.notifications[0]?.message ?? "", /not offered/u);
});
