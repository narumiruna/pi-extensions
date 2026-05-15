import { complete, type UserMessage } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	DynamicBorder,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

const MAX_CONTEXT_CHARS = 40_000;
const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Use the provided conversation context only as background. Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task. If the context is insufficient, say what is unknown and give the best next step.`;

type MessageContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
	stopReason?: string;
};

type SessionEntry = {
	type: string;
	message?: SessionMessage;
};

export default function btw(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <your side question>", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const answer = await askSideQuestion(question, ctx);
			if (answer === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await showAnswer(question, answer, ctx);
		},
	});
}

async function askSideQuestion(
	question: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Answering /btw with ${ctx.model!.id}...`);
		loader.onAbort = () => done(undefined);

		const ask = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
			}

			const conversationContext = buildConversationContext(ctx.sessionManager.getBranch());
			const userMessage: UserMessage = {
				role: "user",
				content: [
					{
						type: "text",
						text: buildUserPrompt(question, conversationContext),
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") {
				return undefined;
			}

			const text = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim();

			return text || "No response received.";
		};

		ask()
			.then(done)
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				done(`Error: ${message}`);
			});

		return loader;
	});
}

async function showAnswer(question: string, answer: string, ctx: ExtensionCommandContext) {
	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const border = new DynamicBorder((text: string) => theme.fg("warning", text));
		const markdownTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("warning", theme.bold(`/btw ${question}`)), 1, 0));
		container.addChild(new Markdown(answer, 1, 1, markdownTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter, Space, or Esc to close"), 1, 1));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "space") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

function buildUserPrompt(question: string, conversationContext: string) {
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

function buildConversationContext(entries: readonly SessionEntry[]) {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const contentLines = extractContentLines(entry.message.content);
		if (contentLines.length === 0) continue;

		const label = role === "user" ? "User" : "Assistant";
		const status = entry.message.stopReason && entry.message.stopReason !== "stop"
			? ` (${entry.message.stopReason})`
			: "";
		sections.push(`${label}${status}: ${contentLines.join("\n")}`);
	}

	return truncateFromStart(sections.join("\n\n"), MAX_CONTEXT_CHARS);
}

function extractContentLines(content: unknown): string[] {
	if (typeof content === "string") {
		return [content.trim()].filter(Boolean);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;

		const block = part as MessageContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text.trim());
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}(${formatJson(block.arguments)})`);
		} else if (block.type === "toolResult" && typeof block.name === "string") {
			lines.push(`Tool result from ${block.name}: ${formatJson(block.result)}`);
		}
	}

	return lines.filter(Boolean);
}

function formatJson(value: unknown) {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateFromStart(text: string, maxChars: number) {
	if (text.length <= maxChars) return text;
	return `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
