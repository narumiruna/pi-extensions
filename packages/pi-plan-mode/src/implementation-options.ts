import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChoiceScreen, SettingsScreen } from "@narumitw/pi-tui-kit";
import { safeImplementationText as terminalText } from "./implementation-preferences.js";
import { type ImplementationPreferences, PLAN_MODE_THINKING_LEVELS } from "./settings.js";

export function implementationModelLabel(model: ImplementationPreferences["implementationModel"]) {
	return model ? terminalText(`${model.provider} / ${model.id}`) : "Use current";
}

export function implementationSummary(preferences: ImplementationPreferences) {
	return `Model: ${implementationModelLabel(preferences.implementationModel)} · Thinking: ${preferences.implementationThinkingLevel && preferences.implementationThinkingLevel !== "inherit" ? preferences.implementationThinkingLevel : "Use normal behavior"}`;
}

export type ImplementationOptionAction =
	| "open-implementation-model"
	| "set-implementation-model"
	| "set-implementation-thinking";

export function implementationSettingItems(
	preferences: ImplementationPreferences,
): SettingsScreen<ImplementationOptionAction>["items"] {
	return [
		{
			id: "implementationModel",
			label: "Implementation model",
			currentValue: implementationModelLabel(preferences.implementationModel),
			description:
				"Select the model only when implementation starts; never switch back automatically.",
			action: "open-implementation-model",
		},
		{
			id: "implementationThinkingLevel",
			label: "Implementation thinking",
			currentValue: preferences.implementationThinkingLevel ?? "inherit",
			values: PLAN_MODE_THINKING_LEVELS,
			description:
				"inherit preserves normal behavior, including restoration of Plan thinking. Explicit levels apply after model selection and are clamped by Pi.",
			action: "set-implementation-thinking",
		},
	];
}

export function createImplementationModelPicker(ctx: ExtensionContext) {
	// Snapshot Pi's scoped catalogue without network refresh or auth execution.
	// Unlike /model, this picker stages a preference and never persists Pi defaults.
	const models = ctx.scopedModels?.length
		? ctx.scopedModels.map(({ model }) => model)
		: ctx.modelRegistry.getAvailable();
	const byId = new Map(
		models.map((model, index) => [
			`implementation-model:${index}`,
			{ provider: model.provider, id: model.id },
		]),
	);
	return {
		selection(itemId: string) {
			return itemId === "implementation-current" ? null : byId.get(itemId);
		},
		screen(preferences: ImplementationPreferences): ChoiceScreen<"set-implementation-model"> {
			return {
				kind: "choice",
				title: "Implementation model",
				enableSearch: true,
				viewportSize: 10,
				hint: "back",
				action: "set-implementation-model",
				lines: [
					"Use current makes no model change. Reopen this menu to refresh the catalogue.",
					"Implement here sends the planning conversation to the selected provider; fresh transfers only the approved plan and normal destination resources.",
					`Selected: ${implementationModelLabel(preferences.implementationModel)}`,
				],
				items: [
					{ id: "implementation-current", label: "Use current" },
					...[...byId].map(([id, model]) => ({ id, label: implementationModelLabel(model) })),
				],
			};
		},
	};
}

/** Local draft lives only as long as the owning action menu. */
export function createImplementationOptions(
	ctx: ExtensionContext,
	initial: ImplementationPreferences = {},
) {
	let preferences = { ...initial };
	let picker: ReturnType<typeof createImplementationModelPicker> | undefined;
	return {
		get: () => preferences,
		summary: () => implementationSummary(preferences),
		screens: {
			"implementation-options": (): SettingsScreen<ImplementationOptionAction> => ({
				kind: "settings",
				title: "Implementation options",
				lines: [
					"Applies to both implementation actions in this menu only.",
					"Changes take effect only when implementation starts. No automatic restoration afterwards.",
					`Current model: ${implementationModelLabel(ctx.model)}`,
					"inherit keeps normal thinking behavior, not necessarily the temporary Plan thinking level.",
				],
				items: implementationSettingItems(preferences),
			}),
			"implementation-model": () => {
				picker ??= createImplementationModelPicker(ctx);
				return picker.screen(preferences);
			},
		},
		actions: {
			"open-implementation-model": async () => ({
				kind: "to" as const,
				screen: "implementation-model" as const,
			}),
			"set-implementation-model": async ({ itemId }: { itemId: string }) => {
				const selected = picker?.selection(itemId);
				if (selected === undefined) return { kind: "rejected" as const };
				preferences = { ...preferences, implementationModel: selected ?? undefined };
				return { kind: "back" as const };
			},
			"set-implementation-thinking": async ({ value }: { value?: string }) => {
				const level = PLAN_MODE_THINKING_LEVELS.find((level) => level === value);
				if (!level) return { kind: "rejected" as const };
				preferences = { ...preferences, implementationThinkingLevel: level };
				return { kind: "stay" as const };
			},
		},
	};
}
