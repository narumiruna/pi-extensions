import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";
import type { PlanModeFixedThinkingLevel } from "./settings.js";
import type { ImplementationModelOverride, ImplementationRuntimeSelection } from "./state.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"Implement here keeps this planning conversation.",
	"Start fresh transfers only the approved plan to a new session.",
] as const;

const FIXED_THINKING_LEVELS: readonly PlanModeFixedThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface PlanMenuOptions extends MenuLifecycle {
	statusText: string;
	hasReadyPlan: boolean;
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	show(): void;
	finalize(): void;
	implementHere(): void | Promise<void>;
	implementFresh(
		runtime: ImplementationRuntimeSelection,
		signal: AbortSignal,
	): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
	type Screen = "main" | "fresh" | "models" | "thinking" | "export";
	type Action =
		| "show"
		| "finalize"
		| "implement-here"
		| "select-model"
		| "select-thinking"
		| "start-fresh"
		| "export"
		| "save"
		| "stay"
		| "exit";
	const freshFlow = createFreshImplementationFlow(ctx, options.implementFresh);
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Plan mode",
				lines: [
					options.statusText,
					...(options.hasReadyPlan
						? [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()]
						: []),
				],
				items: options.hasReadyPlan
					? [
							{ id: "show", label: "Show latest proposed plan", action: "show" },
							{
								id: "implement-here",
								label: "Implement here",
								description: "Continue in this session with the planning conversation.",
								action: "implement-here",
							},
							{
								id: "implement-fresh",
								label: "Start fresh and implement",
								description: "Configure one-shot model and thinking choices first.",
								to: "fresh",
							},
							{ id: "export", label: "Export plan…", to: "export" },
							{ id: "save", label: "Save for later", action: "save" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Discard plan and exit", action: "exit" },
						]
					: [
							{ id: "finalize", label: "Request final plan", action: "finalize" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Exit Plan mode", action: "exit" },
						],
				hint: "close",
			}),
			fresh: freshFlow.settingsScreen,
			models: freshFlow.modelScreen,
			thinking: freshFlow.thinkingScreen,
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			finalize: async () => {
				options.finalize();
				return { kind: "close" };
			},
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"select-model": async ({ itemId }) => {
				freshFlow.selectModel(itemId);
				return { kind: "back" };
			},
			"select-thinking": async ({ itemId }) => {
				freshFlow.selectThinking(itemId);
				return { kind: "back" };
			},
			"start-fresh": async ({ signal }) => {
				await freshFlow.start(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}

interface ReadyPlanMenuOptions extends MenuLifecycle {
	implementationOutcome(): string;
	getExportDestination: PlanExportDestinationProvider;
	implementHere(): void | Promise<void>;
	implementFresh(
		runtime: ImplementationRuntimeSelection,
		signal: AbortSignal,
	): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
	type Screen = "ready" | "fresh" | "models" | "thinking" | "export";
	type Action =
		| "implement-here"
		| "select-model"
		| "select-thinking"
		| "start-fresh"
		| "export"
		| "save"
		| "stay"
		| "exit";
	const freshFlow = createFreshImplementationFlow(ctx, options.implementFresh);
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "ready",
		screens: {
			ready: () => ({
				kind: "actions",
				title: "Proposed plan ready. What next?",
				lines: [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()],
				items: [
					{
						id: "implement-here",
						label: "Implement here",
						description: "Continue in this session with the planning conversation.",
						action: "implement-here",
					},
					{
						id: "implement-fresh",
						label: "Start fresh and implement",
						description: "Configure one-shot model and thinking choices first.",
						to: "fresh",
					},
					{ id: "export", label: "Export plan…", to: "export" },
					{ id: "save", label: "Save for later", action: "save" },
					{ id: "stay", label: "Stay in Plan mode", action: "stay" },
					{ id: "exit", label: "Discard plan and exit", action: "exit" },
				],
				hint: "close",
			}),
			fresh: freshFlow.settingsScreen,
			models: freshFlow.modelScreen,
			thinking: freshFlow.thinkingScreen,
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"select-model": async ({ itemId }) => {
				freshFlow.selectModel(itemId);
				return { kind: "back" };
			},
			"select-thinking": async ({ itemId }) => {
				freshFlow.selectThinking(itemId);
				return { kind: "back" };
			},
			"start-fresh": async ({ signal }) => {
				await freshFlow.start(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}

interface ModelChoice {
	itemId: string;
	model: ImplementationModelOverride;
	label: string;
	description?: string;
	searchText: string;
}

function createFreshImplementationFlow(
	ctx: ExtensionContext,
	implementFresh: (
		runtime: ImplementationRuntimeSelection,
		signal: AbortSignal,
	) => void | Promise<void>,
) {
	const models = snapshotAvailableModels(ctx);
	let selectedModel: ModelChoice | undefined;
	let selectedThinkingLevel: PlanModeFixedThinkingLevel | undefined;
	return {
		settingsScreen: () => ({
			kind: "actions" as const,
			title: "Fresh implementation settings",
			lines: ["These choices apply once to the new implementation session."],
			items: [
				{
					id: "implementation-model",
					label: `Implementation model: ${selectedModel?.label ?? "Destination default"}`,
					to: "models" as const,
				},
				{
					id: "implementation-thinking",
					label: `Implementation thinking: ${selectedThinkingLevel ?? "Destination default"}`,
					to: "thinking" as const,
				},
				{
					id: "start-fresh",
					label: "Start fresh implementation",
					description: "Create the linked session and begin implementation.",
					action: "start-fresh" as const,
					busyLabel: "Starting fresh implementation session…",
				},
			],
		}),
		modelScreen: () => ({
			kind: "choice" as const,
			title: "Implementation model",
			lines: ["Choose a one-shot model override for the destination session."],
			items: [
				{
					id: "destination-default",
					label: "Destination default",
					description: "Use Pi's normal model selection for the new session.",
				},
				...models.map((choice) => ({
					id: choice.itemId,
					label: choice.label,
					description: choice.description,
					searchText: choice.searchText,
				})),
			],
			action: "select-model" as const,
			currentItemId: selectedModel?.itemId ?? "destination-default",
			initialItemId: selectedModel?.itemId ?? "destination-default",
			enableSearch: true,
			viewportSize: 10,
		}),
		thinkingScreen: () => ({
			kind: "choice" as const,
			title: "Implementation thinking",
			lines: ["Choose a one-shot thinking override for the destination session."],
			items: [
				{
					id: "destination-default",
					label: "Destination default",
					description: "Use the destination model's normal thinking level.",
				},
				...FIXED_THINKING_LEVELS.map((level) => ({ id: level, label: level })),
			],
			action: "select-thinking" as const,
			currentItemId: selectedThinkingLevel ?? "destination-default",
			initialItemId: selectedThinkingLevel ?? "destination-default",
			viewportSize: FIXED_THINKING_LEVELS.length + 1,
		}),
		selectModel(itemId: string) {
			selectedModel = models.find((choice) => choice.itemId === itemId);
		},
		selectThinking(itemId: string) {
			selectedThinkingLevel = FIXED_THINKING_LEVELS.find((level) => level === itemId);
		},
		start(signal: AbortSignal) {
			return implementFresh(
				{
					...(selectedModel ? { model: { ...selectedModel.model } } : {}),
					...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
				},
				signal,
			);
		},
	};
}

function snapshotAvailableModels(ctx: ExtensionContext): ModelChoice[] {
	const getAvailable = ctx.modelRegistry.getAvailable;
	const models =
		ctx.scopedModels.length > 0
			? ctx.scopedModels.map((entry) => entry.model)
			: typeof getAvailable === "function"
				? getAvailable.call(ctx.modelRegistry)
				: [];
	return models.map((model, index) => {
		const provider = safeModelMetadata(model.provider, "unknown provider");
		const modelId = safeModelMetadata(model.id, "unknown model");
		const name = safeModelMetadata(model.name, "");
		return {
			itemId: `model-${index}`,
			model: { provider: model.provider, modelId: model.id },
			label: `${provider}/${modelId}${name ? ` — ${name}` : ""}`,
			...(name ? { description: name } : {}),
			searchText: [provider, modelId, name].filter(Boolean).join(" "),
		};
	});
}

function safeModelMetadata(value: unknown, fallback: string) {
	if (typeof value !== "string") return fallback;
	const safe = sanitizeTerminalText(value).trim() || fallback;
	return [...safe].slice(0, 512).join("");
}
