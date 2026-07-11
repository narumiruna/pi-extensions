import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configuredApiUrl, hasApiKey } from "./client.js";
import { loadSettings, saveSettings, settingsFilePath, type SettingsLoadResult } from "./settings.js";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tools.js";

type CommandContext = ExtensionCommandContext;

const TOOL_SELECTOR_DONE = "Done";
const TOOL_SELECTOR_ENABLE_ALL = "Enable all Firecrawl tools";
const TOOL_SELECTOR_DISABLE_ALL = "Disable all Firecrawl tools";
type ToolRuntimeStatus = "enabled" | "disabled" | "partial";
type ToolSelectorAction = "enableAll" | "disableAll" | "done";
type ToolSelectorRow =
	| { kind: "tool"; toolName: FirecrawlToolName }
	| { kind: "action"; action: ToolSelectorAction; label: string };
interface ToolStatusSummary {
	runtimeStatus: ToolRuntimeStatus;
	activeFirecrawlToolCount: number;
	activeNonFirecrawlToolCount: number;
}

let settingsNotice: string | undefined;

export function clearSettingsNotice() {
	settingsNotice = undefined;
}

export function recordSettingsNotice(settings: SettingsLoadResult) {
	if (settings.notice) settingsNotice = settings.notice;
}

export async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
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

export async function updateFirecrawlTools(
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

export async function setSelectedFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
) {
	applyFirecrawlTools(pi, selectedTools);
	await persistSettings(ctx, selectedTools);
}

export function applyFirecrawlTools(pi: ExtensionAPI, selectedTools: readonly FirecrawlToolName[]) {
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

export async function buildStatusMessage(pi: ExtensionAPI) {
	const summary = getToolStatusSummary(pi);
	const persistedSetting = await persistedSettingLabel();
	return [
		`Firecrawl tools: ${formatRuntimeStatus(summary)}`,
		`Persisted selection: ${persistedSetting}`,
		`Settings file: ${settingsFilePath()}`,
		...(settingsNotice ? [`Settings note: ${settingsNotice}`] : []),
		`Other active tools preserved: ${summary.activeNonFirecrawlToolCount}`,
		`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
		`API URL: ${configuredApiUrl()}`,
	].join("\n");
}

export function buildConfigMessage() {
	return [
		"Firecrawl configuration:",
		`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
		`API URL: ${configuredApiUrl()}`,
		"Override API URL with FIRECRAWL_API_URL or FIRECRAWL_BASE_URL.",
		"This extension never logs, displays, or stores your Firecrawl API key.",
	].join("\n");
}

export function buildCommandGuide() {
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

export function allFirecrawlTools() {
	return [...FIRECRAWL_TOOL_NAMES];
}

function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

export function orderedFirecrawlTools(selectedTools: ReadonlySet<FirecrawlToolName>) {
	return FIRECRAWL_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
	return `${summary.runtimeStatus} (${summary.activeFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length} active)`;
}

async function persistedSettingLabel() {
	const settings = await loadSettings();
	recordSettingsNotice(settings);
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

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
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
