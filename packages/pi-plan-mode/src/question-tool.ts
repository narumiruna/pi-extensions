import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionnaireAnswer, QuestionnaireQuestion, RunQuestionnaireResult } from "@narumitw/pi-tui-kit";

import {
  MAX_PLAN_MODE_RESPONSE_LENGTH,
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
  planModeQuestionAnswered,
  planModeQuestionCancelled,
} from "./question-domain.js";

export {
  MAX_PLAN_MODE_RESPONSE_LENGTH,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
  type PlanModeQuestionOption,
  planModeQuestionAnswered,
  planModeQuestionCancelled,
} from "./question-domain.js";

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
