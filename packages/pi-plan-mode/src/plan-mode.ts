import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputSource,
} from "@earendil-works/pi-coding-agent";
import { completePlanArguments } from "./command.js";
import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_PARAMS,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planModeCompleted,
	renderPlanModeCompletion,
} from "./completion-tool.js";
import { isStaleExtensionContextError } from "./extension-runtime.js";
import {
	createFinalizationRequestCoordinator,
	FINALIZE_PLAN_PROMPT,
	type FinalizationRunOutcome,
	RETRY_FINALIZE_PLAN_PROMPT,
} from "./finalization-request.js";
import { createDeferredFreshHandoffCoordinator } from "./fresh-handoff-coordinator.js";
import {
	formatHistoryImplementationPrompt,
	formatImplementationHandoff,
	formatTransferredPlanPrompt,
	startFreshImplementationFromState,
} from "./fresh-implementation.js";
import {
	createImplementationRetentionCoordinator,
	implementationRetentionPreview,
} from "./implementation-retention.js";
import {
	invalidPlanMessage,
	latestAssistantStopReason,
	latestAssistantText,
	messageTextContent,
	parseProposedPlan,
} from "./message-transform.js";
import {
	createModeContractMessage,
	hasModeContractArtifact,
	latestModeContract,
	MODE_CONTRACT_MESSAGE_TYPE,
	type PlanModeContract,
	reconcileModeContract,
} from "./mode-contract.js";
import {
	createPlanActionController,
	type FreshImplementationTiming,
} from "./plan-action-controller.js";
import { createPlanExportController } from "./plan-export-controller.js";
import {
	clearPlanModeUi,
	planModeStatusText as formatPlanModeStatusText,
	showStoredPlan,
	updatePlanModeUi,
} from "./presentation.js";
import {
	answerPlanModeQuestions,
	normalizePlanModeQuestionParams,
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	planModeQuestionCancelled,
} from "./question-tool.js";
import {
	assertPlanModeHelperToolsAvailable,
	planModeHelperToolsAvailable,
} from "./required-tools.js";
import {
	preflightSavedPlanImplementation,
	savedPlanBlocksNewWorkflow,
} from "./saved-plan-preflight.js";
import {
	awaitPlanModeSettingsWrites,
	configuredImplementationPlanRetention,
	configuredPlanModeToggleShortcut,
	configuredThinkingLevel,
	type ImplementationPlanRetention,
	type PlanModeSettings,
	type PlanModeSettingsPatch,
	planModeSettingsPath,
	readPlanModeSettings,
	type UpdatePlanModeSettingsOptions,
	updatePlanModeSettings,
} from "./settings.js";
import {
	type ImplementationRuntimeSelection,
	type PlanCompletionSource,
	type PlanModeState,
	type PlanModeWorkflowToolPolicy,
	restorePlanModeState,
} from "./state.js";
import {
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	findBlockedCommandSegment,
	findBlockedPowerShellCommandSegment,
	readCommand,
} from "./tool-policy.js";
import { compareTools, snapshotPlanModeSelectedNames, toolPolicyLabel } from "./tool-selection.js";
import { WorkflowMutex, type WorkflowMutexOwner } from "./workflow-mutex.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE = "plan-mode-recovered-input";
const BLOCKED_MUTATING_TOOLS = new Set(["edit", "write", "update_plan"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
interface ReadyPresentationIntent {
	nonce: number;
	plan: string;
	source: PlanCompletionSource;
}
interface DeferredFreshImplementation {
	ctx: ExtensionContext;
	sourceSession: object;
	menuGeneration: number;
	workflowGeneration: number;
	workflowOwner: WorkflowMutexOwner | undefined;
	enabled: boolean;
	plan: string;
	source: PlanCompletionSource;
	savedPlan: PlanModeState["savedPlan"];
	retention: ImplementationPlanRetention;
	runtime: ImplementationRuntimeSelection | undefined;
	menuIsCurrent(): boolean;
}
interface PendingWorkflowToolPolicy {
	generation: number;
	mode: "resolve" | "revalidate";
}
type ImplementationRuntimeApplicationResult = "ready" | "blocked" | "stale";
interface ActiveImplementationRuntimeApplication {
	sessionManager: ExtensionContext["sessionManager"];
	completion: Promise<ImplementationRuntimeApplicationResult>;
	drainOnShutdown: boolean;
	holdForAdmission: boolean;
}
interface QueuedRuntimeAdmissionInput {
	sessionManager: ExtensionContext["sessionManager"];
	text: string;
	images?: NonNullable<InputEvent["images"]>;
	source: InputSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
	readSettings?(): ReturnType<typeof readPlanModeSettings>;
	updateSettings?(
		patch: PlanModeSettingsPatch,
		options?: UpdatePlanModeSettingsOptions,
	): ReturnType<typeof updatePlanModeSettings>;
	settingsPath?: string;
	loadInteractiveUi?(): Promise<InteractiveUi>;
}

// Keep session state, persistence, tool, thinking, and mutex commits in this one closure so an
// activation path cannot bypass the same atomic transition by crossing module-owned state.
export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
	const workflowMutex = new WorkflowMutex(pi);
	let workflowOwner: WorkflowMutexOwner | undefined;
	let currentSession: object | undefined;
	let currentSessionContext: ExtensionContext | undefined;
	let interactiveUiPromise: Promise<InteractiveUi> | undefined;
	const loadInteractiveUi = () => {
		if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
		if (!interactiveUiPromise) {
			interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
				interactiveUiPromise = undefined;
				throw error;
			});
		}
		return interactiveUiPromise;
	};
	const explicitPlanModeSettingsPath = dependencies.settingsPath;
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let settings: PlanModeSettings = { thinkingLevel: "inherit" };
	let toggleShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>;
	const clearPlanModeShortcutHandler = () => {};
	let workflowAllowedToolNames: string[] | undefined;
	let pendingWorkflowToolPolicy: PendingWorkflowToolPolicy | undefined;
	let publishedContractMode: PlanModeContract | undefined;
	let modeContractsRelevant = false;
	let readyPresentationIntent: ReadyPresentationIntent | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;
	let stagedFreshImplementation: DeferredFreshImplementation | undefined;
	const deferredFreshHandoff = createDeferredFreshHandoffCoordinator();
	let nextReadyPresentationNonce = 0;
	let menuGeneration = 0;
	let workflowGeneration = 0;
	let refreshStateBeforeFirstAgentStart = false;
	let activeImplementationRuntimeApplication: ActiveImplementationRuntimeApplication | undefined;
	let pendingRuntimeAdmissionSession: object | undefined;
	let queuedRuntimeAdmissionInputs: QueuedRuntimeAdmissionInput[] = [];
	let menuController = new AbortController();
	let settingsWatch: ReturnType<typeof watch> | undefined;
	let settingsReloadTimer: ReturnType<typeof setTimeout> | undefined;
	const implementationRetention = createImplementationRetentionCoordinator();
	const finalizationRequest = createFinalizationRequestCoordinator();
	const persistState = () => pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	const planExports = createPlanExportController({
		getState: () => state,
		getSettings: () => settings,
		finishReady: (ctx) => {
			exitPlanMode(ctx);
		},
	});
	const planActions = createPlanActionController({
		loadInteractiveUi,
		getState: () => state,
		captureLifecycle: captureMenuLifecycle,
		statusText: planStatusText,
		// ExtensionContext.thinkingLevel was added after the supported Pi 0.80.6 floor.
		// ExtensionAPI has exposed the same runtime value throughout that compatibility range.
		getThinkingLevel: () => pi.getThinkingLevel(),
		getSettings: () => settings,
		implementationOutcome,
		getExportDestination: (ctx) => planExports.getDestination(ctx),
		show: (ctx) => showStoredPlan(pi, ctx, state),
		finalize: requestFinalPlan,
		implementHere: startImplementation,
		implementFresh: startFreshImplementation,
		exportPlan: exportPlan,
		settings: showSettings,
		save: savePlanForLater,
		stay: updateUi,
		exitReady: (ctx) => {
			if (exitPlanMode(ctx)) {
				ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
			}
		},
		clearSaved: (ctx) => {
			if (exitPlanMode(ctx)) ctx.ui.notify("Saved plan cleared.", "info");
		},
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask one to three structured questions only when the latest effective Plan contract explicitly says /plan mode is active. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}
			finalizationRequest.satisfy();

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const sessionGeneration = menuGeneration;
			const questionWorkflowGeneration = workflowGeneration;
			const questionOwner = workflowOwner;
			return answerPlanModeQuestions(parsed.questions, ctx, {
				isCurrent: () =>
					sessionGeneration === menuGeneration &&
					questionWorkflowGeneration === workflowGeneration &&
					workflowMutex.isOwner(questionOwner),
				isEnabled: () => state.enabled,
			});
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Complete plan",
		description:
			"Submit a decision-ready plan only when the latest effective Plan contract explicitly says /plan mode is active, and call it alone as the final action. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		renderResult: renderPlanModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
			return planModeCompleted(parsed.plan);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			latestCommandContext = ctx;
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "start") {
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
				if (state.enabled) {
					ctx.ui.notify("Plan mode is already active.", "info");
					return;
				}
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
				return;
			}
			if (command === "show") {
				showStoredPlan(pi, ctx, state);
				return;
			}
			if (command === "finalize") {
				requestFinalPlan(ctx);
				return;
			}
			if (command === "implement") {
				if (!(state.enabled && state.latestPlan?.trim()) && !state.savedPlan?.plan.trim()) {
					ctx.ui.notify("No completed plan is available to implement.", "warning");
					return;
				}
				await startImplementation(ctx);
				return;
			}
			if (command === "save") {
				savePlanForLater(ctx);
				return;
			}
			if (command === "settings") {
				if (!ctx.hasUI) {
					throw new Error("/plan settings requires TUI or RPC mode and is unavailable here.");
				}
				const lifecycle = captureMenuLifecycle();
				await showSettings(ctx, lifecycle.signal, lifecycle.isCurrent);
				return;
			}
			const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
			if (exportMatch) {
				const lifecycle = captureMenuLifecycle();
				await exportPlan(ctx, exportMatch[1], lifecycle.signal, lifecycle.isCurrent);
				return;
			}
			if (command === "exit" || command === "off") {
				const notification = planModeDisableNotification();
				if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
				return;
			}
			if (command === "tools") {
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
				if (state.enabled) {
					const message =
						"Plan-mode tools are locked while Planning is active. Exit Plan mode and choose tools before starting again.";
					if (!ctx.hasUI) throw new Error(message);
					ctx.ui.notify(message, "warning");
					return;
				}
				if (!ctx.hasUI) {
					throw new Error("/plan tools requires TUI or RPC mode and is unavailable here.");
				}
				await showLaunchMenu(ctx, "tools");
				return;
			}
			if (prompt) {
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!ctx.hasUI) {
				throw new Error(
					"The interactive /plan menu is unavailable in print and JSON modes. Use /plan start or /plan <prompt>.",
				);
			}
			if (!state.enabled) {
				if (state.activeImplementation && ctx.hasUI) {
					await showActivePlanMenu(ctx);
					return;
				}
				if (state.savedPlan) {
					await planActions.showSaved(ctx);
					return;
				}
				await showLaunchMenu(ctx);
				return;
			}
			await planActions.showCurrent(ctx);
		},
	});

	const applyPlanModeShortcut = (
		nextShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>,
	) => {
		if (toggleShortcut && toggleShortcut !== nextShortcut) {
			pi.registerShortcut(toggleShortcut, {
				handler: clearPlanModeShortcutHandler,
			});
		}
		if (!nextShortcut) {
			toggleShortcut = undefined;
			return;
		}
		if (toggleShortcut === nextShortcut) return;
		pi.registerShortcut(nextShortcut, {
			description: "Toggle Plan mode",
			handler: (ctx) => {
				togglePlanMode(ctx);
			},
		});
		toggleShortcut = nextShortcut;
	};

	const readPlanModeRuntimeSettings = async () => {
		return dependencies.readSettings?.() ?? readPlanModeSettings(explicitPlanModeSettingsPath);
	};

	const applyPlanModeSettings = async (
		generation: number,
		ctx: ExtensionContext | undefined,
		showWarnings: boolean,
	) => {
		const loadedSettings = await readPlanModeRuntimeSettings();
		if (generation !== menuGeneration || menuController.signal.aborted) {
			return undefined;
		}
		settings =
			loadedSettings.kind === "loaded"
				? loadedSettings.settings
				: ({ thinkingLevel: "inherit" } satisfies PlanModeSettings);
		applyPlanModeShortcut(configuredPlanModeToggleShortcut(settings));
		if (!ctx || !showWarnings) return loadedSettings;
		if (loadedSettings.kind === "invalid") {
			ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
		}
		if (loadedSettings.notice) {
			ctx.ui.notify(loadedSettings.notice, "warning");
		}
		return loadedSettings;
	};

	const stopPlanModeSettingsWatch = () => {
		if (settingsReloadTimer) {
			clearTimeout(settingsReloadTimer);
			settingsReloadTimer = undefined;
		}
		settingsWatch?.close();
		settingsWatch = undefined;
	};

	const schedulePlanModeSettingsReload = (generation: number) => {
		if (settingsReloadTimer) {
			clearTimeout(settingsReloadTimer);
			settingsReloadTimer = undefined;
		}
		settingsReloadTimer = setTimeout(() => {
			settingsReloadTimer = undefined;
			void applyPlanModeSettings(generation, currentSessionContext, false);
		}, 75);
	};

	const startPlanModeSettingsWatch = (generation: number) => {
		stopPlanModeSettingsWatch();
		if (dependencies.readSettings) return;
		const pathToWatch = explicitPlanModeSettingsPath ?? planModeSettingsPath();
		try {
			const directory = dirname(pathToWatch);
			const fileName = basename(pathToWatch);
			const watcher = watch(directory, { persistent: false }, (event, changedFile) => {
				if (event !== "rename" && event !== "change") return;
				if (!changedFile || changedFile.toString() !== fileName) return;
				schedulePlanModeSettingsReload(generation);
			});
			watcher.on("error", () => {
				stopPlanModeSettingsWatch();
			});
			settingsWatch = watcher;
		} catch {
			stopPlanModeSettingsWatch();
		}
	};

	pi.on("session_start", async (event, ctx) => {
		cancelDeferredFreshImplementation();
		const generation = ++menuGeneration;
		finalizationRequest.reset();
		currentSession = ctx.sessionManager;
		currentSessionContext = ctx;
		workflowOwner = undefined;
		workflowMutex.bindSession(ctx.sessionManager);
		refreshStateBeforeFirstAgentStart = event.reason === "new";
		pendingRuntimeAdmissionSession = undefined;
		queuedRuntimeAdmissionInputs = [];
		menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		workflowAllowedToolNames = undefined;
		pendingWorkflowToolPolicy = undefined;
		implementationRetention.reset();
		settings = { thinkingLevel: "inherit" };
		const branch = ctx.sessionManager.getBranch();
		const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
		restoreModeContractTracking(branch, restoredState);
		state = { enabled: false, awaitingAction: false };
		await applyPlanModeSettings(generation, ctx, true);
		if (generation !== menuGeneration || menuController.signal.aborted) return;
		startPlanModeSettingsWatch(generation);
		if (!installRestoredState(restoredState, ctx)) return;
		implementationRetention.restore(state.activeImplementation);
		updateUi(ctx);
		// A new session receives its setup entries after session_start, so its input gate refreshes
		// them. Resumed and forked sessions already have the intent and must apply it here because
		// extension-triggered custom-message turns bypass both input and before_agent_start.
		if (event.reason !== "new") await applyPendingImplementationRuntime(ctx);
	});

	pi.on("session_before_tree", (event, ctx) => {
		if (runtimeAdmissionIsPending(ctx.sessionManager)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Wait for fresh implementation startup to admit the pending prompts before changing branches.",
					"warning",
				);
			}
			return { cancel: true };
		}
		const target = ctx.sessionManager.getEntry(event.preparation.targetId);
		if (target?.type !== "custom_message" || target.customType !== MODE_CONTRACT_MESSAGE_TYPE) {
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Plan mode transition markers are internal. Select the adjacent conversation entry instead.",
				"warning",
			);
		}
		return { cancel: true };
	});

	pi.on("session_tree", async (_event, ctx) => {
		cancelDeferredFreshImplementation();
		advanceWorkflowGeneration();
		menuGeneration += 1;
		menuController.abort(new DOMException("Plan-mode tree branch changed", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		pendingRuntimeAdmissionSession = undefined;
		queuedRuntimeAdmissionInputs = [];
		implementationRetention.reset();
		const branch = ctx.sessionManager.getBranch();
		const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
		restoreModeContractTracking(branch, restoredState);
		if (!installRestoredState(restoredState, ctx)) return;
		implementationRetention.restore(state.activeImplementation);
		startPlanModeSettingsWatch(menuGeneration);
		updateUi(ctx);
		await applyPendingImplementationRuntime(ctx);
	});

	pi.on("thinking_level_select", (event) => {
		if (!state.enabled || !state.appliedThinkingLevel) return;
		if (event.level !== state.appliedThinkingLevel) {
			state = {
				...state,
				manualThinkingLevel: event.level,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			persistState();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cancelDeferredFreshImplementation();
		const shutdownSession = ctx.sessionManager;
		const runtimeApplication =
			activeImplementationRuntimeApplication?.sessionManager === shutdownSession &&
			activeImplementationRuntimeApplication.drainOnShutdown
				? activeImplementationRuntimeApplication
				: undefined;
		const queuedInputs = takeQueuedRuntimeAdmissionInputs(shutdownSession);
		for (const queued of queuedInputs) {
			pi.sendMessage(
				{
					customType: RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE,
					content: runtimeAdmissionInputContent(queued),
					display: true,
					details: { source: queued.source },
				},
				{ triggerTurn: false },
			);
		}
		finalizationRequest.reset();
		menuGeneration += 1;
		menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		refreshStateBeforeFirstAgentStart = false;
		pendingRuntimeAdmissionSession = undefined;
		queuedRuntimeAdmissionInputs = [];
		workflowAllowedToolNames = undefined;
		pendingWorkflowToolPolicy = undefined;
		implementationRetention.reset();
		if (runtimeApplication) await runtimeApplication.completion;
		if (currentSession !== undefined && currentSession !== shutdownSession) {
			workflowMutex.unbindSession(shutdownSession);
			return;
		}
		await awaitPlanModeSettingsWrites(dependencies.settingsPath);
		if (currentSession !== undefined && currentSession !== shutdownSession) {
			workflowMutex.unbindSession(shutdownSession);
			return;
		}
		captureManualThinkingLevel();
		persistState();
		if (state.enabled) restoreThinkingLevel();
		stopPlanModeSettingsWatch();
		clearUi(ctx);
		releaseWorkflowOwner();
		workflowMutex.unbindSession(ctx.sessionManager);
		if (currentSession === ctx.sessionManager) {
			currentSession = undefined;
			currentSessionContext = undefined;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const requiredHelper =
			event.toolName === PLAN_MODE_QUESTION_TOOL_NAME ||
			event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME;
		if (!state.enabled) {
			if (!requiredHelper) return;
			return {
				block: true,
				reason: `${event.toolName} is only available while Plan mode is active.`,
			};
		}
		if (!workflowMutex.isOwner(workflowOwner)) {
			return {
				block: true,
				reason: `Plan mode blocks tool '${event.toolName}' because workflow ownership is unavailable.`,
			};
		}
		if (BLOCKED_MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					event.toolName === "update_plan"
						? "Plan mode blocks update_plan because it tracks execution progress rather than conversational planning."
						: `Plan mode blocks mutating tool '${event.toolName}'.`,
			};
		}
		if (requiredHelper) return;

		const calledTool = toolByName(event.toolName);
		const activeToolNames = new Set(safeGetActiveTools());
		if (!calledTool) {
			return {
				block: true,
				reason: activeToolNames.has(event.toolName)
					? `Plan mode blocks tool '${event.toolName}' because its safe policy metadata is unavailable.`
					: `Plan mode blocks tool '${event.toolName}' because it is not registered or active. Register and activate it before starting the next Plan workflow.`,
			};
		}
		if (classifyPlanModeTool(calledTool) === "blocked") {
			return {
				block: true,
				reason: `Plan mode blocks tool '${event.toolName}' because its built-in policy is blocked and settings cannot enable it.`,
			};
		}
		const allowedToolNames = new Set(planModePolicyToolNames());
		if (!activeToolNames.has(event.toolName)) {
			return {
				block: true,
				reason: allowedToolNames.has(event.toolName)
					? `Plan mode blocks tool '${event.toolName}' because it was admitted to the active Plan workflow but is currently inactive. Reactivate it to continue without restarting.`
					: `Plan mode blocks tool '${event.toolName}' because it is registered but inactive. Activate it before starting the next Plan workflow.`,
			};
		}
		if (!allowedToolNames.has(event.toolName)) {
			return {
				block: true,
				reason: workflowDesiredToolNames().has(event.toolName)
					? `Plan mode blocks tool '${event.toolName}' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is active.`
					: `Plan mode blocks tool '${event.toolName}' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.`,
			};
		}
		if (event.toolName === "bash") {
			const blocked = findBlockedCommandSegment(
				readCommand(event.input),
				settings.safeSubcommands,
				ctx.cwd,
			);
			if (blocked !== undefined) {
				return {
					block: true,
					reason: `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${blocked}`,
				};
			}
		}
		if (event.toolName === "powershell") {
			const blocked = findBlockedPowerShellCommandSegment(
				readCommand(event.input),
				settings.safeSubcommands,
				ctx.cwd,
			);
			if (blocked !== undefined) {
				return {
					block: true,
					reason: `Plan mode blocks PowerShell commands outside its reviewed inspection policy or containing explicitly unsafe syntax.\nBlocked command: ${blocked}`,
				};
			}
		}
	});

	pi.on("message_start", (event) => {
		if (
			state.enabled &&
			event.message.role === "user" &&
			messageTextContent(event.message).trim() === FINALIZE_PLAN_PROMPT
		) {
			finalizationRequest.request(workflowGeneration);
		}
	});

	pi.on("context", async (event, ctx) => {
		resolvePendingWorkflowToolPolicy(ctx);
		const result = implementationRetention.transformContext(event.messages, state);
		if (result.clearActiveImplementationId) {
			clearActiveImplementation(result.clearActiveImplementationId, ctx);
		}
		const messages =
			state.enabled || modeContractsRelevant
				? reconcileModeContract(result.messages, state.enabled ? "plan" : "normal")
				: result.messages;
		return { messages: messages as typeof event.messages };
	});

	pi.on("input", async (event, ctx) => {
		refreshStateForFirstPrompt(ctx);
		const waitsForRuntimeAdmission =
			activeImplementationRuntimeApplication?.sessionManager === ctx.sessionManager ||
			pendingRuntimeAdmissionSession === ctx.sessionManager;
		const queuedInput = waitsForRuntimeAdmission
			? {
					sessionManager: ctx.sessionManager,
					text: event.text,
					...(event.images ? { images: [...event.images] } : {}),
					source: event.source,
				}
			: undefined;
		if (queuedInput) queuedRuntimeAdmissionInputs.push(queuedInput);
		const result = await applyPendingImplementationRuntime(ctx, true);
		if (result !== "ready") {
			if (result === "stale" && queuedInput) removeQueuedRuntimeAdmissionInput(queuedInput);
			return { action: "handled" };
		}
		if (queuedInput) return { action: "handled" };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (currentSession !== ctx.sessionManager) return;
		if (pendingRuntimeAdmissionSession === ctx.sessionManager) {
			pendingRuntimeAdmissionSession = undefined;
		}
		const queuedInputs = takeQueuedRuntimeAdmissionInputs(ctx.sessionManager);
		for (const queued of queuedInputs) {
			pi.sendUserMessage(runtimeAdmissionInputContent(queued), {
				deliverAs: "followUp",
				expandPromptTemplates: queued.source !== "extension",
			});
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		refreshStateForFirstPrompt(ctx);
		if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;
		if (state.latestPlan || state.awaitingAction) {
			cancelDeferredFreshImplementation();
			readyPresentationIntent = undefined;
			state = {
				...state,
				latestPlan: undefined,
				latestPlanSource: undefined,
				awaitingAction: false,
			};
			persistState();
			updateUi(ctx);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;

		const text = latestAssistantText(event.messages);
		const parsedPlan = parseProposedPlan(text);
		if (parsedPlan.kind !== "valid") {
			finalizationRequest.observeRunEnd(workflowGeneration, finalizationRunOutcome(event.messages));
			if (parsedPlan.kind !== "absent") {
				ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
			}
			persistState();
			updateUi(ctx);
			return;
		}
		acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const settledImplementationId = implementationRetention.implementationSettled(
			state.activeImplementation,
		);
		if (settledImplementationId) clearActiveImplementation(settledImplementationId, ctx);

		if (
			finalizationRequest.hasPendingRequest() &&
			state.enabled &&
			workflowMutex.isOwner(workflowOwner)
		) {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			const action = finalizationRequest.settle(workflowGeneration);
			if (action === "retry") {
				if (sendPlanModeUserMessage(RETRY_FINALIZE_PLAN_PROMPT, ctx)) return;
				finalizationRequest.reset();
			}
			if (action === "failed") {
				ctx.ui.notify(
					"Plan finalization ended twice without a structured question or completed plan. Plan mode remains active; revise the plan or run /plan finalize again.",
					"warning",
				);
			}
		}

		const intent = readyPresentationIntent;
		if (!intent || !readyPresentationIsCurrent(intent)) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		readyPresentationIntent = undefined;
		stagedFreshImplementation = undefined;
		try {
			if (intent.source === "legacy_proposed_plan") {
				pi.sendMessage(
					{
						customType: PROPOSED_PLAN_MESSAGE_TYPE,
						content: `**Proposed Plan**\n\n${intent.plan}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			if (ctx.hasUI && completedPlanIsCurrent(intent)) {
				await planActions.showReady(latestCommandContext ?? ctx);
			}
			const request = stagedFreshImplementation;
			stagedFreshImplementation = undefined;
			if (request) armDeferredFreshImplementation(request);
		} catch (error: unknown) {
			stagedFreshImplementation = undefined;
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	function enterPlanMode(
		ctx: ExtensionContext,
		candidate: Pick<PlanModeState, "selectedToolNames" | "selectedToolKeys"> = state,
	) {
		if (!state.enabled && !allowModeTransition(ctx, "start Plan mode")) return false;
		bindWorkflowSessionIfNeeded(ctx);
		if (state.enabled) return workflowMutex.isOwner(workflowOwner);
		const owner = workflowMutex.acquire();
		if (!owner) return reportWorkflowBusy(ctx);
		workflowOwner = owner;

		const previousState = state;
		try {
			assertPlanModeHelperToolsAvailable(safeGetActiveTools());
			if (!publishModeContract("plan", ctx)) {
				releaseWorkflowOwner();
				return false;
			}
		} catch (error: unknown) {
			releaseWorkflowOwner();
			return reportHelperActivationFailure(ctx, error);
		}
		advanceWorkflowGeneration();
		try {
			modeContractsRelevant = true;
			state = {
				...state,
				enabled: true,
				awaitingAction: false,
				savedPlan: undefined,
				activeImplementation: undefined,
				pendingImplementationRuntime: undefined,
				selectedToolNames: candidate.selectedToolNames,
				selectedToolKeys: candidate.selectedToolKeys,
			};
			beginWorkflowToolPolicy();
			applyPlanThinkingLevel();
			persistState();
			updateUi(ctx);
			return true;
		} catch (error: unknown) {
			rollbackNewActivation(previousState, ctx);
			throw error;
		}
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const previousState = state;
		const previousOwner = workflowOwner;
		const wasEnabled = state.enabled;
		if (!enterPlanMode(ctx)) return;
		if (!wasEnabled) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
		if (sendPlanModeUserMessage(prompt, ctx)) return;
		if (wasEnabled) return;
		rollbackNewActivation(previousState, ctx, previousOwner);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		if (!allowModeTransition(ctx, "leave or clear Plan mode")) return false;
		const wasEnabled = state.enabled;
		if ((wasEnabled || modeContractsRelevant) && !publishModeContract("normal", ctx)) {
			return false;
		}
		advanceWorkflowGeneration();
		readyPresentationIntent = undefined;
		workflowAllowedToolNames = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			savedPlan: undefined,
			activeImplementation: undefined,
			pendingImplementationRuntime: undefined,
			workflowToolPolicy: undefined,
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);
		if (wasEnabled) releaseWorkflowOwner();
		return true;
	}

	function restoreModeContractTracking(branch: unknown[], restoredState: PlanModeState) {
		publishedContractMode = latestModeContract(branch)?.mode;
		modeContractsRelevant =
			hasModeContractArtifact(branch) ||
			restoredState.enabled ||
			restoredState.savedPlan !== undefined ||
			restoredState.activeImplementation !== undefined ||
			restoredState.pendingImplementationRuntime !== undefined;
	}

	function publishModeContract(mode: PlanModeContract, ctx: ExtensionContext) {
		if (publishedContractMode === mode) return true;
		const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(mode);
		try {
			pi.sendMessage(message, { triggerTurn: false });
			publishedContractMode = mode;
			modeContractsRelevant = true;
			return true;
		} catch (error: unknown) {
			const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
			const notification = `Unable to publish the ${mode === "plan" ? "Plan" : "Normal"} mode contract: ${detail}`;
			if (!ctx.hasUI) throw new Error(notification, { cause: error });
			ctx.ui.notify(notification, "error");
			return false;
		}
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			return true;
		} catch (error: unknown) {
			const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
			ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
			return false;
		}
	}

	function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
		const normalized = normalizePlanModeCompletion({ plan });
		if (!normalized.ok) {
			ctx.ui.notify(`Proposed plan is not ready: ${normalized.error}.`, "warning");
			persistState();
			updateUi(ctx);
			return;
		}
		finalizationRequest.satisfy();
		if (
			state.enabled &&
			state.awaitingAction &&
			state.latestPlan === normalized.plan &&
			state.latestPlanSource === source
		) {
			return;
		}
		state = {
			...state,
			latestPlan: normalized.plan,
			latestPlanSource: source,
			awaitingAction: true,
		};
		readyPresentationIntent = {
			nonce: ++nextReadyPresentationNonce,
			plan: normalized.plan,
			source,
		};
		persistState();
		updateUi(ctx);
	}

	function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
		return (
			state.enabled &&
			workflowMutex.isOwner(workflowOwner) &&
			state.awaitingAction &&
			state.latestPlan === intent.plan &&
			state.latestPlanSource === intent.source
		);
	}

	function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
		return completedPlanIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
	}

	function togglePlanMode(ctx: ExtensionContext) {
		if (state.enabled) {
			const notification = planModeDisableNotification();
			if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
			return;
		}
		if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined)) return;
		if (enterPlanMode(ctx)) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
	}

	function planModeDisableNotification() {
		return state.activeImplementation
			? "Active implementation plan cleared."
			: state.savedPlan
				? "Saved plan cleared."
				: state.latestPlan
					? "Plan mode disabled. Proposed plan discarded."
					: "Plan mode disabled.";
	}

	function requestFinalPlan(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
			return;
		}
		finalizationRequest.request(workflowGeneration);
		if (!sendPlanModeUserMessage(FINALIZE_PLAN_PROMPT, ctx)) finalizationRequest.reset();
	}

	function savePlanForLater(ctx: ExtensionContext) {
		const plan = state.enabled ? state.latestPlan?.trim() : undefined;
		if (!plan) {
			const message = "No completed plan is available to save.";
			if (!ctx.hasUI) throw new Error(message);
			ctx.ui.notify(message, "warning");
			return;
		}
		const source = state.latestPlanSource ?? "legacy_proposed_plan";
		if (!allowModeTransition(ctx, "save the plan and leave Plan mode")) return;

		if (!publishModeContract("normal", ctx)) return;
		advanceWorkflowGeneration();
		readyPresentationIntent = undefined;
		workflowAllowedToolNames = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			savedPlan: { plan, source },
			activeImplementation: undefined,
			pendingImplementationRuntime: undefined,
			workflowToolPolicy: undefined,
			manualThinkingLevel: undefined,
		};
		restoreThinkingLevel();
		state = { ...state, manualThinkingLevel: undefined };
		persistState();
		updateUi(ctx);
		releaseWorkflowOwner();
		ctx.ui.notify("Plan saved for later. Plan mode disabled.", "info");
	}

	async function startFreshImplementation(
		ctx: ExtensionContext,
		menuIsCurrent: () => boolean,
		runtime: ImplementationRuntimeSelection | undefined,
		timing: FreshImplementationTiming,
	) {
		const retention = configuredImplementationPlanRetention(settings);
		if (timing === "immediate") {
			await startFreshImplementationFromState(ctx, {
				getState: () => state,
				menuIsCurrent,
				retention,
				stateEntryType: STATE_ENTRY_TYPE,
				runtime,
			});
			return;
		}

		const initialState = state;
		const savedPlan = initialState.enabled ? undefined : initialState.savedPlan;
		const plan = (initialState.enabled ? initialState.latestPlan : savedPlan?.plan)?.trim();
		const source = initialState.enabled ? initialState.latestPlanSource : savedPlan?.source;
		if (!plan || !source || !menuIsCurrent()) return;
		stagedFreshImplementation = {
			ctx,
			sourceSession: ctx.sessionManager,
			menuGeneration,
			workflowGeneration,
			workflowOwner,
			enabled: initialState.enabled,
			plan,
			source,
			savedPlan,
			retention,
			runtime: runtime
				? {
						...(runtime.model ? { model: { ...runtime.model } } : {}),
						...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
					}
				: undefined,
			menuIsCurrent,
		};
	}

	function armDeferredFreshImplementation(request: DeferredFreshImplementation) {
		deferredFreshHandoff.schedule(
			async (taskIsCurrent) => {
				const isCurrent = () => taskIsCurrent() && deferredFreshImplementationIsCurrent(request);
				if (!isCurrent()) return;
				await startFreshImplementationFromState(request.ctx, {
					getState: () => state,
					menuIsCurrent: isCurrent,
					retention: request.retention,
					stateEntryType: STATE_ENTRY_TYPE,
					runtime: request.runtime,
				});
			},
			(error) => {
				if (!deferredFreshImplementationIsCurrent(request)) return;
				try {
					request.ctx.ui.notify(
						`Unable to start the deferred fresh implementation: ${terminalErrorDetail(error)}`,
						"error",
					);
				} catch {
					// The source context can become stale while a detached failure is reported.
				}
			},
		);
	}

	function deferredFreshImplementationIsCurrent(request: DeferredFreshImplementation) {
		if (
			currentSession !== request.sourceSession ||
			menuGeneration !== request.menuGeneration ||
			workflowGeneration !== request.workflowGeneration ||
			workflowOwner !== request.workflowOwner ||
			!request.menuIsCurrent() ||
			state.enabled !== request.enabled
		) {
			return false;
		}
		return request.enabled
			? workflowMutex.isOwner(request.workflowOwner) &&
					state.latestPlan === request.plan &&
					state.latestPlanSource === request.source
			: state.savedPlan === request.savedPlan;
	}

	function cancelDeferredFreshImplementation() {
		stagedFreshImplementation = undefined;
		deferredFreshHandoff.cancel();
	}

	async function startImplementation(ctx: ExtensionContext) {
		const savedPlan = state.enabled ? undefined : state.savedPlan;
		const initialPlan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
		if (!initialPlan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}
		if (!allowModeTransition(ctx, "start plan implementation")) return;
		if (savedPlan) {
			const sessionGeneration = menuGeneration;
			const planWorkflowGeneration = workflowGeneration;
			const isCurrent = () =>
				sessionGeneration === menuGeneration &&
				planWorkflowGeneration === workflowGeneration &&
				!menuController.signal.aborted &&
				!state.enabled &&
				state.savedPlan === savedPlan;
			if (!(await preflightSavedPlanImplementation(ctx, isCurrent))) return;
			if (!allowModeTransition(ctx, "start plan implementation")) return;
		}
		const plan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
		const source =
			(state.enabled ? state.latestPlanSource : savedPlan?.source) ?? "legacy_proposed_plan";
		if (!plan) return;

		const previousState = state;
		const previousIntent = readyPresentationIntent;
		const wasEnabled = state.enabled;
		if (!publishModeContract("normal", ctx)) return;
		advanceWorkflowGeneration();
		const retention = configuredImplementationPlanRetention(settings);
		const usesConversationHistory = retention === "clear-on-start";
		readyPresentationIntent = undefined;
		workflowAllowedToolNames = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			savedPlan: undefined,
			pendingImplementationRuntime: undefined,
			activeImplementation: usesConversationHistory
				? undefined
				: {
						id: randomUUID(),
						plan,
						source,
						startedAt: Date.now(),
						retention,
					},
			workflowToolPolicy: undefined,
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);

		const handoff = usesConversationHistory
			? wasEnabled
				? formatHistoryImplementationPrompt()
				: formatTransferredPlanPrompt(plan, false)
			: formatImplementationHandoff(plan);
		const sent = sendPlanModeUserMessage(handoff, ctx);
		if (!sent) {
			state = previousState;
			readyPresentationIntent = previousIntent;
			if (wasEnabled) {
				restoreWorkflowToolPolicy(state.workflowToolPolicy);
				publishModeContract("plan", ctx);
				applyPlanThinkingLevel();
			}
			persistState();
			updateUi(ctx);
			return;
		}
		if (wasEnabled) releaseWorkflowOwner();
	}

	function clearActiveImplementation(id: string, ctx: ExtensionContext) {
		if (state.activeImplementation?.id !== id) return false;
		advanceWorkflowGeneration();
		state = { ...state, activeImplementation: undefined };
		persistState();
		updateUi(ctx);
		return true;
	}

	async function exportPlan(
		ctx: ExtensionContext,
		path: string | undefined,
		signal: AbortSignal,
		isCurrent: () => boolean,
	) {
		const exitsReadyPlan = state.enabled && Boolean(state.latestPlan?.trim());
		if (exitsReadyPlan && !allowModeTransition(ctx, "export the ready plan and leave Plan mode")) {
			return false;
		}
		return planExports.export(path, ctx, signal, () => {
			return isCurrent() && (!exitsReadyPlan || ctx.isIdle());
		});
	}

	async function showLaunchMenu(ctx: ExtensionContext, initialScreen: "main" | "tools" = "main") {
		const lifecycle = captureMenuLifecycle();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const tools = selectableTools();
		const activeToolNames = new Set(safeGetActiveTools());
		const initialSelectedNames = snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot());
		const retainsInactiveSelection =
			state.selectedToolNames !== undefined ||
			state.selectedToolKeys !== undefined ||
			settings.defaultPlanTools !== undefined;
		const retainedInactiveNames = retainsInactiveSelection
			? initialSelectedNames
			: new Set<string>();
		const registeredNames = new Set(tools.map((tool) => tool.name));
		const pendingNames = Array.from(retainedInactiveNames).filter(
			(name) => !registeredNames.has(name),
		);
		await ui.showPlanLaunchMenu(ctx, {
			statusText: planModeHelperToolsAvailable(safeGetActiveTools())
				? "Status: Off — visible Plan helpers stay inactive until /plan starts."
				: "Status: Off — required Plan helpers are unavailable under the active tool policy.",
			initialScreen,
			getSelectedNames: () => snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()),
			toolSummary: (selectedNames) => {
				const allowed = tools
					.filter(
						(tool) =>
							activeToolNames.has(tool.name) &&
							selectedNames.has(tool.name) &&
							canSelectToolInPlanMode(tool),
					)
					.map((tool) => tool.name);
				const pending = pendingNames
					.filter((name) => selectedNames.has(name))
					.map(terminalToolName);
				const visiblePending = pending.slice(0, 3);
				const pendingSuffix =
					pending.length > visiblePending.length
						? `, +${pending.length - visiblePending.length} more`
						: "";
				return [
					`Plan policy will allow: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`,
					...(pending.length > 0
						? [`Pending registration: ${visiblePending.join(", ")}${pendingSuffix}.`]
						: []),
				].join(" ");
			},
			tools: [
				...tools.map((tool) => {
					const selectable = canSelectToolInPlanMode(tool);
					const active = activeToolNames.has(tool.name);
					const retained = retainedInactiveNames.has(tool.name);
					const policy = active
						? toolPolicyLabel(tool)
						: retained
							? "not active yet; retained for first-request resolution"
							: "not active in this Pi session";
					const description = tool.description ?? "No description available";
					return {
						name: tool.name,
						description: `${policy} · ${description}`,
						searchText: [policy, description].join(" "),
						disabled: !selectable || !active,
						disabledReason: !active
							? retained
								? "Not active yet; retained and resolved before the first request"
								: "Not active in Pi; Plan mode will not activate it"
							: selectable
								? undefined
								: "Blocked by Plan-mode policy",
					};
				}),
				...pendingNames.map((name) => {
					const label = terminalToolName(name);
					return {
						name,
						label,
						description:
							"pending registration · Retained and resolved before the first Plan request",
						searchText: `${label} pending registration retained first Plan request`,
						disabled: true,
						disabledReason:
							"Not registered yet; Plan mode will not activate it and will resolve it before the first request",
					};
				}),
			],
			...lifecycle,
			start: (signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
			},
			startWithTools: (names, signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				const selectedToolNames = Array.from(
					new Set(
						names.filter((name) => activeToolNames.has(name) || retainedInactiveNames.has(name)),
					),
				);
				if (enterPlanMode(ctx, { selectedToolNames, selectedToolKeys: undefined })) {
					ctx.ui.notify("Plan mode enabled with the selected tools.", "info");
				}
			},
			settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
		});
	}

	async function showActivePlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}
		const lifecycle = captureMenuLifecycle();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
		await ui.showActiveImplementationMenu(ctx, {
			statusText: planStatusText(),
			getExportDestination: () => planExports.getDestination(ctx),
			signal: lifecycle.signal,
			isCurrent: lifecycle.isCurrent,
			show: () => showStoredPlan(pi, ctx, state),
			exportPlan: (path, signal) => planExports.export(path, ctx, signal, lifecycle.isCurrent),
			settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
			startNew: () => {
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
			},
			clear: () => {
				if (exitPlanMode(ctx)) ctx.ui.notify("Active implementation plan cleared.", "info");
			},
		});
	}

	async function showSettings(
		ctx: ExtensionContext,
		signal: AbortSignal,
		isCurrent: () => boolean,
	) {
		if (!isCurrent() || signal.aborted) return false;
		const ui = await loadInteractiveUi();
		if (!isCurrent() || signal.aborted) return false;
		const result = await ui.showPlanModeSettings(ctx, {
			tools: selectableTools(),
			activeToolNames: safeGetActiveTools(),
			signal,
			isCurrent,
			settingsPath: dependencies.settingsPath,
			updateSettings: dependencies.updateSettings ?? updatePlanModeSettings,
			onSaved: (saved) => {
				if (!isCurrent()) return;
				settings = saved;
				applyPlanModeShortcut(configuredPlanModeToggleShortcut(saved));
			},
			...(dependencies.readSettings
				? { readSettings: async () => dependencies.readSettings?.() ?? { kind: "missing" } }
				: {}),
		});
		return result.kind === "closed" && "reason" in result && result.reason === "close";
	}

	function allowModeTransition(ctx: ExtensionContext, action: string) {
		if (ctx.isIdle()) return true;
		const message = `Cannot ${action} while an agent run is active. Wait for the run to settle, then retry.`;
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "warning");
		return false;
	}

	function advanceWorkflowGeneration() {
		cancelDeferredFreshImplementation();
		workflowGeneration += 1;
		pendingWorkflowToolPolicy = undefined;
		finalizationRequest.reset();
	}

	function finalizationRunOutcome(messages: unknown): FinalizationRunOutcome {
		const stopReason = latestAssistantStopReason(messages);
		if (stopReason === undefined || stopReason === "stop") return "normal";
		if (stopReason === "aborted") return "cancelled";
		return "error";
	}

	function captureMenuLifecycle() {
		const sessionGeneration = menuGeneration;
		const planWorkflowGeneration = workflowGeneration;
		const owner = workflowOwner;
		const controller = menuController;
		return {
			signal: controller.signal,
			isCurrent: () =>
				sessionGeneration === menuGeneration &&
				planWorkflowGeneration === workflowGeneration &&
				!controller.signal.aborted &&
				(!state.enabled || workflowMutex.isOwner(owner)),
		};
	}

	function planModePolicyToolNames() {
		if (state.enabled) return workflowAllowedToolNames ?? [];
		return computePlanModePolicyToolNames();
	}

	function workflowDesiredToolNames() {
		const policy = state.workflowToolPolicy;
		if (!state.enabled || !policy) return new Set<string>();
		return new Set(
			policy.kind === "automatic" ? automaticPlanModeToolNames() : (policy.desiredNames ?? []),
		);
	}

	function beginWorkflowToolPolicy() {
		const kind = toolPolicySelectionIsExplicit() ? "explicit" : "automatic";
		const desiredNames = desiredPlanModeToolNames();
		const allowedNames = resolvePlanModePolicyToolNames(desiredNames);
		const policy: PlanModeWorkflowToolPolicy = {
			kind,
			...(kind === "explicit" ? { desiredNames } : {}),
			allowedNames,
			resolved: false,
		};
		state = { ...state, workflowToolPolicy: policy };
		pendingWorkflowToolPolicy = { generation: workflowGeneration, mode: "resolve" };
		workflowAllowedToolNames = allowedNames;
	}

	function resolvePendingWorkflowToolPolicy(ctx: ExtensionContext) {
		const pending = pendingWorkflowToolPolicy;
		if (!pending) return;
		if (
			pending.generation !== workflowGeneration ||
			!state.enabled ||
			!workflowMutex.isOwner(workflowOwner)
		) {
			pendingWorkflowToolPolicy = undefined;
			return;
		}
		const policy = state.workflowToolPolicy;
		const expectedResolved = pending.mode === "revalidate";
		if (!policy || policy.resolved !== expectedResolved) {
			pendingWorkflowToolPolicy = undefined;
			return;
		}
		const allowedNames =
			pending.mode === "resolve"
				? resolveWorkflowToolPolicy(policy)
				: revalidateFrozenWorkflowToolPolicy(policy);
		const policyChanged = !policy.resolved || !arrayEquals(policy.allowedNames, allowedNames);
		workflowAllowedToolNames = allowedNames;
		state = {
			...state,
			workflowToolPolicy: { ...policy, allowedNames, resolved: true },
		};
		pendingWorkflowToolPolicy = undefined;
		if (policyChanged) persistState();
		updateUi(ctx);
	}

	function toolPolicySelectionIsExplicit() {
		return (
			state.selectedToolNames !== undefined ||
			state.selectedToolKeys !== undefined ||
			settings.defaultPlanTools !== undefined
		);
	}

	function desiredPlanModeToolNames() {
		const tools = activePlanPolicyTools();
		return Array.from(snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()));
	}

	function automaticPlanModeToolNames() {
		return Array.from(snapshotPlanModeSelectedNames(activePlanPolicyTools(), {}));
	}

	function resolveWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
		return resolvePlanModePolicyToolNames(
			policy.kind === "automatic" ? automaticPlanModeToolNames() : (policy.desiredNames ?? []),
		);
	}

	function revalidateFrozenWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
		const currentlyAllowed = new Set(
			policy.kind === "automatic"
				? resolvePlanModePolicyToolNames(automaticPlanModeToolNames())
				: resolvePlanModePolicyToolNames(policy.allowedNames),
		);
		return policy.allowedNames.filter((name) => currentlyAllowed.has(name));
	}

	function restoreWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy | undefined) {
		let nextPolicy: PlanModeWorkflowToolPolicy;
		if (!policy) {
			const kind = toolPolicySelectionIsExplicit() ? "explicit" : "automatic";
			const desiredNames = desiredPlanModeToolNames();
			nextPolicy = {
				kind,
				...(kind === "explicit" ? { desiredNames } : {}),
				allowedNames: resolvePlanModePolicyToolNames(desiredNames),
				resolved: true,
			};
		} else if (policy.resolved) {
			nextPolicy = policy;
		} else {
			nextPolicy = {
				...policy,
				allowedNames: resolveWorkflowToolPolicy(policy),
			};
		}
		state = { ...state, workflowToolPolicy: nextPolicy };
		workflowAllowedToolNames = nextPolicy.resolved
			? revalidateFrozenWorkflowToolPolicy(nextPolicy)
			: nextPolicy.allowedNames;
		pendingWorkflowToolPolicy = {
			generation: workflowGeneration,
			mode: nextPolicy.resolved ? "revalidate" : "resolve",
		};
		return !workflowToolPoliciesEqual(policy, nextPolicy);
	}

	function workflowToolPoliciesEqual(
		left: PlanModeWorkflowToolPolicy | undefined,
		right: PlanModeWorkflowToolPolicy,
	) {
		return (
			left?.kind === right.kind &&
			left.resolved === right.resolved &&
			arrayEquals(left.allowedNames, right.allowedNames) &&
			arrayEquals(left.desiredNames ?? [], right.desiredNames ?? [])
		);
	}

	function arrayEquals(left: readonly string[], right: readonly string[]) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	function computePlanModePolicyToolNames() {
		return resolvePlanModePolicyToolNames(desiredPlanModeToolNames());
	}

	function resolvePlanModePolicyToolNames(desiredNames: readonly string[]) {
		const selectedNames = new Set(desiredNames);
		return activePlanPolicyTools()
			.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
			.map((tool) => tool.name);
	}

	function toolSelectionSnapshot() {
		return {
			selectedToolNames: state.selectedToolNames,
			selectedToolKeys: state.selectedToolKeys,
			defaultPlanTools: settings.defaultPlanTools,
		};
	}

	function selectableTools() {
		return safeGetAllTools()
			.filter(
				(tool) =>
					tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
			)
			.sort(compareTools);
	}

	function activePlanPolicyTools() {
		const activeNames = new Set(safeGetActiveTools());
		return selectableTools().filter((tool) => activeNames.has(tool.name));
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function runtimeAdmissionIsPending(sessionManager: ExtensionContext["sessionManager"]) {
		return (
			activeImplementationRuntimeApplication?.sessionManager === sessionManager ||
			pendingRuntimeAdmissionSession === sessionManager ||
			queuedRuntimeAdmissionInputs.some((queued) => queued.sessionManager === sessionManager)
		);
	}

	function takeQueuedRuntimeAdmissionInputs(sessionManager: ExtensionContext["sessionManager"]) {
		const matching: QueuedRuntimeAdmissionInput[] = [];
		const remaining: QueuedRuntimeAdmissionInput[] = [];
		for (const queued of queuedRuntimeAdmissionInputs) {
			if (queued.sessionManager === sessionManager) matching.push(queued);
			else remaining.push(queued);
		}
		queuedRuntimeAdmissionInputs = remaining;
		return matching;
	}

	function removeQueuedRuntimeAdmissionInput(queuedInput: QueuedRuntimeAdmissionInput) {
		const index = queuedRuntimeAdmissionInputs.indexOf(queuedInput);
		if (index >= 0) queuedRuntimeAdmissionInputs.splice(index, 1);
	}

	function runtimeAdmissionInputContent(queued: QueuedRuntimeAdmissionInput) {
		return queued.images?.length
			? [{ type: "text" as const, text: queued.text }, ...queued.images]
			: queued.text;
	}

	function refreshStateForFirstPrompt(ctx: ExtensionContext) {
		if (!refreshStateBeforeFirstAgentStart) return;
		refreshStateBeforeFirstAgentStart = false;
		implementationRetention.reset();
		const branch = ctx.sessionManager.getBranch();
		const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
		restoreModeContractTracking(branch, restoredState);
		if (!installRestoredState(restoredState, ctx)) return;
		implementationRetention.restore(state.activeImplementation);
		updateUi(ctx);
	}

	async function applyPendingImplementationRuntime(
		ctx: ExtensionContext,
		holdForAdmission = false,
	): Promise<ImplementationRuntimeApplicationResult> {
		const session = ctx.sessionManager;
		const activeApplication = activeImplementationRuntimeApplication;
		if (activeApplication?.sessionManager === session) {
			if (holdForAdmission) activeApplication.holdForAdmission = true;
			return activeApplication.completion;
		}

		const intent = state.enabled ? undefined : state.pendingImplementationRuntime;
		if (!intent) return "ready";
		const generation = menuGeneration;
		const isCurrent = () =>
			currentSession === session && generation === menuGeneration && !menuController.signal.aborted;
		const notifyCurrent = (message: string) => {
			if (!isCurrent()) return;
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// The session can become stale while an asynchronous runtime application settles.
			}
		};
		let application!: ActiveImplementationRuntimeApplication;
		const completion = Promise.resolve()
			.then(async (): Promise<ImplementationRuntimeApplicationResult> => {
				if (!isCurrent()) return "stale";
				const pendingState = state;
				const previousThinkingLevel = pi.getThinkingLevel();

				const applyThinking = () => {
					if (!intent.thinkingLevel) return;
					try {
						pi.setThinkingLevel(intent.thinkingLevel);
						const effectiveLevel = pi.getThinkingLevel();
						if (effectiveLevel !== intent.thinkingLevel) {
							notifyCurrent(
								`Implementation thinking ${intent.thinkingLevel} is unsupported by the destination model; Pi is using ${effectiveLevel}.`,
							);
						}
					} catch (error: unknown) {
						notifyCurrent(
							`Implementation thinking ${intent.thinkingLevel} could not be applied: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default will continue.`,
						);
					}
				};

				if (intent.model) {
					let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
					let resolutionFailed = false;
					try {
						model = ctx.modelRegistry.find(intent.model.provider, intent.model.modelId);
					} catch (error: unknown) {
						notifyCurrent(
							`Implementation model ${terminalModelReference(intent.model)} could not be resolved: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
						);
						resolutionFailed = true;
						model = undefined;
					}
					if (!model && !resolutionFailed) {
						notifyCurrent(
							`Implementation model ${terminalModelReference(intent.model)} is no longer available. The destination default model will continue.`,
						);
					}
					if (model) {
						let authenticated = false;
						try {
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
							if (!isCurrent()) return "stale";
							if (auth.ok) authenticated = true;
							else {
								notifyCurrent(
									`Implementation model ${terminalModelReference(intent.model)} could not be authenticated: ${safeTerminalText(auth.error)}. The destination default model will continue.`,
								);
							}
						} catch (error: unknown) {
							notifyCurrent(
								`Implementation model ${terminalModelReference(intent.model)} could not be authenticated: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
							);
						}
						if (!isCurrent()) return "stale";
						if (authenticated) {
							let applied = false;
							let applicationFailed = false;
							application.drainOnShutdown = true;
							try {
								try {
									applied = await pi.setModel(model);
								} catch (error: unknown) {
									applicationFailed = true;
									notifyCurrent(
										`Implementation model ${terminalModelReference(intent.model)} could not be applied: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
									);
								}
							} finally {
								application.drainOnShutdown = false;
							}
							if (!isCurrent()) return "stale";
							if (!applied && !applicationFailed) {
								notifyCurrent(
									`Implementation model ${terminalModelReference(intent.model)} could not be applied after authentication changed. The destination default model will continue.`,
								);
							}
						}
					}
				}
				if (!isCurrent()) return "stale";
				applyThinking();
				if (!isCurrent()) return "stale";

				state = { ...state, pendingImplementationRuntime: undefined };
				try {
					persistState();
				} catch (error: unknown) {
					state = pendingState;
					try {
						if (pi.getThinkingLevel() !== previousThinkingLevel) {
							pi.setThinkingLevel(previousThinkingLevel);
						}
					} catch {
						// Keep the durable intent pending even if a runtime rollback is unavailable.
					}
					try {
						persistState();
					} catch {
						// SessionManager mutates its in-memory branch before a disk append can fail.
						// A best-effort rollback entry keeps that branch aligned with durable pending state.
					}
					notifyCurrent(
						`Unable to apply fresh implementation settings because their one-shot state could not be consumed: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The implementation request was not sent; retry after session persistence is available.`,
					);
					return "blocked";
				}
				if (application.holdForAdmission) pendingRuntimeAdmissionSession = session;
				return "ready";
			})
			.finally(() => {
				if (activeImplementationRuntimeApplication === application) {
					activeImplementationRuntimeApplication = undefined;
				}
			});
		application = {
			sessionManager: session,
			completion,
			drainOnShutdown: false,
			holdForAdmission,
		};
		activeImplementationRuntimeApplication = application;
		return completion;
	}

	function applyPlanThinkingLevel() {
		if (state.manualThinkingLevel) {
			if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
				pi.setThinkingLevel(state.manualThinkingLevel);
			}
			return;
		}
		const configured = configuredThinkingLevel(settings);
		if (!configured) {
			state = {
				...state,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			return;
		}
		const current = pi.getThinkingLevel();
		if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
		if (current !== configured) pi.setThinkingLevel(configured);
		state.appliedThinkingLevel = pi.getThinkingLevel();
	}

	function captureManualThinkingLevel() {
		if (!state.appliedThinkingLevel) return;
		const current = pi.getThinkingLevel();
		if (current === state.appliedThinkingLevel) return;
		state = {
			...state,
			manualThinkingLevel: current,
			previousThinkingLevel: undefined,
			appliedThinkingLevel: undefined,
		};
	}

	function restoreThinkingLevel() {
		captureManualThinkingLevel();
		const { appliedThinkingLevel, previousThinkingLevel } = state;
		if (
			appliedThinkingLevel &&
			previousThinkingLevel &&
			pi.getThinkingLevel() === appliedThinkingLevel
		) {
			pi.setThinkingLevel(previousThinkingLevel);
		}
		state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function installRestoredState(candidate: PlanModeState, ctx: ExtensionContext) {
		const previousState = state;
		const previousWorkflowAllowedToolNames = workflowAllowedToolNames;
		const previousPendingWorkflowToolPolicy = pendingWorkflowToolPolicy;
		const previousOwner = workflowOwner;
		const wasEnabled = state.enabled;
		if (candidate.enabled && !workflowMutex.isOwner(workflowOwner)) {
			const owner = workflowMutex.acquire();
			if (!owner) {
				state = { enabled: false, awaitingAction: false };
				workflowAllowedToolNames = undefined;
				pendingWorkflowToolPolicy = undefined;
				reportRestoredWorkflowBusy(ctx);
				return false;
			}
			workflowOwner = owner;
		}

		try {
			if (candidate.enabled) {
				try {
					assertPlanModeHelperToolsAvailable(safeGetActiveTools());
				} catch {
					state = { enabled: false, awaitingAction: false };
					workflowAllowedToolNames = undefined;
					pendingWorkflowToolPolicy = undefined;
					if (workflowOwner !== previousOwner) {
						workflowMutex.release(workflowOwner);
						workflowOwner = previousOwner;
					}
					reportRestoredHelpersUnavailable(ctx);
					return false;
				}
			}
			if (wasEnabled && !candidate.enabled) {
				readyPresentationIntent = undefined;
				restoreThinkingLevel();
			}
			state = candidate;
			const policyChanged = state.enabled
				? restoreWorkflowToolPolicy(state.workflowToolPolicy)
				: false;
			if (!state.enabled) {
				workflowAllowedToolNames = undefined;
				pendingWorkflowToolPolicy = undefined;
			}
			if (policyChanged) persistState();
			if (state.enabled) applyPlanThinkingLevel();
			else if (wasEnabled) releaseWorkflowOwner();
			return true;
		} catch (error: unknown) {
			try {
				if (!wasEnabled && state.enabled) restoreThinkingLevel();
			} finally {
				state = previousState;
				workflowAllowedToolNames = previousWorkflowAllowedToolNames;
				pendingWorkflowToolPolicy = previousPendingWorkflowToolPolicy;
				if (workflowOwner !== previousOwner) {
					workflowMutex.release(workflowOwner);
					workflowOwner = previousOwner;
				}
			}
			throw error;
		}
	}

	function rollbackNewActivation(
		previousState: PlanModeState,
		ctx: ExtensionContext,
		previousOwner?: WorkflowMutexOwner,
	) {
		const activatedOwner = workflowOwner;
		readyPresentationIntent = undefined;
		try {
			if (state.enabled) {
				publishModeContract("normal", ctx);
				restoreThinkingLevel();
			}
		} finally {
			state = previousState;
			workflowAllowedToolNames = undefined;
			pendingWorkflowToolPolicy = undefined;
			try {
				persistState();
				updateUi(ctx);
			} finally {
				if (activatedOwner !== previousOwner) {
					workflowMutex.release(activatedOwner);
					workflowOwner = previousOwner;
				}
			}
		}
	}

	function bindWorkflowSessionIfNeeded(ctx: ExtensionContext) {
		if (currentSession === ctx.sessionManager) return;
		currentSession = ctx.sessionManager;
		workflowOwner = undefined;
		workflowMutex.bindSession(ctx.sessionManager);
	}

	function releaseWorkflowOwner() {
		const owner = workflowOwner;
		workflowMutex.release(owner);
		if (!workflowMutex.isOwner(owner)) workflowOwner = undefined;
	}

	function reportWorkflowBusy(ctx: ExtensionContext) {
		const message = "Another workflow is active in this session. End it before starting Plan mode.";
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "warning");
		return false;
	}

	function reportRestoredWorkflowBusy(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			"Plan mode was not restored because another workflow is active in this session. Reload or start Plan mode after it ends.",
			"warning",
		);
	}

	function reportRestoredHelpersUnavailable(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			"Plan mode was not restored because its helper tools are unavailable under the active tool policy.",
			"warning",
		);
	}

	function reportHelperActivationFailure(ctx: ExtensionContext, error: unknown) {
		const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
		const message = `Cannot start Plan mode: ${detail}.`;
		if (!ctx.hasUI) throw new Error(message, { cause: error });
		ctx.ui.notify(message, "error");
		return false;
	}

	function updateUi(ctx: ExtensionContext) {
		updatePlanModeUi(ctx, state, formatToolSummary);
	}

	function clearUi(ctx: ExtensionContext) {
		clearPlanModeUi(ctx);
	}

	function planStatusText() {
		return formatPlanModeStatusText(state, formatToolSummary);
	}

	function implementationOutcome() {
		return implementationRetentionPreview(configuredImplementationPlanRetention(settings));
	}

	function formatToolSummary() {
		const names = planModePolicyToolNames();
		return `Plan policy allows: ${names.length > 0 ? names.join(", ") : "none"}. Model-visible tools stay unchanged.`;
	}

	function toolByName(toolName: string) {
		return safeGetAllTools().find((candidate) => candidate.name === toolName);
	}

	function terminalToolName(value: string) {
		const safe = safeTerminalText(value) || "(unnamed tool)";
		return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
	}

	function terminalModelReference(model: { provider: string; modelId: string }) {
		const safe = safeTerminalText(`${model.provider}/${model.modelId}`) || "(unnamed model)";
		return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
	}

	function terminalErrorDetail(error: unknown) {
		const safe = safeTerminalText(error instanceof Error ? error.message : String(error));
		if (!safe) return "unknown error";
		return safe.length > 500 ? `${safe.slice(0, 499)}…` : safe;
	}

	function safeTerminalText(value: string) {
		return [...stripVTControlCharacters(value)]
			.map((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f ||
					(codePoint >= 0x7f && codePoint <= 0x9f) ||
					(codePoint >= 0x202a && codePoint <= 0x202e) ||
					(codePoint >= 0x2066 && codePoint <= 0x2069)
					? " "
					: character;
			})
			.join("")
			.trim();
	}
}

export { completePlanArguments } from "./command.js";
export {
	extractProposedPlan,
	latestAssistantText,
	parseProposedPlan,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
export {
	createModeContractMessage,
	modeContractContent,
	reconcileModeContract,
} from "./mode-contract.js";
export { buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { canSelectToolInPlanMode, classifyPlanModeTool, isSafeCommand } from "./tool-policy.js";
