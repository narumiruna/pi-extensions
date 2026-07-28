import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	browserCandidateHint,
	devToolsEndpoint,
	endpointConfigHint,
	endpointSourceLabel,
	launchAttemptLines,
	launchHint,
	launchModeLabel,
} from "./browser-manager.js";
import { state } from "./runtime.js";
import { loadSettings, saveSettings, settingsFilePath } from "./settings.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";

type CommandContext = ExtensionCommandContext;
type ToolSelectorScreen = "tools";
type ToolSelectorAction = "toggle" | "enableAll" | "disableAll";

function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

function recordSettingsNotice(settings: { notice?: string }) {
	if (settings.notice) state.settingsNotice = settings.notice;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

interface ToolStatusSummary {
	runtimeStatus: "enabled" | "disabled" | "partial";
	activeChromeToolCount: number;
	activeNonChromeToolCount: number;
}

export async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	const generation = state.sessionGeneration;
	if (!ctx.hasUI) return;
	const menu = defineMenu<undefined, ToolSelectorScreen, ToolSelectorAction>({
		start: "tools",
		screens: {
			tools: () => {
				const selectedTools = new Set(getActiveChromeDevtoolsTools(pi));
				return {
					kind: "multiSelect",
					title: toolSelectorTitle(selectedTools),
					items: CHROME_DEVTOOLS_TOOL_NAMES.map((toolName) => ({
						id: toolName,
						label: toolName,
						selected: selectedTools.has(toolName),
					})),
					action: "toggle",
					actions: [
						{
							id: "enable-all",
							label: "Enable all Chrome DevTools tools",
							action: "enableAll",
						},
						{
							id: "disable-all",
							label: "Disable all Chrome DevTools tools",
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
				if (!isChromeDevtoolsToolName(itemId)) return { kind: "rejected" };
				const selectedTools = new Set(getActiveChromeDevtoolsTools(pi));
				if (selected) selectedTools.add(itemId);
				else selectedTools.delete(itemId);
				const saved = await transactSelectedTools(
					pi,
					ctx,
					orderedChromeDevtoolsTools(selectedTools),
					generation,
				);
				return saved ? { kind: "stay" } : { kind: "rejected" };
			},
			enableAll: async () => {
				const saved = await transactSelectedTools(pi, ctx, allChromeDevtoolsTools(), generation);
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
		signal: state.sessionController.signal,
		isCurrent: () => generation === state.sessionGeneration,
	});
	if (result.kind !== "closed" || generation !== state.sessionGeneration) return;
	const status = await buildToolStatusMessage(pi);
	if (generation !== state.sessionGeneration) return;
	ctx.ui.notify(status, "info");
}

export async function updateChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
	action: string,
) {
	const generation = state.sessionGeneration;
	const saved = await transactSelectedTools(pi, ctx, selectedTools, generation);
	if (!saved || generation !== state.sessionGeneration) return;
	const status = await buildToolStatusMessage(pi);
	if (generation !== state.sessionGeneration) return;
	ctx.ui.notify(`Chrome DevTools tools ${action}.\n\n${status}`, "info");
}

export async function setSelectedChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
): Promise<boolean> {
	return transactSelectedTools(pi, ctx, selectedTools, state.sessionGeneration);
}

let toolTransactionQueue = Promise.resolve();

export async function waitForChromeDevtoolsSettings(): Promise<void> {
	await toolTransactionQueue;
}

function transactSelectedTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
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
	selectedTools: readonly ChromeDevToolsToolName[],
	expectedGeneration: number,
): Promise<boolean> {
	if (expectedGeneration !== state.sessionGeneration) return false;
	const previousActiveTools = pi.getActiveTools();
	try {
		applyChromeDevtoolsTools(pi, selectedTools);
		await persistSettings(selectedTools);
		return expectedGeneration === state.sessionGeneration;
	} catch (error) {
		let rollbackError: unknown;
		try {
			const previousChromeTools = previousActiveTools.filter((name) =>
				CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName),
			) as ChromeDevToolsToolName[];
			applyChromeDevtoolsTools(pi, previousChromeTools);
		} catch (caught) {
			rollbackError = caught;
		}
		if (expectedGeneration !== state.sessionGeneration) return false;
		ctx.ui.notify(
			rollbackError
				? `Chrome DevTools settings save failed: ${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`
				: `Chrome DevTools settings save failed; active tools restored: ${formatError(error)}`,
			"warning",
		);
		return false;
	}
}

export function applyChromeDevtoolsTools(
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

export async function buildToolStatusMessage(pi: ExtensionAPI) {
	const summary = getToolStatusSummary(pi);
	const persistedSetting = await persistedSettingLabel();
	return [
		`Chrome DevTools tools: ${formatRuntimeStatus(summary)}`,
		`Persisted selection: ${persistedSetting}`,
		`Settings file: ${settingsFilePath()}`,
		...(state.settingsNotice ? [`Settings note: ${state.settingsNotice}`] : []),
		`Other active tools preserved: ${summary.activeNonChromeToolCount}`,
		`Endpoint: ${devToolsEndpoint()}`,
		`Endpoint source: ${endpointSourceLabel()}`,
		`Launch mode: ${launchModeLabel()}`,
		...launchAttemptLines(),
	].join("\n");
}

export function buildQuickstartMessage() {
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

export function buildCommandGuide() {
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

function isChromeDevtoolsToolName(value: string): value is ChromeDevToolsToolName {
	return CHROME_DEVTOOLS_TOOL_NAMES.includes(value as ChromeDevToolsToolName);
}

function getActiveChromeDevtoolsTools(pi: ExtensionAPI) {
	const activeToolNames = new Set(pi.getActiveTools());
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => activeToolNames.has(toolName));
}

export function allChromeDevtoolsTools() {
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
	recordSettingsNotice(settings);
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

async function persistSettings(selectedTools: readonly ChromeDevToolsToolName[]) {
	await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
}
