import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineModule } from "./types.js";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

function thinkingLevelOf(value: string): ThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === value);
}

export const thinkingModule = defineModule({
  name: "thinking",
  variables: ["symbol", "level"],
  defaults: {
    format: "[$symbol $level ]($style)",
    symbol: "🧠",
    style: "bold purple",
    disabled: false,
  },
  styleDefaults: Object.fromEntries(THINKING_LEVELS.map((level) => [`style_${level}`, ""])) as Record<
    `style_${ThinkingLevel}`,
    string
  >,
  fallbackStyle: true,
  styleVariables: ["style"],
  resolveStyleVariables: ({ runtime, styles, style }) => {
    const level = thinkingLevelOf(runtime.thinkingLevel);
    return { style: (level && styles[`style_${level}`]) || style };
  },
  values: ({ runtime }) => ({ level: runtime.thinkingLevel }),
});
