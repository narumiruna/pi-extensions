import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, type TomlTable } from "smol-toml";
import { normalizeModuleOption } from "./config/module-options.js";
import { type FormatNode, formatVariables, parseFormat, styleVariables } from "./format/formatter.js";
import { type ColorPalette, isValidStyle, parseColor } from "./format/style.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./modules/catalog.js";
import type { ModuleDisplayConfig, ModuleOptionSchema, ModuleOptionValue, ModuleStyleRule } from "./modules/types.js";

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
  styleRules: ModuleStyleRule[];
  display: ModuleDisplayConfig[];
  disabled: boolean;
  options: Record<string, ModuleOptionValue>;
}

export interface ExtensionStatusConfig {
  separator: string;
  maxStatuses: number;
  icons: Record<string, string>;
  styles: Record<string, string>;
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
  rawBytes?: Buffer;
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
      styleRules: [] as ModuleStyleRule[],
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
  extensionStatus: { separator: " • ", maxStatuses: 5, icons: {}, styles: {} },
};

export const BUILT_IN_EXAMPLE = `# Native Pi modules with Starship-compatible format and style syntax.\n${BUILT_IN_FORMAT_DOCUMENT}\n`;

export function settingsFilePath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

/** No active Starship document: Pi owns the footer. Module defaults remain available for new drafts. */
export function nativeFooterConfig(settingsPath: string): LoadedStarshipConfig {
  return { config: cloneBuiltInConfig(), source: "built-in", settingsPath, diagnostics: [] };
}

export function loadStarshipConfig(settingsPath: string): LoadedStarshipConfig {
  let rawDocument: string;
  let snapshot: ConfigDocumentSnapshot;
  try {
    const rawBytes = readFileSync(settingsPath);
    snapshot = readConfigDocumentSnapshot(settingsPath);
    if (!snapshot.rawBytes?.equals(rawBytes)) throw new Error("Settings changed while being read; retry the operation");
    rawDocument = rawBytes.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(settingsPath)) {
      return nativeFooterConfig(settingsPath);
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
    if (!Buffer.from(rawDocument, "utf8").equals(snapshot.rawBytes ?? Buffer.alloc(0)))
      throw new Error("Settings are not valid UTF-8");
    parsed = parseToml(rawDocument);
  } catch (error) {
    return {
      config: cloneBuiltInConfig(),
      source: "built-in",
      settingsPath,
      rawDocument,
      ...snapshot,
      diagnostics: [diagnostic("error", "", `Unable to parse TOML: ${formatError(error)}`)],
    };
  }
  const normalized = normalizeConfig(parsed);
  return {
    ...normalized,
    source: "user",
    settingsPath,
    rawDocument,
    ...snapshot,
  };
}

export interface ConfigDocumentSnapshot {
  rawBytes?: Buffer;
  fileIdentity?: { dev: number; ino: number };
}

export function readConfigDocumentSnapshot(settingsPath: string): ConfigDocumentSnapshot {
  let info: Stats;
  try {
    info = lstatSync(settingsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Settings must be a regular file, not a symbolic link");
  const rawBytes = readFileSync(settingsPath);
  const after = lstatSync(settingsPath);
  if (after.dev !== info.dev || after.ino !== info.ino || !after.isFile()) {
    throw new Error("Settings changed while being read; retry the operation");
  }
  return { rawBytes, fileIdentity: { dev: info.dev, ino: info.ino } };
}

export function assertConfigDocumentUnchanged(settingsPath: string, expected: ConfigDocumentSnapshot): void {
  const current = readConfigDocumentSnapshot(settingsPath);
  if (current.rawBytes === undefined && expected.rawBytes === undefined) return;
  if (
    current.rawBytes?.equals(expected.rawBytes ?? Buffer.alloc(0)) &&
    current.fileIdentity?.dev === expected.fileIdentity?.dev &&
    current.fileIdentity?.ino === expected.fileIdentity?.ino
  )
    return;
  throw new Error("Starship settings changed concurrently; the newer file was preserved. Reopen settings and retry.");
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
          if (typeof color !== "string" || !parseColor(color)) {
            diagnostics.push(
              diagnostic(
                "warning",
                `palettes.${paletteName}.${name}`,
                "Palette colors must be named, ANSI 0-255, #RRGGBB, or pi:<role>",
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
  if (definition.styleRuleSelectors) known.add("style_rules");
  if (name === "extension_status") {
    known.add("separator");
    known.add("max_statuses");
    known.add("icons");
    known.add("styles");
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
  if (definition.styleRuleSelectors && value.style_rules !== undefined) {
    module.styleRules = normalizeStyleRules(
      name,
      value.style_rules,
      new Set(Object.keys(definition.styleRuleSelectors)),
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
    const normalized = normalizeModuleOption(value[key], schema, activePalette(config));
    if (normalized.ok && name === "directory" && key === "repo_root_format" && typeof normalized.value === "string") {
      try {
        const ast = parseFormat(normalized.value);
        if (
          normalized.value.length > 4_096 ||
          [...formatVariables(ast)].some((variable) => !definition.variables.includes(variable)) ||
          [...styleVariables(ast)].some((variable) => !definition.styleVariables?.includes(variable))
        )
          throw new Error("Unknown format variable");
        validateLiteralStyles(ast, activePalette(config), `${name}.${key}`, diagnostics);
      } catch {
        diagnostics.push(diagnostic("warning", `${name}.${key}`, "Invalid repository-root format; using the default"));
        continue;
      }
    }
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
  if (value.styles !== undefined) {
    if (!isRecord(value.styles)) diagnostics.push(typeDiagnostic("extension_status.styles", "table"));
    else {
      config.extensionStatus.styles = Object.fromEntries(
        Object.entries(value.styles).flatMap(([key, style]) => {
          if (typeof style === "string" && isValidStyle(style, activePalette(config))) return [[key, style]];
          diagnostics.push(
            diagnostic("warning", `extension_status.styles.${key}`, "Expected a valid Starship style string; ignored"),
          );
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
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  fsyncSync: typeof fsyncSync;
}

export function validateConfigDocument(settingsPath: string, rawDocument: string): LoadedStarshipConfig {
  if (Buffer.from(rawDocument, "utf8").toString("utf8") !== rawDocument)
    throw new Error("Settings must be lossless UTF-8 text");
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
  expected?: ConfigDocumentSnapshot,
): LoadedStarshipConfig {
  const validated = validateConfigDocument(settingsPath, rawDocument);
  return {
    ...validated,
    rawBytes: Buffer.from(rawDocument),
    fileIdentity: atomicWriteConfigDocument(settingsPath, rawDocument, overrides, expected),
  };
}

export function atomicRestoreConfigDocument(
  settingsPath: string,
  rawDocument: string | Buffer,
  overrides: Partial<AtomicFileSystem> = {},
  expected?: ConfigDocumentSnapshot,
) {
  atomicWriteConfigDocument(settingsPath, rawDocument, overrides, expected);
}

export class ConfigPublicationError extends Error {
  constructor(
    message: string,
    readonly fileIdentity: { dev: number; ino: number },
  ) {
    super(message);
  }
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
    if (process.platform !== "win32") {
      const directory = openSync(dirname(settingsPath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    return;
  }
  if (quarantinedSavedFile && !pathEntryExists(settingsPath)) {
    try {
      renameSync(quarantinePath, settingsPath);
    } catch {
      // Keep the quarantine for recovery when its atomic restoration fails.
    }
  }
  throw new Error(
    `Starship settings changed concurrently; the newer file was preserved. Recovery path: ${quarantinePath}`,
  );
}

function atomicWriteConfigDocument(
  settingsPath: string,
  rawDocument: string | Buffer,
  overrides: Partial<AtomicFileSystem>,
  captured?: ConfigDocumentSnapshot,
): { dev: number; ino: number } {
  const fs = { mkdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, ...overrides };
  const expected = captured ?? readConfigDocumentSnapshot(settingsPath);
  const replaceExisting = expected.rawBytes !== undefined;
  fs.mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(settingsPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
  let publishedIdentity: { dev: number; ino: number } | undefined;
  try {
    fs.writeFileSync(tempPath, rawDocument, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    const info = lstatSync(tempPath);
    if (!replaceExisting && pathEntryExists(settingsPath)) {
      throw new Error(`${CONFIG_FILE_NAME} was created concurrently; reopen settings and retry.`);
    }
    assertConfigDocumentUnchanged(settingsPath, expected);
    fs.renameSync(tempPath, settingsPath);
    publishedIdentity = { dev: info.dev, ino: info.ino };
    if (process.platform !== "win32") {
      const directory = fs.openSync(dirname(settingsPath), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
    return publishedIdentity;
  } catch (error) {
    if (publishedIdentity) throw new ConfigPublicationError(formatError(error), publishedIdentity);
    throw error;
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
          styleRules: structuredClone(BUILT_IN_CONFIG.modules[name].styleRules),
          display: structuredClone(BUILT_IN_CONFIG.modules[name].display),
          options: structuredClone(BUILT_IN_CONFIG.modules[name].options),
        },
      ]),
    ) as Record<ModuleName, ModuleConfig>,
    extensionStatus: {
      ...BUILT_IN_CONFIG.extensionStatus,
      icons: { ...BUILT_IN_CONFIG.extensionStatus.icons },
      styles: { ...BUILT_IN_CONFIG.extensionStatus.styles },
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

function normalizeStyleRules(
  name: ModuleName,
  value: unknown,
  allowedSelectors: ReadonlySet<string>,
  palette: ColorPalette,
  diagnostics: ConfigDiagnostic[],
): ModuleStyleRule[] {
  if (!Array.isArray(value)) {
    diagnostics.push(typeDiagnostic(`${name}.style_rules`, "array of tables"));
    return [];
  }
  const result: ModuleStyleRule[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `${name}.style_rules.${index}`;
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic("warning", path, "Expected a table; rule ignored"));
      continue;
    }
    let valid = true;
    for (const field of Object.keys(entry)) {
      if (field !== "style" && !allowedSelectors.has(field)) {
        diagnostics.push(diagnostic("warning", `${path}.${field}`, "Unknown style-rule field; rule ignored"));
        valid = false;
      }
    }
    if (typeof entry.style !== "string" || !isValidStyle(entry.style, palette)) {
      diagnostics.push(diagnostic("warning", `${path}.style`, "Expected a valid Starship style string; rule ignored"));
      valid = false;
    }
    const selectors: Record<string, string> = {};
    for (const selector of allowedSelectors) {
      if (entry[selector] === undefined) continue;
      if (typeof entry[selector] !== "string") {
        diagnostics.push(diagnostic("warning", `${path}.${selector}`, "Expected string; rule ignored"));
        valid = false;
      } else setOwn(selectors, selector, entry[selector]);
    }
    if (valid) result.push({ style: entry.style as string, selectors });
  }
  return result;
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
