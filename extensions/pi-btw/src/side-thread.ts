import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";

export const BTW_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export interface SideQuestionAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export type CompleteSimpleFunction = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

type ModuleImporter = (moduleId: string) => Promise<unknown>;

function hasCompleteSimple(value: unknown): value is { completeSimple: CompleteSimpleFunction } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "completeSimple") === "function"
	);
}

export async function loadCompleteSimple(
	importModule: ModuleImporter = (moduleId) => import(moduleId),
): Promise<CompleteSimpleFunction> {
	let importError: unknown;
	for (const moduleId of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]) {
		try {
			const module = await importModule(moduleId);
			if (hasCompleteSimple(module)) return module.completeSimple;
		} catch (error: unknown) {
			importError = error;
		}
	}

	throw new Error("@earendil-works/pi-ai does not export completeSimple", {
		cause: importError,
	});
}

const defaultCompleteSimple = await loadCompleteSimple();

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
	messages.push(
		createUserMessage(buildUserPrompt(first.question, thread.conversationContext)),
		first.response,
	);
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
	completeSimple?: CompleteSimpleFunction;
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
	completeSimple = defaultCompleteSimple,
}: CompleteSideThreadTurnOptions): Promise<CompleteSideThreadTurnResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let response: AssistantMessage;
	try {
		response = await completeSimple(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: buildSideThreadMessages(thread, question) },
			buildStreamOptions(auth, thinkingLevel, signal),
		);
	} catch (error: unknown) {
		if (signal?.aborted) return { kind: "aborted" };
		return { kind: "error", message: formatError(error) };
	}

	if (signal?.aborted || response.stopReason === "aborted") return { kind: "aborted" };
	if (response.stopReason === "error") {
		return { kind: "error", message: response.errorMessage ?? "The side model returned an error." };
	}

	const answer = extractAssistantText(response) || "No response received.";
	thread.turns.push({ kind: "answered", question, answer, response });
	return { kind: "answered", response, answer };
}

export interface CompleteSideQuestionOptions {
	model: Model<Api>;
	question: string;
	conversationContext: string;
	thinkingLevel: BtwThinkingLevel;
	auth: SideQuestionAuth;
	signal?: AbortSignal;
	completeSimple?: CompleteSimpleFunction;
}

export async function completeSideQuestion({
	model,
	question,
	conversationContext,
	thinkingLevel,
	auth,
	signal,
	completeSimple = defaultCompleteSimple,
}: CompleteSideQuestionOptions): Promise<AssistantMessage> {
	return completeSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [createUserMessage(buildUserPrompt(question, conversationContext))],
		},
		buildStreamOptions(auth, thinkingLevel, signal),
	);
}

export function extractAssistantText(response: AssistantMessage): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
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
	return [
		"Continue the same side conversation.",
		"",
		"<side_question>",
		question,
		"</side_question>",
	].join("\n");
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function buildStreamOptions(
	auth: SideQuestionAuth,
	thinkingLevel: BtwThinkingLevel,
	signal?: AbortSignal,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
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
