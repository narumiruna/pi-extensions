import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionnaireAnswer, QuestionnaireQuestion, RunQuestionnaireResult } from "@narumitw/pi-tui-kit";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
export const MAX_PLAN_MODE_RESPONSE_LENGTH = 4_000;

export type PlanModeQuestionOption = {
  label: string;
  description?: string;
};

export type PlanModeQuestion = {
  id: string;
  header: string;
  question: string;
  options: PlanModeQuestionOption[];
};

export type PlanModeQuestionAnswer = {
  id: string;
  header: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  optionIndex?: number;
  note?: string;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "plan_mode_inactive" | "invalid_input";

type PlanModeQuestionDetails = {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  questions: PlanModeQuestion[];
  answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "Questions to show the user. Prefer 1 and do not exceed 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "header", "question", "options"],
        properties: {
          id: {
            type: "string",
            description: "Stable identifier for mapping answers (snake_case).",
          },
          header: {
            type: "string",
            description: "Short header label shown in the UI (12 or fewer chars).",
          },
          question: { type: "string", description: "Single-sentence prompt shown to the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description:
              "Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description"],
              properties: {
                label: { type: "string", description: "User-facing label (1-5 words)." },
                description: {
                  type: "string",
                  description: "One short sentence explaining impact/tradeoff if selected.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

type NormalizePlanModeQuestionParamsResult = { ok: true; questions: PlanModeQuestion[] } | { ok: false; error: string };

export function normalizePlanModeQuestionParams(input: unknown): NormalizePlanModeQuestionParamsResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (input.questions.length < 1 || input.questions.length > 3) {
    return { ok: false, error: "questions must contain 1-3 items" };
  }

  const questions: PlanModeQuestion[] = [];
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    if (!isRecord(rawQuestion)) {
      return { ok: false, error: `question ${questionIndex + 1} must be an object` };
    }
    const id = stringField(rawQuestion.id);
    const header = stringField(rawQuestion.header);
    const question = stringField(rawQuestion.question);
    if (!id || !header || !question) {
      return {
        ok: false,
        error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
      };
    }
    if (!Array.isArray(rawQuestion.options)) {
      return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
    }
    const options: PlanModeQuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (!isRecord(rawOption)) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
        };
      }
      const label = stringField(rawOption.label);
      if (!label) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
        };
      }
      const description = stringField(rawOption.description);
      if (!description) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
        };
      }
      options.push({ label, description });
    }
    questions.push({ id, header, question, options });
  }
  return { ok: true, questions };
}

export async function answerPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
) {
  const answers = await askPlanModeQuestions(questions, ctx, () => lifecycle.isCurrent() && lifecycle.isEnabled());
  if (!lifecycle.isCurrent()) {
    return planModeQuestionCancelled(
      questions,
      "cancelled",
      "Plan-mode question cancelled because the session changed.",
    );
  }
  if (!lifecycle.isEnabled()) {
    return planModeQuestionCancelled(
      questions,
      "plan_mode_inactive",
      "Plan-mode question cancelled because Plan mode is no longer active.",
    );
  }
  if (!answers) {
    return planModeQuestionCancelled(questions, "cancelled", "User cancelled the Plan-mode question prompt.");
  }
  return planModeQuestionAnswered(questions, answers);
}

export async function askPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  shouldContinue: () => boolean = () => true,
): Promise<PlanModeQuestionAnswer[] | undefined> {
  const { runQuestionnaire, sanitizeTerminalText } = await import("@narumitw/pi-tui-kit");
  if (!shouldContinue()) return undefined;
  const runnerQuestions: QuestionnaireQuestion<string>[] = questions.map((question, index) => ({
    id: String(index),
    header: displayText(question.header, `Question ${index + 1}`, sanitizeTerminalText),
    prompt: displayText(question.question, `Question ${index + 1}`, sanitizeTerminalText),
    options: question.options.map((option, optionIndex) => ({
      ...option,
      label: displayText(option.label, `Option ${optionIndex + 1}`, sanitizeTerminalText),
    })),
  }));
  const result = await runQuestionnaire(ctx, {
    questions: runnerQuestions,
    allowNotes: true,
    maxTextLength: MAX_PLAN_MODE_RESPONSE_LENGTH,
    signal: ctx.signal,
    isCurrent: shouldContinue,
  });
  if (!shouldContinue()) return undefined;
  return mapQuestionnaireResult(questions, result);
}

function mapQuestionnaireResult(
  questions: PlanModeQuestion[],
  result: RunQuestionnaireResult<string>,
): PlanModeQuestionAnswer[] | undefined {
  if (result.kind !== "submitted") return undefined;
  if (result.answers.length !== questions.length) {
    throw new Error("Questionnaire returned an incomplete answer set");
  }

  const answers = new Map<number, QuestionnaireAnswer<string>>();
  for (const answer of result.answers) {
    const index = Number(answer.questionId);
    if (!Number.isSafeInteger(index) || String(index) !== answer.questionId || !questions[index]) {
      throw new Error("Questionnaire returned an answer for an unknown question");
    }
    if (answers.has(index)) throw new Error("Questionnaire returned duplicate answers");
    if (answer.wasCustom) {
      if (answer.optionIndex !== undefined) {
        throw new Error("Questionnaire returned a custom answer with an option index");
      }
      if (!answer.answer.trim()) return undefined;
    } else if (answer.optionIndex === undefined || !questions[index]?.options[answer.optionIndex - 1]) {
      throw new Error("Questionnaire returned an invalid selected option");
    }
    answers.set(index, answer);
  }

  return questions.map((question, index) => {
    const answer = answers.get(index);
    if (!answer) throw new Error("Questionnaire returned an incomplete answer set");
    const answerText = answer.wasCustom
      ? answer.answer
      : (question.options[(answer.optionIndex ?? 0) - 1]?.label ?? answer.answer);
    return answerFor(question, answerText, {
      wasCustom: answer.wasCustom,
      optionIndex: answer.optionIndex,
      note: answer.note,
    });
  });
}

function displayText(value: string, fallback: string, sanitize: (value: string) => string): string {
  const sanitized = sanitize(value);
  return sanitized.trim() ? sanitized : fallback;
}

function answerFor(
  question: PlanModeQuestion,
  answer: string,
  options: { wasCustom: boolean; optionIndex?: number; note?: string },
): PlanModeQuestionAnswer {
  const result: PlanModeQuestionAnswer = {
    id: question.id,
    header: question.header,
    question: question.question,
    answer,
    wasCustom: options.wasCustom,
  };
  if (options.optionIndex !== undefined) result.optionIndex = options.optionIndex;
  if (options.note !== undefined) result.note = options.note;
  return result;
}

export function planModeQuestionAnswered(questions: PlanModeQuestion[], answers: PlanModeQuestionAnswer[]) {
  return {
    content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) }],
    details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
  };
}

export function planModeQuestionCancelled(
  questions: PlanModeQuestion[],
  reason: PlanModeQuestionReason,
  message: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
      },
    ],
    details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
  };
}

function formatPlanModeQuestionPayload(payload: {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  message?: string;
  answers?: PlanModeQuestionAnswer[];
}) {
  return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}
