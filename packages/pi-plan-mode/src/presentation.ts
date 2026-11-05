import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function updatePlanModeUi(
  ctx: ExtensionContext,
  state: PlanModeState,
  toolSummary: () => string,
  interactionShortcut?: string,
) {
  ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
  const discussion = state.interactionMode === "discussion";
  const interactionHint = formatInteractionHint(state, ctx.mode === "tui" ? interactionShortcut : undefined);
  let lines: string[] | undefined;
  if (state.enabled && state.latestPlan) {
    lines = [
      "Proposed plan ready",
      ...(discussion ? ["Plan mode: free discussion"] : []),
      "Use /plan to implement, save, revise, or exit Plan mode.",
      interactionHint,
    ];
  } else if (state.enabled) {
    lines = [
      discussion ? "Plan mode: free discussion" : "Plan mode: planning",
      toolSummary(),
      discussion
        ? "Plain-text questions are allowed; questionnaires are paused."
        : "Finish with plan_mode_complete when decision-ready.",
      interactionHint,
    ];
  } else if (state.savedPlan) {
    lines = ["Plan saved for later", "Use /plan to show, implement, or clear it."];
  } else if (state.activeImplementation) {
    lines = ["Implementation plan active", "Use /plan to show, replace, or clear it."];
  }

  publishPlanModeWidget(ctx, lines);
}

export function renderPlanModeWidget(lines: readonly string[], theme: Theme, width: number): string[] {
  return createPlanModeWidget(lines, theme).render(width);
}

function createPlanModeWidget(lines: readonly string[], theme: Theme): EditorStatusWidget {
  // Kit normalizes fractional and invalid widths before clipping sanitized body rows.
  return new EditorStatusWidget({
    theme,
    renderBody: () =>
      lines.map((line, index) => {
        const text = sanitizePlanModeWidgetLine(line);
        return index === 0 ? text : theme.fg("muted", text);
      }),
  });
}

export function sanitizePlanModeWidgetLine(value: string): string {
  let text = "";
  for (const character of stripTerminalSequences(value).replace(BIDI_CONTROLS, "")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    text += isControl ? " " : character;
  }
  return text;
}

export function clearPlanModeUi(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function showStoredPlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanModeState) {
  const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
  const savedPlan = state.savedPlan?.plan.trim();
  if (savedPlan && (ctx.mode === "print" || ctx.mode === "json")) {
    throw new Error("Saved plan display is unavailable in print/JSON mode. Use TUI or RPC.");
  }
  const activePlan = state.activeImplementation?.plan.trim();
  const plan = readyPlan ?? savedPlan ?? activePlan;
  if (!plan) {
    ctx.ui.notify("No completed plan is available. Use /plan finalize when planning is complete.", "info");
    return;
  }
  const title = readyPlan ? "Proposed Plan" : savedPlan ? "Saved Plan" : "Active Implementation Plan";
  showPlanModePlan(pi, ctx, title, plan);
}

export function showPlanModePlan(pi: ExtensionAPI, ctx: ExtensionContext, title: string, plan: string) {
  try {
    pi.sendMessage(
      {
        customType: "proposed-plan",
        content: `**${title}**\n\n${plan}`,
        display: true,
      },
      { triggerTurn: false },
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
  }
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
  if (state.enabled) {
    const ready = state.latestPlan ? " A proposed plan is ready." : "";
    const interaction =
      state.interactionMode === "discussion"
        ? "Free discussion is active; questionnaires are paused and plain-text questions are allowed."
        : "Explore, ask, and finish with plan_mode_complete when decision-ready.";
    return `Plan mode is active.${ready} ${interaction} File edits remain blocked. ${toolSummary()}`;
  }
  if (state.savedPlan) return "A plan is saved for later.";
  if (state.activeImplementation) return "An implementation plan is active.";
  return "Plan mode is off.";
}

function publishPlanModeWidget(ctx: ExtensionContext, lines: readonly string[] | undefined) {
  if (!lines) {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, [...lines]);
    return;
  }

  const snapshot = [...lines];
  ctx.ui.setWidget(PLAN_WIDGET_KEY, (_tui, theme) => createPlanModeWidget(snapshot, theme));
}

function formatInteractionHint(state: PlanModeState, interactionShortcut?: string) {
  const action = state.interactionMode === "discussion" ? "enable questionnaires" : "switch to free discussion";
  return interactionShortcut ? `${interactionShortcut}: ${action}.` : `Use /plan to ${action}.`;
}

function formatStatus(state: PlanModeState) {
  if (state.enabled) {
    if (state.awaitingAction || state.latestPlan) return "plan ready";
    return state.interactionMode === "discussion" ? "plan discussion" : "plan active";
  }
  if (state.savedPlan) return "plan saved";
  if (state.activeImplementation) return "plan implementing";
  return undefined;
}
