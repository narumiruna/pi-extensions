import { PLAN_MODE_COMPLETE_TOOL_NAME, PLAN_MODE_UPDATE_TOOL_NAME } from "./completion-tool.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { unique } from "./tool-selection.js";

export const REQUIRED_PLAN_MODE_TOOL_NAMES = [
  PLAN_MODE_QUESTION_TOOL_NAME,
  PLAN_MODE_UPDATE_TOOL_NAME,
  PLAN_MODE_COMPLETE_TOOL_NAME,
] as const;
const requiredHelpers = new Set<string>(REQUIRED_PLAN_MODE_TOOL_NAMES);

export function isRequiredPlanModeTool(toolName: string) {
  return requiredHelpers.has(toolName);
}

export function planModeHelperToolsAvailable(toolNames: readonly string[]) {
  const active = new Set(toolNames);
  return REQUIRED_PLAN_MODE_TOOL_NAMES.every((name) => active.has(name));
}

export function assertPlanModeHelperToolsAvailable(toolNames: readonly string[]) {
  const missing = REQUIRED_PLAN_MODE_TOOL_NAMES.filter((name) => !toolNames.includes(name));
  if (missing.length === 0) return;
  throw new Error(
    `Required Plan tools are unavailable: ${missing.join(", ")}; include them in the active tool allowlist or leave the restrictive tool mode before starting Plan mode`,
  );
}

export function withRequiredPlanModeTools(toolNames: string[]) {
  return unique([...withoutRequiredPlanModeTools(toolNames), ...REQUIRED_PLAN_MODE_TOOL_NAMES]);
}

export function withoutRequiredPlanModeTools(toolNames: string[]) {
  return toolNames.filter((name) => !isRequiredPlanModeTool(name));
}
