import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "teach_language";
const LEGACY_TOOL_NAME = "teach_english";
const WIDGET_KEY = "english-grammar";
const VISIBILITY_ENTRY = "language-coach-visibility";
const SENTENCE_LIMIT = 300;
const EXPLANATION_LIMIT = 240;

interface Lesson {
  sentence: string;
  // Older stored lessons can omit the revised sentence.
  correction?: string;
  explanation: string;
}

interface LessonVisibility {
  submissionId: string | null;
  automatic: boolean;
}

interface LessonState {
  latest?: { id: string; lesson: Lesson };
  visible?: Lesson;
  submissionId: string | null;
  submissionHash?: string;
}

function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function displayText(value: string): string {
  return stripTerminalSequences(stripVTControlCharacters(value))
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && [...value].length <= limit && visibleWidth(displayText(value)) > 0;
}

function isLesson(value: unknown): value is Lesson {
  if (!value || typeof value !== "object") return false;
  const lesson = value as Record<string, unknown>;
  return (
    isText(lesson.sentence, SENTENCE_LIMIT) &&
    isText(lesson.explanation, EXPLANATION_LIMIT) &&
    (lesson.correction === undefined || isText(lesson.correction, SENTENCE_LIMIT))
  );
}

function storedLesson(details: unknown): Lesson | undefined {
  if (!details || typeof details !== "object") return undefined;
  const lesson = (details as Record<string, unknown>).lesson;
  return isLesson(lesson) ? lesson : undefined;
}

function lessonLines(lesson: Lesson): string[] {
  return [
    `Original: ${lesson.sentence}`,
    ...(lesson.correction ? [`Suggestion: ${lesson.correction}`] : []),
    `Explanation: ${lesson.explanation}`,
  ];
}

function showLesson(ctx: ExtensionContext, lesson: Lesson | undefined): void {
  if (ctx.mode !== "tui") return;
  if (!lesson) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(
    WIDGET_KEY,
    (_tui, theme: Theme) => {
      const border = new DynamicBorder((text) => theme.fg("borderMuted", text));
      return {
        render(width: number): string[] {
          if (width < 1) return [];
          const explanation = wrapTextWithAnsi(`Explanation: ${displayText(lesson.explanation)}`, width);
          const description = explanation.slice(0, 2);
          if (explanation.length > 2) {
            description[1] = `${truncateToWidth(description[1] ?? "", width - 1, "")}…`;
          }
          return [
            ...border.render(width),
            theme.fg("accent", "Language lesson"),
            theme.fg("text", `Original: ${displayText(lesson.sentence)}`),
            ...(lesson.correction ? [theme.fg("success", `Suggestion: ${displayText(lesson.correction)}`)] : []),
            ...description.map((line) => theme.fg("muted", line)),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
      };
    },
    { placement: "aboveEditor" },
  );
}

function lessonState(ctx: ExtensionContext): LessonState {
  const state: LessonState = { submissionId: null };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === VISIBILITY_ENTRY) {
      const data = entry.data as { action?: string; lessonId?: string; promptHash?: string } | undefined;
      if (data?.action === "dismiss") {
        state.submissionId = entry.id;
        state.submissionHash = typeof data.promptHash === "string" ? data.promptHash : undefined;
        state.visible = undefined;
      } else if (data?.action === "show" && state.latest && state.latest.id === data.lessonId) {
        state.visible = state.latest.lesson;
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (
      message.role !== "toolResult" ||
      (message.toolName !== TOOL_NAME && message.toolName !== LEGACY_TOOL_NAME) ||
      message.isError
    )
      continue;
    const lesson = storedLesson(message.details);
    if (!lesson) continue;
    state.latest = { id: entry.id, lesson };
    const { visibility } = message.details as { visibility?: LessonVisibility };
    if (visibility === undefined || (visibility?.automatic === true && visibility.submissionId === state.submissionId))
      state.visible = lesson;
  }
  return state;
}

function canShowAutomatically(ctx: ExtensionContext, toolCallId: string, state: LessonState): boolean {
  // Keep the widget hidden until queued user messages have been delivered.
  if (ctx.hasPendingMessages()) return false;
  if (state.submissionId === null) return true;
  let foundCall = false;
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.id === state.submissionId) return false;
    if (entry.type !== "message") continue;
    const message = entry.message;
    // A starting run can store its user after the next input arrives. Match text too.
    if (foundCall && message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
      return state.submissionHash === promptHash(text);
    }
    if (
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
    )
      foundCall = true;
  }
  return false;
}

function restoreLesson(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  showLesson(ctx, undefined);
  const { visible } = lessonState(ctx);
  if (visible) showLesson(ctx, visible);
}

export default function languageCoach(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && ctx.mode === "tui") {
      showLesson(ctx, undefined);
      pi.appendEntry(VISIBILITY_ENTRY, { action: "dismiss", promptHash: promptHash(event.text) });
    }
    return { action: "continue" };
  });
  pi.on("session_start", (_event, ctx) => restoreLesson(ctx));
  pi.on("session_tree", (_event, ctx) => restoreLesson(ctx));
  pi.on("session_shutdown", (_event, ctx) => showLesson(ctx, undefined));

  pi.registerCommand("lesson", {
    description: "Reopen the latest language lesson on this branch without a model request",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/lesson requires interactive mode.", "warning");
        return;
      }
      const { latest } = lessonState(ctx);
      if (!latest) {
        showLesson(ctx, undefined);
        ctx.ui.notify("No language lesson on this branch.", "info");
        return;
      }
      pi.appendEntry(VISIBILITY_ENTRY, { action: "show", lessonId: latest.id });
      showLesson(ctx, latest.lesson);
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    // Nested calls have no transcript entry for restoring the lesson.
    exposure: "model-only",
    label: "Language lesson",
    description:
      "Proactively suggest one useful grammar or wording improvement in any language for one short sentence the user wrote in their current message. " +
      "Focus on the main language of the user's current message, including mixed-language messages. " +
      "Call this tool for improvements in clarity, naturalness, or concision in spoken or written language, even when the grammar is correct. " +
      "Prioritize grammar errors and substantial wording improvements. " +
      "Skip cosmetic changes, such as adding please, unless the user asks about tone. " +
      "Do not wait for a grammar error or an explicit request for language help. " +
      "Skip this tool when there is no useful improvement; it is not required on every turn. " +
      "Choose at most one sentence per user message. Avoid pasted or quoted material, code, logs, and commands. " +
      "Copy the sentence without changing it. Keep the revision in the sentence's original language and writing system; do not translate it. " +
      "Give a simple explanation in the main language of the user's current message, in one or two short sentences. " +
      "Use familiar words and explain any grammar terms you need. " +
      "Always provide a revised sentence in correction, preserving meaning and technical names. " +
      "Fix clear grammar errors; if the original is already correct, say so and explain why the suggested wording may suit the context better. " +
      "Do not treat valid imperatives or style preferences as errors. " +
      "This tool saves the lesson in session history and returns it as text. " +
      "It updates the widget above the editor only for the current message when no user input is queued; /lesson reopens saved lessons. " +
      "It makes no model or network requests. Repeating a current-message call replaces the same widget. " +
      "Invalid or cancelled calls fail without changing the widget. Continue the user's main task without repeating the lesson in the reply.",
    parameters: Type.Object({
      sentence: Type.String({
        description: "One short sentence copied from the user's own current message, in any language.",
        minLength: 1,
        maxLength: SENTENCE_LIMIT,
      }),
      correction: Type.String({
        description:
          "Revised sentence in the same language and writing system: fix grammar or improve clarity, naturalness, or concision in spoken or written language. Preserve meaning and technical names.",
        minLength: 1,
        maxLength: SENTENCE_LIMIT,
      }),
      explanation: Type.String({
        description:
          "One grammar or wording point in the main language of the user's current message, using simple words and one or two short sentences. For correct originals, say so and explain the suggestion's benefit.",
        minLength: 1,
        maxLength: EXPLANATION_LIMIT,
      }),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isLesson(params) || params.correction === undefined) {
        throw new Error("Provide a short sentence, a revised sentence, and a non-empty explanation.");
      }
      const lesson: Lesson = {
        sentence: params.sentence,
        correction: params.correction,
        explanation: params.explanation,
      };
      const state = ctx.mode === "tui" ? lessonState(ctx) : undefined;
      const visibility: LessonVisibility | undefined = state && {
        submissionId: state.submissionId,
        automatic: canShowAutomatically(ctx, toolCallId, state),
      };
      if (visibility?.automatic) showLesson(ctx, lesson);
      return {
        content: [{ type: "text", text: lessonLines(lesson).join("\n") }],
        details: { lesson, ...(visibility ? { visibility } : {}) },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Language lesson")), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const lesson = storedLesson(result.details);
      if (lesson && expanded) {
        return {
          render(width: number): string[] {
            if (width < 1) return [];
            return lessonLines(lesson)
              .flatMap((line) => wrapTextWithAnsi(displayText(line), width))
              .map((line) => truncateToWidth(theme.fg("text", line), width));
          },
          invalidate() {},
        };
      }
      const visibility = (result.details as { visibility?: LessonVisibility } | undefined)?.visibility;
      const text = lesson
        ? visibility?.automatic === false
          ? "Language lesson saved. Use /lesson to show it."
          : "Language lesson updated."
        : result.content
            .filter((block) => block.type === "text")
            .map((block) => displayText(block.text))
            .join(" ");
      return new Text(theme.fg("muted", text), 0, 0);
    },
  });
}
