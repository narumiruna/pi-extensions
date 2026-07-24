import { randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, type TomlTable } from "smol-toml";
import {
	type FormatNode,
	formatVariables,
	parseFormat,
	styleVariables,
} from "./format/formatter.js";
import { type ColorPalette, isValidStyle, parseColor } from "./format/style.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./modules/catalog.js";

export const CONFIG_FILE_NAME = "pi-starship.toml";
export { MODULE_NAMES, type ModuleName } from "./modules/catalog.js";

const MODULE_CONTENT_VARIABLES = Object.fromEntries(
	MODULE_DEFINITIONS.map((definition) => [definition.name, definition.variables]),
) as Record<ModuleName, readonly string[]>;

export interface ModuleConfig {
	format: string;
	formatAst: FormatNode[];
	symbol: string;
	style: string;
	disabled: boolean;
}

export interface ExtensionStatusConfig {
	separator: string;
	maxStatuses: number;
	icons: Record<string, string>;
}

export interface StarshipConfig {
	format: string;
	formatAst: FormatNode[];
	palette: string;
	palettes: Record<string, Record<string, string>>;
	modules: Record<ModuleName, ModuleConfig>;
	extensionStatus: ExtensionStatusConfig;
}

export interface ConfigDiagnostic {
	severity: "warning" | "error";
	path: string;
	message: string;
}

export interface LoadedStarshipConfig {
	config: StarshipConfig;
	source: "built-in" | "user";
	settingsPath: string;
	rawDocument?: string;
	diagnostics: ConfigDiagnostic[];
}

const BUILT_IN_FORMAT_DOCUMENT = String.raw`format = """
[░▒▓](lead)\
$brand\
$provider\
$model\
$thinking\
[](fg:header bg:directory)\
$directory\
[](fg:directory bg:git)\
$git_worktree\
$git_branch\
$git_status\
[](fg:git bg:runtime)\
$activity\
$context\
$tokens\
[](fg:runtime bg:meter)\
$cost\
$time\
[](fg:meter)\
(\n$extension_status)"""`;

const BUILT_IN_FORMAT = parseBuiltInFormat(BUILT_IN_FORMAT_DOCUMENT);

const BUILT_IN_PALETTE = {
	lead: "#a3aed2",
	header: "#a3aed2",
	header_fg: "#090c0c",
	directory: "#769ff0",
	directory_fg: "#e3e5e5",
	git: "#394260",
	git_fg: "#769ff0",
	runtime: "#212736",
	runtime_fg: "#769ff0",
	meter: "#1d2230",
	meter_fg: "#a0a9cb",
	extension: "#a0a9cb",
};

const BUILT_IN_MODULES = Object.fromEntries(
	MODULE_DEFINITIONS.map(({ name, defaults }) => [
		name,
		{
			...defaults,
			formatAst: parseFormat(defaults.format),
		},
	]),
) as Record<ModuleName, ModuleConfig>;

export const BUILT_IN_CONFIG: StarshipConfig = {
	format: BUILT_IN_FORMAT,
	formatAst: parseFormat(BUILT_IN_FORMAT),
	palette: "tokyo-night",
	palettes: { "tokyo-night": BUILT_IN_PALETTE },
	modules: BUILT_IN_MODULES,
	extensionStatus: { separator: " • ", maxStatuses: 5, icons: {} },
};

export const BUILT_IN_EXAMPLE = `# Native Pi modules with Starship-compatible format and style syntax.\n${BUILT_IN_FORMAT_DOCUMENT}\npalette = "tokyo-night"\n\n[palettes.tokyo-night]\n${Object.entries(
	BUILT_IN_PALETTE,
)
	.map(([name, color]) => `${name} = "${color}"`)
	.join("\n")}\n`;

function parseBuiltInFormat(document: string): string {
	const format = parse(document).format;
	if (typeof format !== "string") throw new Error("Built-in format document must define a string");
	return format;
}

export function settingsFilePath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function loadStarshipConfig(settingsPath: string): LoadedStarshipConfig {
	let rawDocument: string;
	try {
		rawDocument = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if (!existsSync(settingsPath)) {
			return {
				config: cloneBuiltInConfig(),
				source: "built-in",
				settingsPath,
				diagnostics: [],
			};
		}
		return {
			config: cloneBuiltInConfig(),
			source: "built-in",
			settingsPath,
			diagnostics: [diagnostic("error", "", `Unable to read settings: ${formatError(error)}`)],
		};
	}

	let parsed: TomlTable;
	try {
		parsed = parse(rawDocument);
	} catch (error) {
		return {
			config: cloneBuiltInConfig(),
			source: "built-in",
			settingsPath,
			rawDocument,
			diagnostics: [diagnostic("error", "", `Unable to parse TOML: ${formatError(error)}`)],
		};
	}
	const normalized = normalizeConfig(parsed);
	return {
		...normalized,
		source: "user",
		settingsPath,
		rawDocument,
	};
}

interface InitialFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	linkSync: typeof linkSync;
	rmSync: typeof rmSync;
}

export function loadOrCreateStarshipConfig(
	settingsPath: string,
	overrides: Partial<InitialFileSystem> = {},
): LoadedStarshipConfig {
	const loaded = loadStarshipConfig(settingsPath);
	if (loaded.source === "user" || loaded.diagnostics.length > 0) return loaded;

	const fs = { mkdirSync, writeFileSync, linkSync, rmSync, ...overrides };
	const tempPath = join(dirname(settingsPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
	try {
		fs.mkdirSync(dirname(settingsPath), { recursive: true });
		fs.writeFileSync(tempPath, BUILT_IN_EXAMPLE, { encoding: "utf8", flag: "wx" });
		try {
			fs.linkSync(tempPath, settingsPath);
		} catch (error) {
			if (isAlreadyExistsError(error)) return loadStarshipConfig(settingsPath);
			throw error;
		}
		return loadStarshipConfig(settingsPath);
	} catch (error) {
		return {
			...loaded,
			diagnostics: [
				diagnostic("warning", "", `Unable to create default settings: ${formatError(error)}`),
			],
		};
	} finally {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the initialization result.
		}
	}
}

export function normalizeConfig(value: unknown): {
	config: StarshipConfig;
	diagnostics: ConfigDiagnostic[];
} {
	const config = cloneBuiltInConfig();
	const diagnostics: ConfigDiagnostic[] = [];
	if (!isRecord(value)) {
		return {
			config,
			diagnostics: [diagnostic("error", "", "Settings must contain a TOML table")],
		};
	}

	const knownRoot = new Set(["format", "palette", "palettes", ...MODULE_NAMES]);
	for (const key of Object.keys(value)) {
		if (!knownRoot.has(key)) diagnostics.push(unknownDiagnostic(key));
	}

	if (value.format !== undefined) {
		if (typeof value.format !== "string") {
			diagnostics.push(typeDiagnostic("format", "string"));
		} else {
			try {
				config.formatAst = parseFormat(value.format);
				config.format = value.format;
			} catch (error) {
				diagnostics.push(
					diagnostic("warning", "format", `Invalid format; using built-in: ${formatError(error)}`),
				);
			}
		}
	}

	if (value.palettes !== undefined) {
		if (!isRecord(value.palettes)) {
			diagnostics.push(typeDiagnostic("palettes", "table"));
		} else {
			for (const [paletteName, paletteValue] of Object.entries(value.palettes)) {
				if (!isRecord(paletteValue)) {
					diagnostics.push(typeDiagnostic(`palettes.${paletteName}`, "table"));
					continue;
				}
				const palette: Record<string, string> = {};
				for (const [name, color] of Object.entries(paletteValue)) {
					if (typeof color !== "string" || !parseColor(color.toLowerCase())) {
						diagnostics.push(
							diagnostic(
								"warning",
								`palettes.${paletteName}.${name}`,
								"Palette colors must be named, ANSI 0-255, or #RRGGBB",
							),
						);
						continue;
					}
					setOwn(palette, name, color);
				}
				setOwn(config.palettes, paletteName, palette);
			}
		}
	}

	if (value.palette !== undefined) {
		if (typeof value.palette !== "string") diagnostics.push(typeDiagnostic("palette", "string"));
		else if (!Object.hasOwn(config.palettes, value.palette)) {
			diagnostics.push(
				diagnostic("warning", "palette", `Unknown palette ${JSON.stringify(value.palette)}`),
			);
		} else config.palette = value.palette;
	}

	for (const name of MODULE_NAMES) {
		const moduleValue = value[name];
		if (moduleValue === undefined) continue;
		if (!isRecord(moduleValue)) {
			diagnostics.push(typeDiagnostic(name, "table"));
			continue;
		}
		normalizeModule(name, moduleValue, config, diagnostics);
	}

	validateFormatVariables(
		config.formatAst,
		new Set([...MODULE_NAMES, "all"]),
		"format",
		diagnostics,
	);
	validateStyleVariables(config.formatAst, new Set(), "format", diagnostics);
	const palette = activePalette(config);
	for (const name of MODULE_NAMES) {
		const module = config.modules[name];
		validateFormatVariables(
			module.formatAst,
			new Set(MODULE_CONTENT_VARIABLES[name]),
			`${name}.format`,
			diagnostics,
		);
		validateStyleVariables(module.formatAst, new Set(["style"]), `${name}.format`, diagnostics);
		if (!isValidStyle(module.style, palette)) {
			diagnostics.push(
				diagnostic(
					"warning",
					`${name}.style`,
					`Invalid style ${JSON.stringify(module.style)}; using the module default`,
				),
			);
			module.style = BUILT_IN_CONFIG.modules[name].style;
		}
	}

	return { config, diagnostics };
}

function normalizeModule(
	name: ModuleName,
	value: Record<string, unknown>,
	config: StarshipConfig,
	diagnostics: ConfigDiagnostic[],
) {
	const known = new Set(["format", "symbol", "style", "disabled"]);
	if (name === "extension_status") {
		known.add("separator");
		known.add("max_statuses");
		known.add("icons");
	}
	for (const key of Object.keys(value)) {
		if (!known.has(key)) diagnostics.push(unknownDiagnostic(`${name}.${key}`));
	}
	const module = config.modules[name];
	if (value.format !== undefined) {
		if (typeof value.format !== "string")
			diagnostics.push(typeDiagnostic(`${name}.format`, "string"));
		else {
			try {
				module.formatAst = parseFormat(value.format);
				module.format = value.format;
			} catch (error) {
				diagnostics.push(
					diagnostic(
						"warning",
						`${name}.format`,
						`Invalid format; using module default: ${formatError(error)}`,
					),
				);
			}
		}
	}
	for (const field of ["symbol", "style"] as const) {
		if (value[field] === undefined) continue;
		if (typeof value[field] !== "string") {
			diagnostics.push(typeDiagnostic(`${name}.${field}`, "string"));
		} else module[field] = value[field];
	}
	if (value.disabled !== undefined) {
		if (typeof value.disabled !== "boolean") {
			diagnostics.push(typeDiagnostic(`${name}.disabled`, "boolean"));
		} else module.disabled = value.disabled;
	}
	if (name !== "extension_status") return;
	if (value.separator !== undefined) {
		if (typeof value.separator !== "string") {
			diagnostics.push(typeDiagnostic("extension_status.separator", "string"));
		} else config.extensionStatus.separator = value.separator;
	}
	if (value.max_statuses !== undefined) {
		if (
			typeof value.max_statuses !== "number" ||
			!Number.isInteger(value.max_statuses) ||
			value.max_statuses < 0 ||
			value.max_statuses > 100
		) {
			diagnostics.push(
				diagnostic(
					"warning",
					"extension_status.max_statuses",
					"Expected an integer from 0 through 100",
				),
			);
		} else config.extensionStatus.maxStatuses = value.max_statuses;
	}
	if (value.icons !== undefined) {
		if (!isRecord(value.icons)) diagnostics.push(typeDiagnostic("extension_status.icons", "table"));
		else {
			config.extensionStatus.icons = Object.fromEntries(
				Object.entries(value.icons).flatMap(([key, icon]) => {
					if (typeof icon === "string") return [[key, icon]];
					diagnostics.push(typeDiagnostic(`extension_status.icons.${key}`, "string"));
					return [];
				}),
			);
		}
	}
}

interface AtomicFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	renameSync: typeof renameSync;
	rmSync: typeof rmSync;
}

export function validateConfigDocument(
	settingsPath: string,
	rawDocument: string,
): LoadedStarshipConfig {
	let parsed: TomlTable;
	try {
		parsed = parse(rawDocument);
	} catch (error) {
		throw new Error(`Unable to parse TOML: ${formatError(error)}`);
	}
	const normalized = normalizeConfig(parsed);
	if (normalized.diagnostics.some((item) => item.severity === "error")) {
		throw new Error(normalized.diagnostics.map((item) => item.message).join("\n"));
	}
	return {
		...normalized,
		source: "user",
		settingsPath,
		rawDocument,
	};
}

export function atomicSaveConfigDocument(
	settingsPath: string,
	rawDocument: string,
	overrides: Partial<AtomicFileSystem> = {},
): LoadedStarshipConfig {
	const validated = validateConfigDocument(settingsPath, rawDocument);
	atomicWriteConfigDocument(settingsPath, rawDocument, overrides);
	return validated;
}

export function atomicRestoreConfigDocument(
	settingsPath: string,
	rawDocument: string,
	overrides: Partial<AtomicFileSystem> = {},
) {
	atomicWriteConfigDocument(settingsPath, rawDocument, overrides);
}

function atomicWriteConfigDocument(
	settingsPath: string,
	rawDocument: string,
	overrides: Partial<AtomicFileSystem>,
) {
	const fs = { mkdirSync, writeFileSync, renameSync, rmSync, ...overrides };
	fs.mkdirSync(dirname(settingsPath), { recursive: true });
	const tempPath = join(dirname(settingsPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempPath, rawDocument, { encoding: "utf8", flag: "wx" });
		fs.renameSync(tempPath, settingsPath);
	} finally {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the publication result.
		}
	}
}

function cloneBuiltInConfig(): StarshipConfig {
	return {
		...BUILT_IN_CONFIG,
		formatAst: structuredClone(BUILT_IN_CONFIG.formatAst),
		palettes: Object.fromEntries(
			Object.entries(BUILT_IN_CONFIG.palettes).map(([name, colors]) => [name, { ...colors }]),
		),
		modules: Object.fromEntries(
			MODULE_NAMES.map((name) => [
				name,
				{
					...BUILT_IN_CONFIG.modules[name],
					formatAst: structuredClone(BUILT_IN_CONFIG.modules[name].formatAst),
				},
			]),
		) as Record<ModuleName, ModuleConfig>,
		extensionStatus: {
			...BUILT_IN_CONFIG.extensionStatus,
			icons: { ...BUILT_IN_CONFIG.extensionStatus.icons },
		},
	};
}

function validateFormatVariables(
	ast: readonly FormatNode[],
	allowed: ReadonlySet<string>,
	path: string,
	diagnostics: ConfigDiagnostic[],
) {
	for (const variable of formatVariables(ast)) {
		if (allowed.has(variable)) continue;
		diagnostics.push(
			diagnostic(
				"warning",
				path,
				`Unknown variable ${JSON.stringify(variable)} in ${path} was ignored`,
			),
		);
	}
}

function validateStyleVariables(
	ast: readonly FormatNode[],
	allowed: ReadonlySet<string>,
	path: string,
	diagnostics: ConfigDiagnostic[],
) {
	for (const variable of styleVariables(ast)) {
		if (allowed.has(variable)) continue;
		diagnostics.push(
			diagnostic(
				"warning",
				path,
				`Unknown style variable ${JSON.stringify(variable)} in ${path} was ignored`,
			),
		);
	}
}

function setOwn<T>(record: Record<string, T>, key: string, value: T) {
	Object.defineProperty(record, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeDiagnostic(path: string, type: string): ConfigDiagnostic {
	return diagnostic("warning", path, `Expected ${type}; using the default value`);
}

function unknownDiagnostic(path: string): ConfigDiagnostic {
	return diagnostic("warning", path, `Unknown setting ${JSON.stringify(path)} was ignored`);
}

function diagnostic(
	severity: ConfigDiagnostic["severity"],
	path: string,
	message: string,
): ConfigDiagnostic {
	return { severity, path, message };
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function activePalette(config: StarshipConfig): ColorPalette {
	return {
		...ownPalette(config.palettes, BUILT_IN_CONFIG.palette),
		...ownPalette(config.palettes, config.palette),
	};
}

function ownPalette(
	palettes: Readonly<Record<string, Record<string, string>>>,
	name: string,
): Record<string, string> | undefined {
	return Object.hasOwn(palettes, name) ? palettes[name] : undefined;
}
