import { complete, type UserMessage } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	DynamicBorder,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const MAX_CONTEXT_CHARS = 40_000;
const ANSWER_CHROME_LINES = 4;
// Pi renders a spacer above the custom editor and a two-line built-in footer below it.
const ANSWER_RESERVED_APP_LINES = 3;
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

type BtwOptions = {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
};

export default function btw(pi: ExtensionAPI, options: BtwOptions = {}) {
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

			if (shouldOpenGhosttyTab(options.env, options.platform)) {
				const opened = await tryOpenGhosttyForkTab(question, ctx, pi);
				if (opened) return;
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
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		return new BtwAnswerPager(tui, theme, question, answer, () => done(undefined));
	});
}

async function tryOpenGhosttyForkTab(
	question: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("Could not open Ghostty fork tab (no saved session); showing inline pager.", "warning");
		return false;
	}

	try {
		const result = await pi.exec(
			"osascript",
			["-e", buildGhosttyForkTabAppleScript(question, sessionFile, ctx.cwd)],
			{ timeout: 5000 },
		);
		if (result.code === 0 && !result.killed) return true;

		ctx.ui.notify(
			`Could not open Ghostty fork tab (${formatExecFailure(result)}); showing inline pager.`,
			"warning",
		);
		return false;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not open Ghostty fork tab (${message}); showing inline pager.`, "warning");
		return false;
	}
}

function formatExecFailure(result: {
	stdout?: string;
	stderr?: string;
	code?: number | null;
	killed?: boolean;
}) {
	if (result.killed) return "osascript timed out";
	return (
		result.stderr?.trim() ||
		result.stdout?.trim() ||
		`osascript exited ${result.code ?? "unknown"}`
	);
}

export function shouldOpenGhosttyTab(
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
) {
	return (
		platform === "darwin" &&
		(env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
			env.TERM?.toLowerCase() === "xterm-ghostty")
	);
}

export function buildGhosttyForkTabAppleScript(question: string, sessionFile: string, cwd: string) {
	const input = buildGhosttyForkTabInitialInput(question, sessionFile);
	return [
		'tell application "Ghostty"',
		"set cfg to new surface configuration",
		`set initial working directory of cfg to ${appleScriptText(cwd)}`,
		`set initial input of cfg to ${appleScriptText(input)}`,
		"set tabRef to new tab in front window with configuration cfg",
		"select tab tabRef",
		"end tell",
	].join("\n");
}

export function buildGhosttyForkTabInitialInput(question: string, sessionFile: string) {
	return `pi --fork ${shellQuote(sessionFile)} ${shellQuote(question)}\n`;
}

function shellQuote(text: string) {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function appleScriptText(text: string) {
	return text.split("\n").map(appleScriptString).join(" & linefeed & ");
}

function appleScriptString(text: string) {
	return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

class BtwAnswerPager implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly onClose: () => void;
	private readonly topBorder: DynamicBorder;
	private readonly bottomBorder: DynamicBorder;
	private readonly markdown: Markdown;
	private scrollOffset = 0;
	private lastContentLineCount = 0;
	private lastViewportHeight = 1;

	constructor(tui: TUI, theme: Theme, question: string, answer: string, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.title = sanitizeSingleLine(`/btw ${question}`);
		this.onClose = onClose;
		const borderColor = (text: string) => this.theme.fg("warning", text);
		this.topBorder = new DynamicBorder(borderColor);
		this.bottomBorder = new DynamicBorder(borderColor);
		this.markdown = new Markdown(answer, 1, 1, getMarkdownTheme());
	}

	render(width: number): string[] {
		const viewportHeight = this.getViewportHeight();
		const contentLines = this.markdown.render(width);
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		this.clampScrollOffset();

		const visibleContent = contentLines.slice(
			this.scrollOffset,
			this.scrollOffset + viewportHeight,
		);

		return [
			...this.topBorder.render(width),
			this.renderTitle(width),
			...visibleContent,
			this.renderFooter(width),
			...this.bottomBorder.render(width),
		];
	}

	handleInput(data: string): void {
		if (this.matchesCloseKey(data)) {
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollBy(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollBy(1);
		} else if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.shift(Key.space)) ||
			matchesKey(data, Key.ctrl("b"))
		) {
			this.scrollBy(-this.lastViewportHeight);
		} else if (
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.space) ||
			matchesKey(data, Key.ctrl("f"))
		) {
			this.scrollBy(this.lastViewportHeight);
		} else if (matchesKey(data, Key.ctrl("u"))) {
			this.scrollBy(-this.getHalfPageHeight());
		} else if (matchesKey(data, Key.ctrl("d"))) {
			this.scrollBy(this.getHalfPageHeight());
		} else if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.scrollOffset = this.getMaxScrollOffset();
		}
	}

	invalidate(): void {
		this.topBorder.invalidate();
		this.bottomBorder.invalidate();
		this.markdown.invalidate();
	}

	private matchesCloseKey(data: string): boolean {
		return (
			matchesKey(data, "q") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.return) ||
			matchesKey(data, Key.ctrl("c"))
		);
	}

	private renderTitle(width: number): string {
		return truncateToWidth(this.theme.fg("warning", this.theme.bold(this.title)), width);
	}

	private renderFooter(width: number): string {
		const progress = this.formatProgress();
		const hints = "↑↓/j/k scroll • PgUp/PgDn page • Home/End jump • q/Esc close";
		const progressWidth = visibleWidth(progress);
		const footer =
			progressWidth + 3 >= width
				? truncateToWidth(progress, width)
				: `${truncateToWidth(hints, width - progressWidth - 3)} • ${progress}`;
		return this.theme.fg("dim", footer);
	}

	private formatProgress(): string {
		const total = this.lastContentLineCount;
		if (total === 0) return "100% 0-0/0";

		const maxScroll = this.getMaxScrollOffset();
		const percent = maxScroll === 0 ? 100 : Math.round((this.scrollOffset / maxScroll) * 100);
		const firstLine = this.scrollOffset + 1;
		const lastLine = Math.min(total, this.scrollOffset + this.lastViewportHeight);

		return `${percent}% ${firstLine}-${lastLine}/${total}`;
	}

	private scrollBy(delta: number): void {
		this.scrollOffset += delta;
		this.clampScrollOffset();
	}

	private clampScrollOffset(): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.getMaxScrollOffset()));
	}

	private getMaxScrollOffset(): number {
		return Math.max(0, this.lastContentLineCount - this.lastViewportHeight);
	}

	private getViewportHeight(): number {
		return Math.max(1, this.tui.terminal.rows - ANSWER_CHROME_LINES - ANSWER_RESERVED_APP_LINES);
	}

	private getHalfPageHeight(): number {
		return Math.max(1, Math.ceil(this.lastViewportHeight / 2));
	}
}

export function sanitizeSingleLine(text: string) {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/ +/g, " ")
		.trim();
}

export function buildUserPrompt(question: string, conversationContext: string) {
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

export function buildConversationContext(entries: readonly SessionEntry[]) {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const contentLines = extractContentLines(entry.message.content);
		if (contentLines.length === 0) continue;

		const label = role === "user" ? "User" : "Assistant";
		const status =
			entry.message.stopReason && entry.message.stopReason !== "stop"
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
