import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import * as completion from "../src/completion-domain.js";
import * as completionTool from "../src/completion-tool.js";
import * as question from "../src/question-domain.js";
import * as questionTool from "../src/question-tool.js";
import * as shell from "../src/shell-policy.js";
import * as toolPolicy from "../src/tool-policy.js";

test("existing tool paths re-export the same pure domain values and functions", () => {
  for (const [domain, adapter] of [
    [question, questionTool],
    [completion, completionTool],
    [shell, toolPolicy],
  ] as const) {
    for (const [name, value] of Object.entries(domain)) {
      assert.equal((adapter as Record<string, unknown>)[name], value, name);
    }
  }
});

test("domain import graphs exclude session and UI code, including declaration imports", () => {
  const roots = ["question-domain", "completion-domain", "shell-policy"].map((name) =>
    fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)),
  );
  const output = execFileSync(
    process.execPath,
    [
      join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc"),
      "--ignoreConfig",
      "--listFilesOnly",
      "--module",
      "nodenext",
      "--target",
      "es2022",
      "--types",
      "node",
      ...roots,
    ],
    { encoding: "utf8", timeout: 4_000 },
  );
  const files = output.trim().split(/\r?\n/);
  for (const root of roots) assert.ok(files.includes(root), root);
  for (const file of files) {
    if (roots.includes(file)) continue;
    // Only the standard library and Node.js declarations belong in this graph.
    assert.match(file, /\/node_modules\/(?:@typescript\/[^/]+\/lib|@types\/node|undici-types)\//, file);
  }
});

const validQuestion = {
  id: " scope ",
  header: " Scope ",
  question: " How broad? ",
  options: [
    { label: " Small ", description: " Only the bug. " },
    { label: " Broad ", description: " Include cleanup. " },
  ],
};

test("question schema and normalization retain current limits and permissive domain semantics", () => {
  assert.equal(question.PLAN_MODE_QUESTION_TOOL_NAME, "plan_mode_question");
  assert.equal(question.MAX_PLAN_MODE_RESPONSE_LENGTH, 4_000);
  const schema = question.PLAN_MODE_QUESTION_PARAMS.properties.questions;
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 3);
  assert.equal(schema.items.properties.options.minItems, 2);
  assert.equal(schema.items.properties.options.maxItems, 4);
  assert.deepEqual(schema.items.properties.options.items.required, ["label", "description"]);
  const input = { questions: [validQuestion, validQuestion], ignored: true };
  const normalized = question.normalizePlanModeQuestionParams(input);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.deepEqual(normalized.questions[0], {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  });
  assert.deepEqual(normalized.questions[0], normalized.questions[1]);
  assert.equal(input.questions[0]?.id, " scope ");
});

test.each([
  [null, "questions must be an array"],
  [{ questions: [] }, "questions must contain 1-3 items"],
  [{ questions: Array(4).fill(validQuestion) }, "questions must contain 1-3 items"],
  [{ questions: [null] }, "question 1 must be an object"],
  [{ questions: [{ ...validQuestion, id: " " }] }, "question 1 requires non-empty id, header, and question"],
  [{ questions: [{ ...validQuestion, options: null }] }, "question 1 options must be an array"],
  [{ questions: [{ ...validQuestion, options: [] }] }, "question 1 options must contain 2-4 items"],
  [{ questions: [{ ...validQuestion, options: [null, null] }] }, "question 1 option 1 must be an object"],
  [{ questions: [{ ...validQuestion, options: [{}, {}] }] }, "question 1 option 1 requires a label"],
  [
    { questions: [{ ...validQuestion, options: [{ label: "A" }, { label: "B" }] }] },
    "question 1 option 1 requires a description",
  ],
])("question validation preserves its existing error for %j", (input, error) => {
  assert.deepEqual(question.normalizePlanModeQuestionParams(input), { ok: false, error });
});

test("completion schema, validation, and result serialization retain the existing contract", () => {
  assert.deepEqual(completion.PLAN_MODE_COMPLETE_PARAMS, {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "string",
        minLength: 1,
        maxLength: 50_000,
        description: "The complete decision-ready implementation plan in Markdown.",
      },
    },
  });
  for (const input of [null, [], {}, { plan: 1 }]) {
    assert.deepEqual(completion.normalizePlanModeCompletion(input), { ok: false, error: "plan must be a string" });
  }
  assert.deepEqual(completion.normalizePlanModeCompletion({ plan: " \n " }), {
    ok: false,
    error: "plan must not be empty",
  });
  assert.deepEqual(completion.normalizePlanModeCompletion({ plan: "x".repeat(50_001) }), {
    ok: false,
    error: "plan must not exceed 50000 characters",
  });
  const plan = "x".repeat(50_000);
  assert.deepEqual(completion.normalizePlanModeCompletion({ plan: ` ${plan} ` }), { ok: true, plan });
  const result = completion.planModeCompleted("# Plan");
  assert.deepEqual(result, {
    content: [{ type: "text", text: "**Proposed Plan**\n\n# Plan" }],
    details: { version: 1, source: "plan_mode_complete", plan: "# Plan" },
    terminate: true,
  });
  assert.equal(completion.planFromCompletionDetails(result.details), "# Plan");
  assert.equal(completion.planFromCompletionDetails({ ...result.details, version: 2 }), undefined);
  assert.equal(completion.planFromCompletionDetails({ ...result.details, source: "other" }), undefined);
  assert.equal(
    completionTool.planModeCompletionMarkdown({ content: [], details: result.details }),
    result.content[0]?.text,
  );
});

test("question payload functions retain raw answer fields and cancellation data", () => {
  const normalized = question.normalizePlanModeQuestionParams({ questions: [validQuestion] });
  assert.ok(normalized.ok);
  const answers: question.PlanModeQuestionAnswer[] = [
    { id: "scope", header: "Scope", question: "How broad?", answer: " raw ", wasCustom: true, note: " note " },
  ];
  const answered = question.planModeQuestionAnswered(normalized.questions, answers);
  assert.deepEqual(JSON.parse(answered.content[0]?.text ?? ""), { cancelled: false, answers });
  assert.deepEqual(answered.details, { cancelled: false, questions: normalized.questions, answers });
  const cancelled = question.planModeQuestionCancelled(normalized.questions, "cancelled", "Cancelled.");
  assert.deepEqual(JSON.parse(cancelled.content[0]?.text ?? ""), {
    cancelled: true,
    reason: "cancelled",
    message: "Cancelled.",
  });
});
