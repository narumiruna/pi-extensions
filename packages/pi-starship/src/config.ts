import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TomlTable } from "smol-toml";
import { type FormatNode, formatVariables, parseFormat, styleVariables } from "./format/formatter.js";
import { type ColorPalette, isValidStyle, parseColor } from "./format/style.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./modules/catalog.js";
import type { ModuleDisplayConfig, ModuleOptionSchema, ModuleOptionValue } from "./modules/types.js";

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
  styles: Record<string, string>;
  display: ModuleDisplayConfig[];
  disabled: boolean;
  options: Record<string, ModuleOptionValue>;
}

export interface ExtensionStatusConfig {
  separator: string;
  maxStatuses: number;
  icons: Record<string, string>;
}

export interface StarshipConfig {
  format: string;
  formatAst: FormatNode[];
  palette?: string;
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
  fileIdentity?: { dev: number; ino: number };
  diagnostics: ConfigDiagnostic[];
}

const BUILT_IN_FORMAT_DOCUMENT = String.raw`format = """
$brand\
$model\
$thinking\
$directory\
$git_branch\
$git_status\
$activity\
$context\
$time"""`;

const BUILT_IN_FORMAT = "$brand$model$thinking$directory$git_branch$git_status$activity$context$time";

const BUILT_IN_MODULES = Object.fromEntries(
  MODULE_DEFINITIONS.map(({ name, defaults, styleDefaults, displayDefaults, options }) => [
    name,
    {
      ...defaults,
      formatAst: parseFormat(defaults.format),
      styles: { ...styleDefaults },
      display: structuredClone(displayDefaults ?? []),
      options: Object.fromEntries(
        Object.entries(options ?? {}).map(([key, schema]) => [key, cloneOptionValue(schema.default)]),
      ),
    },
  ]),
) as Record<ModuleName, ModuleConfig>;

export const BUILT_IN_CONFIG: StarshipConfig = {
  format: BUILT_IN_FORMAT,
  formatAst: parseFormat(BUILT_IN_FORMAT),
  palette: undefined,
  palettes: {},
  modules: BUILT_IN_MODULES,
  extensionStatus: { separator: " • ", maxStatuses: 5, icons: {} },
};

export const BUILT_IN_EXAMPLE = `# Native Pi modules with Starship-compatible format and style syntax.\n${BUILT_IN_FORMAT_DOCUMENT}\n`;

const require = createRequire(import.meta.url);
let parseTomlImplementation: typeof import("smol-toml")["parse"] | undefined;

function parseToml(document: string): TomlTable {
  parseTomlImplementation ??= (require("smol-toml") as typeof import("smol-toml")).parse;
  return parseTomlImplementation(document);
}

export function settingsFilePath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

export function loadStarshipConfig(settingsPath: string): LoadedStarshipConfig {
  let rawDocument: string;
  try {
    rawDocument = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(settingsPath)) {
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
    parsed = parseToml(rawDocument);
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
        diagnostics.push(diagnostic("warning", "format", `Invalid format; using built-in: ${formatError(error)}`));
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
    else {
      config.palette = value.palette;
      if (!Object.hasOwn(config.palettes, value.palette)) {
        diagnostics.push(diagnostic("warning", "palette", `Unknown palette ${JSON.stringify(value.palette)}`));
      }
    }
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

  validateFormatVariables(config.formatAst, new Set([...MODULE_NAMES, "all"]), "format", diagnostics);
  validateStyleVariables(config.formatAst, new Set(), "format", diagnostics);
  const palette = activePalette(config);
  validateLiteralStyles(config.formatAst, palette, "format", diagnostics);
  for (const definition of MODULE_DEFINITIONS) {
    const name = definition.name;
    const module = config.modules[name];
    validateFormatVariables(module.formatAst, new Set(MODULE_CONTENT_VARIABLES[name]), `${name}.format`, diagnostics);
    validateStyleVariables(
      module.formatAst,
      new Set(definition.styleVariables ?? ["style"]),
      `${name}.format`,
      diagnostics,
    );
    validateLiteralStyles(module.formatAst, palette, `${name}.format`, diagnostics);
    if (definition.styleDefaults) {
      if (definition.fallbackStyle) {
        validateModuleStyleField(name, "style", module, palette, diagnostics);
      }
      for (const field of Object.keys(definition.styleDefaults)) {
        validateModuleStyleField(name, field, module, palette, diagnostics);
      }
    } else if (!definition.displayDefaults) {
      validateModuleStyleField(name, "style", module, palette, diagnostics);
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
  const definition = MODULE_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) return;
  const optionSchemas: Readonly<Record<string, ModuleOptionSchema>> = definition.options ?? {};
  const known = new Set(["format", "symbol", "disabled", ...Object.keys(optionSchemas)]);
  if (definition.styleDefaults) {
    if (definition.fallbackStyle) known.add("style");
    for (const field of Object.keys(definition.styleDefaults)) known.add(field);
  } else if (!definition.displayDefaults) known.add("style");
  if (definition.displayDefaults) known.add("display");
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
    if (typeof value.format !== "string") diagnostics.push(typeDiagnostic(`${name}.format`, "string"));
    else {
      try {
        module.formatAst = parseFormat(value.format);
        module.format = value.format;
      } catch (error) {
        diagnostics.push(
          diagnostic("warning", `${name}.format`, `Invalid format; using module default: ${formatError(error)}`),
        );
      }
    }
  }
  if (value.symbol !== undefined) {
    if (typeof value.symbol !== "string") {
      diagnostics.push(typeDiagnostic(`${name}.symbol`, "string"));
    } else module.symbol = value.symbol;
  }
  if (definition.styleDefaults && definition.fallbackStyle && value.style !== undefined) {
    if (typeof value.style !== "string") {
      diagnostics.push(typeDiagnostic(`${name}.style`, "string"));
    } else module.style = value.style;
  }
  if (definition.styleDefaults) {
    for (const field of Object.keys(definition.styleDefaults)) {
      if (value[field] === undefined) continue;
      if (typeof value[field] !== "string") {
        diagnostics.push(typeDiagnostic(`${name}.${field}`, "string"));
      } else module.styles[field] = value[field];
    }
  } else if (!definition.displayDefaults && value.style !== undefined) {
    if (typeof value.style !== "string") {
      diagnostics.push(typeDiagnostic(`${name}.style`, "string"));
    } else module.style = value.style;
  }
  if (definition.displayDefaults && value.display !== undefined) {
    module.display = normalizeDisplay(
      name,
      value.display,
      definition.displayDefaults,
      activePalette(config),
      diagnostics,
    );
  }
  if (value.disabled !== undefined) {
    if (typeof value.disabled !== "boolean") {
      diagnostics.push(typeDiagnostic(`${name}.disabled`, "boolean"));
    } else module.disabled = value.disabled;
  }
  for (const [key, schema] of Object.entries(optionSchemas)) {
    if (value[key] === undefined) continue;
    const normalized = normalizeModuleOption(value[key], schema);
    if (normalized.ok) module.options[key] = normalized.value;
    else diagnostics.push(diagnostic("warning", `${name}.${key}`, normalized.message));
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
        diagnostic("warning", "extension_status.max_statuses", "Expected an integer from 0 through 100"),
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

export function validateConfigDocument(settingsPath: string, rawDocument: string): LoadedStarshipConfig {
  let parsed: TomlTable;
  try {
    parsed = parseToml(rawDocument);
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
  return {
    ...validated,
    fileIdentity: atomicWriteConfigDocument(settingsPath, rawDocument, overrides),
  };
}

export function atomicRestoreConfigDocument(
  settingsPath: string,
  rawDocument: string,
  overrides: Partial<AtomicFileSystem> = {},
) {
  atomicWriteConfigDocument(settingsPath, rawDocument, overrides);
}

export function removeConfigDocumentIfMatches(
  settingsPath: string,
  expectedRawDocument: string,
  expectedIdentity: { dev: number; ino: number },
  overrides: Pick<Partial<AtomicFileSystem>, "rmSync"> = {},
) {
  const quarantinePath = join(dirname(settingsPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.rollback`);
  const before = lstatSync(settingsPath);
  if (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino) {
    throw new Error("Starship settings changed concurrently; the newer file was preserved");
  }
  renameSync(settingsPath, quarantinePath);
  const quarantined = lstatSync(quarantinePath);
  const quarantinedSavedFile =
    quarantined.isFile() &&
    !quarantined.isSymbolicLink() &&
    quarantined.dev === expectedIdentity.dev &&
    quarantined.ino === expectedIdentity.ino;
  if (quarantinedSavedFile && readFileSync(quarantinePath, "utf8") === expectedRawDocument) {
    (overrides.rmSync ?? rmSync)(quarantinePath);
    return;
  }
  if (quarantinedSavedFile && !pathEntryExists(settingsPath)) {
    try {
      renameSync(quarantinePath, settingsPath);
    } catch {
      // Keep the quarantine for recovery when its atomic restoration fails.
    }
  }
  throw new Error("Starship settings changed concurrently; the newer file was preserved");
}

function atomicWriteConfigDocument(
  settingsPath: string,
  rawDocument: string,
  overrides: Partial<AtomicFileSystem>,
): { dev: number; ino: number } {
  const fs = { mkdirSync, writeFileSync, renameSync, rmSync, ...overrides };
  const replaceExisting = pathEntryExists(settingsPath);
  fs.mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = join(dirname(settingsPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, rawDocument, { encoding: "utf8", flag: "wx" });
    const info = lstatSync(tempPath);
    if (!replaceExisting && pathEntryExists(settingsPath)) {
      throw new Error(`${CONFIG_FILE_NAME} was created concurrently; reopen settings and retry.`);
    }
    fs.renameSync(tempPath, settingsPath);
    return { dev: info.dev, ino: info.ino };
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
          styles: { ...BUILT_IN_CONFIG.modules[name].styles },
          display: structuredClone(BUILT_IN_CONFIG.modules[name].display),
          options: structuredClone(BUILT_IN_CONFIG.modules[name].options),
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
      diagnostic("warning", path, `Unknown variable ${JSON.stringify(variable)} in ${path} was ignored`),
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
      diagnostic("warning", path, `Unknown style variable ${JSON.stringify(variable)} in ${path} was ignored`),
    );
  }
}

function validateModuleStyleField(
  name: ModuleName,
  field: string,
  module: ModuleConfig,
  palette: ColorPalette,
  diagnostics: ConfigDiagnostic[],
) {
  const style = field === "style" ? module.style : module.styles[field];
  if (style === undefined || isValidStyle(style, palette)) return;
  diagnostics.push(
    diagnostic("warning", `${name}.${field}`, `Invalid style ${JSON.stringify(style)}; using the module default`),
  );
  if (field === "style") module.style = BUILT_IN_CONFIG.modules[name].style;
  else {
    const fallback = BUILT_IN_CONFIG.modules[name].styles[field];
    if (fallback !== undefined) module.styles[field] = fallback;
  }
}

function normalizeDisplay(
  name: ModuleName,
  value: unknown,
  defaults: readonly ModuleDisplayConfig[],
  palette: ColorPalette,
  diagnostics: ConfigDiagnostic[],
): ModuleDisplayConfig[] {
  if (!Array.isArray(value)) {
    diagnostics.push(typeDiagnostic(`${name}.display`, "array of tables"));
    return defaults.map((entry) => ({ ...entry }));
  }
  const result: ModuleDisplayConfig[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `${name}.display.${index}`;
    if (!isRecord(entry)) {
      diagnostics.push(typeDiagnostic(path, "table"));
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!new Set(["threshold", "style", "hidden"]).has(field)) {
        diagnostics.push(unknownDiagnostic(`${path}.${field}`));
      }
    }
    let valid = true;
    if (typeof entry.threshold !== "number" || !Number.isFinite(entry.threshold)) {
      diagnostics.push(diagnostic("warning", `${path}.threshold`, "Expected a finite number"));
      valid = false;
    }
    if (typeof entry.style !== "string" || !isValidStyle(entry.style, palette)) {
      diagnostics.push(diagnostic("warning", `${path}.style`, "Expected a valid Starship style string"));
      valid = false;
    }
    if (typeof entry.hidden !== "boolean") {
      diagnostics.push(typeDiagnostic(`${path}.hidden`, "boolean"));
      valid = false;
    }
    if (valid) {
      result.push({
        threshold: entry.threshold as number,
        style: entry.style as string,
        hidden: entry.hidden as boolean,
      });
    }
  }
  if (result.length > 0) return result;
  diagnostics.push(diagnostic("warning", `${name}.display`, "Expected at least one valid entry; using defaults"));
  return defaults.map((entry) => ({ ...entry }));
}

function validateLiteralStyles(
  ast: readonly FormatNode[],
  palette: ColorPalette,
  path: string,
  diagnostics: ConfigDiagnostic[],
) {
  for (const node of ast) {
    if (node.type === "group" && node.style.every((part) => part.type === "text")) {
      const style = node.style.map((part) => (part.type === "text" ? part.value : "")).join("");
      if (!isValidStyle(style, palette)) {
        diagnostics.push(
          diagnostic("warning", path, `Invalid literal style ${JSON.stringify(style)}; rendered unstyled`),
        );
      }
    }
    if (node.type === "group" || node.type === "conditional") {
      validateLiteralStyles(node.children, palette, path, diagnostics);
    }
  }
}

function normalizeModuleOption(
  value: unknown,
  schema: ModuleOptionSchema,
): { ok: true; value: ModuleOptionValue } | { ok: false; message: string } {
  switch (schema.kind) {
    case "string":
      return typeof value === "string" && (schema.allowEmpty !== false || value.length > 0)
        ? { ok: true, value }
        : { ok: false, message: "Expected a non-empty string; using the default value" };
    case "string-enum":
      return typeof value === "string" && schema.values.includes(value)
        ? { ok: true, value }
        : {
            ok: false,
            message: `Expected one of: ${schema.values.join(", ")}; using the default value`,
          };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, message: "Expected boolean; using the default value" };
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum
        ? { ok: true, value }
        : {
            ok: false,
            message: `Expected an integer from ${schema.minimum} through ${schema.maximum}; using the default value`,
          };
    case "string-array": {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) => typeof item !== "string" || item.length === 0 || (!schema.allowNegative && item.startsWith("!")),
        )
      ) {
        return {
          ok: false,
          message: "Expected an array of valid strings; using the default value",
        };
      }
      return { ok: true, value: [...value] as string[] };
    }
    case "string-map": {
      if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
        return { ok: false, message: "Expected a table of strings; using the default value" };
      }
      const result: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) setOwn(result, key, item as string);
      return { ok: true, value: result };
    }
  }
}

function cloneOptionValue(value: ModuleOptionValue): ModuleOptionValue {
  return typeof value === "object" ? structuredClone(value) : value;
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

function diagnostic(severity: ConfigDiagnostic["severity"], path: string, message: string): ConfigDiagnostic {
  return { severity, path, message };
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activePalette(config: StarshipConfig): ColorPalette {
  return ownPalette(config.palettes, config.palette) ?? {};
}

function ownPalette(
  palettes: Readonly<Record<string, Record<string, string>>>,
  name: string | undefined,
): Record<string, string> | undefined {
  return name !== undefined && Object.hasOwn(palettes, name) ? palettes[name] : undefined;
}
