import { activePalette, type ModuleConfig, type StarshipConfig } from "../config.js";
import { type FormatValue, formatVariables, renderFormat } from "../format/formatter.js";
import { renderChunksToAnsi, type StyledChunk } from "../format/style.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./catalog.js";
import type { ModuleValueContext, RenderedStatusline, StarshipRuntimeSnapshot } from "./types.js";

export function renderStatusline(
	config: StarshipConfig,
	runtime: StarshipRuntimeSnapshot,
): RenderedStatusline<ModuleName> {
	const palette = activePalette(config);
	const modules = {} as Record<ModuleName, StyledChunk[]>;
	for (const name of MODULE_NAMES) modules[name] = [];
	const consumedExtensionStatusKeys = new Set<string>();

	for (const definition of MODULE_DEFINITIONS) {
		const name = definition.name;
		const values = definition.values(
			valueContext(config, name, runtime, consumedExtensionStatusKeys),
		);
		if (!values) continue;
		modules[name] = renderModule(config.modules[name], values, palette);
		if (
			name === "git_branch" &&
			values.pr &&
			formatVariables(config.modules.git_branch.formatAst).has("pr") &&
			modules.git_branch.some((chunk) => chunk.text.includes(values.pr ?? ""))
		) {
			consumedExtensionStatusKeys.add("github-pr");
		}
	}

	const explicitModules = formatVariables(config.formatAst);
	const all = MODULE_NAMES.flatMap((name) =>
		explicitModules.has(name) || config.modules[name].disabled ? [] : modules[name],
	);
	const rootVariables: Record<string, FormatValue> = { all };
	for (const name of MODULE_NAMES) rootVariables[name] = modules[name];
	const chunks = renderFormat(config.formatAst, { variables: rootVariables, palette });
	return {
		ansi: renderChunksToAnsi(chunks),
		chunks,
		modules,
		consumedExtensionStatusKeys,
	};
}

function valueContext(
	config: StarshipConfig,
	name: ModuleName,
	runtime: StarshipRuntimeSnapshot,
	hiddenExtensionStatusKeys: ReadonlySet<string>,
): ModuleValueContext {
	return {
		runtime,
		symbol: config.modules[name].symbol,
		extensionStatus: config.extensionStatus,
		hiddenExtensionStatusKeys,
	};
}

function renderModule(
	module: ModuleConfig,
	values: Readonly<Record<string, FormatValue>>,
	palette: Readonly<Record<string, string>>,
): StyledChunk[] {
	if (module.disabled) return [];
	return renderFormat(module.formatAst, {
		variables: { ...values, symbol: module.symbol },
		styleVariables: { style: module.style },
		palette,
	});
}
