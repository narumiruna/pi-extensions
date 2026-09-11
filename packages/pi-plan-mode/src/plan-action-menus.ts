import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import {
	type AvailableImplementationModel,
	findAvailableImplementationModel,
	type ImplementationModelOverride,
	snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";
import { IMPLEMENTATION_THINKING_LEVELS, type PlanModeFixedThinkingLevel } from "./settings.js";
import type { ImplementationRuntimeSelection } from "./state.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"Implement here keeps this planning conversation.",
	"Start fresh transfers only the approved plan to a new session.",
] as const;

const THINKING_LEVEL_DESCRIPTIONS: Record<PlanModeFixedThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

interface PlanMenuOptions extends MenuLifecycle {
	statusText: string;
	planThinkingLevel: PlanModeFixedThinkingLevel | undefined;
	implementationDefaults?: ImplementationRuntimeSelection;
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
	const freshFlow = createFreshImplementationFlow(
		ctx,
		options.planThinkingLevel,
		options.implementationDefaults,
		options.implementFresh,
	);
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
	planThinkingLevel: PlanModeFixedThinkingLevel | undefined;
	implementationDefaults?: ImplementationRuntimeSelection;
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
	const freshFlow = createFreshImplementationFlow(
		ctx,
		options.planThinkingLevel,
		options.implementationDefaults,
		options.implementFresh,
	);
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
	modelInfo: AvailableImplementationModel;
	label: string;
	summary: string;
	details?: readonly string[];
	searchText: string;
	isPlanModel: boolean;
}

function createFreshImplementationFlow(
	ctx: ExtensionContext,
	planThinkingLevel: PlanModeFixedThinkingLevel | undefined,
	implementationDefaults: ImplementationRuntimeSelection | undefined,
	implementFresh: (
		runtime: ImplementationRuntimeSelection,
		signal: AbortSignal,
	) => void | Promise<void>,
) {
	const models = snapshotAvailableModels(ctx);
	const planModel = ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
	const planModelSummary = ctx.model
		? `${safeModelMetadata(ctx.model.id, "unknown model")} [${safeModelMetadata(ctx.model.provider, "unknown provider")}]`
		: undefined;
	const configuredModel = implementationDefaults?.model;
	const configuredAvailableModel = findAvailableImplementationModel(
		models.map((choice) => choice.modelInfo),
		configuredModel,
	);
	let unavailableDefaultActive = configuredModel !== undefined && !configuredAvailableModel;
	let selectedModel = configuredAvailableModel
		? models.find((choice) => choice.modelInfo === configuredAvailableModel)
		: undefined;
	let selectedModelUsesDefault = selectedModel !== undefined;
	let selectedThinkingLevel = implementationDefaults?.thinkingLevel;
	return {
		settingsScreen: () => ({
			kind: "actions" as const,
			title: "Fresh implementation settings",
			lines: [
				"These choices apply once to the new implementation session.",
				...(unavailableDefaultActive && configuredModel
					? [
							`Configured default ${safeModelReference(configuredModel)} is unavailable; using same as plan.`,
						]
					: []),
			],
			items: [
				{
					id: "start-fresh",
					label: "Start fresh implementation",
					description: "Create the linked session and begin implementation.",
					action: "start-fresh" as const,
					busyLabel: "Starting fresh implementation session…",
				},
				{
					id: "implementation-model",
					label: "Model",
					description:
						selectedModel?.summary ??
						(planModelSummary ? `${planModelSummary} · same as plan` : "Same as plan"),
					to: "models" as const,
				},
				{
					id: "implementation-thinking",
					label: "Thinking level",
					description:
						selectedThinkingLevel ??
						(planThinkingLevel ? `${planThinkingLevel} · same as plan` : "Same as plan"),
					to: "thinking" as const,
				},
			],
		}),
		modelScreen: () => ({
			kind: "choice" as const,
			title: "Implementation model",
			items: [
				{
					id: "same-as-plan",
					label: "Same as plan",
					...(planModelSummary ? { description: planModelSummary } : {}),
				},
				...models.map((choice) => ({
					id: choice.itemId,
					label: choice.label,
					details: choice.details,
					searchText: choice.searchText,
				})),
			],
			action: "select-model" as const,
			initialItemId: selectedModel?.itemId ?? "same-as-plan",
			enableSearch: true,
			viewportSize: 10,
		}),
		thinkingScreen: () => ({
			kind: "choice" as const,
			title: "Implementation thinking level",
			items: [
				{
					id: "same-as-plan",
					label: "Same as plan",
				},
				...IMPLEMENTATION_THINKING_LEVELS.map((level) => ({
					id: level,
					label: `${level === planThinkingLevel ? "✓ " : ""}${level}`,
					description: THINKING_LEVEL_DESCRIPTIONS[level],
				})),
			],
			action: "select-thinking" as const,
			initialItemId: selectedThinkingLevel ?? "same-as-plan",
			viewportSize: IMPLEMENTATION_THINKING_LEVELS.length + 1,
		}),
		selectModel(itemId: string) {
			const choice = models.find((candidate) => candidate.itemId === itemId);
			selectedModel = itemId === "same-as-plan" || choice?.isPlanModel ? undefined : choice;
			selectedModelUsesDefault = false;
			unavailableDefaultActive = false;
		},
		selectThinking(itemId: string) {
			selectedThinkingLevel = IMPLEMENTATION_THINKING_LEVELS.find((level) => level === itemId);
		},
		start(signal: AbortSignal) {
			if (
				selectedModelUsesDefault &&
				selectedModel &&
				!findAvailableImplementationModel(
					snapshotAvailableImplementationModels(ctx),
					selectedModel.model,
				)
			) {
				selectedModel = undefined;
				selectedModelUsesDefault = false;
				unavailableDefaultActive = true;
				ctx.ui.notify(
					`Configured default ${safeModelReference(configuredModel)} is unavailable; using same as plan.`,
					"warning",
				);
			}
			const model = selectedModel?.model ?? planModel;
			const thinkingLevel = selectedThinkingLevel ?? planThinkingLevel;
			return implementFresh(
				{
					...(model ? { model: { ...model } } : {}),
					...(thinkingLevel ? { thinkingLevel } : {}),
				},
				signal,
			);
		},
	};
}

function snapshotAvailableModels(ctx: ExtensionContext): ModelChoice[] {
	return snapshotAvailableImplementationModels(ctx)
		.map((model, index) => {
			const provider = safeModelMetadata(model.provider, "unknown provider");
			const modelId = safeModelMetadata(model.id, "unknown model");
			const name = safeModelMetadata(model.name, "");
			const isPlanModel = ctx.model?.provider === model.provider && ctx.model.id === model.id;
			const summary = `${modelId} [${provider}]`;
			return {
				itemId: `model-${index}`,
				model: { provider: model.provider, modelId: model.id },
				modelInfo: model,
				label: `${isPlanModel ? "✓ " : ""}${summary}${isPlanModel ? " · default" : ""}`,
				summary,
				...(name ? { details: [`Model Name: ${name}`] } : {}),
				searchText: [provider, modelId, name].filter(Boolean).join(" "),
				isPlanModel,
			};
		})
		.sort((left, right) => Number(right.isPlanModel) - Number(left.isPlanModel));
}

function safeModelReference(model: ImplementationModelOverride | undefined) {
	if (!model) return "configured model";
	return `${safeModelMetadata(model.modelId, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
}

function safeModelMetadata(value: unknown, fallback: string) {
	if (typeof value !== "string") return fallback;
	const safe = sanitizeTerminalText(value).trim() || fallback;
	return [...safe].slice(0, 512).join("");
}
