import { visibleWidth } from "@earendil-works/pi-tui";
import { activePalette, type ModuleConfig, type StarshipConfig } from "../config.js";
import { type FormatValue, formatVariables, renderFormat } from "../format/formatter.js";
import {
	isFillChunk,
	type LayoutChunk,
	renderChunksToAnsi,
	type StyledChunk,
} from "../format/style.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./catalog.js";
import type { ModuleValueContext, RenderedStatusline, StarshipRuntimeSnapshot } from "./types.js";

export function renderStatusline(
	config: StarshipConfig,
	runtime: StarshipRuntimeSnapshot,
	width = 80,
): RenderedStatusline<ModuleName> {
	const palette = activePalette(config);
	const modules = {} as Record<ModuleName, StyledChunk[]>;
	const layoutModules = {} as Record<ModuleName, LayoutChunk[]>;
	for (const name of MODULE_NAMES) {
		modules[name] = [];
		layoutModules[name] = [];
	}
	const consumedExtensionStatusKeys = new Set<string>();

	for (const definition of MODULE_DEFINITIONS) {
		const name = definition.name;
		const values = definition.values(
			valueContext(config, name, runtime, consumedExtensionStatusKeys),
		);
		if (!values) continue;
		const rendered = renderModule(config.modules[name], values, palette);
		modules[name] = rendered;
		layoutModules[name] =
			definition.layout === "fill" && !config.modules[name].disabled
				? [{ type: "fill", pattern: rendered }]
				: rendered;
		if (
			name === "git_branch" &&
			values.pr &&
			formatVariables(config.modules.git_branch.formatAst).has("pr") &&
			rendered.some((chunk) => chunk.text.includes(values.pr ?? ""))
		) {
			consumedExtensionStatusKeys.add("github-pr");
		}
	}

	const explicitModules = formatVariables(config.formatAst);
	const all = MODULE_NAMES.flatMap((name) =>
		explicitModules.has(name) || config.modules[name].disabled ? [] : layoutModules[name],
	);
	const rootVariables: Record<string, FormatValue> = { all };
	for (const name of MODULE_NAMES) rootVariables[name] = layoutModules[name];
	const layout = renderFormat(config.formatAst, { variables: rootVariables, palette });
	const chunks = resolveFillLayout(layout, width);
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
		variables: { symbol: module.symbol, ...values },
		styleVariables: { style: module.style },
		palette,
	}).filter((chunk): chunk is StyledChunk => !isFillChunk(chunk));
}

export function reachableModuleRequirements(
	config: StarshipConfig,
): ReadonlyMap<ModuleName, ReadonlySet<string>> {
	const rootVariables = formatVariables(config.formatAst);
	const includeAll = rootVariables.has("all");
	const requirements = new Map<ModuleName, ReadonlySet<string>>();
	for (const definition of MODULE_DEFINITIONS) {
		if (config.modules[definition.name].disabled) continue;
		if (!includeAll && !rootVariables.has(definition.name)) continue;
		requirements.set(definition.name, formatVariables(config.modules[definition.name].formatAst));
	}
	return requirements;
}

function resolveFillLayout(layout: readonly LayoutChunk[], width: number): StyledChunk[] {
	const lines = splitLogicalLines(layout);
	const resolved: StyledChunk[] = [];
	for (const [lineIndex, line] of lines.entries()) {
		const fills = line.filter(isFillChunk);
		const fixedWidth = line.reduce(
			(total, chunk) =>
				total + (isFillChunk(chunk) ? 0 : visibleWidth(renderChunksToAnsi([chunk]))),
			0,
		);
		const remaining = Math.max(0, width - fixedWidth);
		const base = fills.length > 0 ? Math.floor(remaining / fills.length) : 0;
		let remainder = fills.length > 0 ? remaining % fills.length : 0;
		for (const chunk of line) {
			if (!isFillChunk(chunk)) {
				resolved.push(chunk);
				continue;
			}
			const allocation = base + (remainder > 0 ? 1 : 0);
			if (remainder > 0) remainder -= 1;
			resolved.push(...expandFill(chunk.pattern, allocation));
		}
		if (lineIndex < lines.length - 1) resolved.push({ text: "\n" });
	}
	return resolved;
}

function splitLogicalLines(layout: readonly LayoutChunk[]): LayoutChunk[][] {
	const lines: LayoutChunk[][] = [[]];
	for (const chunk of layout) {
		if (isFillChunk(chunk)) {
			lines.at(-1)?.push(chunk);
			continue;
		}
		const parts = chunk.text.split("\n");
		for (const [index, text] of parts.entries()) {
			if (text) lines.at(-1)?.push({ ...chunk, text });
			if (index < parts.length - 1) lines.push([]);
		}
	}
	return lines;
}

function expandFill(pattern: readonly StyledChunk[], width: number): StyledChunk[] {
	if (width <= 0) return [];
	const patternWidth = visibleWidth(renderChunksToAnsi(pattern));
	if (patternWidth <= 0) return [{ text: " ".repeat(width), style: pattern[0]?.style }];
	const repetitions = Math.floor(width / patternWidth);
	const result: StyledChunk[] = [];
	for (let index = 0; index < repetitions; index += 1) {
		result.push(...pattern.map((chunk) => ({ ...chunk })));
	}
	const remainder = width - repetitions * patternWidth;
	if (remainder > 0) result.push({ text: " ".repeat(remainder), style: pattern.at(-1)?.style });
	return result;
}
