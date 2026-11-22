import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export const PLAN_MODE_COMPLETE_TOOL_NAME = "plan_mode_complete";
export const PLAN_MODE_COMPLETE_VERSION = 1;
export const PLAN_MODE_MAX_CHARS = 50_000;

export type PlanModeCompletionDetails = {
  version: typeof PLAN_MODE_COMPLETE_VERSION;
  source: typeof PLAN_MODE_COMPLETE_TOOL_NAME;
  plan: string;
};

export const PLAN_MODE_COMPLETE_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    plan: {
      type: "string",
      description: "The complete decision-ready Markdown for read-only workflows. Omit in managed-draft workflows.",
    },
  },
} as const;

type NormalizePlanModeCompletionResult = { ok: true; plan: string } | { ok: false; error: string };

export function normalizePlanModeCompletion(input: unknown): NormalizePlanModeCompletionResult {
  if (!isRecord(input) || typeof input.plan !== "string") {
    return { ok: false, error: "plan must be a string" };
  }
  return validatePlanText(input.plan.trim());
}

export function validatePlanText(plan: string): NormalizePlanModeCompletionResult {
  if (!plan.trim()) return { ok: false, error: "plan must not be empty" };
  if (plan.length > PLAN_MODE_MAX_CHARS) {
    return {
      ok: false,
      error: `plan must not exceed ${PLAN_MODE_MAX_CHARS} characters`,
    };
  }
  return { ok: true, plan };
}

export function planFromCompletionDetails(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (value.version !== PLAN_MODE_COMPLETE_VERSION || value.source !== PLAN_MODE_COMPLETE_TOOL_NAME) {
    return undefined;
  }
  if (typeof value.plan !== "string") return undefined;
  const normalized = validatePlanText(value.plan);
  return normalized.ok ? normalized.plan : undefined;
}

export function planModeCompleted(plan: string) {
  return {
    content: [{ type: "text" as const, text: `**Proposed Plan**\n\n${plan}` }],
    details: {
      version: PLAN_MODE_COMPLETE_VERSION,
      source: PLAN_MODE_COMPLETE_TOOL_NAME,
      plan,
    } satisfies PlanModeCompletionDetails,
    terminate: true,
  };
}

type PlanModeCompletionRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

export function planModeCompletionMarkdown(result: PlanModeCompletionRenderResult) {
  const content = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (content) return content;
  const plan = planFromCompletionDetails(result.details);
  return plan ? `**Proposed Plan**\n\n${plan}` : "";
}

export function renderPlanModeCompletion(result: PlanModeCompletionRenderResult) {
  return new Markdown(planModeCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
