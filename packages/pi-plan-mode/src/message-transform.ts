import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import type { ActiveImplementationPlan } from "./state.js";

const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
export const PLAN_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE = "plan-mode-implementation-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PLAN_IMPLEMENTATION_HANDOFF_PREFIX =
  "Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:";
export const PLAN_HISTORY_IMPLEMENTATION_PROMPT = "Implement the plan.";
const PROPOSED_PLAN_PATTERN = /^<proposed_plan>[\t ]*\r?\n([\s\S]*?)\r?\n<\/proposed_plan>[\t ]*$/gm;
const PROPOSED_PLAN_BLOCK_PATTERN = /^<proposed_plan>[\t ]*\r?\n[\s\S]*?\r?\n<\/proposed_plan>[\t ]*$/gm;

export type ProposedPlanParseResult =
  | { kind: "absent" }
  | { kind: "valid"; plan: string }
  | { kind: "empty" }
  | { kind: "multiple" }
  | { kind: "malformed" }
  | { kind: "unclosed" };

type SessionMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

type TextBlock = {
  type?: string;
  text?: string;
};

export function parseProposedPlan(text: string): ProposedPlanParseResult {
  const openingCount = text.match(/<proposed_plan>/gi)?.length ?? 0;
  const closingCount = text.match(/<\/proposed_plan>/gi)?.length ?? 0;
  if (openingCount === 0 && closingCount === 0) return { kind: "absent" };
  if (openingCount > 1 || closingCount > 1) return { kind: "multiple" };
  if (openingCount === 1 && closingCount === 0) return { kind: "unclosed" };
  if (openingCount !== 1 || closingCount !== 1) return { kind: "malformed" };

  const matches = Array.from(text.matchAll(PROPOSED_PLAN_PATTERN));
  if (matches.length !== 1) return { kind: "malformed" };
  const plan = matches[0]?.[1]?.trim() ?? "";
  return plan ? { kind: "valid", plan } : { kind: "empty" };
}

export function extractProposedPlan(text: string) {
  const result = parseProposedPlan(text);
  return result.kind === "valid" ? result.plan : undefined;
}

export function invalidPlanMessage(kind: "empty" | "multiple" | "malformed" | "unclosed") {
  const detail = {
    empty: "the block is empty",
    multiple: "more than one plan block was produced",
    malformed: "the tags must be on their own lines",
    unclosed: "the closing tag is missing",
  }[kind];
  return `Proposed plan is not ready: ${detail}. Continue Plan mode and produce one complete non-empty <proposed_plan> block.`;
}

export function latestAssistantText(messages: unknown) {
  if (!Array.isArray(messages)) return "";
  for (const entry of [...messages].reverse()) {
    const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
    if (message?.role !== "assistant") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return "";
}

export function latestAssistantStopReason(messages: unknown) {
  if (!Array.isArray(messages)) return undefined;
  for (const entry of [...messages].reverse()) {
    const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

export function messageTextContent(message: unknown) {
  return messageText((message as { message?: SessionMessage })?.message ?? (message as SessionMessage));
}

export function messageContainsLegacyPlanModeContextArtifact(message: unknown) {
  return unwrapSessionMessage(message).customType === PLAN_CONTEXT_MESSAGE_TYPE;
}

export function messageContainsPlanModeImplementationContextArtifact(message: unknown) {
  return unwrapSessionMessage(message).customType === PLAN_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE;
}

export function injectActiveImplementationContext(messages: unknown[], activeImplementation: ActiveImplementationPlan) {
  let foundCurrentContext = false;
  let foundCurrentHandoff = false;
  const expectedContext = activeImplementationContextContent(activeImplementation);
  const messagesWithoutStaleContext = messages.filter((message) => {
    if (messageContainsPlanModeImplementationContextArtifact(message)) {
      const candidate = unwrapSessionMessage(message);
      if (!foundCurrentContext && candidate.content === expectedContext) {
        foundCurrentContext = true;
        return true;
      }
      return false;
    }
    if (!messageContainsPlanModeImplementationHandoff(message)) return true;
    if (!foundCurrentHandoff && messageContainsExactPlanModeImplementationHandoff(message, activeImplementation.plan)) {
      foundCurrentHandoff = true;
      return true;
    }
    return false;
  });
  if (foundCurrentHandoff || foundCurrentContext) return messagesWithoutStaleContext;

  let insertionIndex = 0;
  while (isSummaryMessage(messagesWithoutStaleContext[insertionIndex])) insertionIndex += 1;
  const contextMessage = {
    role: "custom" as const,
    customType: PLAN_IMPLEMENTATION_CONTEXT_MESSAGE_TYPE,
    content: expectedContext,
    display: false,
    timestamp: activeImplementation.startedAt,
  };
  return [
    ...messagesWithoutStaleContext.slice(0, insertionIndex),
    contextMessage,
    ...messagesWithoutStaleContext.slice(insertionIndex),
  ];
}

function activeImplementationContextContent(activeImplementation: ActiveImplementationPlan) {
  return `[ACTIVE IMPLEMENTATION PLAN]\n\nThe user approved the exact implementation plan below. Continue following it until the user explicitly clears or supersedes it. The exact plan is the remainder of this message:\n\n${activeImplementation.plan}`;
}

export function messageContainsInactivePlanModeArtifact(message: unknown) {
  const candidate = unwrapSessionMessage(message);
  return (
    candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE ||
    (candidate.role === "toolResult" && candidate.toolName === PLAN_MODE_COMPLETE_TOOL_NAME)
  );
}

interface HistoryImplementationArtifact {
  messageIndex: number;
  kind: "completion" | "legacy" | "presentation";
  toolCallId?: string;
  toolCallMessageIndex?: number;
}

// The kickoff text is intentionally generic, so only trust a plan artifact in the same
// uninterrupted user/summary segment and require a complete tool-call/result pair.
export function findHistoryImplementationArtifact(messages: unknown[]): HistoryImplementationArtifact | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = unwrapSessionMessage(messages[index]);
    if (candidate.role !== "user" || contentText(candidate.content).trim() !== PLAN_HISTORY_IMPLEMENTATION_PROMPT) {
      continue;
    }
    const artifact = findHistoryImplementationArtifactBeforeKickoff(messages, index);
    if (artifact) return artifact;
  }
  return undefined;
}

function findHistoryImplementationArtifactBeforeKickoff(
  messages: unknown[],
  kickoffIndex: number,
): HistoryImplementationArtifact | undefined {
  for (let index = kickoffIndex - 1; index >= 0; index -= 1) {
    const candidate = unwrapSessionMessage(messages[index]);
    if (candidate.role === "user" || isSummaryMessage(messages[index])) return undefined;
    if (candidate.role === "toolResult" && candidate.toolName === PLAN_MODE_COMPLETE_TOOL_NAME) {
      const toolCallId = candidate.toolCallId;
      const toolCallMessageIndex = toolCallId
        ? findPlanModeCompletionCallMessageIndex(messages, index, toolCallId)
        : undefined;
      if (toolCallId && toolCallMessageIndex !== undefined) {
        return {
          messageIndex: index,
          kind: "completion",
          toolCallId,
          toolCallMessageIndex,
        };
      }
      continue;
    }
    if (candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE) {
      return { messageIndex: index, kind: "presentation" };
    }
    if (candidate.role === "assistant" && contentText(candidate.content).match(PROPOSED_PLAN_BLOCK_PATTERN)) {
      return { messageIndex: index, kind: "legacy" };
    }
  }
  return undefined;
}

function findPlanModeCompletionCallMessageIndex(messages: unknown[], endIndex: number, toolCallId: string) {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const candidate = unwrapSessionMessage(messages[index]);
    if (candidate.role === "user" || isSummaryMessage(messages[index])) return undefined;
    if (!Array.isArray(candidate.content)) continue;
    if (
      candidate.content.some((block) => {
        const toolCall = block as { type?: string; id?: string; name?: string };
        return (
          toolCall.type === "toolCall" && toolCall.id === toolCallId && toolCall.name === PLAN_MODE_COMPLETE_TOOL_NAME
        );
      })
    ) {
      return index;
    }
  }
  return undefined;
}

export function messageContainsPlanModeImplementationHandoff(message: unknown) {
  const candidate = unwrapSessionMessage(message);
  return (
    candidate.role === "user" &&
    contentText(candidate.content).trimStart().startsWith(PLAN_IMPLEMENTATION_HANDOFF_PREFIX)
  );
}

export function messageContainsExactPlanModeImplementationHandoff(message: unknown, plan: string) {
  const candidate = unwrapSessionMessage(message);
  if (candidate.role !== "user") return false;
  return contentText(candidate.content).trim() === `${PLAN_IMPLEMENTATION_HANDOFF_PREFIX}\n\n${plan}`.trim();
}

function isSummaryMessage(message: unknown) {
  const role = unwrapSessionMessage(message)?.role;
  return role === "compactionSummary" || role === "branchSummary";
}

export function stripProposedPlanBlocksFromMessage<T>(message: T): T {
  return replaceAssistantContent(message, stripProposedPlanBlocksFromContent);
}

export function stripPlanModeCompletionCallsFromMessage<T>(message: T, preservedToolCallId?: string): T {
  return replaceAssistantContent(message, (content) => {
    if (!Array.isArray(content)) return content;
    const nextContent = content.filter((block) => {
      const candidate = block as { type?: string; id?: string; name?: string };
      return !(
        candidate.type === "toolCall" &&
        candidate.name === PLAN_MODE_COMPLETE_TOOL_NAME &&
        (!preservedToolCallId || candidate.id !== preservedToolCallId)
      );
    });
    return nextContent.length === content.length ? content : nextContent;
  });
}

export function isEmptyAssistantMessage(message: unknown) {
  const candidate = unwrapSessionMessage(message);
  return candidate.role === "assistant" && Array.isArray(candidate.content) && candidate.content.length === 0;
}

function replaceAssistantContent<T>(message: T, transform: (content: unknown) => unknown): T {
  const candidate = unwrapSessionMessage(message);
  if (candidate.role !== "assistant") return message;

  const content = transform(candidate.content);
  if (content === candidate.content) return message;

  if (isSessionMessageEntry(message)) {
    return { ...message, message: { ...candidate, content } };
  }
  return { ...candidate, content } as T;
}

function unwrapSessionMessage(message: unknown) {
  const entry = message as { message?: unknown } | null | undefined;
  return (entry?.message ?? message ?? {}) as {
    role?: string;
    customType?: string;
    toolName?: string;
    toolCallId?: string;
    content?: unknown;
  };
}

function isSessionMessageEntry<T>(message: T): message is T & { message: SessionMessage } {
  return typeof message === "object" && message !== null && "message" in message;
}

function stripProposedPlanBlocksFromContent(content: unknown) {
  if (typeof content === "string") return stripProposedPlanBlocks(content);
  if (!Array.isArray(content)) return content;

  let changed = false;
  const nextContent = content.map((block) => {
    const textBlock = block as TextBlock;
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") return block;

    const text = stripProposedPlanBlocks(textBlock.text);
    if (text === textBlock.text) return block;

    changed = true;
    return { ...textBlock, text };
  });
  return changed ? nextContent : content;
}

export function stripProposedPlanBlocks(text: string) {
  return text.replace(PROPOSED_PLAN_BLOCK_PATTERN, "");
}

function messageText(message: SessionMessage) {
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const textBlock = block as TextBlock;
      return textBlock.type === "text" && typeof textBlock.text === "string" ? textBlock.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
