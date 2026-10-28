import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { activePalette, type ModuleConfig, type StarshipConfig } from "../config.js";
import { type FormatValue, formatVariables, parseFormat, renderFormat } from "../format/formatter.js";
import {
  type ColorPalette,
  isFillChunk,
  type LayoutChunk,
  renderChunksToAnsi,
  type StyledChunk,
} from "../format/style.js";
import { sanitizeFormatText } from "../format/terminal-safety.js";
import type { ThemeColors } from "../format/theme-colors.js";
import { MODULE_DEFINITIONS, MODULE_NAMES, type ModuleName } from "./catalog.js";
import { directoryAlternateFormat } from "./directory.js";
import { resolveStyleRule } from "./style-rules.js";
import type {
  ModuleOptionValue,
  ModuleStyleContext,
  ModuleValueContext,
  RenderedStatusline,
  StarshipRuntimeSnapshot,
} from "./types.js";

export function renderStatusline(
  config: StarshipConfig,
  runtime: StarshipRuntimeSnapshot,
  width = 80,
  trueColor = true,
  themeColors?: ThemeColors,
): RenderedStatusline<ModuleName> {
  const palette = activePalette(config);
  const modules = {} as Record<ModuleName, StyledChunk[]>;
  const layoutModules = {} as Record<ModuleName, LayoutChunk[]>;
  for (const name of MODULE_NAMES) {
    modules[name] = [];
    layoutModules[name] = [];
  }
  for (const definition of MODULE_DEFINITIONS) {
    const name = definition.name;
    const module = config.modules[name];
    const context = valueContext(config, name, runtime, palette);
    const values = definition.values(context);
    if (!values) continue;
    const styleContext: ModuleStyleContext = {
      runtime,
      style: module.style,
      styles: module.styles,
      display: module.display,
      options: context.options,
    };
    const baseStyleVariables = definition.resolveStyleVariables
      ? definition.resolveStyleVariables(styleContext)
      : { style: module.style };
    if (!baseStyleVariables) continue;
    const ruleStyle = definition.styleRuleSelectors
      ? resolveStyleRule(module.styleRules, definition.styleRuleSelectors, styleContext)
      : undefined;
    const styleVariables = ruleStyle === undefined ? baseStyleVariables : { ...baseStyleVariables, style: ruleStyle };
    const contentValues: Record<string, FormatValue> = Object.fromEntries(
      definition.variables.flatMap((variable) =>
        Object.hasOwn(values, variable) ? [[variable, values[variable]]] : [],
      ),
    );
    const alternate = definition.resolveFormat?.(context, values);
    const rendered = renderModule(
      alternate === undefined ? module : { ...module, formatAst: parseFormat(alternate) },
      contentValues,
      styleVariables,
      palette,
    );
    modules[name] = rendered;
    layoutModules[name] =
      definition.layout === "fill" && !module.disabled ? [{ type: "fill", pattern: rendered }] : rendered;
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
    ansi: renderChunksToAnsi(chunks, trueColor, themeColors),
    chunks,
    modules,
  };
}

function valueContext(
  config: StarshipConfig,
  name: ModuleName,
  runtime: StarshipRuntimeSnapshot,
  palette: ColorPalette,
): ModuleValueContext {
  return {
    runtime: runtimeForDisplay(name, runtime),
    palette,
    symbol: sanitizeFormatText(config.modules[name].symbol),
    styles: config.modules[name].styles,
    requestedVariables: formatVariables(config.modules[name].formatAst),
    options: Object.fromEntries(
      Object.entries(config.modules[name].options).map(([key, value]) => [key, sanitizeOption(value)]),
    ),
    extensionStatus: {
      ...config.extensionStatus,
      separator: sanitizeFormatText(config.extensionStatus.separator),
      icons: Object.fromEntries(
        Object.entries(config.extensionStatus.icons).map(([key, value]) => [key, sanitizeFormatText(value)]),
      ),
    },
  };
}

function sanitizeOption(value: ModuleOptionValue): ModuleOptionValue {
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeOption(item as ModuleOptionValue)) as ModuleOptionValue;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeOption(item)]),
    ) as ModuleOptionValue;
  }
  return value;
}

// Shallow presentation copies retain keys used for aliases and status policies.
function sanitizeFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? sanitizeTerminalText(item) : item]),
  ) as T;
}

function runtimeForDisplay(name: ModuleName, runtime: StarshipRuntimeSnapshot): StarshipRuntimeSnapshot {
  // Only modules that transform text need sanitized inputs before their value
  // function runs. Pass-through values are sanitized by the formatter, avoiding
  // a full snapshot copy and preserving raw model/provider alias identities.
  switch (name) {
    case "directory":
      return {
        ...runtime,
        ...sanitizeFields({ cwd: runtime.cwd, homeDir: runtime.homeDir, gitRoot: runtime.gitRoot }),
      };
    case "git_branch":
      return {
        ...runtime,
        gitBranch: runtime.gitBranch === null ? null : sanitizeTerminalText(runtime.gitBranch),
        gitBranchDetails: runtime.gitBranchDetails ? sanitizeFields(runtime.gitBranchDetails) : undefined,
      };
    case "git_commit":
      return { ...runtime, gitCommit: runtime.gitCommit ? sanitizeFields(runtime.gitCommit) : undefined };
    case "conda": {
      const values = runtime.workspace?.modules.conda;
      return values && runtime.workspace
        ? {
            ...runtime,
            workspace: {
              ...runtime.workspace,
              modules: { ...runtime.workspace.modules, conda: sanitizeFields(values) },
            },
          }
        : runtime;
    }
    case "extension_status":
      return {
        ...runtime,
        extensionStatuses: new Map(
          [...runtime.extensionStatuses].map(([key, value]) => [key, sanitizeTerminalText(value)]),
        ),
      };
    default:
      return runtime;
  }
}

function renderModule(
  module: ModuleConfig,
  values: Readonly<Record<string, FormatValue>>,
  styleVariables: Readonly<Record<string, string>>,
  palette: Readonly<Record<string, string>>,
): StyledChunk[] {
  if (module.disabled) return [];
  return renderFormat(module.formatAst, {
    variables: { symbol: module.symbol, ...values },
    styleVariables,
    palette,
  }).filter((chunk): chunk is StyledChunk => !isFillChunk(chunk));
}

export function reachableModuleRequirements(config: StarshipConfig): ReadonlyMap<ModuleName, ReadonlySet<string>> {
  const rootVariables = formatVariables(config.formatAst);
  const includeAll = rootVariables.has("all");
  const requirements = new Map<ModuleName, ReadonlySet<string>>();
  for (const definition of MODULE_DEFINITIONS) {
    if (config.modules[definition.name].disabled) continue;
    if (!includeAll && !rootVariables.has(definition.name)) continue;
    const variables = formatVariables(config.modules[definition.name].formatAst);
    if (definition.name === "directory") {
      const alternate = directoryAlternateFormat(config.modules.directory.options, config.modules.directory.styles);
      if (alternate) {
        for (const variable of formatVariables(parseFormat(alternate))) variables.add(variable);
      }
    }
    requirements.set(definition.name, variables);
  }
  return requirements;
}

function resolveFillLayout(layout: readonly LayoutChunk[], width: number): StyledChunk[] {
  const lines = splitLogicalLines(layout);
  const resolved: StyledChunk[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const fills = line.filter(isFillChunk);
    const fixedWidth = line.reduce(
      (total, chunk) => total + (isFillChunk(chunk) ? 0 : visibleWidth(renderChunksToAnsi([chunk]))),
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
