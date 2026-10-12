import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { safeGoalMenuText } from "./errors.js";
import { GOAL_PROMPT_MESSAGE_TYPE, type GoalPromptKind, type GoalPromptMessageDetails } from "./prompt-channel.js";

interface GoalPromptMessageLike {
  content?: unknown;
  details?: unknown;
}

interface RendererThemeLike {
  fg(name: string, text: string): string;
  bg(name: string, text: string): string;
}

const IDENTITY_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const KIND_LABELS: Record<GoalPromptKind, string> = {
  set: "set",
  resume: "resumed",
  edit: "edit",
  wait: "wait resumed",
  continue: "continue",
  claim: "claim",
};

function goalPromptSummary(message: GoalPromptMessageLike): string {
  const details = message.details as Partial<GoalPromptMessageDetails> | undefined;
  const kind = details?.kind && KIND_LABELS[details.kind] ? KIND_LABELS[details.kind] : "prompt";
  const objective = safeGoalMenuText(typeof details?.objective === "string" ? details.objective : "", 120);
  const iteration = typeof details?.iteration === "number" ? ` #${details.iteration}` : "";
  return `goal ${kind}${iteration}: ${objective}`;
}

function goalPromptFullText(message: GoalPromptMessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && Reflect.get(part, "type") === "text")
    .map((part) => Reflect.get(part, "text"))
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/**
 * Collapsed-by-default single-line rendering for pi-goal prompts, mirroring how
 * skill invocations display: the full prompt still reaches the model unchanged;
 * the transcript shows one line until the global expand toggle.
 */
export function registerGoalPromptRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    GOAL_PROMPT_MESSAGE_TYPE,
    (message: GoalPromptMessageLike, options: { expanded?: boolean; outputPad?: number }, theme: RendererThemeLike) => {
      const box = new Box(options.outputPad ?? 1, 1, (t: string) => theme.bg("customMessageBg", t));
      const label = theme.fg("customMessageLabel", "\x1b[1m[goal]\x1b[22m ");
      if (options.expanded) {
        const content = new Container();
        content.addChild(new Text(label + theme.fg("customMessageText", goalPromptSummary(message))));
        content.addChild(
          new Markdown(goalPromptFullText(message), 0, 0, IDENTITY_MARKDOWN_THEME, {
            color: (text: string) => theme.fg("customMessageText", text),
          }),
        );
        box.addChild(content);
        return box;
      }
      box.addChild(new Text(label + theme.fg("customMessageText", goalPromptSummary(message))));
      return box;
    },
  );
}
