import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPiSelector, type PiSelectorRow } from "./components/pi-selectors.js";
import { runCustomInteraction } from "./custom-interaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { MenuCloseReason, MenuContext } from "./types.js";

type ExtensionMode = MenuContext["mode"];

export interface ModelSelectorItem {
	provider: string;
	id: string;
	name?: string;
	/** Additional non-rendered text used by fuzzy search. */
	searchText?: string;
}

interface PiSelectorLifecycleOptions<Context extends MenuContext> {
	initialSearchInput?: string;
	viewportSize?: number;
	signal?: AbortSignal;
	isCurrent?(): boolean;
	onError?(ctx: Context, error: unknown): void | Promise<void>;
	onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export interface RunModelSelectorOptions<
	Item extends ModelSelectorItem,
	Context extends MenuContext = ExtensionCommandContext,
> extends PiSelectorLifecycleOptions<Context> {
	models: readonly Item[];
	currentModel?: Pick<ModelSelectorItem, "provider" | "id">;
	defaultModel?: Pick<ModelSelectorItem, "provider" | "id">;
	/** Optional context shown above search, such as a provider or scope note. */
	lines?: readonly string[];
}

export type RunModelSelectorResult<Item extends ModelSelectorItem = ModelSelectorItem> =
	| { kind: "selected"; model: Item }
	| { kind: "saveDefault"; model: Item }
	| { kind: "closed"; reason: MenuCloseReason }
	| { kind: "stale" }
	| { kind: "unsupported"; mode: ExtensionMode }
	| { kind: "error"; error: unknown };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RunThinkingSelectorOptions<Context extends MenuContext = ExtensionCommandContext>
	extends PiSelectorLifecycleOptions<Context> {
	availableLevels: readonly ThinkingLevel[];
	currentLevel: ThinkingLevel;
	defaultLevel?: ThinkingLevel;
}

export type RunThinkingSelectorResult =
	| { kind: "selected"; level: ThinkingLevel }
	| { kind: "saveDefault"; level: ThinkingLevel }
	| { kind: "closed"; reason: MenuCloseReason }
	| { kind: "stale" }
	| { kind: "unsupported"; mode: ExtensionMode }
	| { kind: "error"; error: unknown };

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/** Open a searchable TUI model selector with current and default state. */
export async function runModelSelector<
	const Item extends ModelSelectorItem,
	Context extends MenuContext = ExtensionCommandContext,
>(
	ctx: Context,
	options: RunModelSelectorOptions<Item, Context>,
): Promise<RunModelSelectorResult<Item>> {
	const models = sortModels(options.models, options.currentModel, options.defaultModel);
	const rows: PiSelectorRow<Item>[] = models.map((model) => ({
		value: model,
		primary: model.id,
		secondary: `[${model.provider}]`,
		description: model.name ? `Model Name: ${model.name}` : undefined,
		searchText: modelSelectorSearchText(model, sameModel(model, options.defaultModel)),
		current: sameModel(model, options.currentModel),
		default: sameModel(model, options.defaultModel),
	}));
	const result = await runCustomInteraction<
		| { kind: "selected"; value: Item }
		| { kind: "saveDefault"; value: Item }
		| { kind: "closed"; reason: MenuCloseReason },
		Context
	>(ctx, {
		signal: options.signal,
		isCurrent: options.isCurrent,
		onError: options.onError,
		onUnsupportedMode: options.onUnsupportedMode,
		create: ({ tui, theme, keybindings, complete }) => {
			validateViewportSize(options.viewportSize);
			validateModelRows(models);
			return createPiSelector({
				rows,
				context: options.lines,
				initialValue: models.find((model) => sameModel(model, options.currentModel)),
				initialSearchInput: options.initialSearchInput,
				viewportSize: options.viewportSize,
				saveBinding: "app.models.save",
				filterSelection: "bestMatch",
				prioritizeDefaultPrefix: true,
				valueEquals: sameModel,
				onComplete: complete,
				tui,
				theme,
				keybindings,
			});
		},
	});
	if (result.kind !== "completed") return result;
	if (result.value.kind === "selected") return { kind: "selected", model: result.value.value };
	if (result.value.kind === "saveDefault") {
		return { kind: "saveDefault", model: result.value.value };
	}
	return result.value;
}

/** Open a searchable TUI thinking selector with current and default state. */
export async function runThinkingSelector<Context extends MenuContext = ExtensionCommandContext>(
	ctx: Context,
	options: RunThinkingSelectorOptions<Context>,
): Promise<RunThinkingSelectorResult> {
	const rows: PiSelectorRow<ThinkingLevel>[] = options.availableLevels.map((level) => ({
		value: level,
		primary: level,
		description: LEVEL_DESCRIPTIONS[level],
		current: level === options.currentLevel,
		default: level === options.defaultLevel,
		searchText: level === options.defaultLevel ? "default" : undefined,
	}));
	const result = await runCustomInteraction<
		| { kind: "selected"; value: ThinkingLevel }
		| { kind: "saveDefault"; value: ThinkingLevel }
		| { kind: "closed"; reason: MenuCloseReason },
		Context
	>(ctx, {
		signal: options.signal,
		isCurrent: options.isCurrent,
		onError: options.onError,
		onUnsupportedMode: options.onUnsupportedMode,
		create: ({ tui, theme, keybindings, complete }) => {
			validateViewportSize(options.viewportSize);
			validateThinkingLevels(options.availableLevels, options.currentLevel);
			return createPiSelector({
				title: "Thinking Level",
				rows,
				initialValue: options.currentLevel,
				initialSearchInput: options.initialSearchInput,
				viewportSize: options.viewportSize ?? options.availableLevels.length,
				saveBinding: "app.models.save",
				cycleBinding: "app.thinking.cycle",
				filterSelection: "preserveValue",
				valueEquals: (left, right) => left === right,
				onComplete: complete,
				tui,
				theme,
				keybindings,
			});
		},
	});
	if (result.kind !== "completed") return result;
	if (result.value.kind === "selected") return { kind: "selected", level: result.value.value };
	if (result.value.kind === "saveDefault") {
		return { kind: "saveDefault", level: result.value.value };
	}
	return result.value;
}

function modelSelectorSearchText(model: ModelSelectorItem, isDefault: boolean) {
	return [
		model.provider,
		`${model.provider}/${model.id}`,
		model.provider,
		model.id,
		model.name,
		model.searchText,
		isDefault ? "default" : undefined,
	]
		.filter((value): value is string => Boolean(value))
		.join(" ");
}

function sortModels<Item extends ModelSelectorItem>(
	models: readonly Item[],
	current: Pick<ModelSelectorItem, "provider" | "id"> | undefined,
	defaultModel: Pick<ModelSelectorItem, "provider" | "id"> | undefined,
) {
	return models
		.map((model, index) => ({ model, index }))
		.sort((left, right) => {
			const currentOrder =
				Number(sameModel(right.model, current)) - Number(sameModel(left.model, current));
			if (currentOrder !== 0) return currentOrder;
			const defaultOrder =
				Number(sameModel(right.model, defaultModel)) - Number(sameModel(left.model, defaultModel));
			return (
				defaultOrder ||
				sanitizeSortText(left.model.provider).localeCompare(
					sanitizeSortText(right.model.provider),
				) ||
				left.index - right.index
			);
		})
		.map(({ model }) => model);
}

function sameModel(
	left: Pick<ModelSelectorItem, "provider" | "id">,
	right: Pick<ModelSelectorItem, "provider" | "id"> | undefined,
) {
	return left.provider === right?.provider && left.id === right.id;
}

function sanitizeSortText(value: string) {
	return sanitizeTerminalText(value);
}

function validateViewportSize(viewportSize: number | undefined) {
	if (
		viewportSize !== undefined &&
		(!Number.isInteger(viewportSize) || !Number.isFinite(viewportSize) || viewportSize <= 0)
	) {
		throw new Error("Selector viewport size must be a positive integer");
	}
}

function validateModelRows(models: readonly ModelSelectorItem[]) {
	if (models.length === 0) throw new Error("Model selector requires at least one model");
	const identities = new Set<string>();
	for (const model of models) {
		const identity = `${model.provider}\0${model.id}`;
		if (identities.has(identity)) {
			const reference = `${sanitizeTerminalText(model.provider)}/${sanitizeTerminalText(model.id)}`;
			throw new Error(`Model selector contains duplicate model ${reference}`);
		}
		identities.add(identity);
	}
}

function validateThinkingLevels(levels: readonly ThinkingLevel[], current: ThinkingLevel) {
	if (levels.length === 0) throw new Error("Thinking selector requires at least one level");
	if (new Set(levels).size !== levels.length) {
		throw new Error("Thinking selector contains duplicate levels");
	}
	if (!levels.includes(current)) {
		throw new Error(`Current thinking level ${sanitizeTerminalText(current)} is not available`);
	}
}
