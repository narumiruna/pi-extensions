import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { defineModule } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

export const memoryUsageModule = defineModule({
  name: "memory_usage",
  variables: ["symbol", "ram", "ram_pct", "swap", "swap_pct"],
  defaults: {
    format: "via $symbol[$ram( | $swap)]($style) ",
    symbol: "🐏 ",
    style: "white bold dimmed",
    disabled: true,
  },
  options: { threshold: { kind: "number", default: 75, minimum: -100, maximum: 10_000 } },
  values: (context) => workspaceModuleValues("memory_usage", context),
});

export const batteryModule = defineModule({
  name: "battery",
  variables: ["symbol", "percentage"],
  defaults: { format: "[$symbol$percentage]($style) ", symbol: "", style: "none", disabled: true },
  displayDefaults: [{ threshold: 10, style: "red bold", hidden: false }],
  styleVariables: ["style"],
  resolveStyleVariables: ({ runtime, display }) => {
    const raw = runtime.workspace?.modules.battery?.percentage_raw;
    if (raw === undefined) return undefined;
    const percentage = Number(raw);
    if (!Number.isFinite(percentage)) return undefined;
    // Battery thresholds are upper bounds, unlike context-usage display rules.
    const selected = display.reduce<(typeof display)[number] | undefined>(
      (best, rule) =>
        percentage <= rule.threshold && (best === undefined || rule.threshold < best.threshold) ? rule : best,
      undefined,
    );
    return selected && !selected.hidden ? { style: selected.style } : undefined;
  },
  options: {
    full_symbol: { kind: "string", default: "󰁹 ", allowEmpty: true },
    charging_symbol: { kind: "string", default: "󰂄 ", allowEmpty: true },
    discharging_symbol: { kind: "string", default: "󰂃 ", allowEmpty: true },
    unknown_symbol: { kind: "string", default: "󰂑 ", allowEmpty: true },
    empty_symbol: { kind: "string", default: "󰂎 ", allowEmpty: true },
  },
  values(context) {
    const values = workspaceModuleValues("battery", context);
    if (!values) return undefined;
    const state = values.state;
    const key = `${state === "full" || state === "charging" || state === "discharging" || state === "empty" ? state : "unknown"}_symbol`;
    const symbol = context.options[key];
    return { percentage: values.percentage, symbol: typeof symbol === "string" ? sanitizeTerminalText(symbol) : "" };
  },
});

export const systemModules = [memoryUsageModule, batteryModule] as const;
