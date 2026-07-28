import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { configuredApiUrl, hasApiKey } from "./client.js";
import {
	loadSettings,
	type SettingsLoadResult,
	saveSettings,
	settingsFilePath,
} from "./settings.js";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tools.js";

type CommandContext = ExtensionCommandContext;
type ToolRuntimeStatus = "enabled" | "disabled" | "partial";
type ToolSelectorScreen = "tools";
type ToolSelectorAction = "toggle" | "enableAll" | "disableAll";
interface ToolStatusSummary {
	runtimeStatus: ToolRuntimeStatus;
	activeFirecrawlToolCount: number;
	activeNonFirecrawlToolCount: number;
}

let settingsNotice: string | undefined;
let sessionGeneration = 0;
let sessionController = new AbortController();

export function advanceFirecrawlSessionGeneration(): number {
	sessionController.abort(new DOMException("Firecrawl session replaced", "AbortError"));
	sessionController = new AbortController();
	return ++sessionGeneration;
}

export function currentFirecrawlSessionGeneration(): number {
	return sessionGeneration;
}

export function isCurrentFirecrawlSession(generation: number): boolean {
	return generation === sessionGeneration;
}

export function currentFirecrawlSessionSignal(): AbortSignal {
	return sessionController.signal;
}

export function clearSettingsNotice() {
	settingsNotice = undefined;
}

export function recordSettingsNotice(settings: SettingsLoadResult) {
	if (settings.notice) settingsNotice = settings.notice;
}

export async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	const generation = sessionGeneration;
	if (!ctx.hasUI) return;
	const menu = defineMenu<undefined, ToolSelectorScreen, ToolSelectorAction>({
		start: "tools",
		screens: {
			tools: () => {
				const selectedTools = new Set(getActiveFirecrawlTools(pi));
				return {
					kind: "multiSelect",
					title: toolSelectorTitle(selectedTools),
					items: FIRECRAWL_TOOL_NAMES.map((toolName) => ({
						id: toolName,
						label: toolName,
						selected: selectedTools.has(toolName),
					})),
					action: "toggle",
					actions: [
						{
							id: "enable-all",
							label: "Enable all Firecrawl tools",
							action: "enableAll",
						},
						{
							id: "disable-all",
							label: "Disable all Firecrawl tools",
							action: "disableAll",
						},
						{ id: "done", label: "Done", close: true },
					],
					hint: "close",
					doneLabel: "Done",
				};
			},
		},
		actions: {
			toggle: async ({ itemId, selected }) => {
				if (!isFirecrawlToolName(itemId)) return { kind: "rejected" };
				const selectedTools = new Set(getActiveFirecrawlTools(pi));
				if (selected) selectedTools.add(itemId);
				else selectedTools.delete(itemId);
				const saved = await transactSelectedTools(
					pi,
					ctx,
					orderedFirecrawlTools(selectedTools),
					generation,
				);
				return saved ? { kind: "stay" } : { kind: "rejected" };
			},
			enableAll: async () => {
				const saved = await transactSelectedTools(pi, ctx, allFirecrawlTools(), generation);
				return saved ? { kind: "stay" } : { kind: "rejected" };
			},
			disableAll: async () => {
				const saved = await transactSelectedTools(pi, ctx, [], generation);
				return saved ? { kind: "stay" } : { kind: "rejected" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: sessionController.signal,
		isCurrent: () => isCurrentFirecrawlSession(generation),
	});
	if (result.kind !== "closed" || !isCurrentFirecrawlSession(generation)) return;
	const status = await buildStatusMessage(pi);
	if (!isCurrentFirecrawlSession(generation)) return;
	ctx.ui.notify(status, hasApiKey() ? "info" : "warning");
}

export async function updateFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
	action: string,
) {
	const generation = sessionGeneration;
	const saved = await transactSelectedTools(pi, ctx, selectedTools, generation);
	if (!saved || !isCurrentFirecrawlSession(generation)) return;
	const status = await buildStatusMessage(pi);
	if (!isCurrentFirecrawlSession(generation)) return;
	ctx.ui.notify(`Firecrawl tools ${action}.\n\n${status}`, hasApiKey() ? "info" : "warning");
}

export async function setSelectedFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
): Promise<boolean> {
	return transactSelectedTools(pi, ctx, selectedTools, sessionGeneration);
}

let toolTransactionQueue = Promise.resolve();

export async function waitForFirecrawlSettings(): Promise<void> {
	await toolTransactionQueue;
}

function transactSelectedTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
	expectedGeneration: number,
): Promise<boolean> {
	const operation = toolTransactionQueue.then(() =>
		transactSelectedToolsNow(pi, ctx, selectedTools, expectedGeneration),
	);
	toolTransactionQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

async function transactSelectedToolsNow(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
	expectedGeneration: number,
): Promise<boolean> {
	if (!isCurrentFirecrawlSession(expectedGeneration)) return false;
	const previousActiveTools = pi.getActiveTools();
	try {
		applyFirecrawlTools(pi, selectedTools);
		await persistSettings(selectedTools);
		return isCurrentFirecrawlSession(expectedGeneration);
	} catch (error) {
		let rollbackError: unknown;
		try {
			const previousFirecrawlTools = previousActiveTools.filter((name) =>
				FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName),
			) as FirecrawlToolName[];
			applyFirecrawlTools(pi, previousFirecrawlTools);
		} catch (caught) {
			rollbackError = caught;
		}
		if (!isCurrentFirecrawlSession(expectedGeneration)) return false;
		ctx.ui.notify(
			rollbackError
				? `Firecrawl settings save failed: ${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`
				: `Firecrawl settings save failed; active tools restored: ${formatError(error)}`,
			"warning",
		);
		return false;
	}
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

function isFirecrawlToolName(value: string): value is FirecrawlToolName {
	return FIRECRAWL_TOOL_NAMES.includes(value as FirecrawlToolName);
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

async function persistSettings(selectedTools: readonly FirecrawlToolName[]) {
	await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
}
