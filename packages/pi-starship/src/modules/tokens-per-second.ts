import { defineModule } from "./types.js";

export const tokensPerSecondModule = defineModule({
  name: "tokens_per_second",
  variables: ["symbol", "rate"],
  defaults: {
    format: "[$rate tok/s ]($style)",
    symbol: "",
    style: "bold cyan",
    disabled: true,
  },
  values: ({ runtime }) =>
    runtime.tokensPerSecond === undefined ? undefined : { rate: runtime.tokensPerSecond.toFixed(1) },
});
