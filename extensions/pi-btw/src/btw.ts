import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	completeSideThreadTurn,
	createSideThread,
	type SideQuestionAuth,
	type SideThread,
} from "./side-thread.js";
import { BtwTranscriptPager, type TranscriptPagerAction } from "./transcript-pager.js";

export {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	buildUserPrompt,
	completeSideQuestion,
	loadCompleteSimple,
} from "./side-thread.js";

const MAX_CONTEXT_CHARS = 40_000;
export const BTW_SETTINGS_FILE = "pi-btw.json";

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

interface BtwModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(
		model: Model<Api>,
	): Promise<
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

export interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
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
		const reference = parseBtwModelReference(settings.model);
		if (!reference) {
			warn?.(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
			return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn });
		}
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			warn?.(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider &&
					configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) return { model: configuredModel, auth };
				const reason = auth.ok ? "has no request credentials" : auth.error;
				warn?.(`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`);
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

function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return BTW_THINKING_LEVELS.includes(value as BtwThinkingLevel);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function btw(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}

			const settings = await loadSettingsForCommand(ctx);
			const resolution = await resolveBtwModelWithLoader(settings, ctx);
			if (resolution.kind === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (resolution.kind === "unavailable") {
				ctx.ui.notify("No available model for /btw", "error");
				return;
			}

			await runBtwThread({
				initialQuestion: question || undefined,
				selected: resolution.selected,
				thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
				ctx,
			});
		},
	});
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
	const settingsResult = await readBtwSettings();
	if (settingsResult.kind === "loaded") return settingsResult.settings;
	if (settingsResult.kind === "invalid") {
		ctx.ui.notify(`pi-btw settings ignored: ${settingsResult.reason}`, "warning");
	}
	return {};
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
		let settled = false;
		loader.onAbort = () => {
			if (settled) return;
			settled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!settled) ctx.ui.notify(message, "warning");
			},
		})
			.then((selected) => {
				if (settled) return;
				settled = true;
				done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				done({ kind: "unavailable" });
			});

		return loader;
	});
}

interface RunBtwThreadDependencies {
	ask?: typeof askThreadQuestion;
	interact?: typeof showThreadComposer;
}

interface RunBtwThreadOptions {
	initialQuestion?: string;
	selected: ResolvedBtwModel;
	thinkingLevel: BtwThinkingLevel;
	ctx: ExtensionCommandContext;
	dependencies?: RunBtwThreadDependencies;
}

export async function runBtwThread({
	initialQuestion,
	selected,
	thinkingLevel,
	ctx,
	dependencies = {},
}: RunBtwThreadOptions): Promise<void> {
	const ask = dependencies.ask ?? askThreadQuestion;
	const interact = dependencies.interact ?? showThreadComposer;
	const thread = createSideThread(buildConversationContext(ctx.sessionManager.getBranch()));
	let pendingQuestion = initialQuestion;

	while (true) {
		if (!pendingQuestion) {
			const action = await interact(thread, thread.turns.length > 0, ctx);
			if (action.kind === "close") return;
			pendingQuestion = action.question;
		}

		const result = await ask(thread, pendingQuestion, selected, thinkingLevel, ctx);
		if (result.kind === "aborted") {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (result.kind === "error") {
			thread.turns.push({
				kind: "error",
				question: pendingQuestion,
				answer: result.message,
			});
		}

		pendingQuestion = undefined;
	}
}

async function askThreadQuestion(
	thread: SideThread,
	question: string,
	selected: ResolvedBtwModel,
	thinkingLevel: BtwThinkingLevel,
	ctx: ExtensionCommandContext,
) {
	return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>(
		(tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				`Answering /btw with ${selected.model.provider}/${selected.model.id}...`,
			);
			let settled = false;
			loader.onAbort = () => {
				if (settled) return;
				settled = true;
				done({ kind: "aborted" });
			};
			completeSideThreadTurn({
				thread,
				question,
				model: selected.model,
				thinkingLevel,
				auth: selected.auth,
				signal: loader.signal,
			}).then((result) => {
				if (settled) return;
				settled = true;
				done(result);
			});
			return loader;
		},
	);
}

async function showThreadComposer(
	thread: SideThread,
	startAtBottom: boolean,
	ctx: ExtensionCommandContext,
): Promise<TranscriptPagerAction> {
	return ctx.ui.custom<TranscriptPagerAction>(
		(tui, theme, _keybindings, done) =>
			new BtwTranscriptPager(tui, theme, thread.turns, done, { startAtBottom }),
	);
}

export function sanitizeSingleLine(text: string) {
	return [...text.replace(/[\r\n\t]/g, " ")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ +/g, " ")
		.trim();
}

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
	if (typeof content === "string") return [content.trim()].filter(Boolean);
	if (!Array.isArray(content)) return [];

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
