import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configuredApiUrl, hasApiKey } from "./client.js";
import {
	applyAvailableFirecrawlTools,
	availableFirecrawlTools,
	FIRECRAWL_LOAD_TOOL_NAME,
	firecrawlToolExposureMode,
} from "./lazy-tools.js";
import {
	loadSettings,
	type SettingsLoadResult,
	saveSettings,
	settingsFilePath,
} from "./settings.js";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tool-names.js";

type CommandContext = ExtensionCommandContext;
type ToolAvailabilityStatus = "enabled" | "disabled" | "partial";
type ToolSelectorScreen = "tools";
type ToolSelectorAction = "toggle" | "enableAll" | "disableAll";
interface ToolStatusSummary {
	availabilityStatus: ToolAvailabilityStatus;
	availableFirecrawlToolCount: number;
	loadedFirecrawlToolCount: number;
	activeNonFirecrawlToolCount: number;
}

type ToolSelectionSaveResult = "saved" | "available-tools-changed" | "failed";

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
	settingsNotice = settings.notice;
}

export async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
	const generation = sessionGeneration;
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("/firecrawl tools requires TUI or RPC mode");
	}
	const menuSignal = sessionController.signal;
	const isCurrent = () => isCurrentFirecrawlSession(generation) && !menuSignal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	const menu = defineMenu<undefined, ToolSelectorScreen, ToolSelectorAction>({
		start: "tools",
		screens: {
			tools: () => {
				const selectedTools = new Set(availableFirecrawlTools(pi));
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
							label: "Make all Firecrawl tools available",
							action: "enableAll",
						},
						{
							id: "disable-all",
							label: "Make all Firecrawl tools unavailable",
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
				const acceptedTools = availableFirecrawlTools(pi);
				const selectedTools = new Set(acceptedTools);
				if (selected) selectedTools.add(itemId);
				else selectedTools.delete(itemId);
				const result = await transactSelectedTools(
					pi,
					ctx,
					orderedFirecrawlTools(selectedTools),
					generation,
					acceptedTools,
				);
				return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
			},
			enableAll: async () => {
				const acceptedTools = availableFirecrawlTools(pi);
				const result = await transactSelectedTools(
					pi,
					ctx,
					allFirecrawlTools(),
					generation,
					acceptedTools,
				);
				return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
			},
			disableAll: async () => {
				const acceptedTools = availableFirecrawlTools(pi);
				const result = await transactSelectedTools(pi, ctx, [], generation, acceptedTools);
				return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: menuSignal,
		isCurrent,
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
	const result = await transactSelectedTools(pi, ctx, selectedTools, generation);
	if (result !== "saved" || !isCurrentFirecrawlSession(generation)) return;
	const status = await buildStatusMessage(pi);
	if (!isCurrentFirecrawlSession(generation)) return;
	ctx.ui.notify(
		sanitizeFirecrawlDisplay(`Firecrawl tool catalog ${action}.\n\n${status}`),
		hasApiKey() ? "info" : "warning",
	);
}

export async function setSelectedFirecrawlTools(
	pi: ExtensionAPI,
	ctx: CommandContext,
	selectedTools: readonly FirecrawlToolName[],
): Promise<boolean> {
	return (await transactSelectedTools(pi, ctx, selectedTools, sessionGeneration)) === "saved";
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
	expectedAvailableTools?: readonly FirecrawlToolName[],
): Promise<ToolSelectionSaveResult> {
	const operation = toolTransactionQueue.then(() =>
		transactSelectedToolsNow(pi, ctx, selectedTools, expectedGeneration, expectedAvailableTools),
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
	expectedAvailableTools?: readonly FirecrawlToolName[],
): Promise<ToolSelectionSaveResult> {
	if (!isCurrentFirecrawlSession(expectedGeneration)) return "failed";
	if (expectedAvailableTools && !arraysEqual(availableFirecrawlTools(pi), expectedAvailableTools)) {
		ctx.ui.notify(
			"Firecrawl tool availability changed while the selector was open. Review the current state and try again.",
			"warning",
		);
		return "available-tools-changed";
	}
	const previousActiveTools = pi.getActiveTools();
	const previousAvailableTools = availableFirecrawlTools(pi);
	try {
		applyFirecrawlTools(pi, selectedTools, ctx.sessionManager);
		await persistSettings(selectedTools);
		return isCurrentFirecrawlSession(expectedGeneration) ? "saved" : "failed";
	} catch (error) {
		let rollbackError: unknown;
		try {
			applyAvailableFirecrawlTools(pi, previousAvailableTools, ctx.sessionManager);
			const currentNonCapabilityTools = pi
				.getActiveTools()
				.filter((name) => !FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName));
			const previousLoadedTools = previousActiveTools.filter((name) =>
				FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName),
			);
			const restoredFirecrawlTools =
				firecrawlToolExposureMode(pi) === "eager" ? previousAvailableTools : previousLoadedTools;
			pi.setActiveTools(unique([...currentNonCapabilityTools, ...restoredFirecrawlTools]));
		} catch (caught) {
			rollbackError = caught;
		}
		if (!isCurrentFirecrawlSession(expectedGeneration)) return "failed";
		ctx.ui.notify(
			sanitizeFirecrawlDisplay(
				rollbackError
					? `Firecrawl settings save failed: ${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`
					: `Firecrawl settings save failed; active tools restored: ${formatError(error)}`,
			),
			"warning",
		);
		return "failed";
	}
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function applyFirecrawlTools(
	pi: ExtensionAPI,
	selectedTools: readonly FirecrawlToolName[],
	sessionOwner?: object,
) {
	applyAvailableFirecrawlTools(pi, selectedTools, sessionOwner);
}

function getToolStatusSummary(pi: ExtensionAPI): ToolStatusSummary {
	const firecrawlToolNames = new Set<string>(FIRECRAWL_TOOL_NAMES);
	const activeToolNames = new Set(pi.getActiveTools());
	const loadedFirecrawlToolCount = FIRECRAWL_TOOL_NAMES.filter((name) =>
		activeToolNames.has(name),
	).length;
	const availableFirecrawlToolCount = availableFirecrawlTools(pi).length;
	const activeNonFirecrawlToolCount = Array.from(activeToolNames).filter(
		(name) => !firecrawlToolNames.has(name) && name !== FIRECRAWL_LOAD_TOOL_NAME,
	).length;
	const availabilityStatus =
		availableFirecrawlToolCount === FIRECRAWL_TOOL_NAMES.length
			? "enabled"
			: availableFirecrawlToolCount === 0
				? "disabled"
				: "partial";

	return {
		availabilityStatus,
		availableFirecrawlToolCount,
		loadedFirecrawlToolCount,
		activeNonFirecrawlToolCount,
	};
}

export async function buildStatusMessage(pi: ExtensionAPI) {
	const generation = sessionGeneration;
	const settings = await loadSettings();
	if (!isCurrentFirecrawlSession(generation)) return "";
	recordSettingsNotice(settings);
	const summary = getToolStatusSummary(pi);
	const persistedSetting = persistedSettingLabel(settings);
	return sanitizeFirecrawlDisplay(
		[
			`Firecrawl tools available: ${formatRuntimeStatus(summary)}`,
			`Tool exposure: ${firecrawlToolExposureMode(pi)}`,
			`Loaded capability tools this session: ${summary.loadedFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length}`,
			`Loader: ${pi.getActiveTools().includes(FIRECRAWL_LOAD_TOOL_NAME) ? "active" : "inactive"}`,
			`Persisted tool catalog: ${persistedSetting}`,
			`Settings file: ${settingsFilePath()}`,
			...(settingsNotice ? [`Settings note: ${settingsNotice}`] : []),
			`Other active tools preserved: ${summary.activeNonFirecrawlToolCount}`,
			`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
			`API URL: ${configuredApiUrl()}`,
		].join("\n"),
	);
}

export function buildConfigMessage() {
	return sanitizeFirecrawlDisplay(
		[
			"Firecrawl configuration:",
			`API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
			`API URL: ${configuredApiUrl()}`,
			"Override API URL with FIRECRAWL_API_URL or FIRECRAWL_BASE_URL.",
			"This extension never logs, displays, or stores your Firecrawl API key.",
		].join("\n"),
	);
}

export function buildCommandGuide() {
	return [
		"Firecrawl commands:",
		"/firecrawl — open this menu",
		"/firecrawl help — show command usage",
		"/firecrawl config — show API key presence and API URL",
		"/firecrawl quickstart — alias for /firecrawl config",
		"/firecrawl status — show tool and settings status",
		"/firecrawl tools — choose available Firecrawl tools",
		"/firecrawl toggle — alias for /firecrawl tools",
		"/firecrawl enable — make all Firecrawl tools available",
		"/firecrawl disable — make all Firecrawl capability tools unavailable",
	].join("\n");
}

function toolSelectorTitle(selectedTools: ReadonlySet<FirecrawlToolName>) {
	return `Available Firecrawl tools (${selectedTools.size}/${FIRECRAWL_TOOL_NAMES.length}). Non-built-in tools run at user risk.`;
}

function isFirecrawlToolName(value: string): value is FirecrawlToolName {
	return FIRECRAWL_TOOL_NAMES.includes(value as FirecrawlToolName);
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
	return `${summary.availabilityStatus} (${summary.availableFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length} available)`;
}

function persistedSettingLabel(settings: SettingsLoadResult) {
	if (settings.kind === "loaded") return formatPersistedSelection(settings.settings.tools);
	if (settings.kind === "invalid") {
		return `none; current availability policy preserved (invalid settings ignored: ${settings.reason})`;
	}
	return "none; current availability policy preserved";
}

export function formatPersistedSelection(tools: readonly FirecrawlToolName[]) {
	if (tools.length === FIRECRAWL_TOOL_NAMES.length) {
		return `all available (${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected)`;
	}
	if (tools.length === 0) return `all unavailable (0/${FIRECRAWL_TOOL_NAMES.length} selected)`;
	return `${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

export function sanitizeFirecrawlDisplay(value: string, maxCharacters = 50_000) {
	const characters = Array.from(stripVTControlCharacters(value), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafeControl =
			(codePoint >= 0 && codePoint <= 8) ||
			(codePoint >= 11 && codePoint <= 31) ||
			(codePoint >= 127 && codePoint <= 159);
		return unsafeControl ? "�" : character;
	});
	const limit = Number.isFinite(maxCharacters) ? Math.max(0, Math.floor(maxCharacters)) : 0;
	if (characters.length <= limit) return characters.join("");
	if (limit === 0) return "";
	return `${characters.slice(0, limit - 1).join("")}…`;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function persistSettings(selectedTools: readonly FirecrawlToolName[]) {
	await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
}
