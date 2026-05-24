import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
const DEFAULT_ENDPOINT_RETRY_MS = 250;
const STATUS_KEY = "chrome-devtools";
const SETTINGS_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"pi-chrome-devtools-settings.json",
);
const CHROME_DEVTOOLS_TOOL_NAMES = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_evaluate",
	"chrome_devtools_screenshot",
] as const;
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "Show command usage" },
	{ value: "quickstart", label: "Show endpoint and launch help" },
	{ value: "status", label: "Show tool and settings status" },
	{ value: "tools", label: "Select Chrome DevTools tools" },
	{ value: "toggle", label: "Select Chrome DevTools tools" },
	{ value: "enable", label: "Enable all Chrome DevTools tools" },
	{ value: "disable", label: "Disable all Chrome DevTools tools" },
];
const MENU_OPTIONS = {
	quickstart: "Quick start / endpoint help",
	help: "Command usage guide",
	status: "Show tool status",
	tools: "Select Chrome DevTools tools",
	enable: "Enable all Chrome DevTools tools",
	disable: "Disable all Chrome DevTools tools",
} as const;
const TOOL_SELECTOR_DONE = "Done";
const TOOL_SELECTOR_ENABLE_ALL = "Enable all Chrome DevTools tools";
const TOOL_SELECTOR_DISABLE_ALL = "Disable all Chrome DevTools tools";

type ChromeDevToolsToolName = (typeof CHROME_DEVTOOLS_TOOL_NAMES)[number];
type ToolRuntimeStatus = "enabled" | "disabled" | "partial";
type CommandAction =
	| "menu"
	| "help"
	| "quickstart"
	| "status"
	| "tools"
	| "enable"
	| "disable";
type CommandContext = ExtensionCommandContext;
type ToolSelectorAction = "enableAll" | "disableAll" | "done";
type ToolSelectorRow =
	| { kind: "tool"; toolName: ChromeDevToolsToolName }
	| { kind: "action"; action: ToolSelectorAction; label: string };

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

interface RenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

interface RenderComponent {
	invalidate(): void;
	render(width: number): string[];
}

interface DevToolsPage {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

interface ChromeDevToolsState {
	host: string;
	port: number;
	activePageId?: string;
}

interface ChromeDevToolsSettings {
	tools: ChromeDevToolsToolName[];
	updatedAt: number;
}

interface ToolStatusSummary {
	runtimeStatus: ToolRuntimeStatus;
	activeChromeToolCount: number;
	activeNonChromeToolCount: number;
}

interface CdpResponse<T = unknown> {
	id: number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

const state: ChromeDevToolsState = {
	host: process.env.PI_CHROME_DEVTOOLS_HOST ?? DEFAULT_HOST,
	port: Number(process.env.PI_CHROME_DEVTOOLS_PORT ?? DEFAULT_PORT),
};

const listPagesTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[0],
	label: "Chrome DevTools: List Pages",
	description: "List Chrome tabs/pages from a running Chrome DevTools Protocol endpoint.",
	promptSnippet: "List Chrome tabs/pages available over Chrome DevTools Protocol",
	parameters: Type.Object({}),
	renderCall: renderToolCall("list pages"),
	renderResult: renderTextResult,
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 list pages", async () => {
			const pages = await listPages();
			return textResult(JSON.stringify(pages.map(formatPage), null, 2), { pages });
		});
	},
});

const selectPageTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[1],
	label: "Chrome DevTools: Select Page",
	description: "Select the active Chrome page for later chrome_devtools_* tool calls.",
	promptSnippet: "Select the Chrome tab/page to inspect or control",
	parameters: Type.Object({
		pageId: Type.String({ description: "Page id from chrome_devtools_list_pages." }),
	}),
	renderCall: renderToolCall("select page"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 select page", async () => {
			const page = await getPage(params.pageId);
			state.activePageId = page.id;
			return textResult(`Selected page ${page.id}: ${page.title}\n${page.url}`, {
				page: formatPage(page),
			});
		});
	},
});

const navigateTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[2],
	label: "Chrome DevTools: Navigate",
	description:
		"Navigate a Chrome page to a URL through Chrome DevTools Protocol, creating a page first if none is available.",
	promptSnippet: "Navigate the selected or first Chrome tab to a URL, creating one if needed",
	parameters: Type.Object({
		url: Type.String({ description: "URL to navigate to." }),
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
	}),
	renderCall: renderToolCall("navigate"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 navigate", async () => {
			const { created, page } = await resolvePageForNavigation(params.pageId);
			const result = await withCdp(page, async (client) => {
				await client.send("Page.enable");
				return client.send("Page.navigate", { url: params.url });
			});

			state.activePageId = page.id;
			const action = created ? "Created page and navigated" : "Navigated";
			return textResult(`${action} ${page.id} to ${params.url}`, {
				created,
				page: formatPage(page),
				result,
			});
		});
	},
});

const evaluateTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[3],
	label: "Chrome DevTools: Evaluate",
	description: "Evaluate JavaScript in a Chrome page through Chrome DevTools Protocol.",
	promptSnippet: "Evaluate JavaScript in the selected Chrome tab",
	parameters: Type.Object({
		expression: Type.String({ description: "JavaScript expression to evaluate." }),
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
		awaitPromise: Type.Optional(
			Type.Boolean({ description: "Whether to await a returned Promise. Defaults to true." }),
		),
	}),
	renderCall: renderToolCall("evaluate"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 evaluate", async () => {
			const page = await resolvePage(params.pageId);
			const result = await withCdp(page, (client) =>
				client.send("Runtime.evaluate", {
					expression: params.expression,
					awaitPromise: params.awaitPromise ?? true,
					returnByValue: true,
				}),
			);

			state.activePageId = page.id;
			return textResult(JSON.stringify(result, null, 2), { page: formatPage(page), result });
		});
	},
});

const screenshotTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[4],
	label: "Chrome DevTools: Screenshot",
	description: "Capture a PNG screenshot from a Chrome page through Chrome DevTools Protocol.",
	promptSnippet: "Capture a screenshot from the selected Chrome tab",
	parameters: Type.Object({
		pageId: Type.Optional(
			Type.String({ description: "Optional page id. Defaults to selected or first page." }),
		),
		fullPage: Type.Optional(
			Type.Boolean({ description: "Capture the full document, not just the viewport." }),
		),
	}),
	renderCall: renderToolCall("screenshot"),
	renderResult: renderScreenshotResult,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 screenshot", async () => {
			const page = await resolvePage(params.pageId);
			const result = await withCdp(page, async (client) => {
				await client.send("Page.enable");

				if (!params.fullPage) {
					return client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				}

				const metrics = await client.send<{
					contentSize: { x: number; y: number; width: number; height: number };
				}>("Page.getLayoutMetrics");

				return client.send<{ data: string }>("Page.captureScreenshot", {
					captureBeyondViewport: true,
					format: "png",
					clip: {
						x: metrics.contentSize.x,
						y: metrics.contentSize.y,
						width: metrics.contentSize.width,
						height: metrics.contentSize.height,
						scale: 1,
					},
				});
			});

			state.activePageId = page.id;
			return {
				content: [
					{ type: "text", text: `Captured PNG screenshot from ${page.title || page.url}` },
					{ type: "image", data: result.data, mimeType: "image/png" },
				],
				details: { page: formatPage(page), bytes: Buffer.byteLength(result.data, "base64") },
			};
		});
	},
});

export default function chromeDevtools(pi: ExtensionAPI) {
	pi.registerTool(listPagesTool);
	pi.registerTool(selectPageTool);
	pi.registerTool(navigateTool);
	pi.registerTool(evaluateTool);
	pi.registerTool(screenshotTool);

	pi.registerCommand("chrome-devtools", {
		description: "Open Chrome DevTools help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleChromeDevtoolsCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const settings = await loadSettings();
		if (settings.kind === "loaded") {
			applyChromeDevtoolsTools(pi, settings.settings.tools);
			return;
		}
		if (settings.kind === "invalid") {
			ctx.ui.notify(`Chrome DevTools settings ignored: ${settings.reason}`, "warning");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function handleChromeDevtoolsCommand(pi: ExtensionAPI, args: string, ctx: CommandContext) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "quickstart":
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case "status":
			ctx.ui.notify(await buildToolStatusMessage(pi), "info");
			return;
		case "tools":
			await showToolSelector(pi, ctx);
			return;
		case "enable":
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all");
			return;
		case "disable":
			await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
			return;
	}

	ctx.ui.notify(`Unknown /chrome-devtools command: ${args.trim()}

${buildCommandGuide()}`, "warning");
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${buildCommandGuide()}

${await buildToolStatusMessage(pi)}`, "info");
		return;
	}

	const choice = await ctx.ui.select("Chrome DevTools", Object.values(MENU_OPTIONS));
	switch (choice) {
		case MENU_OPTIONS.quickstart:
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case MENU_OPTIONS.help:
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case MENU_OPTIONS.status:
			ctx.ui.notify(await buildToolStatusMessage(pi), "info");
			return;
		case MENU_OPTIONS.tools:
			await showToolSelector(pi, ctx);
			return;
		case MENU_OPTIONS.enable:
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all");
			return;
		case MENU_OPTIONS.disable:
			await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
			return;
	}
}

function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

function commandCompletions(prefix: string) {
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
			`Chrome DevTools tool selection needs an interactive UI.

${await buildToolStatusMessage(pi)}`,
			"info",
		);
		return;
	}

	let selectedTools = new Set<ChromeDevToolsToolName>(getActiveChromeDevtoolsTools(pi));
	let persistQueue = Promise.resolve();
	const commitSelectedTools = () => {
		const nextSelectedTools = orderedChromeDevtoolsTools(selectedTools);
		applyChromeDevtoolsTools(pi, nextSelectedTools);
		persistQueue = persistQueue.then(() => persistSettings(ctx, nextSelectedTools));
	};

	const customResult = await ctx.ui.custom<"closed" | undefined>(
		(tui, theme, keybindings, done) => {
			const rows = chromeDevtoolsToolSelectorRows();
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
					selectedTools = new Set(allChromeDevtoolsTools());
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
	ctx.ui.notify(await buildToolStatusMessage(pi), "info");
}

async function showDialogToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	let selectedTools = new Set<ChromeDevToolsToolName>(getActiveChromeDevtoolsTools(pi));
	while (true) {
		const rows = chromeDevtoolsToolSelectorRows();
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
			selectedTools = new Set(allChromeDevtoolsTools());
		} else if (row.action === "disableAll") {
			selectedTools = new Set();
		}

		await setSelectedChromeDevtoolsTools(pi, ctx, orderedChromeDevtoolsTools(selectedTools));
	}

	ctx.ui.notify(await buildToolStatusMessage(pi), "info");
}

async function updateChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
	action: string,
) {
	await setSelectedChromeDevtoolsTools(pi, ctx, selectedTools);
	ctx.ui.notify(`Chrome DevTools tools ${action}.

${await buildToolStatusMessage(pi)}`, "info");
}

async function setSelectedChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
) {
	applyChromeDevtoolsTools(pi, selectedTools);
	await persistSettings(ctx, selectedTools);
}

function applyChromeDevtoolsTools(
	pi: ExtensionAPI,
	selectedTools: readonly ChromeDevToolsToolName[],
) {
	const activeToolNames = pi.getActiveTools();
	const chromeToolNames = new Set<string>(CHROME_DEVTOOLS_TOOL_NAMES);
	const activeNonChromeToolNames = activeToolNames.filter((name) => !chromeToolNames.has(name));
	pi.setActiveTools(unique([...activeNonChromeToolNames, ...selectedTools]));
}

function getToolStatusSummary(pi: ExtensionAPI): ToolStatusSummary {
	const chromeToolNames = new Set<string>(CHROME_DEVTOOLS_TOOL_NAMES);
	const activeToolNames = new Set(pi.getActiveTools());
	const activeChromeToolCount = CHROME_DEVTOOLS_TOOL_NAMES.filter((name) =>
		activeToolNames.has(name),
	).length;
	const activeNonChromeToolCount = Array.from(activeToolNames).filter(
		(name) => !chromeToolNames.has(name),
	).length;
	const runtimeStatus =
		activeChromeToolCount === CHROME_DEVTOOLS_TOOL_NAMES.length
			? "enabled"
			: activeChromeToolCount === 0
				? "disabled"
				: "partial";

	return { runtimeStatus, activeChromeToolCount, activeNonChromeToolCount };
}

async function buildToolStatusMessage(pi: ExtensionAPI) {
	const summary = getToolStatusSummary(pi);
	const persistedSetting = await persistedSettingLabel();
	return [
		`Chrome DevTools tools: ${formatRuntimeStatus(summary)}`,
		`Persisted selection: ${persistedSetting}`,
		`Settings file: ${SETTINGS_FILE}`,
		`Other active tools preserved: ${summary.activeNonChromeToolCount}`,
		`Endpoint: ${devToolsEndpoint()}`,
	].join("\n");
}

function buildQuickstartMessage() {
	return [
		`Chrome DevTools endpoint: ${devToolsEndpoint()}`,
		launchHint(),
		endpointConfigHint(),
	].join("\n");
}

function buildCommandGuide() {
	return [
		"Chrome DevTools commands:",
		"/chrome-devtools — open this menu",
		"/chrome-devtools help — show command usage",
		"/chrome-devtools quickstart — show endpoint and launch help",
		"/chrome-devtools status — show tool and settings status",
		"/chrome-devtools tools — select individual Chrome DevTools tools",
		"/chrome-devtools toggle — alias for /chrome-devtools tools",
		"/chrome-devtools enable — enable all Chrome DevTools tools",
		"/chrome-devtools disable — disable all Chrome DevTools tools",
	].join("\n");
}

function toolSelectorTitle(selectedTools: ReadonlySet<ChromeDevToolsToolName>) {
	return `Chrome DevTools tools (${selectedTools.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}). Non-built-in tools run at user risk.`;
}

function chromeDevtoolsToolSelectorRows(): ToolSelectorRow[] {
	return [
		...CHROME_DEVTOOLS_TOOL_NAMES.map((toolName) => ({ kind: "tool" as const, toolName })),
		{ kind: "action", action: "enableAll", label: TOOL_SELECTOR_ENABLE_ALL },
		{ kind: "action", action: "disableAll", label: TOOL_SELECTOR_DISABLE_ALL },
		{ kind: "action", action: "done", label: TOOL_SELECTOR_DONE },
	];
}

function formatToolSelectorRow(
	row: ToolSelectorRow,
	selectedTools: ReadonlySet<ChromeDevToolsToolName>,
) {
	if (row.kind === "action") return row.label;
	return `${selectedTools.has(row.toolName) ? "[x]" : "[ ]"} ${row.toolName}`;
}

function getActiveChromeDevtoolsTools(pi: ExtensionAPI) {
	const activeToolNames = new Set(pi.getActiveTools());
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => activeToolNames.has(toolName));
}

function allChromeDevtoolsTools() {
	return [...CHROME_DEVTOOLS_TOOL_NAMES];
}

function orderedChromeDevtoolsTools(selectedTools: ReadonlySet<ChromeDevToolsToolName>) {
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
	return `${summary.runtimeStatus} (${summary.activeChromeToolCount}/${CHROME_DEVTOOLS_TOOL_NAMES.length} active)`;
}

async function persistedSettingLabel() {
	const settings = await loadSettings();
	if (settings.kind === "loaded") return formatPersistedSelection(settings.settings.tools);
	if (settings.kind === "invalid") {
		return `none; current active-tool policy preserved (invalid settings ignored: ${settings.reason})`;
	}
	return "none; current active-tool policy preserved";
}

function formatPersistedSelection(tools: readonly ChromeDevToolsToolName[]) {
	if (tools.length === CHROME_DEVTOOLS_TOOL_NAMES.length) {
		return `all enabled (${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
	}
	if (tools.length === 0) return `all disabled (0/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
	return `${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

async function persistSettings(
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
) {
	try {
		await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
	} catch (error) {
		ctx.ui.notify(`Chrome DevTools settings save failed: ${formatError(error)}`, "warning");
	}
}

async function loadSettings(): Promise<
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: ChromeDevToolsSettings }
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
		const settings = normalizeChromeDevtoolsSettings(parsed);
		if (settings) return { kind: "loaded", settings };
		return { kind: "invalid", reason: "expected tools to be an array of Chrome DevTools tool names" };
	} catch (error) {
		return { kind: "invalid", reason: formatError(error) };
	}
}

function normalizeChromeDevtoolsSettings(value: unknown): ChromeDevToolsSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { tools?: unknown; updatedAt?: unknown };
	if (typeof settings.updatedAt !== "number") return undefined;

	if (settings.tools === "enabled") {
		return { tools: allChromeDevtoolsTools(), updatedAt: settings.updatedAt };
	}
	if (settings.tools === "disabled") return { tools: [], updatedAt: settings.updatedAt };

	if (!Array.isArray(settings.tools)) return undefined;
	if (!settings.tools.every(isChromeDevtoolsToolName)) return undefined;
	return { tools: orderedUniqueChromeDevtoolsTools(settings.tools), updatedAt: settings.updatedAt };
}

function isChromeDevtoolsToolName(value: unknown): value is ChromeDevToolsToolName {
	return typeof value === "string" && CHROME_DEVTOOLS_TOOL_NAMES.includes(value as never);
}

function orderedUniqueChromeDevtoolsTools(tools: readonly ChromeDevToolsToolName[]) {
	const selectedTools = new Set(tools);
	return orderedChromeDevtoolsTools(selectedTools);
}

async function saveSettings(settings: ChromeDevToolsSettings) {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true });
	const tempFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}
`, "utf8");
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

async function listPages(options: { waitMs?: number } = {}) {
	return withEndpointRetry(async () => {
		const pages = await fetchDevToolsJson<DevToolsPage[]>("/json/list");
		return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
	}, options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS);
}

async function getPage(pageId: string) {
	const pages = await listPages();
	return requirePage(pageId, pages);
}

async function resolvePage(pageId?: string) {
	const pages = await listPages();
	if (pageId) return requirePage(pageId, pages);

	const page = resolveDefaultPage(pages);
	if (!page) {
		throw new Error(
			[
				`No Chrome pages found at ${devToolsEndpoint()}.`,
				"Use chrome_devtools_navigate with a URL to create a page, or open a Chrome tab manually.",
				launchHint(),
			].join("\n"),
		);
	}

	return page;
}

async function resolvePageForNavigation(pageId?: string) {
	const pages = await listPages();
	if (pageId) return { created: false, page: requirePage(pageId, pages) };

	const page = resolveDefaultPage(pages);
	if (page) return { created: false, page };

	return { created: true, page: await createPage("about:blank") };
}

function resolveDefaultPage(pages: DevToolsPage[]) {
	if (!state.activePageId) return pages[0];

	const activePage = pages.find((candidate) => candidate.id === state.activePageId);
	if (activePage) return activePage;

	state.activePageId = undefined;
	return pages[0];
}

function requirePage(pageId: string, pages: DevToolsPage[]) {
	const page = pages.find((candidate) => candidate.id === pageId);
	if (page) return page;

	const availablePages = pages.map(formatPageListItem).join("\n");
	throw new Error(
		[
			`Chrome DevTools page not found: ${pageId}.`,
			availablePages
				? `Available pages:\n${availablePages}`
				: "No inspectable Chrome pages are currently available.",
		].join("\n"),
	);
}

async function createPage(url: string) {
	const page = await fetchDevToolsJson<DevToolsPage>(`/json/new?${encodeURIComponent(url)}`, {
		method: "PUT",
	});
	if (page.type !== "page" || !page.webSocketDebuggerUrl) {
		throw new Error("Chrome DevTools created a target that is not an inspectable page.");
	}

	return page;
}

async function fetchDevToolsJson<T>(path: string, init?: RequestInit) {
	const url = `${devToolsEndpoint()}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
		});
	} catch (error) {
		throw new DevToolsEndpointError(endpointConnectionErrorMessage(error), { retryable: true });
	}

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim();
		const suffix = body ? `: ${body.slice(0, 200)}` : "";
		throw new DevToolsEndpointError(
			[
				`Chrome DevTools endpoint ${url} returned ${response.status} ${response.statusText}${suffix}.`,
				endpointConfigHint(),
			].join("\n"),
			{ retryable: response.status === 429 || response.status >= 500 },
		);
	}

	return (await response.json()) as T;
}

async function withEndpointRetry<T>(operation: () => Promise<T>, waitMs: number) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableEndpointError(error)) throw error;

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw error;

			await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
		}
	}
}

function isRetryableEndpointError(error: unknown) {
	return error instanceof DevToolsEndpointError && error.retryable;
}

function endpointConnectionErrorMessage(error: unknown) {
	const reason = isTimeoutError(error) ? "request timed out" : "connection failed";
	return [
		`Cannot connect to Chrome DevTools endpoint at ${devToolsEndpoint()} (${reason}).`,
		launchHint(),
		endpointConfigHint(),
	].join("\n");
}

function isTimeoutError(error: unknown) {
	return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function devToolsEndpoint() {
	return `http://${state.host}:${state.port}`;
}

function launchHint() {
	return `Start Chrome with remote debugging enabled: ${chromeLaunchCommand()}`;
}

function chromeLaunchCommand() {
	const executable =
		process.platform === "darwin"
			? "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome"
			: process.platform === "win32"
				? "chrome.exe"
				: "google-chrome";
	const dataDir = process.platform === "win32" ? "%TEMP%\\pi-chrome-devtools" : "/tmp/pi-chrome-devtools";
	return `${executable} --remote-debugging-port=${state.port} --user-data-dir=${dataDir}`;
}

function endpointConfigHint() {
	return "Set PI_CHROME_DEVTOOLS_HOST and PI_CHROME_DEVTOOLS_PORT if Chrome uses a different endpoint.";
}

function formatPageListItem(page: DevToolsPage) {
	return `- ${page.id}: ${page.title || "(untitled)"} ${page.url}`;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class DevToolsEndpointError extends Error {
	readonly retryable: boolean;

	constructor(message: string, options: { retryable?: boolean } = {}) {
		super(message);
		this.name = "DevToolsEndpointError";
		this.retryable = options.retryable ?? false;
	}
}

function formatPage(page: DevToolsPage) {
	return {
		id: page.id,
		type: page.type,
		title: page.title,
		url: page.url,
	};
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function renderToolCall(action: string) {
	return () => new PiTextComponent(`Chrome DevTools: ${action}`);
}

function renderTextResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
) {
	const output = formatCollapsibleOutput(textContent(result), options);
	return new PiTextComponent(output.text, theme, output.color);
}

function renderScreenshotResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
): RenderComponent {
	const output = formatCollapsibleOutput(textContent(result), options);
	return new PiTextComponent(output.text, theme, output.color);
}

function textContent(result: AgentToolResult<unknown>) {
	return result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
}

function formatCollapsibleOutput(
	text: string,
	options: ToolRenderResultOptions,
): { text: string; color?: string } {
	if (options.isPartial) return { text: "Running...", color: "warning" };
	if (options.expanded) return { text, color: "toolOutput" };

	return { text: "" };
}

class PiTextComponent implements RenderComponent {
	constructor(
		private text = "",
		private readonly theme?: RenderTheme,
		private readonly color?: string,
	) {}

	setText(text: string) {
		this.text = text;
	}

	invalidate() {
		// Stateless renderer: no cached layout to invalidate.
	}

	render(width: number) {
		if (!this.text.trim()) return [];
		return this.text
			.replace(/\t/g, "   ")
			.split(/\r?\n/)
			.map((line) => {
				const truncatedLine = truncateLine(line, Math.max(1, width));
				return this.theme && this.color
					? this.theme.fg(this.color, truncatedLine)
					: truncatedLine;
			});
	}
}

function truncateLine(line: string, maxWidth: number) {
	return Array.from(line).slice(0, maxWidth).join("");
}

async function withStatus<T>(ctx: StatusContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function withCdp<T>(page: DevToolsPage, callback: (client: CdpClient) => Promise<T>) {
	if (!page.webSocketDebuggerUrl) throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);

	const client = await CdpClient.connect(page.webSocketDebuggerUrl);
	try {
		return await callback(client);
	} finally {
		client.close();
	}
}

class CdpClient {
	#nextId = 1;
	#pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	private readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const response = JSON.parse(String(event.data)) as CdpResponse;
			if (typeof response.id !== "number") return;

			const pending = this.#pending.get(response.id);
			if (!pending) return;

			clearTimeout(pending.timeout);
			this.#pending.delete(response.id);

			if (response.error) {
				pending.reject(new Error(`CDP error ${response.error.code}: ${response.error.message}`));
			} else {
				pending.resolve(response.result);
			}
		});

		socket.addEventListener("close", () => {
			this.rejectAll(new Error("Chrome DevTools WebSocket closed"));
		});

		socket.addEventListener("error", () => {
			this.rejectAll(new Error("Chrome DevTools WebSocket error"));
		});
	}

	static connect(url: string) {
		return new Promise<CdpClient>((resolve, reject) => {
			const socket = new WebSocket(url);
			const timeout = setTimeout(() => {
				socket.close();
				reject(new Error(`Timed out connecting to Chrome DevTools WebSocket: ${url}`));
			}, DEFAULT_TIMEOUT_MS);

			socket.addEventListener("open", () => {
				clearTimeout(timeout);
				resolve(new CdpClient(socket));
			});

			socket.addEventListener("error", () => {
				clearTimeout(timeout);
				reject(new Error(`Failed to connect to Chrome DevTools WebSocket: ${url}`));
			});
		});
	}

	send<T = unknown>(method: string, params?: Record<string, unknown>) {
		const id = this.#nextId;
		this.#nextId += 1;

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Timed out waiting for CDP response: ${method}`));
			}, DEFAULT_TIMEOUT_MS);

			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
			this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
		});
	}

	close() {
		this.socket.close();
	}

	private rejectAll(error: Error) {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.#pending.delete(id);
		}
	}
}
