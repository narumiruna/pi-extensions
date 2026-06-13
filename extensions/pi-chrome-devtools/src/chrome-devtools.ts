import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolRenderResultOptions,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
const DEFAULT_ENDPOINT_RETRY_MS = 250;
const MANAGED_BROWSER_PROFILE_PREFIX = "pi-chrome-devtools-profile-";
const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
const BROWSER_SHUTDOWN_WAIT_MS = 1_500;
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
type BrowserCandidateSource = "env" | "path" | "wellKnownPath";
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
	configuredPort: number;
	hostConfigured: boolean;
	portConfigured: boolean;
	autoLaunchEnabled: boolean;
	browserExecutable?: string;
	activePageId?: string;
	managedBrowser?: ManagedBrowser;
	launchPromise?: Promise<void>;
	lastLaunchAttempt?: BrowserLaunchAttempt;
	shuttingDown: boolean;
}

interface ManagedBrowser {
	process: ChildProcess;
	userDataDir: string;
	port?: number;
	exited: boolean;
	ready: boolean;
}

interface BrowserLaunchAttempt {
	candidateLabels: string[];
	mode: "dynamic-port" | "explicit-port";
	selectedCandidate?: string;
	userDataDir?: string;
	lastError?: string;
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

interface ResolvedScreenshotPath {
	path: string;
	allowedRoots: string[];
	isDefault: boolean;
}

interface ScreenshotSaveResult {
	savedPath: string;
	bytes: number;
	isDefaultPath: boolean;
}

interface BrowserCandidateDefinition {
	label: string;
	executable: string;
	source: BrowserCandidateSource;
}

interface BrowserCandidate extends BrowserCandidateDefinition {
	resolvedExecutable: string;
}

const configuredHost = process.env.PI_CHROME_DEVTOOLS_HOST ?? DEFAULT_HOST;
const configuredPortOverride = parseConfiguredPort(process.env.PI_CHROME_DEVTOOLS_PORT);
const configuredPort = configuredPortOverride ?? DEFAULT_PORT;

const state: ChromeDevToolsState = {
	host: configuredHost,
	port: configuredPort,
	configuredPort,
	hostConfigured: process.env.PI_CHROME_DEVTOOLS_HOST !== undefined,
	portConfigured: configuredPortOverride !== undefined,
	autoLaunchEnabled: process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH !== "0",
	browserExecutable: process.env.PI_CHROME_DEVTOOLS_BROWSER,
	shuttingDown: false,
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
		savePath: Type.Optional(
			Type.String({
				description:
					"Screenshot is always saved as a PNG file. Optional output path; omitted defaults to a unique temp file. Relative paths resolve from the current working directory. A single leading @ is stripped to match Pi file-mention paths. Existing regular files are replaced.",
			}),
		),
	}),
	renderCall: renderToolCall("screenshot"),
	renderResult: renderScreenshotResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🌐 screenshot", async () => {
			const page = await resolvePage(params.pageId);
			const result = await withCdp(page, async (client) => {
				throwIfAborted(signal);
				await client.send("Page.enable");

				if (!params.fullPage) {
					return client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				}

				const metrics = await client.send<{
					contentSize: { x: number; y: number; width: number; height: number };
				}>("Page.getLayoutMetrics");

				throwIfAborted(signal);
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
			const savedScreenshot = await saveScreenshot(result.data, params.savePath, ctx.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text: formatScreenshotText(page, savedScreenshot),
					},
					{ type: "image", data: result.data, mimeType: "image/png" },
				],
				details: {
					page: formatPage(page),
					bytes: savedScreenshot.bytes,
					savedPath: savedScreenshot.savedPath,
					isDefaultPath: savedScreenshot.isDefaultPath,
				},
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
		state.shuttingDown = false;
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

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await shutdownManagedBrowser(undefined, { cancelLaunch: true });
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

export function parseCommand(args: string): CommandAction | "unknown" {
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
		`Endpoint source: ${endpointSourceLabel()}`,
		`Launch mode: ${launchModeLabel()}`,
		...launchAttemptLines(),
	].join("\n");
}

function buildQuickstartMessage() {
	return [
		`Chrome DevTools endpoint: ${devToolsEndpoint()}`,
		`Endpoint source: ${endpointSourceLabel()}`,
		`Launch mode: ${launchModeLabel()}`,
		launchHint(),
		browserCandidateHint(),
		...launchAttemptLines(),
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

export function orderedChromeDevtoolsTools(selectedTools: ReadonlySet<ChromeDevToolsToolName>) {
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

export function normalizeChromeDevtoolsSettings(value: unknown): ChromeDevToolsSettings | undefined {
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

export function parseConfiguredPort(value: string | undefined) {
	if (value === undefined) return undefined;
	const trimmedValue = value.trim();
	if (!/^\d+$/.test(trimmedValue)) return undefined;

	const port = Number(trimmedValue);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return port;
}

async function listPages(options: { waitMs?: number } = {}) {
	const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
	await ensureDevToolsEndpoint(waitMs);
	return withEndpointRetry(async () => {
		const pages = await fetchDevToolsJson<DevToolsPage[]>("/json/list");
		return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
	}, waitMs);
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

async function createPage(url: string, options: { waitMs?: number } = {}) {
	const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
	await ensureDevToolsEndpoint(waitMs);
	const page = await withEndpointRetry(
		() =>
			fetchDevToolsJson<DevToolsPage>(`/json/new?${encodeURIComponent(url)}`, {
				method: "PUT",
			}),
		waitMs,
	);
	if (page.type !== "page" || !page.webSocketDebuggerUrl) {
		throw new Error("Chrome DevTools created a target that is not an inspectable page.");
	}

	return page;
}

async function ensureDevToolsEndpoint(waitMs = DEFAULT_ENDPOINT_WAIT_MS) {
	if (canAutoLaunchBrowser()) {
		try {
			await withEndpointRetry(() => fetchDevToolsJson<unknown>("/json/version"), waitMs);
			return;
		} catch (error) {
			if (shouldAutoLaunchAfterEndpointError(error)) {
				await ensureManagedBrowserLaunched(waitMs);
				return;
			}
			throw error;
		}
	}

	try {
		await fetchDevToolsJson<unknown>("/json/version");
	} catch (error) {
		if (isRetryableEndpointError(error)) return;
		throw error;
	}
}

async function ensureManagedBrowserLaunched(waitMs: number) {
	if (state.launchPromise) return state.launchPromise;
	if (state.managedBrowser && !state.managedBrowser.exited && state.managedBrowser.ready) return;
	if (state.managedBrowser) {
		await shutdownManagedBrowser(state.managedBrowser, { awaitLaunch: false });
	}
	throwIfBrowserLaunchCancelled();

	state.launchPromise = launchManagedBrowser(waitMs).finally(() => {
		state.launchPromise = undefined;
	});
	return state.launchPromise;
}

async function launchManagedBrowser(waitMs: number) {
	throwIfBrowserLaunchCancelled();
	const candidateDefinitions = browserCandidateDefinitions();
	const candidates = await resolveBrowserCandidates(candidateDefinitions);
	throwIfBrowserLaunchCancelled();
	state.lastLaunchAttempt = {
		candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
		mode: state.portConfigured ? "explicit-port" : "dynamic-port",
	};

	if (candidates.length === 0) {
		throw new DevToolsEndpointError(noBrowserCandidateMessage(candidateDefinitions));
	}

	let lastError: unknown;
	for (const candidate of candidates) {
		throwIfBrowserLaunchCancelled();
		try {
			await launchBrowserCandidate(candidate, waitMs);
			state.lastLaunchAttempt = {
				...state.lastLaunchAttempt,
				selectedCandidate: formatBrowserCandidate(candidate),
				userDataDir: state.managedBrowser?.userDataDir,
			};
			return;
		} catch (error) {
			lastError = error;
			state.lastLaunchAttempt = {
				...state.lastLaunchAttempt,
				lastError: formatError(error),
			};
		}
	}

	throw new DevToolsEndpointError(
		[
			"Unable to auto-launch a Chromium-family browser for Chrome DevTools.",
			`Tried: ${candidates.map(formatBrowserCandidate).join(", ")}`,
			lastError ? `Last error: ${formatError(lastError)}` : undefined,
			launchHint(),
			endpointConfigHint(),
		]
			.filter(Boolean)
			.join("\n"),
	);
}

async function launchBrowserCandidate(candidate: BrowserCandidate, waitMs: number) {
	throwIfBrowserLaunchCancelled();
	const userDataDir = await mkdtemp(join(tmpdir(), MANAGED_BROWSER_PROFILE_PREFIX));
	let managedBrowser: ManagedBrowser | undefined;
	try {
		const portArgument = state.portConfigured ? String(state.port) : "0";
		const args = [
			`--remote-debugging-port=${portArgument}`,
			`--user-data-dir=${userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		];
		throwIfBrowserLaunchCancelled();
		const child = spawn(candidate.resolvedExecutable, args, { shell: false, stdio: "ignore" });
		const launchedBrowser: ManagedBrowser = { process: child, userDataDir, exited: false, ready: false };
		managedBrowser = launchedBrowser;
		state.managedBrowser = launchedBrowser;

		child.once("exit", () => {
			launchedBrowser.exited = true;
			launchedBrowser.ready = false;
			if (!state.portConfigured && launchedBrowser.port === state.port) {
				state.port = state.configuredPort;
			}
		});

		await waitForBrowserSpawn(child);
		if (state.portConfigured) {
			launchedBrowser.port = state.port;
		} else {
			launchedBrowser.port = await readManagedBrowserPort(userDataDir, launchedBrowser, waitMs);
			state.port = launchedBrowser.port;
		}
		await waitForDevToolsEndpoint(waitMs, launchedBrowser);
		launchedBrowser.ready = true;
	} catch (error) {
		if (managedBrowser) await shutdownManagedBrowser(managedBrowser, { awaitLaunch: false });
		else await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

function waitForBrowserSpawn(child: ChildProcess) {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			child.off("error", onError);
			child.off("spawn", onSpawn);
			callback();
		};
		const onError = (error: Error) => settle(() => reject(error));
		const onSpawn = () => settle(resolve);
		child.once("error", onError);
		child.once("spawn", onSpawn);
	});
}

async function readManagedBrowserPort(
	userDataDir: string,
	managedBrowser: ManagedBrowser,
	waitMs: number,
) {
	const activePortFile = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
	const deadline = Date.now() + waitMs;
	while (true) {
		throwIfManagedBrowserExited(managedBrowser);
		const text = await readFile(activePortFile, "utf8").catch((error: unknown) => {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		const portText = text?.split(/\r?\n/, 1)[0]?.trim();
		const port = Number(portText);
		if (Number.isInteger(port) && port > 0) return port;

		throwIfBrowserLaunchCancelled();
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new DevToolsEndpointError(
				[
					"Timed out waiting for auto-launched browser DevToolsActivePort.",
					`Expected file: ${activePortFile}`,
					launchHint(),
				].join("\n"),
			);
		}
		await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
	}
}

async function waitForDevToolsEndpoint(waitMs: number, managedBrowser: ManagedBrowser) {
	const deadline = Date.now() + waitMs;
	while (true) {
		throwIfManagedBrowserExited(managedBrowser);
		try {
			await fetchDevToolsJson<unknown>("/json/version");
			return;
		} catch (error) {
			if (!isRetryableEndpointError(error)) throw error;
		}

		throwIfBrowserLaunchCancelled();
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new DevToolsEndpointError(
				[
					`Timed out waiting for auto-launched browser at ${devToolsEndpoint()}.`,
					launchHint(),
				].join("\n"),
			);
		}
		await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
	}
}

function throwIfManagedBrowserExited(managedBrowser: ManagedBrowser) {
	if (!managedBrowser.exited) return;
	throw new DevToolsEndpointError("Auto-launched browser exited before DevTools became available.");
}

function throwIfBrowserLaunchCancelled() {
	if (!state.shuttingDown) return;
	throw new DevToolsEndpointError("Chrome DevTools browser launch cancelled during shutdown.");
}

async function shutdownManagedBrowser(
	managedBrowser = state.managedBrowser,
	options: { awaitLaunch?: boolean; cancelLaunch?: boolean } = {},
) {
	if (options.cancelLaunch) state.shuttingDown = true;
	if (options.awaitLaunch !== false) {
		await state.launchPromise?.catch(() => undefined);
		managedBrowser = managedBrowser ?? state.managedBrowser;
	}
	if (!managedBrowser) return;
	if (state.managedBrowser === managedBrowser) state.managedBrowser = undefined;

	if (!managedBrowser.exited) {
		killManagedBrowserProcess(managedBrowser);
		await waitForManagedBrowserExit(managedBrowser, BROWSER_SHUTDOWN_WAIT_MS).catch(() => {
			killManagedBrowserProcess(managedBrowser, "SIGKILL");
		});
	}
	await rm(managedBrowser.userDataDir, { recursive: true, force: true }).catch(() => undefined);
	if (!state.portConfigured && managedBrowser.port === state.port) state.port = state.configuredPort;
}

function killManagedBrowserProcess(managedBrowser: ManagedBrowser, signal?: NodeJS.Signals) {
	try {
		managedBrowser.process.kill(signal);
	} catch {
		// Best-effort shutdown: the browser may have already exited or failed to spawn.
	}
}

function waitForManagedBrowserExit(managedBrowser: ManagedBrowser, waitMs: number) {
	if (managedBrowser.exited) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const settle = (callback: () => void) => {
			clearTimeout(timeout);
			managedBrowser.process.off("exit", onExitOrClose);
			managedBrowser.process.off("close", onExitOrClose);
			callback();
		};
		const onExitOrClose = () => {
			managedBrowser.exited = true;
			settle(resolve);
		};
		const timeout = setTimeout(
			() => settle(() => reject(new Error("Timed out waiting for browser shutdown."))),
			waitMs,
		);
		managedBrowser.process.once("exit", onExitOrClose);
		managedBrowser.process.once("close", onExitOrClose);
	});
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
		throw new DevToolsEndpointError(endpointConnectionErrorMessage(error), {
			launchable: true,
			retryable: true,
		});
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

	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new DevToolsEndpointError(
			[
				`Chrome DevTools endpoint ${url} returned invalid JSON: ${formatError(error)}.`,
				endpointConfigHint(),
			].join("\n"),
		);
	}
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

function isLaunchableEndpointError(error: unknown) {
	return error instanceof DevToolsEndpointError && error.launchable;
}

function shouldAutoLaunchAfterEndpointError(error: unknown) {
	if (!canAutoLaunchBrowser()) return false;
	if (isLaunchableEndpointError(error)) return true;

	// After the attach-first attempt (including its retry window, when applicable) fails, treat any
	// DevTools endpoint error on an unpinned port as a conflict we can avoid with a dynamic port.
	return !state.portConfigured && error instanceof DevToolsEndpointError;
}

function canAutoLaunchBrowser() {
	return state.autoLaunchEnabled && isLocalDevToolsHost(state.host);
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
	return `http://${formatHostForUrl(state.host)}:${state.port}`;
}

export function formatHostForUrl(host: string) {
	if (host.startsWith("[") && host.endsWith("]")) return host;
	return host.includes(":") ? `[${host}]` : host;
}

function endpointSourceLabel() {
	const hostSource = state.hostConfigured ? "PI_CHROME_DEVTOOLS_HOST" : "default host";
	const portSource = state.portConfigured ? "PI_CHROME_DEVTOOLS_PORT" : "default/dynamic port";
	return `${hostSource}; ${portSource}`;
}

function launchModeLabel() {
	if (!isLocalDevToolsHost(state.host)) return "manual remote endpoint";
	if (!state.autoLaunchEnabled) return "manual; auto-launch disabled";
	if (state.managedBrowser && !state.managedBrowser.exited) {
		return state.portConfigured ? "auto-launched on explicit port" : "auto-launched on dynamic port";
	}
	return state.portConfigured ? "attach first; auto-launch explicit port" : "attach first; auto-launch dynamic port";
}

function launchAttemptLines() {
	if (!state.lastLaunchAttempt) return [];

	const lines = [`Last launch attempt: ${state.lastLaunchAttempt.mode}`];
	if (state.lastLaunchAttempt.selectedCandidate) {
		lines.push(`Launched browser: ${state.lastLaunchAttempt.selectedCandidate}`);
	} else {
		lines.push(`Tried browser candidates: ${state.lastLaunchAttempt.candidateLabels.join(", ")}`);
	}
	if (state.lastLaunchAttempt.userDataDir) {
		lines.push(`Managed browser profile: ${state.lastLaunchAttempt.userDataDir}`);
	}
	if (state.lastLaunchAttempt.lastError) {
		lines.push(`Last launch error: ${state.lastLaunchAttempt.lastError}`);
	}
	return lines;
}

function launchHint() {
	if (!isLocalDevToolsHost(state.host)) {
		return `Remote/non-local endpoints are not auto-launched. Start a browser with CDP enabled at ${devToolsEndpoint()}.`;
	}
	if (!state.autoLaunchEnabled) {
		return `Auto-launch is disabled. Start a browser manually: ${chromeLaunchCommand()}`;
	}
	const managedMode = state.portConfigured ? `port ${state.port}` : "a dynamic DevTools port";
	return `If no endpoint is available, Pi will auto-launch a Chromium-family browser with ${managedMode} and an isolated temp profile. Manual command: ${chromeLaunchCommand()}`;
}

function browserCandidateHint() {
	return `Browser candidates: ${browserCandidateDefinitions().map((candidate) => candidate.label).join(", ")}`;
}

function chromeLaunchCommand() {
	const executable = state.browserExecutable ?? defaultManualBrowserExecutable();
	const dataDir =
		process.platform === "win32" ? "%TEMP%\\pi-chrome-devtools" : "/tmp/pi-chrome-devtools";
	return `${quoteCommandPart(executable)} --remote-debugging-port=${state.port} --user-data-dir=${dataDir}`;
}

function defaultManualBrowserExecutable() {
	return process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: process.platform === "win32"
			? "chrome.exe"
			: "google-chrome";
}

export function quoteCommandPart(value: string) {
	return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function endpointConfigHint() {
	return "Set PI_CHROME_DEVTOOLS_HOST and PI_CHROME_DEVTOOLS_PORT for a manual endpoint, PI_CHROME_DEVTOOLS_BROWSER to choose an executable, or PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0 to disable auto-launch.";
}

export function isLocalDevToolsHost(host: string) {
	const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
	return ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(normalizedHost);
}

function browserCandidateDefinitions(): BrowserCandidateDefinition[] {
	const explicitCandidate = explicitBrowserCandidateDefinition();
	if (explicitCandidate.length > 0) return explicitCandidate;

	return uniqueBrowserCandidates(platformBrowserCandidateDefinitions());
}

function explicitBrowserCandidateDefinition(): BrowserCandidateDefinition[] {
	if (!state.browserExecutable) return [];
	return [{ label: "PI_CHROME_DEVTOOLS_BROWSER", executable: state.browserExecutable, source: "env" }];
}

function platformBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
	if (process.platform === "darwin") {
		return [
			{
				label: "Google Chrome",
				executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				source: "wellKnownPath",
			},
			{
				label: "Chromium",
				executable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
				source: "wellKnownPath",
			},
			{
				label: "Brave Browser",
				executable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
				source: "wellKnownPath",
			},
			{
				label: "Microsoft Edge",
				executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				source: "wellKnownPath",
			},
		];
	}

	if (process.platform === "win32") {
		return windowsBrowserCandidateDefinitions();
	}

	return [
		{ label: "Google Chrome", executable: "google-chrome", source: "path" },
		{ label: "Google Chrome Stable", executable: "google-chrome-stable", source: "path" },
		{ label: "Chromium", executable: "chromium", source: "path" },
		{ label: "Chromium Browser", executable: "chromium-browser", source: "path" },
		{ label: "Brave Browser", executable: "brave-browser", source: "path" },
		{ label: "Brave", executable: "brave", source: "path" },
		{ label: "Microsoft Edge", executable: "microsoft-edge", source: "path" },
		{ label: "Microsoft Edge Stable", executable: "microsoft-edge-stable", source: "path" },
	];
}

function windowsBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
	const programFiles = [
		process.env.PROGRAMFILES,
		process.env["PROGRAMFILES(X86)"],
		process.env.LOCALAPPDATA,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	const wellKnownPaths = programFiles.flatMap((root) => [
		join(root, "Google", "Chrome", "Application", "chrome.exe"),
		join(root, "Chromium", "Application", "chrome.exe"),
		join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
	]);
	return [
		...wellKnownPaths.map((executable) => ({
			label: browserLabelFromExecutable(executable),
			executable,
			source: "wellKnownPath" as const,
		})),
		{ label: "Google Chrome", executable: "chrome.exe", source: "path" },
		{ label: "Chromium", executable: "chromium.exe", source: "path" },
		{ label: "Brave Browser", executable: "brave.exe", source: "path" },
		{ label: "Microsoft Edge", executable: "msedge.exe", source: "path" },
	];
}

function browserLabelFromExecutable(executable: string) {
	const normalizedExecutable = normalizePathForComparison(executable);
	if (normalizedExecutable.includes("brave")) return "Brave Browser";
	if (normalizedExecutable.includes("edge") || normalizedExecutable.includes("msedge")) {
		return "Microsoft Edge";
	}
	if (normalizedExecutable.includes("chromium")) return "Chromium";
	return "Google Chrome";
}

function uniqueBrowserCandidates(candidates: BrowserCandidateDefinition[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = normalizePathForComparison(candidate.executable);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function resolveBrowserCandidates(definitions: BrowserCandidateDefinition[]) {
	const candidates: BrowserCandidate[] = [];
	for (const definition of definitions) {
		const resolvedExecutable = await resolveBrowserExecutable(definition.executable);
		if (!resolvedExecutable) continue;
		candidates.push({ ...definition, resolvedExecutable });
	}
	return uniqueBrowserCandidatesByResolvedPath(candidates);
}

function uniqueBrowserCandidatesByResolvedPath(candidates: BrowserCandidate[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = normalizePathForComparison(resolve(candidate.resolvedExecutable));
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function resolveBrowserExecutable(executable: string) {
	if (hasPathSeparator(executable) || isAbsolute(executable)) {
		const resolvedExecutable = isAbsolute(executable) ? executable : resolve(executable);
		return (await canAccessExecutable(resolvedExecutable)) ? resolvedExecutable : undefined;
	}

	for (const directory of executableSearchPath()) {
		for (const executableName of executableSearchNames(executable)) {
			const candidate = join(directory, executableName);
			if (await canAccessExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

function hasPathSeparator(path: string) {
	return path.includes("/") || path.includes("\\");
}

function executableSearchPath() {
	return (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0);
}

function executableSearchNames(executable: string) {
	if (process.platform !== "win32" || /\.[a-z0-9]+$/i.test(executable)) return [executable];
	return [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`];
}

async function canAccessExecutable(path: string) {
	try {
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function formatBrowserCandidate(candidate: BrowserCandidate) {
	return `${candidate.label} (${candidate.resolvedExecutable})`;
}

function formatBrowserCandidateDefinition(candidate: BrowserCandidateDefinition) {
	return `${candidate.label} (${candidate.executable})`;
}

function noBrowserCandidateMessage(candidateDefinitions: BrowserCandidateDefinition[]) {
	return [
		"Cannot auto-launch Chrome DevTools because no Chromium-family browser executable was found.",
		`Tried: ${candidateDefinitions.map(formatBrowserCandidateDefinition).join(", ")}`,
		endpointConfigHint(),
	].join("\n");
}

function formatPageListItem(page: DevToolsPage) {
	return `- ${page.id}: ${page.title || "(untitled)"} ${page.url}`;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class DevToolsEndpointError extends Error {
	readonly retryable: boolean;
	readonly launchable: boolean;

	constructor(message: string, options: { retryable?: boolean; launchable?: boolean } = {}) {
		super(message);
		this.name = "DevToolsEndpointError";
		this.retryable = options.retryable ?? false;
		this.launchable = options.launchable ?? false;
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

async function saveScreenshot(
	base64Png: string,
	savePath: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ScreenshotSaveResult> {
	const resolvedPath = resolveScreenshotPath(savePath, cwd);
	const pngBytes = Buffer.from(base64Png, "base64");

	await withFileMutationQueue(resolvedPath.path, async () => {
		throwIfAborted(signal);
		await ensureSafeScreenshotParent(resolvedPath);
		await assertSafeScreenshotTargetPath(resolvedPath);
		await writeScreenshotFileSafely(resolvedPath, pngBytes, signal);
	});

	return {
		savedPath: resolvedPath.path,
		bytes: pngBytes.byteLength,
		isDefaultPath: resolvedPath.isDefault,
	};
}

export function resolveScreenshotPath(savePath: string | undefined, cwd: string): ResolvedScreenshotPath {
	const cwdRoot = resolve(cwd);
	const tempRoot = resolve(tmpdir());

	if (savePath === undefined) {
		return {
			path: join(tempRoot, `pi-chrome-devtools-screenshot-${randomUUID()}.png`),
			allowedRoots: [tempRoot],
			isDefault: true,
		};
	}

	const normalizedPath = stripLeadingAtPath(savePath);
	if (!normalizedPath.trim()) {
		throw new Error("Screenshot savePath must not be empty.");
	}
	if (normalizedPath.includes("\0")) {
		throw new Error("Screenshot savePath must not contain NUL bytes.");
	}
	if (hasParentPathSegment(normalizedPath)) {
		throw new Error("Screenshot savePath must not contain '..' path segments.");
	}

	const isAbsolutePath = isAbsolute(normalizedPath);
	const path = isAbsolutePath ? resolve(normalizedPath) : resolve(cwdRoot, normalizedPath);
	const allowedRoots = isAbsolutePath ? unique([cwdRoot, tempRoot]) : [cwdRoot];
	if (!allowedRoots.some((root) => isPathInsideRoot(path, root))) {
		throw new Error(
			"Screenshot savePath must be relative to the current working directory, or an absolute path inside the current working directory or OS temp directory.",
		);
	}

	return { path, allowedRoots, isDefault: false };
}

function stripLeadingAtPath(path: string) {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function hasParentPathSegment(path: string) {
	return path.split(/[\\/]+/).some((part) => part === "..");
}

async function ensureSafeScreenshotParent(resolvedPath: ResolvedScreenshotPath) {
	const parentPath = dirname(resolvedPath.path);
	const rootPath = selectAllowedRoot(parentPath, resolvedPath.allowedRoots);
	if (!rootPath) {
		throw new Error(
			"Screenshot savePath parent must stay inside the current working directory or OS temp directory.",
		);
	}

	const realRootPath = await realpath(rootPath);
	let currentPath = rootPath;
	const parentSegments = relative(rootPath, parentPath)
		.split(/[\\/]+/)
		.filter((part) => part.length > 0);

	for (const segment of parentSegments) {
		currentPath = join(currentPath, segment);
		await ensureSafeDirectorySegment(currentPath, realRootPath);
	}
}

export function selectAllowedRoot(path: string, roots: readonly string[]) {
	const matchingRoots = roots.filter((root) => isPathInsideRoot(path, root));
	matchingRoots.sort(
		(left, right) =>
			normalizePathForComparison(resolve(right)).length -
			normalizePathForComparison(resolve(left)).length,
	);
	return matchingRoots[0];
}

async function ensureSafeDirectorySegment(path: string, realRootPath: string) {
	const existingDirectory = await lstat(path).catch(async (error: unknown) => {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		await mkdir(path).catch((mkdirError: unknown) => {
			if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
		});
		return lstat(path);
	});

	if (existingDirectory.isSymbolicLink()) {
		throw new Error("Screenshot savePath parent directories must not contain symbolic links.");
	}
	if (!existingDirectory.isDirectory()) {
		throw new Error("Screenshot savePath parent must be a directory.");
	}
	await assertPathWithinRealRoot(path, realRootPath);
}

async function assertSafeScreenshotTargetPath(resolvedPath: ResolvedScreenshotPath) {
	const existingTarget = await lstat(resolvedPath.path).catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existingTarget?.isSymbolicLink()) {
		throw new Error("Screenshot savePath must not point to a symbolic link.");
	}
	if (existingTarget?.isDirectory()) {
		throw new Error("Screenshot savePath must point to a file, not a directory.");
	}
	if (existingTarget && !existingTarget.isFile()) {
		throw new Error("Screenshot savePath may only replace regular files.");
	}

	const realAllowedRoots = await Promise.all(resolvedPath.allowedRoots.map(realpathOrResolvedPath));
	const realParent = await realpath(dirname(resolvedPath.path));
	const realTargetPath = join(realParent, basename(resolvedPath.path));
	if (!realAllowedRoots.some((root) => isPathInsideRoot(realTargetPath, root))) {
		throw new Error(
			"Screenshot savePath resolves outside the current working directory or OS temp directory.",
		);
	}
}

async function assertPathWithinRealRoot(path: string, realRootPath: string) {
	const realPath = await realpath(path);
	if (!isPathInsideRoot(realPath, realRootPath)) {
		throw new Error(
			"Screenshot savePath parent resolves outside the current working directory or OS temp directory.",
		);
	}
}

async function writeScreenshotFileSafely(
	resolvedPath: ResolvedScreenshotPath,
	pngBytes: Buffer,
	signal: AbortSignal | undefined,
) {
	const tempFile = join(
		dirname(resolvedPath.path),
		`.${basename(resolvedPath.path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(tempFile, pngBytes, { flag: "wx", signal });
		throwIfAborted(signal);
		await replaceScreenshotFile(resolvedPath, tempFile, signal);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function replaceScreenshotFile(
	resolvedPath: ResolvedScreenshotPath,
	tempFile: string,
	signal: AbortSignal | undefined,
) {
	try {
		await rename(tempFile, resolvedPath.path);
		return;
	} catch (error) {
		if (!shouldRetryRenameAfterRemovingDestination(error)) throw error;
	}

	// Some Windows filesystems reject renaming over an existing file. Revalidate before
	// removing the destination so the fallback still refuses directories and symlinks.
	await assertSafeScreenshotTargetPath(resolvedPath);
	throwIfAborted(signal);
	await rm(resolvedPath.path, { force: true });
	await rename(tempFile, resolvedPath.path);
}

function shouldRetryRenameAfterRemovingDestination(error: unknown) {
	return (
		process.platform === "win32" &&
		isNodeError(error) &&
		["EACCES", "EEXIST", "EPERM"].includes(error.code ?? "")
	);
}

async function realpathOrResolvedPath(path: string) {
	return realpath(path).catch(() => resolve(path));
}

export function isPathInsideRoot(path: string, root: string) {
	const normalizedPath = normalizePathForComparison(resolve(path));
	const normalizedRoot = normalizePathForComparison(resolve(root));
	if (normalizedPath === normalizedRoot) return true;
	const rootWithSeparator = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return normalizedPath.startsWith(rootWithSeparator);
}

function normalizePathForComparison(path: string) {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Screenshot capture cancelled.");
}

function formatScreenshotText(page: DevToolsPage, screenshot: ScreenshotSaveResult) {
	const pathLabel = screenshot.isDefaultPath ? "Saved to temp file" : "Saved to";
	return [
		`Captured PNG screenshot from ${page.title || page.url || page.id}.`,
		`${pathLabel}: ${screenshot.savedPath}`,
		`Bytes: ${screenshot.bytes}`,
		`Use read({ path: ${JSON.stringify(screenshot.savedPath)} }) to inspect the saved screenshot if inline image content is not available.`,
	].join("\n");
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
	const output = formatCollapsibleOutput(screenshotTextContent(result), options);
	return new PiTextComponent(output.text, theme, output.color);
}

function textContent(result: AgentToolResult<unknown>) {
	return result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
}

function screenshotTextContent(result: AgentToolResult<unknown>) {
	const text = textContent(result);
	if (text.trim()) return text;

	const details = result.details as { savedPath?: unknown; bytes?: unknown } | undefined;
	if (typeof details?.savedPath !== "string") return text;
	const bytes = typeof details.bytes === "number" ? ` (${details.bytes} bytes)` : "";
	return `Saved screenshot to ${details.savedPath}${bytes}`;
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
	private text: string;
	private readonly theme?: RenderTheme;
	private readonly color?: string;

	constructor(text = "", theme?: RenderTheme, color?: string) {
		this.text = text;
		this.theme = theme;
		this.color = color;
	}

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
