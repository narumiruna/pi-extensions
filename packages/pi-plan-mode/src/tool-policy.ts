import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export {
  BUILTIN_SAFE_GIT_SUBCOMMANDS,
  type BuiltinSafeGitSubcommand,
  CONFIGURABLE_SAFE_GIT_SUBCOMMANDS,
  type ConfigurableSafeGitSubcommand,
  findBlockedCommandSegment,
  findBlockedPowerShellCommandSegment,
  isSafeCommand,
  isSafePowerShellCommand,
  readCommand,
  SAFE_GH_SUBCOMMAND_PATHS,
  SAFE_GIT_SUBCOMMANDS,
  type SafeGhSubcommandPath,
  type SafeGitSubcommand,
  type SafeSubcommands,
} from "./shell-policy.js";

export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "powershell", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "limited" | "user-opt-in" | "blocked";

const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);

export function isBuiltinTool(tool: ToolInfo) {
  const source = tool.sourceInfo;
  if (source?.source !== "builtin") return false;
  // Core tools own builtin:<name>; built-in extensions may own many tools or
  // expose model-only orchestration. Missing paths preserve legacy core policy.
  return !source.path || (source.path === `builtin:${tool.name}` && tool.exposure !== "model-only");
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (!tool.sourceInfo?.source) return "blocked";
  if (!isBuiltinTool(tool)) return "user-opt-in";
  if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
  if (tool.name === "bash" || tool.name === "powershell") return "limited";
  return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
  return classifyPlanModeTool(tool) !== "blocked";
}
