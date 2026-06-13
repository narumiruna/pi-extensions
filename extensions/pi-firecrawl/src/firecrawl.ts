import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_API_URL = "https://api.firecrawl.dev/v1";
const STATUS_KEY = "firecrawl";
const SETTINGS_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"pi-firecrawl-settings.json",
);
const FIRECRAWL_TOOL_NAMES = [
	"firecrawl_scrape",
	"firecrawl_crawl",
	"firecrawl_crawl_status",
	"firecrawl_map",
	"firecrawl_search",
] as const;
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "Show command usage" },
	{ value: "config", label: "Show configuration quick start" },
	{ value: "quickstart", label: "Show configuration quick start" },
	{ value: "status", label: "Show tool and settings status" },
	{ value: "tools", label: "Select Firecrawl tools" },
	{ value: "toggle", label: "Select Firecrawl tools" },
	{ value: "enable", label: "Enable all Firecrawl tools" },
	{ value: "disable", label: "Disable all Firecrawl tools" },
];
const MENU_OPTIONS = {
	config: "Configuration quick start",
	help: "Command usage guide",
	status: "Show tool status",
	tools: "Select Firecrawl tools",
	enable: "Enable all Firecrawl tools",
	disable: "Disable all Firecrawl tools",
} as const;
const TOOL_SELECTOR_DONE = "Done";
const TOOL_SELECTOR_ENABLE_ALL = "Enable all Firecrawl tools";
const TOOL_SELECTOR_DISABLE_ALL = "Disable all Firecrawl tools";

const StringArray = Type.Array(Type.String());

type FirecrawlToolName = (typeof FIRECRAWL_TOOL_NAMES)[number];
type ToolRuntimeStatus = "enabled" | "disabled" | "partial";
type CommandAction =
	| "menu"
	| "help"
	| "config"
	| "quickstart"
	| "status"
	| "tools"
	| "enable"
	| "disable";
type CommandContext = ExtensionCommandContext;
type ToolSelectorAction = "enableAll" | "disableAll" | "done";
type ToolSelectorRow =
	| { kind: "tool"; toolName: FirecrawlToolName }
	| { kind: "action"; action: ToolSelectorAction; label: string };

interface FirecrawlState {
	apiUrl: string;
}

interface FirecrawlSettings {
	tools: FirecrawlToolName[];
	updatedAt: number;
}

interface ToolStatusSummary {
	runtimeStatus: ToolRuntimeStatus;
	activeFirecrawlToolCount: number;
	activeNonFirecrawlToolCount: number;
}

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

const state: FirecrawlState = {
	apiUrl: normalizeApiUrl(process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL),
};

const scrapeTool = defineTool({
	name: FIRECRAWL_TOOL_NAMES[0],
	label: "Firecrawl: Scrape",
	description: "Scrape a single URL through Firecrawl and return requested formats.",
	promptSnippet: "Scrape a URL through Firecrawl",
	promptGuidelines: [
		"Use firecrawl_scrape when you need clean markdown, HTML, links, screenshots, or structured extraction for one URL.",
		"If FIRECRAWL_API_KEY is missing, report the configuration error instead of retrying repeatedly.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "URL to scrape." }),
		formats: Type.Optional(
			Type.Array(
				Type.String({
					description:
						"Requested Firecrawl output format, such as markdown, html, rawHtml, links, screenshot, or json.",
				}),
				{ description: "Firecrawl output formats. Defaults to Firecrawl's API default." },
			),
		),
		onlyMainContent: Type.Optional(
			Type.Boolean({ description: "Return only the main page content when supported." }),
		),
		includeTags: Type.Optional(StringArray),
		excludeTags: Type.Optional(StringArray),
		waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping." })),
		timeout: Type.Optional(
			Type.Number({ description: "Firecrawl request timeout in milliseconds." }),
		),
		mobile: Type.Optional(Type.Boolean({ description: "Use a mobile user agent when supported." })),
		skipTlsVerification: Type.Optional(
			Type.Boolean({ description: "Skip TLS certificate verification when supported." }),
		),
		removeBase64Images: Type.Optional(
			Type.Boolean({ description: "Remove base64 image data from the response when supported." }),
		),
		blockAds: Type.Optional(
			Type.Boolean({ description: "Block ads while scraping when supported." }),
		),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Additional HTTP headers Firecrawl should use while fetching the target URL.",
			}),
		),
		jsonOptions: Type.Optional(
			Type.Any({ description: "Firecrawl jsonOptions for structured extraction." }),
		),
		actions: Type.Optional(
			Type.Array(Type.Any(), {
				description: "Firecrawl browser actions to perform before scraping.",
			}),
		),
		location: Type.Optional(Type.Any({ description: "Firecrawl location options." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🔥 scrape", async () => {
			const payload = await firecrawlRequest("POST", "/scrape", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const crawlTool = defineTool({
	name: FIRECRAWL_TOOL_NAMES[1],
	label: "Firecrawl: Crawl",
	description: "Start a Firecrawl crawl job for a website.",
	promptSnippet: "Start a Firecrawl site crawl job",
	parameters: Type.Object({
		url: Type.String({ description: "Starting URL for the crawl." }),
		limit: Type.Optional(Type.Number({ description: "Maximum number of pages to crawl." })),
		maxDepth: Type.Optional(Type.Number({ description: "Maximum crawl depth when supported." })),
		includePaths: Type.Optional(
			Type.Array(Type.String(), { description: "URL path patterns to include." }),
		),
		excludePaths: Type.Optional(
			Type.Array(Type.String(), { description: "URL path patterns to exclude." }),
		),
		allowBackwardLinks: Type.Optional(
			Type.Boolean({ description: "Allow crawling backward links when supported." }),
		),
		allowExternalLinks: Type.Optional(
			Type.Boolean({ description: "Allow crawling external links when supported." }),
		),
		ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
		deduplicateSimilarURLs: Type.Optional(
			Type.Boolean({ description: "Deduplicate similar URLs when supported." }),
		),
		scrapeOptions: Type.Optional(
			Type.Any({ description: "Firecrawl scrapeOptions applied to crawled pages." }),
		),
		webhook: Type.Optional(Type.Any({ description: "Firecrawl webhook configuration." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🔥 crawl", async () => {
			const payload = await firecrawlRequest("POST", "/crawl", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const crawlStatusTool = defineTool({
	name: FIRECRAWL_TOOL_NAMES[2],
	label: "Firecrawl: Crawl Status",
	description: "Check a Firecrawl crawl job status and retrieve completed crawl data.",
	promptSnippet: "Check a Firecrawl crawl job status",
	parameters: Type.Object({
		id: Type.String({ description: "Crawl job id returned by firecrawl_crawl." }),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🔥 crawl status", async () => {
			const payload = await firecrawlRequest(
				"GET",
				`/crawl/${encodeURIComponent(params.id)}`,
				undefined,
				signal,
			);
			return jsonResult(payload);
		});
	},
});

const mapTool = defineTool({
	name: FIRECRAWL_TOOL_NAMES[3],
	label: "Firecrawl: Map",
	description: "Discover URLs for a site through Firecrawl's map endpoint.",
	promptSnippet: "Map/discover URLs for a site through Firecrawl",
	parameters: Type.Object({
		url: Type.String({ description: "Website URL to map." }),
		search: Type.Optional(
			Type.String({ description: "Optional search term to filter discovered URLs." }),
		),
		ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
		sitemapOnly: Type.Optional(
			Type.Boolean({ description: "Only use sitemap URLs when supported." }),
		),
		includeSubdomains: Type.Optional(
			Type.Boolean({ description: "Include subdomains when supported." }),
		),
		limit: Type.Optional(Type.Number({ description: "Maximum number of URLs to return." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🔥 map", async () => {
			const payload = await firecrawlRequest("POST", "/map", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const searchTool = defineTool({
	name: FIRECRAWL_TOOL_NAMES[4],
	label: "Firecrawl: Search",
	description: "Search the web through Firecrawl and optionally scrape search results.",
	promptSnippet: "Search the web through Firecrawl",
	parameters: Type.Object({
		query: Type.String({ description: "Search query." }),
		limit: Type.Optional(Type.Number({ description: "Maximum number of search results." })),
		tbs: Type.Optional(
			Type.String({ description: "Google-style time based search filter when supported." }),
		),
		location: Type.Optional(Type.String({ description: "Search location when supported." })),
		scrapeOptions: Type.Optional(
			Type.Any({ description: "Firecrawl scrapeOptions for search result pages." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🔥 search", async () => {
			const payload = await firecrawlRequest("POST", "/search", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

export default function firecrawl(pi: ExtensionAPI) {
	pi.registerTool(scrapeTool);
	pi.registerTool(crawlTool);
	pi.registerTool(crawlStatusTool);
	pi.registerTool(mapTool);
	pi.registerTool(searchTool);

	pi.registerCommand("firecrawl", {
		description: "Open Firecrawl help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleFirecrawlCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const settings = await loadSettings();
		if (settings.kind === "loaded") {
			applyFirecrawlTools(pi, settings.settings.tools);
			return;
		}
		if (settings.kind === "invalid") {
			ctx.ui.notify(`Firecrawl settings ignored: ${settings.reason}`, "warning");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function handleFirecrawlCommand(pi: ExtensionAPI, args: string, ctx: CommandContext) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "config":
		case "quickstart":
			ctx.ui.notify(buildConfigMessage(), hasApiKey() ? "info" : "warning");
			return;
		case "status":
			ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
			return;
		case "tools":
			await showToolSelector(pi, ctx);
			return;
		case "enable":
			await updateFirecrawlTools(pi, ctx, allFirecrawlTools(), "enabled all");
			return;
		case "disable":
			await updateFirecrawlTools(pi, ctx, [], "disabled all");
			return;
	}

	ctx.ui.notify(`Unknown /firecrawl command: ${args.trim()}\n\n${buildCommandGuide()}`, "warning");
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${buildCommandGuide()}\n\n${await buildStatusMessage(pi)}`, hasApiKey() ? "info" : "warning");
		return;
	}

	const choice = await ctx.ui.select("Firecrawl", Object.values(MENU_OPTIONS));
	switch (choice) {
		case MENU_OPTIONS.config:
			ctx.ui.notify(buildConfigMessage(), hasApiKey() ? "info" : "warning");
			return;
		case MENU_OPTIONS.help:
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case MENU_OPTIONS.status:
			ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
			return;
		case MENU_OPTIONS.tools:
			await showToolSelector(pi, ctx);
			return;
		case MENU_OPTIONS.enable:
			await updateFirecrawlTools(pi, ctx, allFirecrawlTools(), "enabled all");
			return;
		case MENU_OPTIONS.disable:
			await updateFirecrawlTools(pi, ctx, [], "disabled all");
			return;
	}
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "config") return "config";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trim().toLowerCase();
	if (normalized.includes(" ")) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) =>
		completion.value.startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Firecrawl tool selection needs an interactive UI.\n\n${await buildStatusMessage(pi)}`,
			hasApiKey() ? "info" : "warning",
		);
		return;
	}

	let selectedTools = new Set<FirecrawlToolName>(getActiveFirecrawlTools(pi));
	let persistQueue = Promise.resolve();
	const commitSelectedTools = () => {
		const nextSelectedTools = orderedFirecrawlTools(selectedTools);
		applyFirecrawlTools(pi, nextSelectedTools);
		persistQueue = persistQueue.then(() => persistSettings(ctx, nextSelectedTools));
	};

	const customResult = await ctx.ui.custom<"closed" | undefined>(
		(tui, theme, keybindings, done) => {
			const rows = firecrawlToolSelectorRows();
			let selectedIndex = 0;
			const moveSelection = (delta: number) => {
				selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
			};
			const activateSelectedRow = () => {
				const row = rows[selectedIndex];
				if (!row) return;

				if (row.kind === "tool") {
					if (selectedTools.has(row.toolName)) selectedTools.delete(row.toolName);
					else selectedTools.add(row.toolName);
					commitSelectedTools();
					return;
				}

				if (row.action === "enableAll") {
					selectedTools = new Set(allFirecrawlTools());
					commitSelectedTools();
					return;
				}
				if (row.action === "disableAll") {
					selectedTools = new Set();
					commitSelectedTools();
					return;
				}

				done("closed");
			};

			return {
				invalidate() {},
				render() {
					return [
						theme.fg("accent", theme.bold(toolSelectorTitle(selectedTools))),
						"",
						...rows.map((row, index) => {
							const label = formatToolSelectorRow(row, selectedTools);
							if (index === selectedIndex) {
								return `${theme.fg("accent", "›")} ${theme.fg("accent", label)}`;
							}
							return `  ${label}`;
						}),
						"",
						theme.fg("dim", "↑↓ navigate • Enter/Space toggle • Esc close"),
					];
				},
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.up")) {
						moveSelection(-1);
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						moveSelection(1);
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageUp")) {
						selectedIndex = 0;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageDown")) {
						selectedIndex = rows.length - 1;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
						activateSelectedRow();
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) {
						done("closed");
					}
				},
			};
		},
	);

	if (customResult !== "closed") {
		await showDialogToolSelector(pi, ctx);
		return;
	}

	await persistQueue;
	ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
}

async function showDialogToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	let selectedTools = new Set<FirecrawlToolName>(getActiveFirecrawlTools(pi));
	while (true) {
		const rows = firecrawlToolSelectorRows();
		const choices = rows.map((row) => formatToolSelectorRow(row, selectedTools));
		const choice = await ctx.ui.select(toolSelectorTitle(selectedTools), choices);
		if (!choice) break;

		const row = rows[choices.indexOf(choice)];
		if (!row) continue;
		if (row.kind === "action" && row.action === "done") break;

		if (row.kind === "tool") {
			if (selectedTools.has(row.toolName)) selectedTools.delete(row.toolName);
			else selectedTools.add(row.toolName);
		} else if (row.action === "enableAll") {
			selectedTools = new Set(allFirecrawlTools());
		} else if (row.action === "disableAll") {
			selectedTools = new Set();
		}

		await setSelectedFirecrawlTools(pi, ctx, orderedFirecrawlTools(selectedTools));
	}

	ctx.ui.notify(await buildStatusMessage(pi), hasApiKey() ? "info" : "warning");
}

async function updateFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
	action: string,
) {
	await setSelectedFirecrawlTools(pi, ctx, selectedTools);
	ctx.ui.notify(
		`Firecrawl tools ${action}.\n\n${await buildStatusMessage(pi)}`,
		hasApiKey() ? "info" : "warning",
	);
}

async function setSelectedFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
) {
	applyFirecrawlTools(pi, selectedTools);
	await persistSettings(ctx, selectedTools);
}

function applyFirecrawlTools(pi: ExtensionAPI, selectedTools: readonly FirecrawlToolName[]) {
	const activeToolNames = pi.getActiveTools();
	const firecrawlToolNames = new Set<string>(FIRECRAWL_TOOL_NAMES);
	const activeNonFirecrawlToolNames = activeToolNames.filter(
		(name) => !firecrawlToolNames.has(name),
	);
	pi.setActiveTools(unique([...activeNonFirecrawlToolNames, ...selectedTools]));
}

function getToolStatusSummary(pi: ExtensionAPI): ToolStatusSummary {
	const firecrawlToolNames = new Set<string>(FIRECRAWL_TOOL_NAMES);
	const activeToolNames = new Set(pi.getActiveTools());
	const activeFirecrawlToolCount = FIRECRAWL_TOOL_NAMES.filter((name) =>
		activeToolNames.has(name),
	).length;
	const activeNonFirecrawlToolCount = Array.from(activeToolNames).filter(
		(name) => !firecrawlToolNames.has(name),
	).length;
	const runtimeStatus =
		activeFirecrawlToolCount === FIRECRAWL_TOOL_NAMES.length
			? "enabled"
			: activeFirecrawlToolCount === 0
				? "disabled"
				: "partial";

	return { runtimeStatus, activeFirecrawlToolCount, activeNonFirecrawlToolCount };
}

async function buildStatusMessage(pi: ExtensionAPI) {
	const summary = getToolStatusSummary(pi);
	const persistedSetting = await persistedSettingLabel();
	return [
		`Firecrawl tools: ${formatRuntimeStatus(summary)}`,
		`Persisted selection: ${persistedSetting}`,
		`Settings file: ${SETTINGS_FILE}`,
		`Other active tools preserved: ${summary.activeNonFirecrawlToolCount}`,
		`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
		`API URL: ${state.apiUrl}`,
	].join("\n");
}

function buildConfigMessage() {
	return [
		"Firecrawl configuration:",
		`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
		`API URL: ${state.apiUrl}`,
		"Override API URL with FIRECRAWL_API_URL or FIRECRAWL_BASE_URL.",
		"This extension never logs, displays, or stores your Firecrawl API key.",
	].join("\n");
}

function buildCommandGuide() {
	return [
		"Firecrawl commands:",
		"/firecrawl — open this menu",
		"/firecrawl help — show command usage",
		"/firecrawl config — show API key presence and API URL",
		"/firecrawl quickstart — alias for /firecrawl config",
		"/firecrawl status — show tool and settings status",
		"/firecrawl tools — select individual Firecrawl tools",
		"/firecrawl toggle — alias for /firecrawl tools",
		"/firecrawl enable — enable all Firecrawl tools",
		"/firecrawl disable — disable all Firecrawl tools",
	].join("\n");
}

function toolSelectorTitle(selectedTools: ReadonlySet<FirecrawlToolName>) {
	return `Firecrawl tools (${selectedTools.size}/${FIRECRAWL_TOOL_NAMES.length}). Non-built-in tools run at user risk.`;
}

function firecrawlToolSelectorRows(): ToolSelectorRow[] {
	return [
		...FIRECRAWL_TOOL_NAMES.map((toolName) => ({ kind: "tool" as const, toolName })),
		{ kind: "action", action: "enableAll", label: TOOL_SELECTOR_ENABLE_ALL },
		{ kind: "action", action: "disableAll", label: TOOL_SELECTOR_DISABLE_ALL },
		{ kind: "action", action: "done", label: TOOL_SELECTOR_DONE },
	];
}

function formatToolSelectorRow(
	row: ToolSelectorRow,
	selectedTools: ReadonlySet<FirecrawlToolName>,
) {
	if (row.kind === "action") return row.label;
	return `${selectedTools.has(row.toolName) ? "[x]" : "[ ]"} ${row.toolName}`;
}

function getActiveFirecrawlTools(pi: ExtensionAPI) {
	const activeToolNames = new Set(pi.getActiveTools());
	return FIRECRAWL_TOOL_NAMES.filter((toolName) => activeToolNames.has(toolName));
}

function allFirecrawlTools() {
	return [...FIRECRAWL_TOOL_NAMES];
}

export function orderedFirecrawlTools(selectedTools: ReadonlySet<FirecrawlToolName>) {
	return FIRECRAWL_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
	return `${summary.runtimeStatus} (${summary.activeFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length} active)`;
}

async function persistedSettingLabel() {
	const settings = await loadSettings();
	if (settings.kind === "loaded") return formatPersistedSelection(settings.settings.tools);
	if (settings.kind === "invalid") {
		return `none; current active-tool policy preserved (invalid settings ignored: ${settings.reason})`;
	}
	return "none; current active-tool policy preserved";
}

export function formatPersistedSelection(tools: readonly FirecrawlToolName[]) {
	if (tools.length === FIRECRAWL_TOOL_NAMES.length) {
		return `all enabled (${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected)`;
	}
	if (tools.length === 0) return `all disabled (0/${FIRECRAWL_TOOL_NAMES.length} selected)`;
	return `${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

async function persistSettings(
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
) {
	try {
		await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
	} catch (error) {
		ctx.ui.notify(`Firecrawl settings save failed: ${formatError(error)}`, "warning");
	}
}

async function loadSettings(): Promise<
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: FirecrawlSettings }
> {
	let text: string;
	try {
		text = await readFile(SETTINGS_FILE, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: formatError(error) };
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const settings = normalizeFirecrawlSettings(parsed);
		if (settings) return { kind: "loaded", settings };
		return { kind: "invalid", reason: "expected tools to be an array of Firecrawl tool names" };
	} catch (error) {
		return { kind: "invalid", reason: formatError(error) };
	}
}

export function normalizeFirecrawlSettings(value: unknown): FirecrawlSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { tools?: unknown; updatedAt?: unknown };
	if (typeof settings.updatedAt !== "number") return undefined;
	if (!Array.isArray(settings.tools)) return undefined;
	if (!settings.tools.every(isFirecrawlToolName)) return undefined;
	return { tools: orderedUniqueFirecrawlTools(settings.tools), updatedAt: settings.updatedAt };
}

function isFirecrawlToolName(value: unknown): value is FirecrawlToolName {
	return typeof value === "string" && FIRECRAWL_TOOL_NAMES.includes(value as never);
}

function orderedUniqueFirecrawlTools(tools: readonly FirecrawlToolName[]) {
	const selectedTools = new Set(tools);
	return orderedFirecrawlTools(selectedTools);
}

async function saveSettings(settings: FirecrawlSettings) {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true });
	const tempFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await rename(tempFile, SETTINGS_FILE);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

async function firecrawlRequest(
	method: "GET" | "POST",
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
) {
	const apiKey = getApiKey();
	const response = await fetch(`${state.apiUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});

	const responseText = await response.text();
	const payload = parseResponseBody(responseText);

	if (!response.ok) {
		throw new Error(
			`Firecrawl ${method} ${path} returned ${response.status} ${response.statusText}: ${formatPayload(payload)}`,
		);
	}

	return payload;
}

function getApiKey() {
	const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"FIRECRAWL_API_KEY is required for pi-firecrawl. Set it in the environment before running pi.",
		);
	}

	return apiKey;
}

function hasApiKey() {
	return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}

export function normalizeApiUrl(apiUrl: string | undefined) {
	return (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function parseResponseBody(responseText: string) {
	if (!responseText) return null;

	try {
		return JSON.parse(responseText) as unknown;
	} catch {
		return responseText;
	}
}

export function formatPayload(payload: unknown) {
	if (typeof payload === "string") return payload;
	return JSON.stringify(payload);
}

export function jsonResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

async function withStatus<T>(ctx: StatusContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export function cleanObject<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => cleanObject(item)) as T;
	}

	if (!value || typeof value !== "object") return value;

	const entries = Object.entries(value)
		.filter(([, entryValue]) => entryValue !== undefined)
		.map(([entryKey, entryValue]) => [entryKey, cleanObject(entryValue)]);

	return Object.fromEntries(entries) as T;
}
