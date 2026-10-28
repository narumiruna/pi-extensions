import { validPattern } from "../format/bounded-regex.js";
import { isValidStyle } from "../format/style.js";
import { validStatusTemplate } from "../modules/git/status-templates.js";
import type { ModuleContextRule, ModuleOptionSchema, ModuleOptionValue, ModuleSubstitution } from "../modules/types.js";

type Result = { ok: true; value: ModuleOptionValue } | { ok: false; message: string };
const invalid = (expected: string): Result => ({ ok: false, message: `Expected ${expected}; using the default value` });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4_096): value is string => typeof value === "string" && value.length <= max;

export function normalizeModuleOption(
  value: unknown,
  schema: ModuleOptionSchema,
  palette: Readonly<Record<string, string>> = {},
): Result {
  switch (schema.kind) {
    case "string": {
      if (typeof value !== "string" || (schema.allowEmpty === false && value.length === 0)) return invalid("a string");
      if (schema.templateVariables && !validStatusTemplate(value, schema.templateVariables)) {
        return invalid("a bounded template with only the documented variables");
      }
      return { ok: true, value };
    }
    case "string-enum":
      return typeof value === "string" && schema.values.includes(value)
        ? { ok: true, value }
        : invalid(`one of: ${schema.values.join(", ")}`);
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : invalid("boolean");
    case "integer":
    case "number":
      return typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.kind !== "integer" || Number.isInteger(value)) &&
        value >= schema.minimum &&
        value <= schema.maximum
        ? { ok: true, value }
        : invalid(`${schema.kind} from ${schema.minimum} through ${schema.maximum}`);
    case "string-array":
      return Array.isArray(value) &&
        value.every(
          (item) => typeof item === "string" && item.length > 0 && (schema.allowNegative || !item.startsWith("!")),
        )
        ? { ok: true, value: [...value] as string[] }
        : invalid("an array of valid strings");
    case "string-map":
      return stringMap(value);
    case "command-alternatives": {
      if (typeof value === "string") value = [value];
      const argument = (item: unknown): item is string =>
        text(item, 1_024) &&
        item.length > 0 &&
        ![...item].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code < 32 || (code >= 127 && code <= 159);
        });
      if (
        !Array.isArray(value) ||
        value.length > 16 ||
        !value.every(
          (item) =>
            argument(item) || (Array.isArray(item) && item.length > 0 && item.length <= 16 && item.every(argument)),
        )
      )
        return invalid("at most 16 command names or argv arrays without terminal controls");
      return { ok: true, value: structuredClone(value) };
    }
    case "context-rules": {
      if (!Array.isArray(value) || value.length > 64) return invalid("at most 64 context rules");
      const keys = new Set(["context_pattern", "user_pattern", "symbol", "style", "context_alias", "user_alias"]);
      for (const rule of value) {
        if (
          !record(rule) ||
          !text(rule.context_pattern, 512) ||
          !validPattern(rule.context_pattern) ||
          Object.entries(rule).some(
            ([key, item]) =>
              !keys.has(key) ||
              !text(item) ||
              ((key === "context_pattern" || key === "user_pattern") && (!text(item, 512) || !validPattern(item))) ||
              (key === "style" && !isValidStyle(item, palette)),
          )
        )
          return invalid("context rules with valid bounded patterns, strings, and styles");
      }
      return { ok: true, value: structuredClone(value) as ModuleContextRule[] };
    }
    case "substitutions": {
      if (!Array.isArray(value)) return stringMap(value);
      if (value.length > 64) return invalid("at most 64 substitutions");
      for (const substitution of value) {
        if (
          !record(substitution) ||
          !text(substitution.from, 512) ||
          !text(substitution.to) ||
          Object.keys(substitution).some((key) => key !== "from" && key !== "to" && key !== "regex") ||
          (substitution.regex !== undefined && typeof substitution.regex !== "boolean") ||
          (substitution.regex === true && !validPattern(substitution.from))
        )
          return invalid("bounded from/to substitutions with an optional regex boolean");
      }
      return { ok: true, value: structuredClone(value) as ModuleSubstitution[] };
    }
  }
}

function stringMap(value: unknown): Result {
  if (!record(value) || Object.values(value).some((item) => typeof item !== "string"))
    return invalid("a table of strings");
  return { ok: true, value: Object.fromEntries(Object.entries(value)) as Record<string, string> };
}
