import { stringify, type TomlTable, type TomlValue } from "smol-toml";
import type { StarshipConfig } from "./config.js";
import { MODULE_DEFINITIONS } from "./modules/catalog.js";
import type { ModuleOptionValue } from "./modules/types.js";

export function projectEffectiveConfig(config: StarshipConfig): TomlTable {
  const projected: TomlTable = {
    format: config.format,
  };
  if (config.palette !== undefined) projected.palette = config.palette;
  projected.palettes = Object.fromEntries(
    sortedEntries(config.palettes).map(([name, colors]) => [name, sortedRecord(colors)]),
  );
  for (const definition of MODULE_DEFINITIONS) {
    const module = config.modules[definition.name];
    const table: TomlTable = {
      format: module.format,
      symbol: module.symbol,
    };
    if (definition.styleDefaults) {
      if (definition.fallbackStyle) table.style = module.style;
      for (const field of Object.keys(definition.styleDefaults)) {
        table[field] = module.styles[field] ?? "";
      }
    } else if (!definition.displayDefaults) {
      table.style = module.style;
    }
    if (definition.displayDefaults) {
      table.display = module.display.map((entry) => ({ ...entry }));
    }
    table.disabled = module.disabled;
    for (const key of Object.keys(definition.options ?? {})) {
      table[key] = cloneOptionValue(module.options[key]);
    }
    if (definition.name === "extension_status") {
      table.separator = config.extensionStatus.separator;
      table.max_statuses = config.extensionStatus.maxStatuses;
      table.icons = sortedRecord(config.extensionStatus.icons);
    }
    projected[definition.name] = table;
  }
  return projected;
}

export function serializeEffectiveConfig(config: StarshipConfig): string {
  return stringify(projectEffectiveConfig(config));
}

function cloneOptionValue(value: ModuleOptionValue | undefined): TomlValue {
  if (value === undefined) throw new Error("Missing normalized module option");
  if (Array.isArray(value)) return [...(value as readonly string[])];
  if (typeof value === "object") {
    return sortedRecord(value as Readonly<Record<string, string>>);
  }
  return value;
}

function sortedRecord(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(sortedEntries(values));
}

function sortedEntries<Value>(values: Readonly<Record<string, Value>>): [string, Value][] {
  return Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
