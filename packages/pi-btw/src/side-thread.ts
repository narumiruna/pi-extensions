import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";

export const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export interface SideQuestionAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
}

export type CompleteSimpleFunction = <TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type SideThreadTurn =
  | {
      kind: "answered";
      question: string;
      answer: string;
      response: AssistantMessage;
    }
  | {
      kind: "error";
      question: string;
      answer: string;
    };

export interface SideThread {
  conversationContext: string;
  turns: SideThreadTurn[];
}

export function createSideThread(conversationContext: string): SideThread {
  return { conversationContext, turns: [] };
}

export function buildSideThreadMessages(thread: SideThread, question: string): Message[] {
  const answeredTurns = thread.turns.filter(
    (turn): turn is Extract<SideThreadTurn, { kind: "answered" }> => turn.kind === "answered",
  );
  const messages: Message[] = [];

  if (answeredTurns.length === 0) {
    messages.push(createUserMessage(buildUserPrompt(question, thread.conversationContext)));
    return messages;
  }

  const [first, ...rest] = answeredTurns;
  messages.push(createUserMessage(buildUserPrompt(first.question, thread.conversationContext)), first.response);
  for (const turn of rest) {
    messages.push(createUserMessage(buildFollowUpPrompt(turn.question)), turn.response);
  }
  messages.push(createUserMessage(buildFollowUpPrompt(question)));
  return messages;
}

export interface CompleteSideThreadTurnOptions {
  thread: SideThread;
  model: Model<Api>;
  question: string;
  thinkingLevel: BtwThinkingLevel;
  auth: SideQuestionAuth;
  signal?: AbortSignal;
  completeSimple: CompleteSimpleFunction;
  sessionId?: string;
}

export type CompleteSideThreadTurnResult =
  | { kind: "answered"; response: AssistantMessage; answer: string }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

export async function completeSideThreadTurn({
  thread,
  model,
  question,
  thinkingLevel,
  auth,
  signal,
  completeSimple,
  sessionId,
}: CompleteSideThreadTurnOptions): Promise<CompleteSideThreadTurnResult> {
  if (signal?.aborted) return { kind: "aborted" };
  try {
    const response = await completeSimple(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: buildSideThreadMessages(thread, question) },
      buildStreamOptions(auth, { thinkingLevel, signal, model, sessionId }),
    );
    if (signal?.aborted || response?.stopReason === "aborted") return { kind: "aborted" };
    if (!isAssistantMessage(response)) {
      return { kind: "error", message: "The side model returned a malformed response." };
    }
    if (response.stopReason === "error") {
      return {
        kind: "error",
        message: response.errorMessage ?? "The side model returned an error.",
      };
    }

    const answer = extractAssistantText(response) || "No response received.";
    thread.turns.push({ kind: "answered", question, answer, response });
    return { kind: "answered", response, answer };
  } catch (error: unknown) {
    if (signal?.aborted) return { kind: "aborted" };
    return { kind: "error", message: formatError(error) };
  }
}

export interface CompleteSideQuestionOptions {
  model: Model<Api>;
  question: string;
  conversationContext: string;
  thinkingLevel: BtwThinkingLevel;
  auth: SideQuestionAuth;
  signal?: AbortSignal;
  completeSimple: CompleteSimpleFunction;
  sessionId?: string;
}

export async function completeSideQuestion({
  model,
  question,
  conversationContext,
  thinkingLevel,
  auth,
  signal,
  completeSimple,
  sessionId,
}: CompleteSideQuestionOptions): Promise<AssistantMessage> {
  return completeSimple(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [createUserMessage(buildUserPrompt(question, conversationContext))],
    },
    buildStreamOptions(auth, { thinkingLevel, signal, model, sessionId }),
  );
}

export function extractAssistantText(response: AssistantMessage): string {
  return response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content !== null && typeof content === "object" && content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantMessage>;
  return candidate.role === "assistant" && Array.isArray(candidate.content) && typeof candidate.stopReason === "string";
}

export function buildUserPrompt(question: string, conversationContext: string): string {
  return [
    "Answer this side question without modifying the main conversation.",
    "",
    "<side_question>",
    question,
    "</side_question>",
    "",
    "<conversation_context>",
    conversationContext || "No prior conversation context was available.",
    "</conversation_context>",
  ].join("\n");
}

export function buildFollowUpPrompt(question: string): string {
  return ["Continue the same side conversation.", "", "<side_question>", question, "</side_question>"].join("\n");
}

function createUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

// Minimal session-headers fork of Pi core provider-attribution
// (pinned to @earendil-works/pi-coding-agent@0.85.0 src/core/provider-attribution.ts:getSessionHeaders).
// Core does not export this helper and extensions have no SettingsManager, so only session
// headers are mirrored here. Default attribution headers are intentionally out of scope.
// Keep semantics bug-compatible with core: case-sensitive Object.assign, explicit auth
// headers win on exact-case match.
const OPENCODE_HOST = "opencode.ai";

function matchesOpencodeHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

function getOpencodeSessionHeaders(
  model: Pick<Model<Api>, "provider" | "baseUrl">,
  sessionId?: string,
): ProviderHeaders | undefined {
  if (!sessionId) return undefined;
  if (model.provider !== "opencode" && model.provider !== "opencode-go" && !matchesOpencodeHost(model.baseUrl)) {
    return undefined;
  }
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function mergeSessionHeaders(
  authHeaders: ProviderHeaders | undefined,
  sessionHeaders: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!sessionHeaders && !authHeaders) return undefined;
  // Bug-compatible with core mergeProviderAttributionHeaders: case-sensitive assign.
  return { ...sessionHeaders, ...authHeaders };
}

interface BuildSideThreadStreamOptions {
  thinkingLevel: BtwThinkingLevel;
  signal?: AbortSignal;
  model?: Pick<Model<Api>, "provider" | "baseUrl">;
  sessionId?: string;
}

function buildStreamOptions(
  auth: SideQuestionAuth,
  { thinkingLevel, signal, model, sessionId }: BuildSideThreadStreamOptions,
): SimpleStreamOptions {
  const sessionHeaders = model ? getOpencodeSessionHeaders(model, sessionId) : undefined;
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: mergeSessionHeaders(auth.headers, sessionHeaders),
    env: auth.env,
    signal,
  };
  if (thinkingLevel !== "off") options.reasoning = thinkingLevel;
  return options;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Use the provided conversation context only as background. Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task. If the context is insufficient, say what is unknown and give the best next step.`;
