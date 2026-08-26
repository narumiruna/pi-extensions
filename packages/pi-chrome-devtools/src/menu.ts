import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import { browserLifecycleState, devToolsEndpoint, launchModeLabel } from "./browser-manager.js";
import { availableChromeDevtoolsTools } from "./lazy-tools.js";
import { state } from "./runtime.js";
import { loadSettings, type SettingsLoadResult } from "./settings.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";
import {
	buildBrowserStatusMessage,
	buildCommandGuide,
	sanitizeChromeDevtoolsDisplay,
	setSelectedChromeDevtoolsTools,
} from "./tool-selector.js";

type CommandContext = ExtensionCommandContext;
type MainScreen = "main" | "browserStatus" | "help";
type MainAction = "tools" | "bulk" | "settings";
type ToolScreen = "tools" | "review";
type ToolAction = "toggle" | "selectAll" | "selectNone" | "review" | "apply" | "cancel";

interface MenuSnapshot {
	activeTools: ChromeDevToolsToolName[];
	persistenceLabel: string;
	mutationBlockedReason?: string;
	settingsWarning?: string;
}

interface ToolWorkflowState {
	accepted: Set<ChromeDevToolsToolName>;
	draft: Set<ChromeDevToolsToolName>;
	mutationBlockedReason?: string;
	generation: number;
	applied: boolean;
}

const TOOL_PRESENTATION: Record<ChromeDevToolsToolName, { label: string; description: string }> = {
	chrome_devtools_list_pages: {
		label: "List open pages",
		description: "List inspectable Chrome tabs and pages (chrome_devtools_list_pages).",
	},
	chrome_devtools_select_page: {
		label: "Select the active page",
		description: "Choose the page later browser actions use (chrome_devtools_select_page).",
	},
	chrome_devtools_navigate: {
		label: "Navigate a page",
		description: "Open a URL, creating a page when needed (chrome_devtools_navigate).",
	},
	chrome_devtools_evaluate: {
		label: "Run JavaScript",
		description: "Evaluate JavaScript in the selected page (chrome_devtools_evaluate).",
	},
	chrome_devtools_screenshot: {
		label: "Capture a screenshot",
		description: "Save a PNG of the selected page (chrome_devtools_screenshot).",
	},
};

export async function showChromeDevtoolsMenu(
	pi: ExtensionAPI,
	ctx: CommandContext,
	generation: number,
) {
	const snapshot = await loadSnapshotWithFeedback(pi, ctx, generation);
	if (!snapshot) return;
	const menuSignal = state.sessionController.signal;
	const isCurrent = () => generation === state.sessionGeneration && !menuSignal.aborted;
	const menu = defineMenu<MenuSnapshot, MainScreen, MainAction>({
		start: "main",
		screens: {
			main: ({ state: current }) => ({
				kind: "actions",
				title: "Chrome DevTools",
				lines: mainStateLines(current),
				items: [
					{
						id: "tools",
						label: "Choose available browser tools…",
						description: "Choose which capabilities the loader may expose.",
						disabled: Boolean(current.mutationBlockedReason),
						disabledReason: current.mutationBlockedReason,
						action: "tools",
					},
					{
						id: "bulk",
						label:
							current.activeTools.length === CHROME_DEVTOOLS_TOOL_NAMES.length
								? "Make all browser tools unavailable…"
								: "Make all browser tools available…",
						description:
							current.activeTools.length === CHROME_DEVTOOLS_TOOL_NAMES.length
								? "Preview 0 of 5; other active tools stay enabled."
								: "Preview 5 of 5; other active tools stay enabled.",
						disabled: Boolean(current.mutationBlockedReason),
						disabledReason: current.mutationBlockedReason,
						action: "bulk",
					},
					{
						id: "browser-status",
						label: "Browser status",
						description: "Runtime, endpoint, and last launch attempt.",
						to: "browserStatus",
					},
					{
						id: "settings",
						label: "Browser settings",
						description: "Edit endpoint, auto-launch, and browser executable settings.",
						action: "settings",
					},
					{
						id: "help",
						label: "Help",
						description: "Commands and usage.",
						to: "help",
					},
				],
				hint: "close",
			}),
			browserStatus: () => ({
				kind: "review",
				title: "Browser status",
				content: buildBrowserStatusMessage(),
				format: { kind: "text" },
				viewportSize: "adaptive",
				hint: "back",
			}),
			help: () => ({
				kind: "review",
				title: "Chrome DevTools help",
				content: buildCommandGuide(),
				format: { kind: "text" },
				viewportSize: "adaptive",
				hint: "back",
			}),
		},
		actions: {
			tools: async ({ state: current }) => {
				const result = await showChromeDevtoolsToolWorkflow(pi, ctx, generation, {
					snapshot: current,
				});
				if (result?.applied && isCurrent()) updateSnapshotAfterApply(current, result.selectedTools);
				return result?.closeParent ? { kind: "close" } : { kind: "stay" };
			},
			bulk: async ({ state: current }) => {
				const selectedTools =
					current.activeTools.length === CHROME_DEVTOOLS_TOOL_NAMES.length
						? []
						: [...CHROME_DEVTOOLS_TOOL_NAMES];
				const result = await showChromeDevtoolsToolWorkflow(pi, ctx, generation, {
					snapshot: current,
					initialDraft: selectedTools,
					startAtReview: true,
				});
				if (result?.applied && isCurrent()) updateSnapshotAfterApply(current, result.selectedTools);
				return result?.closeParent ? { kind: "close" } : { kind: "stay" };
			},
			settings: async () => {
				const { showChromeDevtoolsBrowserSettings } = await import("./browser-settings-menu.js");
				if (!isCurrent()) return { kind: "stay" };
				const result = await showChromeDevtoolsBrowserSettings(ctx, generation);
				if (!isCurrent()) return { kind: "stay" };
				return result.closeParent ? { kind: "close" } : { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => snapshot,
		signal: menuSignal,
		isCurrent,
		onError: (currentCtx, error) =>
			currentCtx.ui.notify(
				sanitizeChromeDevtoolsDisplay(`Chrome DevTools menu failed: ${formatError(error)}`),
				"error",
			),
	});
}

export async function showChromeDevtoolsToolWorkflow(
	pi: ExtensionAPI,
	ctx: CommandContext,
	generation: number,
	options: {
		snapshot?: MenuSnapshot;
		initialDraft?: readonly ChromeDevToolsToolName[];
		startAtReview?: boolean;
	} = {},
): Promise<
	{ applied: boolean; closeParent: boolean; selectedTools: ChromeDevToolsToolName[] } | undefined
> {
	const snapshot = options.snapshot ?? (await loadSnapshotWithFeedback(pi, ctx, generation));
	if (!snapshot) return undefined;
	const menuSignal = state.sessionController.signal;
	const isCurrent = () => generation === state.sessionGeneration && !menuSignal.aborted;
	const accepted = new Set(snapshot.activeTools);
	const workflow: ToolWorkflowState = {
		accepted,
		draft: new Set(options.initialDraft ?? snapshot.activeTools),
		mutationBlockedReason: snapshot.mutationBlockedReason,
		generation,
		applied: false,
	};
	const menu = defineMenu<ToolWorkflowState, ToolScreen, ToolAction>({
		start: options.startAtReview ? "review" : "tools",
		screens: {
			tools: ({ state: current }) => ({
				kind: "multiSelect",
				title: `Browser tools (${current.draft.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length})`,
				lines: toolDraftLines(current),
				items: CHROME_DEVTOOLS_TOOL_NAMES.map((toolName) => ({
					id: toolName,
					label: TOOL_PRESENTATION[toolName].label,
					description: TOOL_PRESENTATION[toolName].description,
					searchText: `${toolName} ${TOOL_PRESENTATION[toolName].description}`,
					selected: current.draft.has(toolName),
					disabled: Boolean(current.mutationBlockedReason),
					disabledReason: current.mutationBlockedReason,
				})),
				action: "toggle",
				actions: [
					{
						id: "select-all",
						label: "Select all",
						disabled: Boolean(current.mutationBlockedReason),
						disabledReason: current.mutationBlockedReason,
						action: "selectAll",
					},
					{
						id: "select-none",
						label: "Select none",
						disabled: Boolean(current.mutationBlockedReason),
						disabledReason: current.mutationBlockedReason,
						action: "selectNone",
					},
					{
						id: "review",
						label: "Review changes…",
						disabled:
							Boolean(current.mutationBlockedReason) || setsEqual(current.accepted, current.draft),
						disabledReason:
							current.mutationBlockedReason ??
							(setsEqual(current.accepted, current.draft) ? "No unapplied changes" : undefined),
						to: "review",
					},
					{ id: "cancel", label: "Cancel", action: "cancel" },
				],
				hint: "back",
			}),
			review: ({ state: current }) => ({
				kind: "review",
				title: "Review tool changes",
				lines: [
					`Currently available: ${current.accepted.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
					`Proposed availability: ${current.draft.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
				],
				content: buildToolReview(current),
				format: { kind: "text" },
				viewportSize: "adaptive",
				...(current.mutationBlockedReason || setsEqual(current.accepted, current.draft)
					? {}
					: {
							confirm: {
								id: "apply",
								label: "Apply tool changes",
								action: "apply" as const,
							},
						}),
				hint: "back",
			}),
		},
		actions: {
			toggle: ({ state: current, itemId, selected }) => {
				if (!isChromeDevtoolsToolName(itemId) || selected === undefined)
					return { kind: "rejected" };
				if (selected) current.draft.add(itemId);
				else current.draft.delete(itemId);
				return { kind: "stay" };
			},
			selectAll: ({ state: current }) => {
				current.draft = new Set(CHROME_DEVTOOLS_TOOL_NAMES);
				return { kind: "stay" };
			},
			selectNone: ({ state: current }) => {
				current.draft = new Set();
				return { kind: "stay" };
			},
			review: () => ({ kind: "to", screen: "review" }),
			cancel: () => ({ kind: "back" }),
			apply: async ({ state: current, signal }) => {
				await ctx.waitForIdle();
				if (signal.aborted || !isCurrent() || current.generation !== state.sessionGeneration) {
					return { kind: "rejected" };
				}
				const selectedTools = orderedTools(current.draft);
				const saveResult = await setSelectedChromeDevtoolsTools(
					pi,
					ctx,
					selectedTools,
					orderedTools(current.accepted),
				);
				if (!isCurrent()) return { kind: "rejected" };
				if (saveResult === "active-tools-changed") {
					current.accepted = new Set(activeChromeTools(pi));
				}
				if (saveResult !== "saved") return { kind: "rejected" };
				current.accepted = new Set(selectedTools);
				current.draft = new Set(selectedTools);
				current.applied = true;
				ctx.ui.notify(
					`Saved: ${selectedTools.length} of ${CHROME_DEVTOOLS_TOOL_NAMES.length} browser tools available.`,
					"info",
				);
				return { kind: "close" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: () => workflow,
		signal: menuSignal,
		isCurrent,
		onError: (currentCtx, error) =>
			currentCtx.ui.notify(
				sanitizeChromeDevtoolsDisplay(
					`Chrome DevTools tool selection failed: ${formatError(error)}`,
				),
				"error",
			),
	});
	return {
		applied: workflow.applied,
		closeParent: !workflow.applied && result.kind === "closed" && result.reason === "close",
		selectedTools: orderedTools(workflow.accepted),
	};
}

async function loadSnapshotWithFeedback(pi: ExtensionAPI, ctx: CommandContext, generation: number) {
	const menuSignal = state.sessionController.signal;
	const isCurrent = () => generation === state.sessionGeneration && !menuSignal.aborted;
	const result = await runTask(ctx, {
		label: "Loading Chrome DevTools settings…",
		signal: menuSignal,
		isCurrent,
		task: async ({ signal }) => {
			signal.throwIfAborted();
			const settings = await loadSettings();
			signal.throwIfAborted();
			return buildMenuSnapshot(pi, settings);
		},
	});
	return result.kind === "completed" ? result.value : undefined;
}

function buildMenuSnapshot(pi: ExtensionAPI, settings: SettingsLoadResult): MenuSnapshot {
	const activeTools = activeChromeTools(pi);
	const persistedTools =
		settings.kind === "loaded" && settings.settings.tools
			? orderedTools(new Set(settings.settings.tools))
			: undefined;
	const persistenceLabel =
		settings.kind === "invalid"
			? "settings need repair"
			: persistedTools === undefined
				? "not saved"
				: arraysEqual(activeTools, persistedTools)
					? "saved"
					: "runtime catalog differs from saved catalog";
	const settingsWarning = [
		...new Set([settings.notice, state.settingsNotice].filter(Boolean)),
	].join("\n");
	return {
		activeTools,
		persistenceLabel,
		...(settings.kind === "invalid"
			? { mutationBlockedReason: `Repair ${settings.reason} before saving` }
			: {}),
		...(settingsWarning ? { settingsWarning } : {}),
	};
}

function mainStateLines(snapshot: MenuSnapshot) {
	return sanitizeLines([
		`Tool catalog: ${snapshot.activeTools.length} of ${CHROME_DEVTOOLS_TOOL_NAMES.length} available · ${snapshot.persistenceLabel}`,
		`Browser: ${browserLifecycleSummary()}`,
		`Endpoint: ${devToolsEndpoint()}`,
		...(snapshot.settingsWarning ? [`Settings warning: ${snapshot.settingsWarning}`] : []),
		...(state.lastLaunchAttempt?.lastError
			? [`Launch warning: ${state.lastLaunchAttempt.lastError}`]
			: []),
	]);
}

function browserLifecycleSummary() {
	const lifecycle = browserLifecycleState();
	if (lifecycle === "starting") return "starting managed browser";
	if (lifecycle === "running") return "managed browser running";
	if (lifecycle === "exited") return "managed browser exited · open Browser status to recover";
	if (lifecycle === "failed") return "last launch failed · open Browser status to recover";
	const launchMode = launchModeLabel();
	return launchMode.startsWith("attach first")
		? "not started · attaches or launches on first use"
		: `not started · ${launchMode}`;
}

function toolDraftLines(current: ToolWorkflowState) {
	if (current.mutationBlockedReason)
		return sanitizeLines([`Unavailable: ${current.mutationBlockedReason}`]);
	const changes = symmetricDifferenceSize(current.accepted, current.draft);
	return [
		`Currently available: ${current.accepted.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
		changes === 0
			? "No unapplied changes · Escape cancels"
			: `${changes} unapplied ${changes === 1 ? "change" : "changes"} · Escape cancels`,
		"Changes are not applied until Review changes and Apply tool changes.",
	];
}

function buildToolReview(current: ToolWorkflowState) {
	const available = CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => current.draft.has(name));
	const unavailable = CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => !current.draft.has(name));
	return sanitizeChromeDevtoolsDisplay(
		[
			`Current available browser tools: ${current.accepted.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
			`Proposed available browser tools: ${current.draft.size}/${CHROME_DEVTOOLS_TOOL_NAMES.length}`,
			"",
			"Available after apply:",
			...(available.length > 0
				? available.map((name) => `  - ${TOOL_PRESENTATION[name].label} (${name})`)
				: ["  - none"]),
			"",
			"Unavailable after apply:",
			...(unavailable.length > 0
				? unavailable.map((name) => `  - ${TOOL_PRESENTATION[name].label} (${name})`)
				: ["  - none"]),
			"",
			"Other active Pi tools remain unchanged.",
			"Native-capable models defer these tools until chrome_devtools_load selects them.",
			"Other models expose available tools eagerly before the next model request.",
			"The accepted availability policy is saved for future sessions.",
		].join("\n"),
	);
}

function updateSnapshotAfterApply(
	snapshot: MenuSnapshot,
	selectedTools: readonly ChromeDevToolsToolName[],
) {
	snapshot.activeTools = [...selectedTools];
	snapshot.persistenceLabel = "saved";
}

function activeChromeTools(pi: ExtensionAPI) {
	return availableChromeDevtoolsTools(pi);
}

function orderedTools(tools: ReadonlySet<ChromeDevToolsToolName>) {
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => tools.has(toolName));
}

function isChromeDevtoolsToolName(value: string): value is ChromeDevToolsToolName {
	return CHROME_DEVTOOLS_TOOL_NAMES.includes(value as ChromeDevToolsToolName);
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function symmetricDifferenceSize<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
	let changes = 0;
	for (const value of left) if (!right.has(value)) changes += 1;
	for (const value of right) if (!left.has(value)) changes += 1;
	return changes;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeLines(lines: readonly string[]) {
	return sanitizeChromeDevtoolsDisplay(lines.join("\n")).split("\n");
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
