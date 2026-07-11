import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";
// pi-ai 0.79 exports completeSimple from the root; 0.80 moved it to the compat subpath.
type CompleteSimpleFunction = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

function hasCompleteSimple(value: unknown): value is { completeSimple: CompleteSimpleFunction } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "completeSimple") === "function"
	);
}

type ModuleImporter = (moduleId: string) => Promise<unknown>;

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

const completeSimple = await loadCompleteSimple();
import {
	BorderedLoader,
	DynamicBorder,
	getAgentDir,
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
export const BTW_SETTINGS_FILE = "pi-btw.json";
export const BTW_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export interface BtwSettings {
	model?: string;
	thinkingLevel?: BtwThinkingLevel;
}

export type BtwSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: BtwSettings };

interface LoadBtwThinkingLevelOptions {
	settingsPath?: string;
	warn?: (message: string) => void;
}

interface SideQuestionAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

interface BtwModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

interface ResolveBtwModelOptions {
	settings: BtwSettings;
	currentModel: Model<Api> | undefined;
	modelRegistry: BtwModelRegistry;
	warn?: (message: string) => void;
}

interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
}

interface CompleteSideQuestionOptions {
	model: Model<Api>;
	question: string;
	conversationContext: string;
	thinkingLevel: BtwThinkingLevel;
	auth: SideQuestionAuth;
	signal?: AbortSignal;
	completeSimple?: CompleteSimpleFunction;
}

export function normalizeBtwSettings(value: unknown): BtwSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

	const settings: BtwSettings = {};
	if (Object.hasOwn(value, "model")) {
		const model = Reflect.get(value, "model");
		if (typeof model !== "string" || !parseBtwModelReference(model)) return undefined;
		settings.model = model;
	}
	if (Object.hasOwn(value, "thinkingLevel")) {
		const thinkingLevel = Reflect.get(value, "thinkingLevel");
		if (!isBtwThinkingLevel(thinkingLevel)) return undefined;
		settings.thinkingLevel = thinkingLevel;
	}
	return settings;
}

export function parseBtwModelReference(
	reference: string,
): { provider: string; modelId: string } | undefined {
	if (/\s/.test(reference)) return undefined;
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

export async function resolveBtwModel({
	settings,
	currentModel,
	modelRegistry,
	warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
	if (settings.model) {
		const fallback = currentModel
			? `${currentModel.provider}/${currentModel.id}`
			: "the current model";
		const reference = parseBtwModelReference(settings.model)!;
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			warn?.(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider && configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) return { model: configuredModel, auth };
				const reason = auth.ok ? "has no request credentials" : auth.error;
				warn?.(
					`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`,
				);
			} catch (error: unknown) {
				warn?.(
					`pi-btw model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`,
				);
			}
			if (sameAsCurrent) return undefined;
		}
	}

	if (!currentModel) return undefined;
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
		if (auth.ok && hasRequestAuth(auth)) return { model: currentModel, auth };
	} catch {
		// The caller reports the final lack of an available model.
	}
	return undefined;
}

function hasRequestAuth(auth: SideQuestionAuth): boolean {
	return Boolean(
		auth.apiKey ||
			(auth.headers && Object.keys(auth.headers).length > 0) ||
			(auth.env && Object.keys(auth.env).length > 0),
	);
}

export async function readBtwSettings(
	settingsPath = join(getAgentDir(), BTW_SETTINGS_FILE),
): Promise<BtwSettingsLoadResult> {
	let contents: string;
	try {
		contents = await readFile(settingsPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}

	try {
		const settings = normalizeBtwSettings(JSON.parse(contents) as unknown);
		if (settings) return { kind: "loaded", settings };
		return { kind: "invalid", reason: `${settingsPath}: invalid settings shape` };
	} catch (error: unknown) {
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}
}

export async function loadBtwThinkingLevel(
	currentThinkingLevel: BtwThinkingLevel,
	options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
	const settings = await readBtwSettings(options.settingsPath);
	if (settings.kind === "missing") return currentThinkingLevel;
	if (settings.kind === "loaded") {
		return settings.settings.thinkingLevel ?? currentThinkingLevel;
	}

	options.warn?.(
		`pi-btw settings ignored: ${settings.reason}; expected optional model "provider/model-id" and thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}". Using current Pi thinking level.`,
	);
	return currentThinkingLevel;
}

export async function completeSideQuestion({
	model,
	question,
	conversationContext,
	thinkingLevel,
	auth,
	signal,
	completeSimple: runCompleteSimple = completeSimple,
}: CompleteSideQuestionOptions): Promise<AssistantMessage> {
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
	const streamOptions: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
	};
	if (thinkingLevel !== "off") streamOptions.reasoning = thinkingLevel;

	return runCompleteSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, streamOptions);
}

function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return BTW_THINKING_LEVELS.includes(value as BtwThinkingLevel);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

			const settingsResult = await readBtwSettings();
			let settings: BtwSettings = {};
			if (settingsResult.kind === "loaded") {
				settings = settingsResult.settings;
			} else if (settingsResult.kind === "invalid") {
				ctx.ui.notify(`pi-btw settings ignored: ${settingsResult.reason}`, "warning");
			}

			const resolution = await resolveBtwModelWithLoader(settings, ctx);
			if (resolution.kind === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (resolution.kind === "unavailable") {
				ctx.ui.notify("No available model for /btw", "error");
				return;
			}

			const thinkingLevel = settings.thinkingLevel ?? pi.getThinkingLevel();
			const answer = await askSideQuestion(question, resolution.selected, thinkingLevel, ctx);
			if (answer === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await showAnswer(question, answer, ctx);
		},
	});
}

type ModelResolutionOutcome =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelWithLoader(
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
	return ctx.ui.custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
		let cancelled = false;
		loader.onAbort = () => {
			cancelled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!cancelled) ctx.ui.notify(message, "warning");
			},
		}).then((selected) => {
			if (cancelled) return;
			done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
		});

		return loader;
	});
}

async function askSideQuestion(
	question: string,
	selected: ResolvedBtwModel,
	thinkingLevel: BtwThinkingLevel,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Answering /btw with ${selected.model.provider}/${selected.model.id}...`,
		);
		loader.onAbort = () => done(undefined);

		const ask = async () => {
			const conversationContext = buildConversationContext(ctx.sessionManager.getBranch());
			const response = await completeSideQuestion({
				model: selected.model,
				question,
				conversationContext,
				thinkingLevel,
				auth: selected.auth,
				signal: loader.signal,
			});

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
