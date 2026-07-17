import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { lexer, type Token, type Tokens } from "marked";
import {
	type LoadedTelegraphConfig,
	loadTelegraphConfig,
	orderedTelegraphTools,
	saveTelegraphSetup,
	saveTelegraphToolSelection,
	TELEGRAPH_TOOL_NAMES,
	type TelegraphToolName,
} from "./config.js";
import { MAX_MARKDOWN_BYTES } from "./content.js";
import { cleanupTemporaryOutputs } from "./outputs.js";
import {
	clearTelegraphStatus,
	createPageTool,
	editPageTool,
	executeCreatePage,
	getPageTool,
} from "./tools.js";

const TOOL_SELECTOR_ENABLE_ALL = "Enable all Telegraph tools";
const TOOL_SELECTOR_DISABLE_ALL = "Disable all Telegraph tools";
const TOOL_SELECTOR_DONE = "Done";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

interface MarkdownPublicationFile {
	title: string;
	markdown: string;
}

const COMMAND_COMPLETIONS = [
	{ value: "status", label: "status", description: "Show Telegraph config and tool status" },
	{ value: "init", label: "init", description: "Set non-secret Telegraph account defaults" },
	{ value: "tools", label: "tools", description: "Select Telegraph tools" },
	{ value: "enable", label: "enable", description: "Enable all Telegraph tools" },
	{ value: "disable", label: "disable", description: "Disable all Telegraph tools" },
	{ value: "create", label: "create", description: "Publish a Markdown file" },
	{ value: "help", label: "help", description: "Show Telegraph usage and safety guidance" },
];

type CommandAction =
	| { action: "status" | "init" | "tools" | "enable" | "disable" | "help" | "unknown" }
	| { action: "create"; filePath: string };

export default function telegraph(pi: ExtensionAPI) {
	pi.registerTool(createPageTool);
	pi.registerTool(getPageTool);
	pi.registerTool(editPageTool);

	pi.registerCommand("telegraph", {
		description: "Configure Telegraph, select tools, or publish a Markdown file",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await handleCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearTelegraphStatus(ctx);
		applyTelegraphTools(pi, []);
		try {
			const loaded = await loadTelegraphConfig();
			applyTelegraphTools(pi, loaded.config.tools);
		} catch (error) {
			ctx.ui.notify(`Telegraph config ignored: ${formatError(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTelegraphStatus(ctx);
		await cleanupTemporaryOutputs(ctx.sessionManager);
	});
}

export function parseCommand(rawArgs: string): CommandAction {
	const trimmed = rawArgs.trim();
	if (!trimmed) return { action: "status" };
	const separator = trimmed.search(/\s/u);
	const command = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
	const remainder = separator < 0 ? "" : trimmed.slice(separator).trim();
	if (command === "status" || command === "config") return { action: "status" };
	if (command === "init" || command === "setup") return { action: "init" };
	if (command === "tools" || command === "select" || command === "toggle") {
		return { action: "tools" };
	}
	if (command === "enable" || command === "on") return { action: "enable" };
	if (command === "disable" || command === "off") return { action: "disable" };
	if (command === "create") return { action: "create", filePath: removeMatchingQuotes(remainder) };
	if (command === "help") return { action: "help" };
	return { action: "unknown" };
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/u.test(normalized)) return null;
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}

export function buildStatusMessage(pi: ExtensionAPI, loaded: LoadedTelegraphConfig) {
	const activeTools = activeTelegraphTools(pi);
	const persistedTools = loaded.config.tools;
	return [
		"Telegraph status:",
		`runtime tools: ${formatToolSelection(activeTools)} (${activeTools.length}/${TELEGRAPH_TOOL_NAMES.length} active)`,
		`persisted tools: ${formatToolSelection(persistedTools)}`,
		`other active tools: ${activeNonTelegraphToolCount(pi)}`,
		`path: ${loaded.path}`,
		`config file: ${loaded.exists ? "present" : "not created"}`,
		`account token: ${loaded.config.accessToken ? "configured" : "not configured (created lazily on first confirmed publish)"}`,
		`short name: ${loaded.config.shortName}`,
		`default author: ${loaded.config.authorName ?? "not set"}`,
		`default author URL: ${loaded.config.authorUrl ?? "not set"}`,
		`outside workspace file access: ${loaded.config.allowFilesOutsideWorkspace ? "enabled" : "disabled"}`,
	].join("\n");
}

async function handleCommand(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext) {
	const command = parseCommand(rawArgs);
	switch (command.action) {
		case "status":
			await showStatus(pi, ctx);
			return;
		case "init":
			await initializeConfig(ctx);
			return;
		case "tools":
			await showTelegraphToolSelector(pi, ctx);
			return;
		case "enable":
			await updateTelegraphTools(pi, ctx, allTelegraphTools(), "enabled all");
			return;
		case "disable":
			await updateTelegraphTools(pi, ctx, [], "disabled all");
			return;
		case "create":
			await publishMarkdownFile(command.filePath, ctx);
			return;
		case "help":
			ctx.ui.notify(helpText(), "info");
			return;
		case "unknown":
			ctx.ui.notify(helpText(), "warning");
			return;
	}
}

async function publishMarkdownFile(filePath: string, ctx: ExtensionCommandContext) {
	const ui = ctx.ui;
	const hasUI = ctx.hasUI;
	if (!filePath) {
		ui.notify("Usage: /telegraph create <file.md>", "warning");
		return;
	}
	if (!hasUI) {
		ui.notify("/telegraph create requires interactive UI for public confirmation.", "warning");
		return;
	}
	const cwd = ctx.cwd;
	const signal = ctx.signal;

	try {
		const loaded = await loadTelegraphConfig();
		const file = await loadMarkdownPublicationFile(
			filePath,
			cwd,
			loaded.config.allowFilesOutsideWorkspace,
		);
		const result = await executeCreatePage({ title: file.title, markdown: file.markdown }, signal, {
			hasUI,
			ui,
		});
		ui.notify(
			result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
			"info",
		);
	} catch (error) {
		ui.notify(`Unable to publish Telegraph file: ${formatError(error)}`, "error");
	}
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	try {
		ctx.ui.notify(buildStatusMessage(pi, await loadTelegraphConfig()), "info");
	} catch (error) {
		ctx.ui.notify(`Unable to load Telegraph config: ${formatError(error)}`, "warning");
	}
}

async function initializeConfig(ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/telegraph init requires interactive UI. Create pi-telegraph.json manually using /telegraph help guidance.",
			"warning",
		);
		return;
	}
	let loaded: LoadedTelegraphConfig;
	try {
		loaded = await loadTelegraphConfig();
	} catch (error) {
		ctx.ui.notify(`Unable to load Telegraph config: ${formatError(error)}`, "error");
		return;
	}
	const shortName = await ctx.ui.input("Telegraph account short name:", loaded.config.shortName);
	if (shortName === undefined) return notifyCancelled(ctx);
	const authorName = await ctx.ui.input(
		"Default author name (blank for none):",
		loaded.config.authorName ?? "",
	);
	if (authorName === undefined) return notifyCancelled(ctx);
	const authorUrl = await ctx.ui.input(
		"Default author URL (blank for none):",
		loaded.config.authorUrl ?? "",
	);
	if (authorUrl === undefined) return notifyCancelled(ctx);

	try {
		await saveTelegraphSetup({ shortName, authorName, authorUrl });
		const saved = await loadTelegraphConfig();
		ctx.ui.notify(
			`Saved non-secret Telegraph defaults to ${saved.path}. Account token: ${saved.config.accessToken ? "preserved" : "will be created on first confirmed publish"}.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Unable to save Telegraph config: ${formatError(error)}`, "error");
	}
}

function allTelegraphTools(): TelegraphToolName[] {
	return [...TELEGRAPH_TOOL_NAMES];
}

function applyTelegraphTools(pi: ExtensionAPI, selectedTools: readonly TelegraphToolName[]) {
	const telegraphTools = new Set<string>(TELEGRAPH_TOOL_NAMES);
	const unrelatedTools = pi.getActiveTools().filter((name) => !telegraphTools.has(name));
	pi.setActiveTools([...unrelatedTools, ...selectedTools]);
}

function activeTelegraphTools(pi: ExtensionAPI): TelegraphToolName[] {
	const active = new Set(pi.getActiveTools());
	return TELEGRAPH_TOOL_NAMES.filter((name) => active.has(name));
}

function activeNonTelegraphToolCount(pi: ExtensionAPI) {
	const telegraphTools = new Set<string>(TELEGRAPH_TOOL_NAMES);
	return pi.getActiveTools().filter((name) => !telegraphTools.has(name)).length;
}

async function setSelectedTelegraphTools(
	pi: ExtensionAPI,
	selectedTools: readonly TelegraphToolName[],
) {
	await saveTelegraphToolSelection(selectedTools);
	applyTelegraphTools(pi, selectedTools);
}

async function updateTelegraphTools(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selectedTools: readonly TelegraphToolName[],
	action: string,
) {
	const ui = ctx.ui;
	try {
		await setSelectedTelegraphTools(pi, selectedTools);
		ui.notify(`Telegraph tools ${action}.`, "info");
	} catch (error) {
		ui.notify(`Unable to update Telegraph tools: ${formatError(error)}`, "error");
	}
}

async function showTelegraphToolSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const ui = ctx.ui;
	if (!ctx.hasUI) {
		ui.notify("/telegraph tools requires interactive UI.", "warning");
		return;
	}

	let selected = new Set(activeTelegraphTools(pi));
	while (true) {
		const rows = [
			...TELEGRAPH_TOOL_NAMES.map((name) => `${selected.has(name) ? "[x]" : "[ ]"} ${name}`),
			TOOL_SELECTOR_ENABLE_ALL,
			TOOL_SELECTOR_DISABLE_ALL,
			TOOL_SELECTOR_DONE,
		];
		const choice = await ui.select(
			`Telegraph tools (${selected.size}/${TELEGRAPH_TOOL_NAMES.length})`,
			rows,
		);
		if (!choice || choice === TOOL_SELECTOR_DONE) return;

		let next = new Set(selected);
		if (choice === TOOL_SELECTOR_ENABLE_ALL) {
			next = new Set(allTelegraphTools());
		} else if (choice === TOOL_SELECTOR_DISABLE_ALL) {
			next = new Set();
		} else {
			const toolName = TELEGRAPH_TOOL_NAMES.find((name) => choice.endsWith(` ${name}`));
			if (!toolName) continue;
			if (next.has(toolName)) next.delete(toolName);
			else next.add(toolName);
		}

		const ordered = orderedTelegraphTools(next);
		try {
			await setSelectedTelegraphTools(pi, ordered);
			selected = new Set(ordered);
		} catch (error) {
			ui.notify(`Unable to update Telegraph tools: ${formatError(error)}`, "error");
		}
	}
}

async function loadMarkdownPublicationFile(
	inputPath: string,
	cwd: string,
	allowFilesOutsideWorkspace: boolean,
): Promise<MarkdownPublicationFile> {
	if (!inputPath.trim()) throw new Error("Usage: /telegraph create <file.md>");
	const requestedPath = inputPath.trim();
	const extension = extname(requestedPath).toLowerCase();
	if (!MARKDOWN_EXTENSIONS.has(extension)) {
		throw new Error("Telegraph file publication requires a .md or .markdown file.");
	}
	if (
		!allowFilesOutsideWorkspace &&
		(isAbsolute(requestedPath) || hasParentTraversal(requestedPath))
	) {
		throw new Error(
			isAbsolute(requestedPath)
				? "Absolute Markdown paths are disabled; use a workspace-relative path."
				: "Markdown paths outside the workspace are disabled.",
		);
	}

	const workspace = await realpath(cwd);
	const candidate = resolve(cwd, requestedPath);
	let target: string;
	try {
		target = await realpath(candidate);
	} catch (error) {
		throw new Error(
			`Markdown file not found or unreadable: ${requestedPath}: ${formatError(error)}`,
		);
	}
	if (!allowFilesOutsideWorkspace && !isWithin(workspace, target)) {
		throw new Error(`Markdown file resolves outside the workspace: ${requestedPath}.`);
	}

	const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let contents: string;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Markdown path must be a regular file: ${requestedPath}.`);
		if (stats.size > MAX_MARKDOWN_BYTES) {
			throw new Error(`Markdown file is too large; maximum size is ${MAX_MARKDOWN_BYTES} bytes.`);
		}
		contents = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	if (Buffer.byteLength(contents) > MAX_MARKDOWN_BYTES) {
		throw new Error(`Markdown file is too large; maximum size is ${MAX_MARKDOWN_BYTES} bytes.`);
	}

	const normalizedContents = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
	let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(normalizedContents);
	} catch (error) {
		throw new Error(`Invalid YAML frontmatter in ${requestedPath}: ${formatError(error)}`);
	}
	if (!isPlainObject(parsed.frontmatter)) {
		throw new Error(`YAML frontmatter in ${requestedPath} must be an object.`);
	}
	const markdown = parsed.body;
	if (!markdown.trim()) throw new Error("Markdown file body is empty after removing frontmatter.");

	let title: string | undefined;
	if (Object.hasOwn(parsed.frontmatter, "title")) {
		const metadataTitle = parsed.frontmatter.title;
		if (typeof metadataTitle !== "string" || !metadataTitle.trim()) {
			throw new Error("Markdown frontmatter title must be a non-empty string.");
		}
		title = metadataTitle.trim();
	}
	title ??= firstH1Text(markdown);
	const requestedName = basename(candidate);
	title ??= requestedName.slice(0, requestedName.length - extname(requestedName).length);

	return { title, markdown };
}

function firstH1Text(markdown: string) {
	const heading = lexer(markdown).find(
		(token): token is Tokens.Heading => token.type === "heading" && token.depth === 1,
	);
	if (!heading) return undefined;
	const text = inlineTokensToPlainText(heading.tokens).replace(/\s+/gu, " ").trim();
	return text || undefined;
}

function inlineTokensToPlainText(tokens: Token[]): string {
	return tokens
		.map((token) => {
			if (token.type === "image") return (token as Tokens.Image).text;
			if (token.type === "br") return " ";
			const nested = (token as Token & { tokens?: Token[] }).tokens;
			if (nested) return inlineTokensToPlainText(nested);
			return "text" in token && typeof token.text === "string" ? token.text : "";
		})
		.join("");
}

function hasParentTraversal(filePath: string) {
	return filePath.split(/[\\/]+/u).includes("..");
}

function isWithin(root: string, target: string) {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifyCancelled(ctx: ExtensionCommandContext) {
	ctx.ui.notify("Telegraph setup cancelled.", "info");
}

function helpText() {
	return [
		"Telegraph commands:",
		"/telegraph status - show redacted config and tool status",
		"/telegraph init - set shortName and optional author defaults without prompting for secrets",
		"/telegraph tools - select individual agent tools",
		"/telegraph enable - enable all Telegraph agent tools",
		"/telegraph disable - disable all Telegraph agent tools",
		"/telegraph create <file.md> - publish a Markdown file after confirmation",
		"/telegraph help - show this guide",
		"",
		"Agent tools are disabled by default. Set pi-telegraph.json tools to a subset of telegraph_create_page, telegraph_get_page, and telegraph_edit_page, or use /telegraph tools.",
		"File titles use YAML frontmatter title, then the first H1, then the filename; frontmatter is removed and the H1 is preserved.",
		"File paths stay inside the current workspace unless pi-telegraph.json sets allowFilesOutsideWorkspace to true.",
		"Create/edit publish public content and require confirmation. Telegraph has no delete API.",
		"An account is created lazily on the first confirmed publish. To import an existing account, add its literal accessToken to the private pi-telegraph.json file; no Telegraph-specific environment variables are used.",
	].join("\n");
}

function formatToolSelection(tools: readonly string[]) {
	if (tools.length === 0) return "disabled";
	if (tools.length === TELEGRAPH_TOOL_NAMES.length) return "all enabled";
	return tools.join(", ");
}

function removeMatchingQuotes(value: string) {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value.at(-1);
	return (first === '"' || first === "'") && first === last ? value.slice(1, -1) : value;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export { normalizeTelegraphPath } from "./tools.js";
