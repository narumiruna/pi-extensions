import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runCustomInteraction } from "./custom-interaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { MenuCloseReason, MenuContext } from "./types.js";

export interface QuestionnaireOption {
  label: string;
  description?: string;
}

export interface QuestionnaireQuestion<QuestionId extends string = string> {
  id: QuestionId;
  header: string;
  prompt: string;
  options: readonly QuestionnaireOption[];
}

export interface QuestionnaireAnswer<QuestionId extends string = string> {
  questionId: QuestionId;
  answer: string;
  wasCustom: boolean;
  /** One-based index matching the numbered option shown to the user. */
  optionIndex?: number;
  note?: string;
}

export interface QuestionnaireLabels {
  reviewTab: string;
  reviewTitle: string;
  otherOption: string;
  customAnswer: string;
  optionalNote: string;
  answer: string;
  note: string;
}

export interface RunQuestionnaireOptions<
  QuestionId extends string = string,
  Context extends MenuContext = ExtensionCommandContext,
> {
  questions: readonly QuestionnaireQuestion<QuestionId>[];
  allowCustomAnswer?: boolean;
  allowNotes?: boolean;
  maxTextLength?: number;
  labels?: Partial<QuestionnaireLabels>;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: MenuContext["mode"]): void | Promise<void>;
}

export type RunQuestionnaireResult<QuestionId extends string = string> =
  | { kind: "submitted"; answers: QuestionnaireAnswer<QuestionId>[] }
  | { kind: "closed"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: MenuContext["mode"] }
  | { kind: "error"; error: unknown };

const DEFAULT_LABELS: QuestionnaireLabels = {
  reviewTab: "Review",
  reviewTitle: "Review answers",
  otherOption: "Other (free-form)",
  customAnswer: "Custom answer",
  optionalNote: "Optional note",
  answer: "Answer",
  note: "Note",
};

/** Run a standalone questionnaire interaction with TUI and RPC adapters. */
export async function runQuestionnaire<
  const QuestionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
>(ctx: Context, options: RunQuestionnaireOptions<QuestionId, Context>): Promise<RunQuestionnaireResult<QuestionId>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  const validationError = validateOptions(options);
  if (validationError) return questionnaireError(ctx, options, validationError);
  const resolved = resolveOptions(options);
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiQuestionnaire(ctx, options, resolved);
  if (ctx.mode === "rpc" && ctx.hasUI) return runRpcQuestionnaire(ctx, options, resolved);

  try {
    await options.onUnsupportedMode?.(ctx, ctx.mode);
  } catch (error) {
    return questionnaireError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "unsupported", mode: ctx.mode };
}

interface ResolvedQuestionnaireOptions<QuestionId extends string> {
  questions: readonly QuestionnaireQuestion<QuestionId>[];
  allowCustomAnswer: boolean;
  allowNotes: boolean;
  maxTextLength?: number;
  labels: QuestionnaireLabels;
}

async function runTuiQuestionnaire<QuestionId extends string, Context extends MenuContext>(
  ctx: Context,
  options: RunQuestionnaireOptions<QuestionId, Context>,
  resolved: ResolvedQuestionnaireOptions<QuestionId>,
): Promise<RunQuestionnaireResult<QuestionId>> {
  let QuestionnaireComponent: typeof import("./components/questionnaire.js")["QuestionnaireComponent"];
  try {
    ({ QuestionnaireComponent } = await import("./components/questionnaire.js"));
  } catch (error) {
    return questionnaireError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  const result = await runCustomInteraction<
    { kind: "submitted"; answers: QuestionnaireAnswer<QuestionId>[] } | { kind: "closed"; reason: MenuCloseReason },
    Context
  >(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (currentCtx, error) => reportQuestionnaireError(currentCtx, options, error),
    create: ({ tui, theme, keybindings, complete }) =>
      new QuestionnaireComponent({
        ...resolved,
        tui,
        theme,
        keybindings,
        isCurrent: () => isCurrent(options),
        onDone: complete,
      }),
  });
  return result.kind === "completed" ? result.value : result;
}

async function runRpcQuestionnaire<QuestionId extends string, Context extends MenuContext>(
  ctx: Context,
  options: RunQuestionnaireOptions<QuestionId, Context>,
  resolved: ResolvedQuestionnaireOptions<QuestionId>,
): Promise<RunQuestionnaireResult<QuestionId>> {
  const answers: QuestionnaireAnswer<QuestionId>[] = [];
  for (const question of resolved.questions) {
    const rows: Array<
      { kind: "option"; index: number; label: string } | { kind: "custom"; index: number; label: string }
    > = question.options.map((option, index) => ({
      kind: "option",
      index,
      label: formatRpcOption(option, index),
    }));
    if (resolved.allowCustomAnswer) {
      rows.push({
        kind: "custom" as const,
        index: question.options.length,
        label: `${question.options.length + 1}. ${sanitizeTerminalText(resolved.labels.otherOption)}`,
      });
    }
    let selection: string | undefined;
    try {
      selection = await uiFor(ctx).select(
        `${sanitizeTerminalText(question.header)}: ${sanitizeTerminalText(question.prompt)}`,
        rows.map((row) => row.label),
        { signal: options.signal },
      );
    } catch (error) {
      return questionnaireError(ctx, options, error);
    }
    if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
    if (selection === undefined) return { kind: "closed", reason: "back" };
    const row = rows.find((candidate) => candidate.label === selection);
    if (!row) {
      return questionnaireError(
        ctx,
        options,
        new Error("Questionnaire dialog returned an option that was not offered"),
      );
    }
    if (row.kind === "custom") {
      const custom = await askRpcCustomAnswer(ctx, options, resolved, question);
      if (custom.kind !== "answered") return custom.result;
      answers.push({ questionId: question.id, answer: custom.answer, wasCustom: true });
      continue;
    }
    const option = question.options[row.index];
    if (!option) {
      return questionnaireError(ctx, options, new Error("Questionnaire option disappeared"));
    }
    answers.push({
      questionId: question.id,
      answer: option.label,
      wasCustom: false,
      optionIndex: row.index + 1,
    });
  }
  return { kind: "submitted", answers };
}

async function askRpcCustomAnswer<QuestionId extends string, Context extends MenuContext>(
  ctx: Context,
  options: RunQuestionnaireOptions<QuestionId, Context>,
  resolved: ResolvedQuestionnaireOptions<QuestionId>,
  question: QuestionnaireQuestion<QuestionId>,
): Promise<{ kind: "answered"; answer: string } | { kind: "finished"; result: RunQuestionnaireResult<QuestionId> }> {
  let draft = "";
  for (;;) {
    let answer: string | undefined;
    try {
      answer = await uiFor(ctx).editor(sanitizeTerminalText(question.prompt), draft);
    } catch (error) {
      return { kind: "finished", result: await questionnaireError(ctx, options, error) };
    }
    if (!isCurrent(options) || options.signal?.aborted) {
      return { kind: "finished", result: { kind: "stale" } };
    }
    if (answer === undefined) {
      return { kind: "finished", result: { kind: "closed", reason: "back" } };
    }
    if (resolved.maxTextLength !== undefined && answer.length > resolved.maxTextLength) {
      try {
        uiFor(ctx).notify(
          `Custom answer must be ${formatLimit(resolved.maxTextLength)} characters or fewer.`,
          "warning",
        );
      } catch (error) {
        return { kind: "finished", result: await questionnaireError(ctx, options, error) };
      }
      draft = answer;
      continue;
    }
    return { kind: "answered", answer };
  }
}

function resolveOptions<QuestionId extends string, Context extends MenuContext>(
  options: RunQuestionnaireOptions<QuestionId, Context>,
): ResolvedQuestionnaireOptions<QuestionId> {
  return {
    questions: options.questions,
    allowCustomAnswer: options.allowCustomAnswer ?? true,
    allowNotes: options.allowNotes ?? false,
    maxTextLength: options.maxTextLength,
    labels: { ...DEFAULT_LABELS, ...options.labels },
  };
}

function validateOptions<QuestionId extends string, Context extends MenuContext>(
  options: RunQuestionnaireOptions<QuestionId, Context>,
): Error | undefined {
  if (options.questions.length === 0) return new Error("Questionnaire requires at least one question");
  if (options.maxTextLength !== undefined && (!Number.isInteger(options.maxTextLength) || options.maxTextLength <= 0)) {
    return new Error("Questionnaire maxTextLength must be a positive integer");
  }
  const ids = new Set<string>();
  for (const question of options.questions) {
    if (!question.id.trim()) return new Error("Questionnaire question ids must not be blank");
    if (ids.has(question.id)) return new Error(`Duplicate questionnaire question id: ${question.id}`);
    ids.add(question.id);
    if (!sanitizeTerminalText(question.header).trim()) {
      return new Error(`Questionnaire question ${question.id} requires a displayable header`);
    }
    if (!sanitizeTerminalText(question.prompt).trim()) {
      return new Error(`Questionnaire question ${question.id} requires a displayable prompt`);
    }
    if (question.options.length === 0) {
      return new Error(`Questionnaire question ${question.id} requires at least one option`);
    }
    for (const option of question.options) {
      if (!sanitizeTerminalText(option.label).trim()) {
        return new Error(`Questionnaire question ${question.id} has a blank option label`);
      }
    }
  }
  for (const [name, label] of Object.entries(options.labels ?? {})) {
    if (!sanitizeTerminalText(label).trim()) {
      return new Error(`Questionnaire label ${name} must be displayable`);
    }
  }
  return undefined;
}

function formatRpcOption(option: QuestionnaireOption, index: number): string {
  const label = sanitizeTerminalText(option.label);
  const description = option.description ? ` — ${sanitizeTerminalText(option.description)}` : "";
  return `${index + 1}. ${label}${description}`;
}

async function questionnaireError<QuestionId extends string, Context extends MenuContext>(
  ctx: Context,
  options: RunQuestionnaireOptions<QuestionId, Context>,
  error: unknown,
): Promise<RunQuestionnaireResult<QuestionId>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  await reportQuestionnaireError(ctx, options, error);
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "error", error };
}

async function reportQuestionnaireError<QuestionId extends string, Context extends MenuContext>(
  ctx: Context,
  options: RunQuestionnaireOptions<QuestionId, Context>,
  error: unknown,
): Promise<void> {
  let reported = false;
  if (options.onError) {
    try {
      await options.onError(ctx, error);
      reported = true;
    } catch {
      // Fall through to Pi's notifier when a custom reporter is unavailable.
    }
  }
  if (reported || !ctx.hasUI || !isCurrent(options) || options.signal?.aborted) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    uiFor(ctx).notify(`Questionnaire failed: ${sanitizeTerminalText(message)}`, "error");
  } catch {
    // Error reporting must not change the typed result.
  }
}

function isCurrent<QuestionId extends string, Context extends MenuContext>(
  options: RunQuestionnaireOptions<QuestionId, Context>,
): boolean {
  return options.isCurrent?.() ?? true;
}

function formatLimit(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
