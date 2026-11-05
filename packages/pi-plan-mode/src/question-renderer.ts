import type { KeybindingHints, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { PlanModeQuestionAnswer } from "./question-tool.js";

type QuestionResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

type RenderContext = Partial<KeybindingHints> & { isError?: boolean };
type Answer = Pick<PlanModeQuestionAnswer, "header" | "question" | "answer" | "wasCustom" | "note">;
type Style = (text: string) => string;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function renderPlanModeQuestionCall(args: unknown, theme: Theme): Component {
  const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : [];
  return boundedComponent((width) => {
    const title = questions.length > 1 ? "Plan questions" : "Plan question";
    const headers = questions
      .map((question) => (isRecord(question) ? displayLine(question.header) : ""))
      .filter(Boolean);
    const text =
      theme.fg("toolTitle", theme.bold(title)) + theme.fg("muted", headers.length ? `  ${headers.join(" · ")}` : "");
    return [truncateToWidth(text, width, "…")];
  });
}

export function renderPlanModeQuestionResult(
  result: QuestionResult,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext = {},
): Component {
  const text = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const payload = questionPayload(result.details, text);

  return boundedComponent((width) => {
    const muted = (value: string) => theme.fg("muted", value);
    const hint = () =>
      context.keyText?.("app.tools.expand") && context.keyHint
        ? [truncateToWidth(muted(context.keyHint("app.tools.expand", "to expand")), width, "…")]
        : [];

    if (isPartial) return [truncateToWidth(muted("Waiting for answers…"), width, "…")];

    if (context.isError || payload?.cancelled === true) {
      const reason = payload?.reason;
      const failed = context.isError || reason === "invalid_input";
      const status = context.isError
        ? "Question failed"
        : reason === "ui_unavailable"
          ? "Interactive UI unavailable"
          : reason === "plan_mode_inactive"
            ? "Plan mode inactive"
            : reason === "invalid_input"
              ? "Invalid question"
              : "Question cancelled";
      const message = typeof payload?.message === "string" ? payload.message : text;
      const lines = documentLines(status, width, (value) => theme.fg(failed ? "error" : "warning", value));
      if (expanded) {
        lines.push(...documentLines(message, width, muted, "  "));
      } else if (message) {
        lines.push(...hint());
      }
      return lines;
    }

    const answers = payload?.answers;
    if (payload?.cancelled === false && Array.isArray(answers) && answers.length > 0 && answers.every(isAnswer)) {
      const lines: string[] = [];
      for (const answer of answers) {
        if (!expanded) {
          const badge = answer.wasCustom ? muted(" (custom)") : "";
          const note = answer.note ? muted(" · note") : "";
          lines.push(
            truncateToWidth(
              theme.fg("success", "✓ ") +
                muted(`${displayLine(answer.header)}: `) +
                theme.fg("accent", displayLine(answer.answer)) +
                badge +
                note,
              width,
              "…",
            ),
          );
          continue;
        }
        if (lines.length) lines.push("");
        lines.push(...documentLines(answer.header, width, (value) => theme.fg("accent", theme.bold(value))));
        lines.push(...documentLines(answer.question, width, muted, "  "));
        if (answer.wasCustom) lines.push(...documentLines("Custom answer", width, muted, "  "));
        lines.push(
          ...documentLines(
            answer.answer,
            width,
            (value) => theme.fg("text", value),
            "  ✓ ",
            (value) => theme.fg("success", value),
          ),
        );
        if (answer.note) {
          lines.push(...documentLines("Note", width, muted, "  "));
          lines.push(...documentLines(answer.note, width, muted, "    "));
        }
      }
      if (!expanded) lines.push(...hint());
      return lines;
    }

    const lines = documentLines(text || "No answer returned.", width, (value) => theme.fg("toolOutput", value));
    return expanded || lines.length <= 4 ? lines : [...lines.slice(0, 4), ...hint()];
  });
}

function questionPayload(details: unknown, text: string): Record<string, unknown> | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Pi-generated errors and third-party tool-result hooks can return plain text.
  }
  const parsed = isRecord(payload) ? payload : undefined;
  return isRecord(details) && typeof details.cancelled === "boolean" ? { ...parsed, ...details } : parsed;
}

function isAnswer(value: unknown): value is Answer {
  return (
    isRecord(value) &&
    typeof value.header === "string" &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    typeof value.wasCustom === "boolean" &&
    (value.note === undefined || typeof value.note === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayLine(value: unknown): string {
  return typeof value === "string" ? sanitizeTerminalText(value) : "";
}

function documentLines(value: string, width: number, style: Style, prefix = "", prefixStyle = style): string[] {
  const text = sanitizeTerminalDocument(value);
  let contentWidth = 1;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    contentWidth = Math.min(width, Math.max(contentWidth, visibleWidth(segment)));
  }
  // Reduce decoration before it forces a grapheme that fits the viewport into Kit's fallback.
  const visiblePrefix = truncateToWidth(prefix, width - contentWidth, "");
  const prefixWidth = visibleWidth(visiblePrefix);
  return hardWrapTerminalDocument(text, width - prefixWidth).map((line, index) => {
    const decoration = index === 0 ? visiblePrefix : " ".repeat(prefixWidth);
    // Leading marks can change width when they join the decoration's final grapheme.
    const safePrefix = visibleWidth(decoration + line) <= width ? decoration : "";
    return prefixStyle(safePrefix) + style(line);
  });
}

function boundedComponent(render: (width: number) => string[]): Component {
  return {
    render: (width) => (Number.isFinite(width) && width >= 1 ? render(Math.floor(width)) : []),
    // Theme styles are evaluated on every render, so there is no cache to clear.
    invalidate() {},
  };
}
