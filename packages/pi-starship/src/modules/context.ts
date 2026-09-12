import { resolveDisplayStyle } from "./display.js";
import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const contextModule = defineModule({
  name: "context",
  variables: ["symbol", "percentage", "tokens", "window"],
  defaults: {
    format: "[$symbol ctx $percentage ]($style)",
    symbol: "🪟",
    style: "none",
    disabled: false,
  },
  displayDefaults: [
    { threshold: 0, style: "bold green", hidden: true },
    { threshold: 30, style: "bold green", hidden: false },
    { threshold: 60, style: "bold yellow", hidden: false },
    { threshold: 80, style: "bold red", hidden: false },
  ],
  styleVariables: ["style"],
  resolveStyleVariables: ({ runtime, display }) => {
    const style = resolveDisplayStyle(display, runtime.contextUsage?.percent);
    return style === undefined ? undefined : { style };
  },
  values: ({ runtime }) => {
    const percent = runtime.contextUsage?.percent;
    return {
      percentage: percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`,
      tokens: formatCount(runtime.contextUsage?.tokens ?? 0),
      window: formatCount(runtime.contextUsage?.contextWindow ?? 0),
    };
  },
});
