import assert from "node:assert/strict";
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

test("normalizePlanModeQuestionParams validates question shape without changing schema", () => {
  const result = normalizePlanModeQuestionParams({ questions: [questions[0]] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
  assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
    ok: false,
    error: "questions must contain 1-3 items",
  });
});

test("the Kit runner preserves domain fields, notes, raw answers, and duplicate domain ids", async () => {
  const duplicateIds = questions.map((question) => ({ ...question, id: "decision" }));
  const tui = createTuiHarness({ width: 60, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
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
