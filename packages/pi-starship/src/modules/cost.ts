import { resolveDisplayStyle } from "./display.js";
import { defineModule } from "./types.js";

export const costModule = defineModule({
  name: "cost",
  variables: ["symbol", "cost", "subscription", "source"],
  defaults: {
    format: "[ $symbol \\$$cost( $subscription) ]($style)",
    symbol: "💸",
    style: "none",
    disabled: false,
  },
  displayDefaults: [
    { threshold: 0, style: "bold green", hidden: true },
    { threshold: 1, style: "bold yellow", hidden: false },
    { threshold: 5, style: "bold red", hidden: false },
  ],
  styleVariables: ["style"],
  resolveStyleVariables: ({ runtime, display }) => {
    const style = resolveDisplayStyle(display, runtime.tokenTotals.cost);
    return style === undefined ? undefined : { style };
  },
  values: ({ runtime }) => ({
    cost: formatCost(runtime.tokenTotals.cost),
    source: runtime.tokenTotals.costTotalFromProvider === true ? "provider" : "unconfirmed",
    subscription: runtime.usingSubscription ? "(sub)" : "",
  }),
});

function formatCost(value: number): string {
  return value.toFixed(value >= 1 ? 2 : 3);
}
