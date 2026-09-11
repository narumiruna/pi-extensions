import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	defineMenu,
	type RunMenuResult,
	runMenu,
	sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import {
	type AvailableImplementationModel,
	findAvailableImplementationModel,
	type ImplementationModelOverride,
	snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { retentionLabel } from "./implementation-retention.js";
import { planExportDestination } from "./plan-export.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import {
	configuredImplementationModel,
	configuredImplementationPlanRetention,
	configuredImplementationThinkingLevel,
	configuredPlanExportPath,
	configuredPlanModeToggleShortcut,
	IMPLEMENTATION_PLAN_RETENTIONS,
	IMPLEMENTATION_THINKING_LEVELS,
	normalizeKeyId,
	PLAN_MODE_THINKING_LEVELS,
	type PlanModeSettings,
	type PlanModeSettingsLoadResult,
	type PlanModeSettingsPatch,
	planModeSettingsPath,
	readPlanModeSettings,
	type UpdatePlanModeSettingsOptions,
	updatePlanModeSettings,
} from "./settings.js";
import { canSelectToolInPlanMode } from "./tool-policy.js";
import { defaultPlanModeToolNames, toolPolicyLabel } from "./tool-selection.js";

interface SettingsMenuState {
	kind: "valid" | "invalid";
	settings: PlanModeSettings;
	notice?: string;
	reason?: string;
}

export interface PlanModeSettingsMenuOptions {
	tools: readonly ToolInfo[];
	activeToolNames?: readonly string[];
	signal: AbortSignal;
	isCurrent(): boolean;
	settingsPath?: string;
	legacySettingsPath?: string;
	readSettings?: (settingsPath?: string) => Promise<PlanModeSettingsLoadResult>;
	updateSettings?: (
		patch: PlanModeSettingsPatch,
		options?: UpdatePlanModeSettingsOptions,
	) => Promise<PlanModeSettings>;
	onSaved(settings: PlanModeSettings): void;
}

type Screen = "settings" | "tools" | "implementation-model" | "export" | "shortcut";
type Action =
	| "set-thinking"
	| "open-tools"
	| "toggle-tool"
	| "reset-tools"
	| "set-retention"
	| "open-implementation-model"
	| "set-implementation-model"
	| "set-implementation-thinking"
	| "open-export"
	| "set-export"
	| "open-shortcut"
	| "set-shortcut";

export async function showPlanModeSettings(
	ctx: ExtensionContext,
	options: PlanModeSettingsMenuOptions,
): Promise<RunMenuResult> {
	const settingsPath = options.settingsPath ?? planModeSettingsPath();
	const readSettings = options.readSettings ?? readPlanModeSettings;
	const updateSettings = options.updateSettings ?? updatePlanModeSettings;
	const activeToolNames = new Set(
		options.activeToolNames ?? options.tools.map((tool) => tool.name),
	);
	const tools = options.tools.filter(
		(tool) =>
			tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
	);
	const toolItemIds = new Map(
		tools.map((tool, index) => [tool.name, `plan-settings-tool:${index}`]),
	);
	const toolsByItemId = new Map(tools.map((tool) => [toolItemIds.get(tool.name) as string, tool]));
	const implementationModels = snapshotAvailableImplementationModels(ctx);
	const modelItemIds = new Map(
		implementationModels.map((model, index) => [model, `plan-settings-model:${index}`]),
	);
	const modelsByItemId = new Map(
		implementationModels.map((model) => [modelItemIds.get(model) as string, model]),
	);

	const loadState = async (): Promise<SettingsMenuState> => {
		const loaded = await readSettings(options.settingsPath);
		if (loaded.kind === "invalid") {
			return {
				kind: "invalid",
				settings: { thinkingLevel: "inherit" },
				notice: loaded.notice,
				reason: loaded.reason,
			};
		}
		return {
			kind: "valid",
			settings: loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" },
			notice: loaded.notice,
		};
	};

	const menu = defineMenu<SettingsMenuState, Screen, Action, ExtensionContext>({
		start: "settings",
		screens: {
			settings: ({ state }) =>
				state.kind === "invalid"
					? invalidScreen(settingsPath, state)
					: {
							kind: "settings",
							title: "Plan Mode Settings",
							lines: settingsLines(settingsPath, state.notice),
							items: [
								{
									id: "thinkingLevel",
									label: "Plan thinking",
									description: "Set the thinking level when the next Plan workflow starts.",
									currentValue: state.settings.thinkingLevel,
									values: PLAN_MODE_THINKING_LEVELS,
									action: "set-thinking",
								},
								{
									id: "defaultPlanTools",
									label: "Plan policy tools",
									description:
										"Choose active tools or retain names to resolve before the first request.",
									currentValue: defaultToolsValue(state.settings.defaultPlanTools),
									action: "open-tools",
								},
								{
									id: "implementationPlanRetention",
									label: "Plan reinjection",
									description:
										"Choose how long Plan mode restores the exact plan when ordinary context no longer contains it.",
									currentValue: retentionLabel(
										configuredImplementationPlanRetention(state.settings),
									),
									values: IMPLEMENTATION_PLAN_RETENTIONS.map(retentionLabel),
									action: "set-retention",
								},
								{
									id: "defaultImplementationModel",
									label: "Fresh model",
									description: "Choose the default model for a fresh implementation session.",
									currentValue: implementationModelValue(state.settings, implementationModels),
									action: "open-implementation-model",
								},
								{
									id: "defaultImplementationThinkingLevel",
									label: "Fresh thinking",
									description:
										"Choose the default thinking level for a fresh implementation session.",
									currentValue:
										configuredImplementationThinkingLevel(state.settings) ?? "same as plan",
									values: ["same as plan", ...IMPLEMENTATION_THINKING_LEVELS],
									action: "set-implementation-thinking",
								},
								{
									id: "defaultPlanExportPath",
									label: "Export destination",
									description: "Set the destination used when an export omits its path.",
									currentValue: safeTerminalText(configuredPlanExportPath(state.settings)),
									action: "open-export",
								},
								{
									id: "toggleShortcut",
									label: "Plan mode shortcut",
									description: "Set the global shortcut used to toggle Plan mode.",
									currentValue: configuredPlanModeToggleShortcut(state.settings) ?? "none",
									action: "open-shortcut",
								},
							],
						},
			tools: ({ state }) => ({
				kind: "multiSelect",
				title: "Default Plan policy allowlist",
				lines: [
					"Changes apply when a later Plan workflow starts; model-visible tools stay unchanged.",
					"Retained inactive names resolve before that workflow's first request.",
					"Plan mode never activates tools, and non-built-ins run at user risk.",
				],
				enableSearch: true,
				viewportSize: 10,
				items: defaultToolItems(
					tools,
					state.settings.defaultPlanTools,
					activeToolNames,
					toolItemIds,
				),
				action: "toggle-tool",
				actions: [
					{
						id: "reset-tools",
						label: "Use automatic safe built-ins",
						action: "reset-tools",
					},
				],
				hint: "back",
			}),
			"implementation-model": ({ state }) => ({
				kind: "choice",
				title: "Fresh implementation model",
				lines: ["Same as plan is the default and fallback when a configured model is unavailable."],
				items: implementationModelItems(implementationModels, modelItemIds),
				action: "set-implementation-model",
				initialItemId: implementationModelItemId(
					configuredImplementationModel(state.settings),
					implementationModels,
					modelItemIds,
				),
				enableSearch: true,
				viewportSize: 10,
				hint: "back",
			}),
			export: ({ state }) => {
				const configured = configuredPlanExportPath(state.settings);
				const destination = planExportDestination(configured, ctx.cwd);
				return {
					kind: "input",
					title: "Export destination",
					lines: [
						`Configured: ${destination.configuredPath}`,
						`Resolves here to: ${destination.resolvedPath}`,
						"Submit an empty value to reset to PLAN.md. Changes affect the next export.",
					],
					placeholder: configured,
					action: "set-export",
					hint: "back",
				};
			},
			shortcut: ({ state }) => ({
				kind: "input",
				title: "Plan mode shortcut",
				lines: [
					`Configured: ${configuredPlanModeToggleShortcut(state.settings) ?? "none"}`,
					"Use Pi key identifiers.",
					"Submit an empty value to clear the shortcut.",
					"When unset, Plan mode has no global shortcut.",
				],
				placeholder: configuredPlanModeToggleShortcut(state.settings) ?? "",
				action: "set-shortcut",
				hint: "back",
			}),
		},
		actions: {
			"set-thinking": async ({ ctx: actionCtx, value, signal }) => {
				if (
					!PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])
				) {
					return { kind: "rejected" };
				}
				return savePatch(
					actionCtx,
					{ thinkingLevel: value as PlanModeSettings["thinkingLevel"] },
					signal,
					`Plan mode thinking level: ${value}. Applies to the next Plan workflow.`,
				);
			},
			"open-tools": async () => ({ kind: "to", screen: "tools" }),
			"set-retention": async ({ ctx: actionCtx, value, signal }) => {
				const implementationPlanRetention = retentionFromLabel(value);
				if (!implementationPlanRetention) return { kind: "rejected" };
				return savePatch(
					actionCtx,
					{ implementationPlanRetention },
					signal,
					`Plan reinjection: ${retentionLabel(implementationPlanRetention)}. Applies to the next Implement action.`,
				);
			},
			"open-implementation-model": async () => ({
				kind: "to",
				screen: "implementation-model",
			}),
			"set-implementation-model": async ({ ctx: actionCtx, itemId, signal }) => {
				const model = itemId ? modelsByItemId.get(itemId) : undefined;
				if (itemId !== "same-as-plan" && !model) return { kind: "rejected" };
				const defaultImplementationModel = model
					? { provider: model.provider, modelId: model.id }
					: null;
				const result = await savePatch(
					actionCtx,
					{ defaultImplementationModel },
					signal,
					model
						? `Fresh implementation model: ${safeModelReference({ provider: model.provider, modelId: model.id })}.`
						: "Fresh implementation model: same as plan.",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"set-implementation-thinking": async ({ ctx: actionCtx, value, signal }) => {
				if (value === "same as plan") {
					return savePatch(
						actionCtx,
						{ defaultImplementationThinkingLevel: null },
						signal,
						"Fresh implementation thinking: same as plan.",
					);
				}
				if (
					!IMPLEMENTATION_THINKING_LEVELS.includes(
						value as (typeof IMPLEMENTATION_THINKING_LEVELS)[number],
					)
				) {
					return { kind: "rejected" };
				}
				return savePatch(
					actionCtx,
					{
						defaultImplementationThinkingLevel:
							value as PlanModeSettings["defaultImplementationThinkingLevel"],
					},
					signal,
					`Fresh implementation thinking: ${value}.`,
				);
			},
			"open-export": async () => ({ kind: "to", screen: "export" }),
			"set-export": async ({ ctx: actionCtx, value, signal }) => {
				const defaultPlanExportPath = value?.trim() || null;
				const result = await savePatch(
					actionCtx,
					{ defaultPlanExportPath },
					signal,
					defaultPlanExportPath
						? `Default Plan export destination: ${safeTerminalText(defaultPlanExportPath)}.`
						: "Default Plan export destination reset to PLAN.md.",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"open-shortcut": async () => ({ kind: "to", screen: "shortcut" }),
			"set-shortcut": async ({ ctx: actionCtx, value, signal }) => {
				const raw = value?.trim() || null;
				if (raw && !normalizeKeyId(raw)) {
					actionCtx.ui.notify(
						`Invalid key identifier: ${safeTerminalText(raw)}. Use Pi key identifiers like ctrl+alt+p.`,
						"warning",
					);
					return { kind: "stay" as const };
				}
				const toggleShortcut = raw as PlanModeSettingsPatch["toggleShortcut"];
				const result = await savePatch(
					actionCtx,
					{ toggleShortcut },
					signal,
					toggleShortcut
						? `Plan mode shortcut: ${safeTerminalText(toggleShortcut)}.`
						: "Plan mode shortcut cleared (no global shortcut).",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"toggle-tool": async ({ ctx: actionCtx, state, itemId, selected, signal }) => {
				const tool = itemId ? toolsByItemId.get(itemId) : undefined;
				if (!tool || !activeToolNames.has(tool.name) || !canSelectToolInPlanMode(tool)) {
					return { kind: "rejected" };
				}
				const names = explicitToolNames(tools, state.settings.defaultPlanTools);
				const next = selected
					? Array.from(new Set([...names, tool.name]))
					: names.filter((name) => name !== tool.name);
				return savePatch(
					actionCtx,
					{ defaultPlanTools: next },
					signal,
					`Default Plan policy: ${next.length === 0 ? "no optional tools" : `${next.length} allowed`}.`,
				);
			},
			"reset-tools": async ({ ctx: actionCtx, state, signal }) => {
				if (state.settings.defaultPlanTools === undefined) return { kind: "stay" };
				return savePatch(
					actionCtx,
					{ defaultPlanTools: null },
					signal,
					"Default Plan-mode tools: automatic safe built-ins.",
				);
			},
		},
	});

	return runMenu(ctx, menu, {
		getState: loadState,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});

	async function savePatch(
		actionCtx: ExtensionContext,
		patch: PlanModeSettingsPatch,
		signal: AbortSignal,
		successMessage: string,
	) {
		if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
		try {
			const saved = await updateSettings(patch, {
				settingsPath: options.settingsPath,
				legacySettingsPath: options.legacySettingsPath,
				signal,
			});
			if (options.isCurrent()) options.onSaved(saved);
			if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
			actionCtx.ui.notify(successMessage, "info");
			return { kind: "stay" as const };
		} catch (error) {
			if (!signal.aborted && options.isCurrent()) {
				actionCtx.ui.notify(
					`Could not save Plan mode settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
					"error",
				);
			}
			return { kind: "rejected" as const };
		}
	}
}

function settingsLines(settingsPath: string, notice: string | undefined) {
	return [
		`User settings · ${safeTerminalText(settingsPath)}`,
		"Plan defaults apply to the next workflow; reinjection and export choices apply to their next action.",
		...(notice ? [safeTerminalText(notice)] : []),
	];
}

function invalidScreen(settingsPath: string, state: SettingsMenuState) {
	return {
		kind: "detail" as const,
		title: "Plan Mode Settings · Read only",
		lines: [
			`Invalid settings file. Fix ${safeTerminalText(settingsPath)} before saving.`,
			safeTerminalText(state.reason ?? "The settings file is invalid."),
			...(state.notice ? [safeTerminalText(state.notice)] : []),
		],
		hint: "back" as const,
	};
}

function retentionFromLabel(value: string | undefined) {
	return IMPLEMENTATION_PLAN_RETENTIONS.find((retention) => retentionLabel(retention) === value);
}

function implementationModelValue(
	settings: PlanModeSettings,
	models: readonly AvailableImplementationModel[],
) {
	const configured = configuredImplementationModel(settings);
	if (!configured) return "same as plan";
	return findAvailableImplementationModel(models, configured)
		? safeModelReference(configured)
		: `same as plan · ${safeModelReference(configured)} unavailable`;
}

function implementationModelItems(
	models: readonly AvailableImplementationModel[],
	itemIds: ReadonlyMap<AvailableImplementationModel, string>,
) {
	return [
		{
			id: "same-as-plan",
			label: "Same as plan",
			description: "Use the planning session model.",
		},
		...models.map((model) => {
			const reference = safeModelReference({ provider: model.provider, modelId: model.id });
			const name = safeModelMetadata(model.name, "");
			return {
				id: itemIds.get(model) as string,
				label: reference,
				...(name ? { details: [`Model Name: ${name}`] } : {}),
				searchText: [reference, name].filter(Boolean).join(" "),
			};
		}),
	];
}

function implementationModelItemId(
	configured: ImplementationModelOverride | undefined,
	models: readonly AvailableImplementationModel[],
	itemIds: ReadonlyMap<AvailableImplementationModel, string>,
) {
	const model = findAvailableImplementationModel(models, configured);
	return model ? itemIds.get(model) : "same-as-plan";
}

function safeModelReference(model: ImplementationModelOverride) {
	return `${safeModelMetadata(model.modelId, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
}

function safeModelMetadata(value: unknown, fallback: string) {
	if (typeof value !== "string") return fallback;
	const safe = sanitizeTerminalText(value).trim() || fallback;
	return [...safe].slice(0, 512).join("");
}

function defaultToolsValue(configured: string[] | undefined) {
	if (configured === undefined) return "Automatic safe built-ins";
	if (configured.length === 0) return "No optional tools";
	return `${configured.length} selected`;
}

function defaultToolItems(
	tools: readonly ToolInfo[],
	configured: string[] | undefined,
	activeToolNames: ReadonlySet<string>,
	toolItemIds: ReadonlyMap<string, string>,
) {
	const selected = new Set(explicitToolNames(tools, configured));
	const availableNames = new Set(tools.map((tool) => tool.name));
	const items = tools.map((tool) => {
		const active = activeToolNames.has(tool.name);
		const selectable = active && canSelectToolInPlanMode(tool);
		const policy = active
			? toolPolicyLabel(tool)
			: selected.has(tool.name)
				? "not active yet; retained for first-request resolution"
				: "not active in this Pi session";
		const description = tool.description ?? "No description available";
		return {
			id: toolItemIds.get(tool.name) as string,
			label: tool.name,
			description: `${policy} · ${description}`,
			searchText: `${policy} ${description}`,
			selected: selected.has(tool.name),
			disabled: !selectable,
			disabledReason: !active
				? selected.has(tool.name)
					? "Not active yet; retained and resolved before the first request"
					: "Not active in Pi; Plan mode will not activate it"
				: selectable
					? undefined
					: "Blocked by Plan-mode policy",
		};
	});
	for (const [index, name] of (configured ?? []).entries()) {
		if (availableNames.has(name)) continue;
		const label = terminalToolName(name);
		items.push({
			id: `plan-settings-pending:${index}`,
			label,
			description: "pending registration · Retained and resolved before the first request",
			searchText: `${label} pending registration retained settings first request`,
			selected: true,
			disabled: true,
			disabledReason: "Not registered yet; reset defaults to remove retained names",
		});
	}
	return items;
}

function explicitToolNames(tools: readonly ToolInfo[], configured: string[] | undefined) {
	return configured === undefined
		? defaultPlanModeToolNames([...tools], undefined)
		: [...configured];
}

function terminalToolName(value: string) {
	const safe = safeTerminalText(value) || "(unnamed tool)";
	return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
