import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { defineModule } from "./types.js";

const TRUNCATION_DIRECTIONS = ["start", "middle", "end"] as const;
type TruncationDirection = (typeof TRUNCATION_DIRECTIONS)[number];
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const modelModule = defineModule({
  name: "model",
  variables: ["symbol", "model"],
  defaults: {
    format: "[$symbol $model ]($style)",
    symbol: "🤖",
    style: "bold blue",
    disabled: false,
  },
  options: {
    truncation_length: { kind: "integer", default: 0, minimum: 0, maximum: 1000 },
    truncation_symbol: { kind: "string", default: "…" },
    truncation_direction: {
      kind: "string-enum",
      default: "end",
      values: TRUNCATION_DIRECTIONS,
    },
    model_aliases: { kind: "string-map", default: {} },
  },
  values: ({ runtime, options }) => {
    if (!runtime.model) return undefined;
    const length = typeof options.truncation_length === "number" ? options.truncation_length : 0;
    const symbol = typeof options.truncation_symbol === "string" ? options.truncation_symbol : "…";
    const direction = isTruncationDirection(options.truncation_direction) ? options.truncation_direction : "end";
    const aliases = options.model_aliases;
    const aliasMap =
      aliases && typeof aliases === "object" && !Array.isArray(aliases)
        ? (aliases as Readonly<Record<string, string>>)
        : undefined;
    const alias = aliasMap && Object.hasOwn(aliasMap, runtime.model.id) ? aliasMap[runtime.model.id] : undefined;
    return {
      model: truncateModel(alias ?? shortenModel(runtime.model.id), length, symbol, direction),
    };
  },
});

export function truncateModel(model: string, length: number, symbol: string, direction: TruncationDirection): string {
  const safeModel = sanitizeTerminalText(model);
  if (length === 0) return safeModel;
  const graphemes = [...graphemeSegmenter.segment(safeModel)].map(({ segment }) => segment);
  if (graphemes.length <= length) return safeModel;
  const safeSymbol = sanitizeTerminalText(symbol);

  switch (direction) {
    case "start":
      return `${safeSymbol}${graphemes.slice(-length).join("")}`;
    case "middle": {
      const headLength = Math.ceil(length / 2);
      const tailLength = Math.floor(length / 2);
      const tail = tailLength > 0 ? graphemes.slice(-tailLength).join("") : "";
      return `${graphemes.slice(0, headLength).join("")}${safeSymbol}${tail}`;
    }
    case "end":
      return `${graphemes.slice(0, length).join("")}${safeSymbol}`;
  }
}

function isTruncationDirection(value: unknown): value is TruncationDirection {
  return TRUNCATION_DIRECTIONS.includes(value as TruncationDirection);
}

export function shortenModel(model: string): string {
  return model
    .replace(/^claude-/u, "")
    .replace(/^gpt-/u, "gpt ")
    .replace(/-20\d{6}$/u, "")
    .replace(/-latest$/u, "");
}
