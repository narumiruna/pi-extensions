import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const tokensModule = defineModule({
  name: "tokens",
  variables: ["symbol", "input", "output", "total"],
  defaults: {
    format: "[$symbol ↑$input ↓$output ]($style)",
    symbol: "🔢",
    style: "bold cyan",
    disabled: false,
  },
  values: ({ runtime }) => ({
    input: formatCount(runtime.tokenTotals.input),
    output: formatCount(runtime.tokenTotals.output),
    total: formatCount(runtime.tokenTotals.input + runtime.tokenTotals.output),
  }),
});
