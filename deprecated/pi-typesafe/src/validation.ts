import type {
  ChoiceAnswer,
  ChoiceQuestion,
  JevAnswer,
  JevDecisionInput,
  JevDecisionResponse,
  JevQuestion,
  JevUsage,
  JsonValue,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
  StructuredValue,
} from "./types.js";

const QUESTION_FIELDS = new Set(["type", "instructions", "criteria"]);
const PROBABILITY_SUM_TOLERANCE = 0.02;

export function normalizeJevInput(value: unknown): JevDecisionInput {
  const input = requireRecord(value, "input");
  const state = requireStructuredValue(input.state, "state");
  const rawQuestions = requireRecord(input.questions, "questions");
  const entries = Object.entries(rawQuestions);
  if (entries.length === 0) throw new Error("questions must contain at least one typed question");

  const questions = Object.fromEntries(
    entries.map(([id, question]) => {
      if (!id.trim()) throw new Error("question ids must not be empty");
      return [id, normalizeQuestion(question, propertyPath("questions", id))];
    }),
  );
  return { state, questions };
}

export function normalizeJevResponse(value: unknown, input: JevDecisionInput): JevDecisionResponse {
  const response = requireRecord(value, "response");
  if (typeof response.model !== "string" || !response.model.trim()) {
    throw new Error("response.model must be a non-empty string");
  }
  const rawAnswers = requireRecord(response.answers, "response.answers");
  requireExactKeys(rawAnswers, Object.keys(input.questions), "response.answers");

  const answers = Object.fromEntries(
    Object.entries(input.questions).map(([id, question]) => {
      return [id, normalizeAnswer(rawAnswers[id], question, propertyPath("response.answers", id))];
    }),
  );
  const usage = response.usage === undefined ? undefined : normalizeUsage(response.usage);
  return {
    model: response.model,
    answers,
    ...(usage ? { usage } : {}),
  };
}

function normalizeQuestion(value: unknown, path: string): JevQuestion {
  const question = requireRecord(value, path);
  for (const field of Object.keys(question)) {
    if (!QUESTION_FIELDS.has(field)) throw new Error(`${propertyPath(path, field)} is not supported`);
  }
  const instructions = requireStructuredValue(question.instructions, `${path}.instructions`);
  if (question.type === "noul") return normalizeNoulQuestion(question, instructions, path);
  if (question.type === "choice") return normalizeChoiceQuestion(question, instructions, path);
  if (question.type === "score") return normalizeScoreQuestion(question, instructions, path);
  throw new Error(`${path}.type must be noul, choice, or score`);
}

function normalizeNoulQuestion(
  question: Record<string, unknown>,
  instructions: StructuredValue,
  path: string,
): NoulQuestion {
  if (question.criteria === undefined) return { type: "noul", instructions };
  const criteria = requireRecord(question.criteria, `${path}.criteria`);
  requireExactKeys(criteria, ["true", "false"], `${path}.criteria`);
  if (typeof criteria.true !== "string" || typeof criteria.false !== "string") {
    throw new Error(`${path}.criteria true and false descriptions must be strings`);
  }
  return {
    type: "noul",
    instructions,
    criteria: { true: criteria.true, false: criteria.false },
  };
}

function normalizeChoiceQuestion(
  question: Record<string, unknown>,
  instructions: StructuredValue,
  path: string,
): ChoiceQuestion {
  const criteria = requireRecord(question.criteria, `${path}.criteria`);
  const options = Object.entries(criteria);
  if (options.length < 2 || options.length > 255) {
    throw new Error(`${path}.criteria must contain between 2 and 255 options`);
  }
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries(
      options.map(([option, description]) => {
        if (!option.trim()) throw new Error(`${path}.criteria option names must not be empty`);
        return [
          option,
          description === null ? null : requireStructuredValue(description, propertyPath(`${path}.criteria`, option)),
        ];
      }),
    ),
  };
}

function normalizeScoreQuestion(
  question: Record<string, unknown>,
  instructions: StructuredValue,
  path: string,
): ScoreQuestion {
  if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
    throw new Error(`${path}.criteria must contain between 2 and 10 ordered levels`);
  }
  return {
    type: "score",
    instructions,
    criteria: question.criteria.map((level, index) => requireStructuredValue(level, `${path}.criteria.${index}`)),
  };
}

function normalizeAnswer(value: unknown, question: JevQuestion, path: string): JevAnswer {
  const answer = requireRecord(value, path);
  if (answer.type !== question.type) {
    throw new Error(`${path}.type does not match the requested ${question.type} question`);
  }
  if (question.type === "noul") return normalizeNoulAnswer(answer, path);
  if (question.type === "choice") return normalizeChoiceAnswer(answer, question, path);
  return normalizeScoreAnswer(answer, question, path);
}

function normalizeNoulAnswer(answer: Record<string, unknown>, path: string): NoulAnswer {
  return {
    type: "noul",
    noul: requireProbability(answer.noul, `${path}.noul`),
  };
}

function normalizeChoiceAnswer(answer: Record<string, unknown>, question: ChoiceQuestion, path: string): ChoiceAnswer {
  if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
    throw new Error(`${path}.choice must name one of the requested options`);
  }
  const probabilities = normalizeProbabilities(answer.probabilities, Object.keys(question.criteria), path);
  const selectedProbability = probabilities[answer.choice] ?? 0;
  if (Object.values(probabilities).some((probability) => probability > selectedProbability)) {
    throw new Error(`${path}.choice must name a highest-probability option`);
  }
  return {
    type: "choice",
    choice: answer.choice,
    probabilities,
    confidence: requireProbability(answer.confidence, `${path}.confidence`),
  };
}

function normalizeScoreAnswer(answer: Record<string, unknown>, question: ScoreQuestion, path: string): ScoreAnswer {
  const levelKeys = question.criteria.map((_, index) => String(index));
  const score = requireFiniteNumber(answer.score, `${path}.score`);
  if (score < 0 || score > question.criteria.length - 1) {
    throw new Error(`${path}.score must be between 0 and ${question.criteria.length - 1}`);
  }
  const probabilities = normalizeProbabilities(answer.probabilities, levelKeys, path);
  const expectedScore = levelKeys.reduce((total, level) => total + Number(level) * (probabilities[level] ?? 0), 0);
  const scoreTolerance = PROBABILITY_SUM_TOLERANCE * Math.max(1, question.criteria.length - 1);
  if (Math.abs(score - expectedScore) > scoreTolerance) {
    throw new Error(`${path}.score must match the probability-weighted level distribution`);
  }
  const legend = requireRecord(answer.legend, `${path}.legend`);
  requireExactKeys(legend, levelKeys, `${path}.legend`);
  const normalizedLegend = Object.fromEntries(
    levelKeys.map((level) => [level, requireStructuredValue(legend[level], propertyPath(`${path}.legend`, level))]),
  );
  for (const [index, criterion] of question.criteria.entries()) {
    const level = String(index);
    if (!jsonValuesEqual(normalizedLegend[level], criterion)) {
      throw new Error(`${propertyPath(`${path}.legend`, level)} must match the requested score criterion`);
    }
  }
  return {
    type: "score",
    score,
    legend: normalizedLegend,
    probabilities,
    confidence: requireProbability(answer.confidence, `${path}.confidence`),
  };
}

function normalizeProbabilities(value: unknown, expectedKeys: string[], answerPath: string): Record<string, number> {
  const path = `${answerPath}.probabilities`;
  const probabilities = requireRecord(value, path);
  requireExactKeys(probabilities, expectedKeys, path);
  const normalized = Object.fromEntries(
    expectedKeys.map((key) => [key, requireProbability(probabilities[key], propertyPath(path, key))]),
  );
  const sum = Object.values(normalized).reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new Error(`${path} must sum to 1`);
  }
  return normalized;
}

function normalizeUsage(value: unknown): JevUsage {
  const usage = requireRecord(value, "response.usage");
  // Null means unreported usage in the SDK; retain OpenRouter aliases when available.
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? (usage.input_tokens === null ? 0 : undefined);
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? (usage.output_tokens === null ? 0 : undefined);
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
    throw new Error("response.usage must contain non-negative input_tokens and output_tokens");
  }
  const cost = usage.cost;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
    throw new Error("response.usage.cost must be a non-negative finite number");
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cost === undefined ? {} : { cost }),
  };
}

function requireStructuredValue(value: unknown, path: string): StructuredValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => requireJsonValue(item, `${path}.${index}`, new Set()));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, requireJsonValue(item, propertyPath(path, key), new Set())]),
    );
  }
  throw new Error(`${path} must be a string, object, or array`);
}

function requireJsonValue(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${path} must not contain circular data`);
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((item, index) => requireJsonValue(item, `${path}.${index}`, nextAncestors));
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) throw new Error(`${path} must not contain circular data`);
    const nextAncestors = new Set(ancestors).add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, requireJsonValue(item, propertyPath(path, key), nextAncestors)]),
    );
  }
  throw new Error(`${path} must contain only JSON values`);
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
}

function requireProbability(value: unknown, path: string): number {
  const probability = requireFiniteNumber(value, path);
  if (probability < 0 || probability > 1) throw new Error(`${path} must be between 0 and 1`);
  return probability;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} keys must exactly match: ${expected.map(quotePathKey).join(", ")}`);
  }
}

function propertyPath(path: string, key: string): string {
  return `${path}[${quotePathKey(key)}]`;
}

function quotePathKey(key: string): string {
  return JSON.stringify(key).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, (character) => {
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
