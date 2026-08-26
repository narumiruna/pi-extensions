import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	browserCandidateHint,
	browserLifecycleState,
	devToolsEndpoint,
	endpointConfigHint,
	endpointSourceLabel,
	launchAttemptLines,
	launchHint,
	launchModeLabel,
} from "./browser-manager.js";
import {
	applyAvailableChromeDevtoolsTools,
	availableChromeDevtoolsTools,
	CHROME_DEVTOOLS_LOAD_TOOL_NAME,
	chromeDevtoolsToolExposureMode,
} from "./lazy-tools.js";
import { state } from "./runtime.js";
import { loadSettings, saveSettings, settingsFilePath } from "./settings.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";

type CommandContext = ExtensionCommandContext;

function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

interface ToolStatusSummary {
	availabilityStatus: "enabled" | "disabled" | "partial";
	availableChromeToolCount: number;
	loadedChromeToolCount: number;
	activeNonChromeToolCount: number;
}

type ToolSelectionSaveResult = "saved" | "active-tools-changed" | "failed";

export async function updateChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
	action: string,
) {
	const generation = state.sessionGeneration;
	const result = await transactSelectedTools(pi, ctx, selectedTools, generation);
	if (result !== "saved" || generation !== state.sessionGeneration) return;
	const status = await buildToolStatusMessage(pi);
	if (generation !== state.sessionGeneration) return;
	ctx.ui.notify(`Chrome DevTools tool catalog ${action}.\n\n${status}`, "info");
}

export async function setSelectedChromeDevtoolsTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly ChromeDevToolsToolName[],
	expectedActiveTools: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
	return transactSelectedTools(
		pi,
		ctx,
		selectedTools,
		state.sessionGeneration,
		expectedActiveTools,
	);
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
	expectedActiveTools?: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
	const operation = toolTransactionQueue.then(() =>
		transactSelectedToolsNow(pi, ctx, selectedTools, expectedGeneration, expectedActiveTools),
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
	expectedActiveTools?: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
	if (expectedGeneration !== state.sessionGeneration) return "failed";
	if (expectedActiveTools && !arraysEqual(availableChromeDevtoolsTools(pi), expectedActiveTools)) {
		ctx.ui.notify(
			"Browser tool selection changed while review was open. Review the current state, then apply again.",
			"warning",
		);
		return "active-tools-changed";
	}
	const previousActiveTools = pi.getActiveTools();
	const previousAvailableTools = availableChromeDevtoolsTools(pi);
	try {
		applyChromeDevtoolsTools(pi, selectedTools);
		await persistSettings(selectedTools);
		return expectedGeneration === state.sessionGeneration ? "saved" : "failed";
	} catch (error) {
		let rollbackError: unknown;
		try {
			applyAvailableChromeDevtoolsTools(pi, previousAvailableTools);
			const currentNonChromeTools = pi
				.getActiveTools()
				.filter((name) => !CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName));
			const previousLoadedChromeTools = previousActiveTools.filter((name) =>
				CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName),
			);
			const restoredChromeTools =
				chromeDevtoolsToolExposureMode(pi) === "eager"
					? previousAvailableTools
					: previousLoadedChromeTools;
			pi.setActiveTools(unique([...currentNonChromeTools, ...restoredChromeTools]));
		} catch (caught) {
			rollbackError = caught;
		}
		if (expectedGeneration !== state.sessionGeneration) return "failed";
		ctx.ui.notify(
			sanitizeChromeDevtoolsDisplay(
				rollbackError
					? `Chrome DevTools settings save failed: ${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`
					: `Chrome DevTools settings save failed; active tools restored: ${formatError(error)}`,
			),
			"warning",
		);
		return "failed";
	}
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function applyChromeDevtoolsTools(
	pi: ExtensionAPI,
	selectedTools: readonly ChromeDevToolsToolName[],
) {
	applyAvailableChromeDevtoolsTools(pi, selectedTools);
}

function getToolStatusSummary(pi: ExtensionAPI): ToolStatusSummary {
	const chromeToolNames = new Set<string>(CHROME_DEVTOOLS_TOOL_NAMES);
	const activeToolNames = new Set(pi.getActiveTools());
	const loadedChromeToolCount = CHROME_DEVTOOLS_TOOL_NAMES.filter((name) =>
		activeToolNames.has(name),
	).length;
	const availableChromeToolCount = availableChromeDevtoolsTools(pi).length;
	const activeNonChromeToolCount = Array.from(activeToolNames).filter(
		(name) => !chromeToolNames.has(name) && name !== CHROME_DEVTOOLS_LOAD_TOOL_NAME,
	).length;
	const availabilityStatus =
		availableChromeToolCount === CHROME_DEVTOOLS_TOOL_NAMES.length
			? "enabled"
			: availableChromeToolCount === 0
				? "disabled"
				: "partial";

	return {
		availabilityStatus,
		availableChromeToolCount,
		loadedChromeToolCount,
		activeNonChromeToolCount,
	};
}

export async function buildToolStatusMessage(pi: ExtensionAPI) {
	const summary = getToolStatusSummary(pi);
	const persistedSetting = await persistedSettingLabel();
	return sanitizeChromeDevtoolsDisplay(
		[
			`Chrome DevTools tools available: ${formatRuntimeStatus(summary)}`,
			`Tool exposure: ${chromeDevtoolsToolExposureMode(pi)}`,
			`Loaded capability tools this session: ${summary.loadedChromeToolCount}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
			`Loader: ${pi.getActiveTools().includes(CHROME_DEVTOOLS_LOAD_TOOL_NAME) ? "active" : "inactive"}`,
			`Persisted tool catalog: ${persistedSetting}`,
			...browserSettingsStatusLines(),
			...(state.settingsNotice ? [`Settings note: ${state.settingsNotice}`] : []),
			`Other active tools preserved: ${summary.activeNonChromeToolCount}`,
			`Endpoint: ${devToolsEndpoint()}`,
			`Endpoint source: ${endpointSourceLabel()}`,
			`Launch mode: ${launchModeLabel()}`,
			...launchAttemptLines(),
		].join("\n"),
	);
}

export function buildQuickstartMessage() {
	return buildSettingsSetupMessage();
}

export function buildBrowserStatusMessage() {
	const lifecycle = browserLifecycleState();
	const browserState =
		lifecycle === "starting"
			? "starting managed browser"
			: lifecycle === "running"
				? "managed browser running"
				: lifecycle === "exited"
					? "managed browser exited"
					: lifecycle === "failed"
						? "last launch failed"
						: "not started; connection has not been checked";
	const needsRecovery = lifecycle === "exited" || lifecycle === "failed";
	return sanitizeChromeDevtoolsDisplay(
		[
			`Browser: ${browserState}`,
			"Viewing this status does not probe the endpoint or launch Chrome.",
			`Endpoint: ${devToolsEndpoint()}`,
			`Endpoint source: ${endpointSourceLabel()}`,
			`Launch mode: ${launchModeLabel()}`,
			`Unpacked extensions: ${state.extensionPaths.length} (${state.extensionPathsSource})`,
			...(state.extensionPaths.length > 0
				? ["Unpacked extensions execute trusted browser code in an isolated managed browser."]
				: []),
			...launchAttemptLines(),
			...(needsRecovery ? [launchHint(), endpointConfigHint()] : []),
		].join("\n"),
	);
}

export function buildSettingsSetupMessage() {
	return sanitizeChromeDevtoolsDisplay(
		[
			`Chrome DevTools endpoint: ${devToolsEndpoint()}`,
			`Endpoint source: ${endpointSourceLabel()}`,
			`Launch mode: ${launchModeLabel()}`,
			...browserSettingsStatusLines(),
			launchHint(),
			browserCandidateHint(),
			...launchAttemptLines(),
			endpointConfigHint(),
		].join("\n"),
	);
}

export function sanitizeChromeDevtoolsDisplay(value: string, maxCharacters = 50_000) {
	const sanitized = Array.from(stripVTControlCharacters(value), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafeControl =
			(codePoint >= 0 && codePoint <= 8) ||
			(codePoint >= 11 && codePoint <= 31) ||
			(codePoint >= 127 && codePoint <= 159);
		return unsafeControl ? "�" : character;
	}).join("");
	if (sanitized.length <= maxCharacters) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function browserSettingsStatusLines() {
	const extensionLines =
		state.extensionPaths.length > 0
			? state.extensionPaths.map((extensionPath) => `  - ${extensionPath}`)
			: ["  - none"];
	return [
		`Settings file: ${state.settingsFilePath ?? settingsFilePath()} (user)`,
		...(state.projectSettingsFilePath
			? [
					`Project settings: ${state.projectSettingsFilePath} (${state.projectSettingsTrusted ? "trusted" : "untrusted; ignored"})`,
				]
			: []),
		`Auto-launch: ${state.autoLaunchEnabled ? "on" : "off"} (${state.autoLaunchSource})`,
		`Browser executable: ${state.browserExecutable ?? "automatic discovery"} (${state.browserExecutableSource})`,
		`Unpacked extensions (${state.extensionPathsSource}):`,
		...extensionLines,
		"Confirmed menu settings apply before the next browser connection; manual JSON edits require /reload or session replacement.",
		...(state.extensionPaths.length > 0
			? [
					"Unpacked extensions require Chrome for Testing or Chromium and execute trusted browser code.",
				]
			: []),
	];
}

export function buildCommandGuide() {
	return [
		"Chrome DevTools commands:",
		"/chrome-devtools — open this menu",
		"/chrome-devtools help — show command usage",
		"/chrome-devtools quickstart — show endpoint and launch help",
		"/chrome-devtools status — show tool and settings status",
		"/chrome-devtools settings — edit browser connection settings",
		"/chrome-devtools tools — choose available Chrome DevTools tools",
		"/chrome-devtools toggle|select — compatibility aliases for tools",
		"/chrome-devtools enable|on — make all Chrome DevTools tools available",
		"/chrome-devtools disable|off — make all Chrome DevTools capability tools unavailable",
	].join("\n");
}

export function allChromeDevtoolsTools() {
	return [...CHROME_DEVTOOLS_TOOL_NAMES];
}

export function orderedChromeDevtoolsTools(selectedTools: ReadonlySet<ChromeDevToolsToolName>) {
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
	return `${summary.availabilityStatus} (${summary.availableChromeToolCount}/${CHROME_DEVTOOLS_TOOL_NAMES.length} available)`;
}

async function persistedSettingLabel() {
	const settings = await loadSettings();
	if (settings.kind === "loaded" && settings.settings.tools) {
		return formatPersistedSelection(settings.settings.tools);
	}
	if (settings.kind === "invalid") {
		return `none; current active-tool policy preserved (invalid settings ignored: ${settings.reason})`;
	}
	return "none; current active-tool policy preserved";
}

function formatPersistedSelection(tools: readonly ChromeDevToolsToolName[]) {
	if (tools.length === CHROME_DEVTOOLS_TOOL_NAMES.length) {
		return `all available (${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
	}
	if (tools.length === 0)
		return `all unavailable (0/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
	return `${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

async function persistSettings(selectedTools: readonly ChromeDevToolsToolName[]) {
	await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
}
