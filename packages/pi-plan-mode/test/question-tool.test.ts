import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import planMode, { normalizePlanModeQuestionParams } from "../src/plan-mode.js";
import {
  answerPlanModeQuestions,
  askPlanModeQuestions,
  MAX_PLAN_MODE_RESPONSE_LENGTH,
  type PlanModeQuestion,
} from "../src/question-tool.js";
import { createMockContext, createMockPi } from "./support.js";

const questions: PlanModeQuestion[] = [
  {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  },
  {
    id: "tests",
    header: "Tests",
    question: "Which checks?",
    options: [
      { label: "Focused", description: "Run focused checks." },
      { label: "Full", description: "Run all checks." },
    ],
  },
];

const numberedQuestion: PlanModeQuestion = {
  id: "upgrade_scope",
  header: "升版範圍",
  question: "自動升版可以改到什麼程度？",
  options: [
    { label: "1. 同 major 升版", description: "Update compatible dependencies." },
    { label: "\u001b[31m 2. 只改 lockfile", description: "Keep existing version constraints." },
    { label: "3. 允許跨 major 👩\u200d💻", description: "Require a compatibility review." },
  ],
};
const numberedRows = [
  "1. 同 major 升版 — Update compatible dependencies.",
  "2. 只改 lockfile — Keep existing version constraints.",
  "3. 允許跨 major 👩\u200d💻 — Require a compatibility review.",
  "4. Other (free-form)",
];

function paste(tui: ReturnType<typeof createTuiHarness>, text: string) {
  tui.send(`\u001b[200~${text}\u001b[201~`);
}

test("plan_mode_question reports non-interactive cancellation", async () => {
  const mock = createMockPi();
  planMode(mock.pi);
  const execute = mock.tools[0]?.execute as
    | ((...args: unknown[]) => Promise<{ details?: { reason?: string } }>)
    | undefined;
  assert.ok(execute);
  const context = createMockContext({ hasUI: false });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const result = await execute("call-1", { questions: [questions[0]] }, undefined, undefined, context.ctx);
  assert.equal(result.details?.reason, "ui_unavailable");
});

test("normalizePlanModeQuestionParams accepts original numbered labels", () => {
  assert.deepEqual(normalizePlanModeQuestionParams({ questions: [numberedQuestion] }), {
    ok: true,
    questions: [numberedQuestion],
  });
  assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
    ok: false,
    error: "questions must contain 1-3 items",
  });
});

test("the Kit runner preserves domain fields, notes, raw answers, and duplicate domain ids", async () => {
  const duplicateIds = questions.map((question) => ({ ...question, id: "decision" }));
  const tui = createTuiHarness({ width: 60, rows: 30 });
  const capturedOptions: Parameters<typeof tui.custom>[1][] = [];
  const custom: typeof tui.custom = (factory, options) => {
    capturedOptions.push(options);
    return tui.custom(factory, options);
  };
  const context = createMockContext({ mode: "tui", hasUI: true, custom });
  const running = askPlanModeQuestions(duplicateIds, context.ctx);
  await tui.waitForOpen();
  tui.setFocused(true);

  tui.press("tui.select.down");
  tui.type("n");
  paste(tui, "keep this note");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  paste(tui, "  custom answer  ");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");

  assert.deepEqual(await running, [
    {
      id: "decision",
      header: "Scope",
      question: "How broad?",
      answer: "Broad",
      wasCustom: false,
      optionIndex: 2,
      note: "keep this note",
    },
    {
      id: "decision",
      header: "Tests",
      question: "Which checks?",
      answer: "  custom answer  ",
      wasCustom: true,
    },
  ]);
  assert.deepEqual(capturedOptions, [{ blocked: { kind: "question", message: "Answer Plan mode questions" } }]);
});

test("the Kit RPC runner preserves limits, ordering, and answer metadata", async () => {
  const selections = ["1. Small — Only the bug.", "3. Other (free-form)"];
  const editorAnswers = ["x".repeat(MAX_PLAN_MODE_RESPONSE_LENGTH + 1), "rpc custom"];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => selections.shift(),
    editor: async () => editorAnswers.shift(),
    custom: async () => assert.fail("RPC must not open custom TUI"),
  });
  assert.deepEqual(await askPlanModeQuestions(questions, context.ctx), [
    {
      id: "scope",
      header: "Scope",
      question: "How broad?",
      answer: "Small",
      wasCustom: false,
      optionIndex: 1,
    },
    {
      id: "tests",
      header: "Tests",
      question: "Which checks?",
      answer: "rpc custom",
      wasCustom: true,
    },
  ]);
  assert.ok(context.notifications.some(({ message }) => message.includes("4,000")));
});

test("TUI shows one number per choice and returns the original numbered label", async () => {
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = askPlanModeQuestions([numberedQuestion], context.ctx);
  await tui.waitForOpen();
  tui.setFocused(true);
  const rows = tui.render().map((line) => stripVTControlCharacters(line).replace(/^\s*(?:→\s*)?/u, ""));
  tui.press("tui.select.down");
  tui.type("n");
  paste(tui, "keep this note");
  tui.press("tui.input.submit");
  tui.press("tui.select.confirm");

  assert.deepEqual(await running, [
    {
      id: numberedQuestion.id,
      header: numberedQuestion.header,
      question: numberedQuestion.question,
      answer: "\u001b[31m 2. 只改 lockfile",
      wasCustom: false,
      optionIndex: 2,
      note: "keep this note",
    },
  ]);
  assert.deepEqual(
    rows.filter((row) => /^[1-4]\. /u.test(row)),
    numberedRows,
  );
});

test.each([".", ")"])("RPC shows one number for the %s marker and keeps the original label", async (marker) => {
  const question = {
    ...numberedQuestion,
    options: numberedQuestion.options.map((option, index) => ({
      ...option,
      label: option.label.replace(`${index + 1}.`, `${index + 1}${marker}`),
    })),
  };
  let offeredChoices: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      offeredChoices = choices;
      return choices[1];
    },
  });
  assert.deepEqual(await askPlanModeQuestions([question], context.ctx), [
    {
      id: question.id,
      header: question.header,
      question: question.question,
      answer: `\u001b[31m 2${marker} 只改 lockfile`,
      wasCustom: false,
      optionIndex: 2,
    },
  ]);
  assert.deepEqual(offeredChoices, numberedRows);
});

test.each([1, 2])("TUI review identifies option %i when labels match after prefix removal", async (optionIndex) => {
  const scope: PlanModeQuestion = {
    ...questions[0],
    options: [
      { label: "1) Use defaults", description: "Use workspace defaults." },
      { label: "2) Use defaults", description: "Use user defaults." },
    ],
  };
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = askPlanModeQuestions([scope, questions[1]], context.ctx);
  await tui.waitForOpen();
  tui.setFocused(true);
  const choices = stripVTControlCharacters(tui.render().join("\n"));
  if (optionIndex === 2) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  const summary = stripVTControlCharacters(tui.render().join("\n"));
  tui.press("tui.select.confirm");

  const answers = await running;
  assert.match(choices, /1\. Use defaults — Use workspace defaults\./u);
  assert.match(choices, /2\. Use defaults — Use user defaults\./u);
  assert.ok(summary.includes(`1. Scope (Option ${optionIndex}) — Use defaults`));
  assert.match(summary, /2\. Tests \(Option 1\) — Focused/u);
  assert.partialDeepStrictEqual(answers?.[0], { answer: `${optionIndex}) Use defaults`, optionIndex });
});

test("TUI keeps the full sequence when a label has no visible text after its marker", async () => {
  const label = "2) \u200b \u200d";
  const question: PlanModeQuestion = {
    ...questions[0],
    options: [{ label: "1) Small" }, { label }],
  };
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = askPlanModeQuestions([question], context.ctx);
  await tui.waitForOpen();
  tui.setFocused(true);
  const choices = stripVTControlCharacters(tui.render().join("\n"));
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");

  const answers = await running;
  assert.match(choices, /1\. 1\) Small/u);
  assert.match(choices, /2\. 2\) /u);
  assert.partialDeepStrictEqual(answers?.[0], { answer: label, optionIndex: 2 });
});

test.each([
  { name: "mixed labels", labels: ["\u001b[31m 1. Same major", "Lockfile only"] },
  { name: "mismatched positions", labels: ["1. Same major", "3. Across major"] },
  { name: "mixed markers", labels: ["1) Same major", "2. Across major"] },
  { name: "a missing label after a prefix", labels: ["1) Same major", "2) \u001b[31m"] },
  { name: "whitespace after a prefix", labels: ["1) Same major", "2)   "] },
  { name: "zero-width space after a prefix", labels: ["1) Same major", "2) \u200b"] },
  { name: "variation selector after a prefix", labels: ["1) Same major", "2) \ufe0f"] },
  { name: "mixed invisible remainder", labels: ["1) Same major", "2) \u200b \u2060\u00ad\u034f\ufe0f "] },
  { name: "non-printing marks and spaces after a prefix", labels: ["1. Same major", "2. \u0301 \u{e0100}"] },
  { name: "numeric content", labels: ["1.5 GiB", "2 MB", "2026. Plan"] },
])("RPC preserves $name instead of removing a partial sequence", async ({ labels }) => {
  let offeredChoices: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      offeredChoices = choices;
      return undefined;
    },
  });
  await askPlanModeQuestions([{ ...numberedQuestion, options: labels.map((label) => ({ label })) }], context.ctx);
  assert.deepEqual(offeredChoices, [
    ...labels.map((label, index) => `${index + 1}. ${stripVTControlCharacters(label)}`),
    `${labels.length + 1}. Other (free-form)`,
  ]);
});

test("RPC keeps visible remainders unchanged when removing option prefixes", async () => {
  const remainders = ["\u200b Visible\ufe0f", "保留\u2060文字"];
  let offeredChoices: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      offeredChoices = choices;
      return choices[0];
    },
  });
  const labels = remainders.map((remainder, index) => `${index + 1}) ${remainder}`);
  const answers = await askPlanModeQuestions(
    [{ ...numberedQuestion, options: labels.map((label) => ({ label })) }],
    context.ctx,
  );
  assert.deepEqual(offeredChoices, [
    ...remainders.map((remainder, index) => `${index + 1}. ${remainder}`),
    "3. Other (free-form)",
  ]);
  assert.equal(answers?.[0]?.answer, labels[0]);
});

test("the adapter sanitizes mixed display text without mutating raw domain answers", async () => {
  const control = "\u001b[31m";
  const rawHeader = `Visible${control}`;
  const rawLabel = `Unsafe${control}`;
  const unsafeQuestions: PlanModeQuestion[] = [
    {
      id: "unsafe",
      header: rawHeader,
      question: control,
      options: [
        { label: rawLabel, description: "First choice." },
        { label: "Safe", description: "Second choice." },
      ],
    },
  ];
  let offeredTitle = "";
  let offeredChoices: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      offeredTitle = title;
      offeredChoices = choices;
      return choices[0];
    },
  });
  const answers = await askPlanModeQuestions(unsafeQuestions, context.ctx);
  assert.equal(offeredTitle, "Visible: Question 1");
  assert.equal(offeredChoices[0], "1. Unsafe — First choice.");
  assert.equal(answers?.[0]?.answer, rawLabel);
  assert.equal(answers?.[0]?.header, rawHeader);
  assert.equal(answers?.[0]?.question, control);
});

test("the adapter maps closed, stale, unsupported, error, and blank RPC results to cancellation", async () => {
  const closed = createMockContext({ mode: "rpc", hasUI: true, select: async () => undefined });
  assert.equal(await askPlanModeQuestions([questions[0]], closed.ctx), undefined);

  let current = true;
  const stale = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      current = false;
      return "1. Small — Only the bug.";
    },
  });
  assert.equal(await askPlanModeQuestions([questions[0]], stale.ctx, () => current), undefined);

  const unsupported = createMockContext({ mode: "print", hasUI: false });
  assert.equal(await askPlanModeQuestions([questions[0]], unsupported.ctx), undefined);

  const invalid = createMockContext({ mode: "rpc", hasUI: true });
  assert.equal(await askPlanModeQuestions([], invalid.ctx), undefined);
  assert.match(invalid.notifications[0]?.message ?? "", /at least one question/u);

  const blank = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "3. Other (free-form)",
    editor: async () => "   ",
  });
  assert.equal(await askPlanModeQuestions([questions[0]], blank.ctx), undefined);
});

test("answerPlanModeQuestions revalidates session and Plan mode after the runner", async () => {
  let current = true;
  const replaced = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      current = false;
      return "1. Small — Only the bug.";
    },
  });
  const staleResult = await answerPlanModeQuestions([questions[0]], replaced.ctx, {
    isCurrent: () => current,
    isEnabled: () => true,
  });
  assert.ok("reason" in staleResult.details);
  assert.equal(staleResult.details.reason, "cancelled");
  assert.match(staleResult.content[0]?.text ?? "", /session changed/u);

  let enabled = true;
  const deactivated = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      enabled = false;
      return "1. Small — Only the bug.";
    },
  });
  const inactiveResult = await answerPlanModeQuestions([questions[0]], deactivated.ctx, {
    isCurrent: () => true,
    isEnabled: () => enabled,
  });
  assert.ok("reason" in inactiveResult.details);
  assert.equal(inactiveResult.details.reason, "plan_mode_inactive");
  assert.match(inactiveResult.content[0]?.text ?? "", /no longer active/u);
});

test("owner abort closes the Kit interaction without publishing answers", async () => {
  const controller = new AbortController();
  const tui = createTuiHarness({ width: 60, rows: 30 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    signal: controller.signal,
  });
  const running = askPlanModeQuestions(questions, context.ctx);
  await tui.waitForOpen();
  controller.abort(new DOMException("Session replaced", "AbortError"));
  assert.equal(await running, undefined);
  assert.equal(tui.isOpen, false);
});
