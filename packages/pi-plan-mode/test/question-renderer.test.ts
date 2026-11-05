import assert from "node:assert/strict";
import { initTheme, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { renderPlanModeQuestionCall, renderPlanModeQuestionResult } from "../src/question-renderer.js";
import {
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
  planModeQuestionAnswered,
  planModeQuestionCancelled,
} from "../src/question-tool.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };
const hints = {
  keyText: () => "ctrl+o",
  keyHint: (_action: string, description: string) => `ctrl+o ${description}`,
};
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
const answers: PlanModeQuestionAnswer[] = [
  { id: "scope", header: "Scope", question: "How broad?", answer: "Small", wasCustom: false, optionIndex: 1 },
  {
    id: "tests",
    header: "Tests",
    question: "Which checks?",
    answer: "Only unit tests",
    wasCustom: true,
    note: "Keep integration tests unchanged.",
  },
];
const result = planModeQuestionAnswered(questions, answers);
const originalKeys = getKeybindings();
afterEach(() => setKeybindings(originalKeys));

test("question calls show readable headers instead of serialized arguments", () => {
  assert.deepEqual(renderPlanModeQuestionCall({ questions: [questions[0]] }, theme).render(80), [
    "Plan question  Scope",
  ]);
  assert.deepEqual(renderPlanModeQuestionCall({ questions }, theme).render(80), ["Plan questions  Scope · Tests"]);
  for (const args of [undefined, null, {}, { questions: [null, { header: 7 }] }, { questions: "partial" }]) {
    assert.doesNotThrow(() => renderPlanModeQuestionCall(args, theme).render(20));
  }
});

test("collapsed answers keep choices, custom answers, and note indicators visible without JSON", () => {
  assert.deepEqual(renderPlanModeQuestionResult(result, collapsed, theme, hints).render(120), [
    "✓ Scope: Small",
    "✓ Tests: Only unit tests (custom) · note",
    "ctrl+o to expand",
  ]);
  assert.deepEqual(renderPlanModeQuestionResult(result, expanded, theme, hints).render(120), [
    "Scope",
    "  How broad?",
    "  ✓ Small",
    "",
    "Tests",
    "  Which checks?",
    "  Custom answer",
    "  ✓ Only unit tests",
    "  Note",
    "    Keep integration tests unchanged.",
  ]);
});

test("the screenshot's Chinese answer stays readable and does not gain a second option number", () => {
  const answer = {
    ...answers[0],
    header: "討論行為",
    question: "自由討論時，你希望 Agent 如何追問？",
    answer: "1. 只暫停問卷（建議）",
  };
  const chinese = planModeQuestionAnswered([], [answer]);
  assert.deepEqual(renderPlanModeQuestionResult(chinese, collapsed, theme).render(100), [
    "✓ 討論行為: 1. 只暫停問卷（建議）",
  ]);
  assert.ok(renderPlanModeQuestionResult(chinese, expanded, theme).render(100).includes(`  ${answer.question}`));
});

test("expanded multiline answers and notes preserve whitespace at wrap boundaries", () => {
  const multiline = planModeQuestionAnswered(
    [],
    [{ ...answers[0], answer: "ab  cd  ef\n  ghi  ", wasCustom: true, note: "two  words\n  keep  " }],
  );
  const lines = renderPlanModeQuestionResult(multiline, expanded, theme).render(12);
  assert.ok(lines.join("\n").includes("  ✓ ab  cd  \n    ef\n      ghi  "));
  assert.ok(lines.join("\n").includes("    two  wor\n    ds\n      keep  "));
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test.each([
  { reason: "cancelled", status: "Question cancelled", role: "warning" },
  { reason: "discussion_requested", status: "Question cancelled", role: "warning" },
  { reason: "questions_paused", status: "Question cancelled", role: "warning" },
  { reason: "ui_unavailable", status: "Interactive UI unavailable", role: "warning" },
  { reason: "plan_mode_inactive", status: "Plan mode inactive", role: "warning" },
  { reason: "invalid_input", status: "Invalid question", role: "error" },
] as const)("renders $reason as a readable status with details on expansion", ({ reason, status, role }) => {
  const roles: string[] = [];
  const themed = {
    ...theme,
    fg: (role: string, text: string) => {
      roles.push(role);
      return text;
    },
  } as Theme;
  const cancelled = planModeQuestionCancelled(questions, reason, "The full reason.");
  assert.deepEqual(renderPlanModeQuestionResult(cancelled, collapsed, themed, hints).render(100), [
    status,
    "ctrl+o to expand",
  ]);
  assert.ok(roles.includes(role));
  assert.deepEqual(renderPlanModeQuestionResult(cancelled, expanded, theme).render(100), [
    status,
    "  The full reason.",
  ]);
});

test("partial and failed results cannot display a successful answer", () => {
  assert.deepEqual(renderPlanModeQuestionResult(result, { ...collapsed, isPartial: true }, theme).render(80), [
    "Waiting for answers…",
  ]);
  const failed = renderPlanModeQuestionResult(
    { content: [{ type: "text", text: "Permission denied" }], details: result.details },
    expanded,
    theme,
    { isError: true },
  ).render(80);
  assert.deepEqual(failed, ["Question failed", "  Permission denied"]);
});

test("restored content without details still renders answers and cancellation without raw JSON", () => {
  assert.deepEqual(
    renderPlanModeQuestionResult({ content: result.content }, collapsed, theme).render(120),
    renderPlanModeQuestionResult(result, collapsed, theme).render(120),
  );
  const cancelled = planModeQuestionCancelled([], "ui_unavailable", "No interactive UI.");
  assert.deepEqual(renderPlanModeQuestionResult({ content: cancelled.content }, expanded, theme).render(80), [
    "Interactive UI unavailable",
    "  No interactive UI.",
  ]);
  const text = { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }] };
  assert.deepEqual(renderPlanModeQuestionResult(text, collapsed, theme, hints).render(80), [
    "one",
    "two",
    "three",
    "four",
    "ctrl+o to expand",
  ]);
  assert.deepEqual(renderPlanModeQuestionResult(text, expanded, theme).render(80), [
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  assert.deepEqual(renderPlanModeQuestionResult({ content: [] }, collapsed, theme).render(80), ["No answer returned."]);
});

test.each([0, 1, 2, 3, 10, 28, 80, 250, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 12.9])(
  "keeps all display states within width %s after resize and invalidation",
  (width) => {
    const raw = "界e\u0301🙂\u001b[31mred\u001b[0m\u009d52;c;secret\u0007\u001b_pi:c\u0007\u202e\n  words\tend";
    const hostileQuestions = [{ ...questions[0], header: raw, question: raw }];
    const hostile = planModeQuestionAnswered(hostileQuestions, [
      { ...answers[0], header: raw, question: raw, answer: raw, note: raw },
    ]);
    const before = structuredClone(hostile);
    const components = [
      renderPlanModeQuestionCall({ questions: hostileQuestions }, theme),
      renderPlanModeQuestionResult(hostile, collapsed, theme, hints),
      renderPlanModeQuestionResult(hostile, expanded, theme),
      renderPlanModeQuestionResult(hostile, { ...collapsed, isPartial: true }, theme),
      renderPlanModeQuestionResult(planModeQuestionCancelled([], "cancelled", raw), expanded, theme),
      renderPlanModeQuestionResult({ content: [{ type: "text", text: raw }] }, expanded, theme, { isError: true }),
      renderPlanModeQuestionResult(
        { content: [{ type: "text", text: raw }], details: { cancelled: false, answers: [null] } },
        collapsed,
        theme,
      ),
    ];
    for (const component of components) {
      for (const currentWidth of [80, width, 20, width]) {
        component.invalidate();
        const currentBound = Number.isFinite(currentWidth) ? Math.max(0, Math.floor(currentWidth)) : 0;
        const lines = component.render(currentWidth);
        assert.ok(lines.every((line) => visibleWidth(line) <= currentBound));
        // Pi truncation adds SGR resets even when the theme is an identity function.
        assert.ok(lines.every((line) => !/[\p{Cc}\p{Bidi_Control}]/u.test(line.replaceAll("\u001b[0m", ""))));
        if (currentBound === 0) assert.deepEqual(lines, []);
      }
    }
    assert.deepEqual(hostile, before, "display sanitization must not change content or details");
  },
);

test("theme changes take effect after invalidation and use semantic roles", () => {
  let color = "\u001b[31m";
  const roles = new Set<string>();
  const themed = {
    bold: (text: string) => text,
    fg: (role: string, text: string) => {
      roles.add(role);
      return `${color}${text}\u001b[0m`;
    },
  } as Theme;
  for (const component of [
    renderPlanModeQuestionCall({ questions }, themed),
    renderPlanModeQuestionResult(result, collapsed, themed, hints),
    renderPlanModeQuestionResult(result, expanded, themed),
  ]) {
    color = "\u001b[31m";
    assert.ok(component.render(80).join("\n").includes(color));
    color = "\u001b[32m";
    component.invalidate();
    const lines = component.render(80);
    assert.ok(lines.join("\n").includes(color));
    assert.ok(!lines.join("\n").includes("\u001b[31m"));
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  }
  assert.deepEqual([...roles].sort(), ["accent", "muted", "success", "text", "toolTitle"]);
});

test.each([
  { keys: "ctrl+o", input: "\u000f" },
  { keys: "ctrl+y", input: "\u0019" },
  { keys: [], input: undefined },
] as const)("Pi's tool component supplies configured expansion hints: $keys", ({ keys, input }) => {
  initTheme("dark", false);
  const keybindings = new KeybindingsManager(
    { "app.tools.expand": { defaultKeys: "ctrl+o" } },
    {
      "app.tools.expand": typeof keys === "string" ? keys : [...keys],
    },
  );
  setKeybindings(keybindings);
  const component = new ToolExecutionComponent(
    "plan_mode_question",
    "question-1",
    { questions },
    undefined,
    { renderCall: renderPlanModeQuestionCall, renderResult: renderPlanModeQuestionResult },
    { requestRender() {} } as TUI,
    process.cwd(),
  );
  component.updateResult({ ...result, isError: false });
  const lines = component.render(120).map(stripTerminalSequences).join("\n");
  assert.match(lines, /Plan questions/u);
  assert.match(lines, /✓ Scope: Small/u);
  assert.doesNotMatch(lines, /cancelled|optionIndex|questions=|wasCustom/u);
  if (input) {
    assert.ok(keybindings.matches(input, "app.tools.expand"));
    assert.ok(lines.includes(`${keys} to expand`));
  } else {
    assert.ok(!lines.includes("to expand"));
  }
  component.setExpanded(true);
  const details = component.render(120).map(stripTerminalSequences).join("\n");
  assert.ok(details.includes("How broad?"));
  assert.ok(details.includes("Keep integration tests unchanged."));
  assert.ok(!details.includes("to expand"));
});
