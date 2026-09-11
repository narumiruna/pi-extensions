import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { unique } from "./tool-selection.js";

export const REQUIRED_PLAN_MODE_TOOL_NAMES = [PLAN_MODE_QUESTION_TOOL_NAME, PLAN_MODE_COMPLETE_TOOL_NAME] as const;

export function planModeHelperToolsAvailable(toolNames: readonly string[]) {
  const active = new Set(toolNames);
  return REQUIRED_PLAN_MODE_TOOL_NAMES.every((name) => active.has(name));
}

export function assertPlanModeHelperToolsAvailable(toolNames: readonly string[]) {
  if (planModeHelperToolsAvailable(toolNames)) return;
  throw new Error(
    "plan_mode_question and plan_mode_complete are unavailable; include them in the active tool allowlist or leave the restrictive tool mode before starting Plan mode",
  );
}

export function withRequiredPlanModeTools(toolNames: string[]) {
  return unique([
    ...withoutRequiredPlanModeTools(toolNames),
    PLAN_MODE_QUESTION_TOOL_NAME,
    PLAN_MODE_COMPLETE_TOOL_NAME,
  ]);
}

export function withoutRequiredPlanModeTools(toolNames: string[]) {
  return toolNames.filter(
    (toolName) => toolName !== PLAN_MODE_QUESTION_TOOL_NAME && toolName !== PLAN_MODE_COMPLETE_TOOL_NAME,
  );
}
