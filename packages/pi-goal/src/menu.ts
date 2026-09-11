import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionMenuItem } from "@narumitw/pi-tui-kit";
import { formatTokenCount as formatCompactTokenCount, formatDuration } from "./accounting.js";
import { parseTokenBudget } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import { notifyTerminal, safeGoalMenuText } from "./errors.js";

export { safeGoalMenuText } from "./errors.js";

import type { ActiveGoal } from "./persistence.js";
import { type GoalRuntime, goalSummary } from "./runtime.js";

export const GOAL_MENU_ACTIONS = {
  start: "Start a goal…",
  startBudget: "Start with token budget…",
  pause: "Pause goal",
  resume: "Resume goal",
  reviewSafety: "Review and continue…",
  increaseBudget: "Increase budget and resume…",
  edit: "Edit goal…",
  replace: "Replace goal…",
  status: "View full status",
  settings: "Settings…",
  help: "Help",
  clear: "Clear goal…",
  close: "Close",
} as const;

interface GoalMenuRuntimeView {
  activeGoal?: ActiveGoal;
  settings: GoalRuntime["settings"];
  recordGoalUsage?: GoalRuntime["recordGoalUsage"];
  persistGoal?: GoalRuntime["persistGoal"];
  updateStatus?: GoalRuntime["updateStatus"];
}

export interface GoalMenuState {
  title: string;
  actions: string[];
}

type ShowSettings = (ctx: ExtensionCommandContext, target?: "automatic") => Promise<void>;
type GoalMenuScreen =
  | "main"
  | "start-budget"
  | "start-custom-budget"
  | "increase-budget"
  | "safety"
  | "status"
  | "help";
type GoalMenuAction =
  | "start"
  | "start-with-budget"
  | "start-with-custom-budget"
  | "submit-increase-budget"
  | "pause"
  | "resume"
  | "safety-resume"
  | "safety-settings"
  | "edit"
  | "replace"
  | "settings"
  | "clear"
  | "back";

export function buildGoalMenuState(runtime: GoalMenuRuntimeView): GoalMenuState {
  const goal = runtime.activeGoal;
  const pausedByAutomaticLimit = goal?.status === "paused" && goal.safetyPauseCause === "continuation_limit";
  const waitingReason = goal?.waiting ? safeGoalMenuText(goal.waiting.reason) : undefined;
  const state = pausedByAutomaticLimit
    ? "Paused — automatic-work limit reached"
    : waitingReason
      ? `Waiting — ${waitingReason}`
      : displayStatus(goal?.status);
  const automaticTurnLimit = runtime.settings.continuationLimits.automaticTurns;
  const used = goal?.automaticModelTurns ?? 0;
  const automaticResponses =
    automaticTurnLimit === null
      ? `Automatic work: ${used} responses · Unlimited`
      : `Automatic work: ${used} of ${automaticTurnLimit} responses${
          used < automaticTurnLimit ? ` · ${automaticTurnLimit - used} remaining` : ""
        }`;
  const title = goal
    ? [
        `Goal · ${state}`,
        safeGoalMenuText(goal.text),
        `Usage: ${
          goal.tokenBudget === undefined
            ? formatDuration(goal.timeUsedSeconds)
            : `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`
        }`,
        automaticResponses,
        ...(pausedByAutomaticLimit ? ["Progress is saved. Review the safety limit before continuing."] : []),
      ].join("\n")
    : [
        `Goal · ${state}`,
        "No goal is currently set",
        automaticTurnLimit === null
          ? "Automatic work is configured as Unlimited."
          : `Automatic work is configured to pause after ${automaticTurnLimit} responses.`,
      ].join("\n");

  const actions: string[] = [];
  if (!goal || goal.status === "complete") {
    actions.push(GOAL_MENU_ACTIONS.start, GOAL_MENU_ACTIONS.startBudget);
  } else if (goal.waiting) {
    actions.push(GOAL_MENU_ACTIONS.resume);
  } else if (goal.status === "active") {
    actions.push(GOAL_MENU_ACTIONS.pause);
  } else if (goal.status === "budget_limited") {
    actions.push(GOAL_MENU_ACTIONS.increaseBudget);
  } else if (pausedByAutomaticLimit) {
    actions.push(GOAL_MENU_ACTIONS.reviewSafety);
  } else {
    actions.push(GOAL_MENU_ACTIONS.resume);
  }
  if (goal && goal.status !== "complete") {
    actions.push(GOAL_MENU_ACTIONS.edit, GOAL_MENU_ACTIONS.replace);
  }
  if (goal) actions.push(GOAL_MENU_ACTIONS.status);
  actions.push(GOAL_MENU_ACTIONS.settings, GOAL_MENU_ACTIONS.help);
  if (goal) actions.push(GOAL_MENU_ACTIONS.clear);
  actions.push(GOAL_MENU_ACTIONS.close);
  return { title, actions };
}

export async function showGoalManager(
  runtime: GoalMenuRuntimeView,
  commands: GoalCommandController,
  ctx: ExtensionCommandContext,
  showSettings: ShowSettings,
): Promise<void> {
  if (ctx.mode !== "tui") {
    commands.showGoal(ctx);
    return;
  }
  const owner = runtime as GoalRuntime;
  const generation = owner.menuGeneration;
  const ownerSignal = owner.menuController?.signal;
  const isMenuCurrent = () =>
    owner.menuController === undefined || (generation === owner.menuGeneration && !owner.menuController.signal.aborted);
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (!isMenuCurrent()) return;
  let displayedGoal: ActiveGoal | undefined;
  let displayedBudgetGoal: ActiveGoal | undefined;
  let displayedBudgetValue: number | undefined;
  let displayedBudgetUsage: number | undefined;
  let displayedBudgetStatus: ActiveGoal["status"] | undefined;
  const menu = defineMenu<undefined, GoalMenuScreen, GoalMenuAction, ExtensionCommandContext>({
    start: "main",
    screens: {
      main: () => {
        refreshGoalMenuState(runtime, ctx);
        const state = buildGoalMenuState(runtime);
        displayedGoal = runtime.activeGoal;
        return {
          kind: "actions",
          title: "Goal",
          lines: state.title.split("\n").slice(1),
          items: state.actions.map(goalMainMenuItem),
          hint: "close",
        };
      },
      "start-budget": () => {
        return {
          kind: "actions",
          title: "Choose token budget",
          lines: tokenBudgetGuidance(runtime.settings.continuationLimits.automaticTurns),
          items: [
            {
              id: "25k",
              label: "25k — Lower token ceiling",
              description: "Set the cumulative token limit to 25k.",
              action: "start-with-budget",
            },
            {
              id: "100k",
              label: "100k — Suggested",
              description: "Set the cumulative token limit to 100k.",
              action: "start-with-budget",
            },
            {
              id: "300k",
              label: "300k — Higher token ceiling",
              description: "Set the cumulative token limit to 300k.",
              action: "start-with-budget",
            },
            {
              id: "custom",
              label: "Set a custom budget…",
              description: "Enter an exact cumulative token limit.",
              to: "start-custom-budget",
            },
            { id: "back", label: "Back", action: "back" },
          ],
          hint: "back",
        };
      },
      "start-custom-budget": () => ({
        kind: "input",
        title: "Custom token budget",
        lines: customTokenBudgetGuidance(runtime.settings.continuationLimits.automaticTurns),
        placeholder: "100k",
        action: "start-with-custom-budget",
        hint: "back",
      }),
      "increase-budget": () => {
        const goal = runtime.activeGoal;
        displayedBudgetGoal = goal;
        displayedBudgetValue = goal?.tokenBudget;
        displayedBudgetUsage = goal?.tokensUsed;
        displayedBudgetStatus = goal?.status;
        if (goal && goal.tokensUsed >= Number.MAX_SAFE_INTEGER) {
          return {
            kind: "detail",
            title: "Increase token budget unavailable",
            lines: [
              `Current usage: ${formatBudgetDecisionValue(goal.tokensUsed)}`,
              "No larger safe whole-number token budget is available. Progress remains saved; choose Back and clear or replace the goal when ready.",
            ],
            hint: "back",
          };
        }
        return {
          kind: "input",
          title: "Increase token budget",
          lines: goal
            ? increaseTokenBudgetGuidance(goal, runtime.settings.continuationLimits.automaticTurns)
            : ["The budget-limited goal is no longer available. Return to the Goal menu."],
          placeholder: goal ? suggestedIncreasedBudget(goal) : "300k",
          action: "submit-increase-budget",
          hint: "back",
        };
      },
      safety: () => {
        const goal = runtime.activeGoal;
        displayedGoal = goal;
        const limit = runtime.settings.continuationLimits.automaticTurns;
        const used = goal?.automaticModelTurns ?? 0;
        return {
          kind: "actions",
          title: "Automatic work paused",
          lines: goal
            ? [
                automaticPauseSummary(used, limit),
                `${safeGoalMenuText(goal.text)} is preserved.`,
                `${formatInteger(goal.tokensUsed)} cumulative tokens and ${formatDuration(goal.timeUsedSeconds)} active time are preserved.`,
                "The objective and usage are preserved.",
                limit === null
                  ? "Continuing resets the counter to 0 and resumes with Unlimited automatic work."
                  : `Continuing resets the counter to 0 and allows up to ${limit} more automatic model responses.`,
              ]
            : ["The paused goal is no longer available. Return to the Goal menu."],
          items: goal
            ? [
                {
                  id: "continue",
                  label: limit === null ? "Continue — Unlimited" : `Continue — up to ${limit} more responses`,
                  action: "safety-resume" as const,
                },
                {
                  id: "settings",
                  label: "Change automatic-work limit…",
                  action: "safety-settings" as const,
                },
                { id: "back", label: "Back", action: "back" as const },
              ]
            : [{ id: "back", label: "Back", action: "back" as const }],
          hint: "back",
        };
      },
      status: () => ({
        kind: "detail",
        title: "Goal status",
        lines: runtime.activeGoal
          ? goalSummary(runtime.activeGoal, runtime.settings.continuationLimits.automaticTurns).split("\n")
          : ["No goal is currently set."],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Goal help",
        lines: goalHelp().split("\n").slice(1),
        hint: "back",
      }),
    },
    actions: {
      start: async () => {
        await startFromMenu(commands, ctx);
        return { kind: "close" };
      },
      "start-with-budget": async ({ itemId, signal }) => {
        const budget = parseTokenBudget(itemId);
        if (budget === undefined) return { kind: "rejected" };
        return startBudgetedGoal(
          commands,
          ctx,
          budget,
          runtime.settings.continuationLimits.automaticTurns,
          signal,
          isMenuCurrent,
          "stay",
        );
      },
      "start-with-custom-budget": async ({ value, signal }) => {
        const budget = parseTokenBudget(value ?? "");
        if (budget === undefined) {
          notifyTerminal(ctx.ui, "Enter a positive token amount, for example 25k, 300k, or 1.5m.", "warning");
          return { kind: "rejected" };
        }
        return startBudgetedGoal(
          commands,
          ctx,
          budget,
          runtime.settings.continuationLimits.automaticTurns,
          signal,
          isMenuCurrent,
          "back",
        );
      },
      "submit-increase-budget": async ({ value, signal }) => {
        const goal = displayedBudgetGoal;
        const budget = parseTokenBudget(value ?? "");
        if (budget === undefined) {
          notifyTerminal(ctx.ui, "Enter a positive token amount, for example 300k, 1.5m, or 300000.", "warning");
          return { kind: "rejected" };
        }
        if (
          !goal ||
          !requireCurrentBudgetPreview(
            runtime,
            goal,
            displayedBudgetValue,
            displayedBudgetUsage,
            displayedBudgetStatus,
            ctx,
          )
        ) {
          return { kind: "close" };
        }
        if (budget <= goal.tokensUsed) {
          notifyTerminal(
            ctx.ui,
            `Enter a new cumulative total greater than current usage (${formatCompactTokenCount(goal.tokensUsed)}).`,
            "warning",
          );
          return { kind: "rejected" };
        }
        const confirmed = await ctx.ui.confirm(
          "Increase goal budget?",
          increaseBudgetPreview(goal, budget, runtime.settings.continuationLimits.automaticTurns),
        );
        if (signal.aborted || !isMenuCurrent()) return { kind: "close" };
        if (!confirmed) return { kind: "rejected" };
        if (
          !requireCurrentBudgetPreview(
            runtime,
            goal,
            displayedBudgetValue,
            displayedBudgetUsage,
            displayedBudgetStatus,
            ctx,
          )
        ) {
          return { kind: "close" };
        }
        await commands.editGoal(goal.text, budget, ctx);
        return { kind: "close" };
      },
      pause: async () => {
        if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
          return { kind: "stay" };
        }
        commands.pauseGoal(ctx);
        return { kind: "close" };
      },
      resume: async () => {
        if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
          return { kind: "stay" };
        }
        await commands.resumeGoal(ctx);
        return { kind: "close" };
      },
      "safety-resume": async () => {
        if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
          return { kind: "stay" };
        }
        await commands.resumeGoal(ctx);
        return { kind: "close" };
      },
      "safety-settings": async () => {
        if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
          return { kind: "stay" };
        }
        const expectedGoal = displayedGoal;
        await showSettings(ctx, "automatic");
        if (!isMenuCurrent()) return { kind: "close" };
        if (!requireCurrentMenuGoal(runtime, expectedGoal, ctx)) return { kind: "stay" };
        return { kind: "stay" };
      },
      edit: async () => {
        if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
          return { kind: "stay" };
        }
        await editFromMenu(runtime, commands, ctx);
        return { kind: "close" };
      },
      replace: async () => {
        await startFromMenu(commands, ctx);
        return { kind: "close" };
      },
      settings: async () => {
        await showSettings(ctx);
        return { kind: "stay" };
      },
      clear: async () => {
        const previewedGoal = runtime.activeGoal;
        if (!(await confirmClear(runtime, ctx))) return { kind: "stay" };
        if (previewedGoal && !requireCurrentMenuGoal(runtime, previewedGoal, ctx)) {
          return { kind: "stay" };
        }
        commands.clearGoal(ctx);
        return { kind: "close" };
      },
      back: async () => ({ kind: "back" }),
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: ownerSignal,
    isCurrent: isMenuCurrent,
  });
}

function goalMainMenuItem(label: string): ActionMenuItem<GoalMenuScreen, GoalMenuAction> {
  if (label === GOAL_MENU_ACTIONS.status) return { id: "status", label, to: "status" as const };
  if (label === GOAL_MENU_ACTIONS.startBudget) {
    return { id: "start-budget", label, to: "start-budget" as const };
  }
  if (label === GOAL_MENU_ACTIONS.increaseBudget) {
    return { id: "increase-budget", label, to: "increase-budget" as const };
  }
  if (label === GOAL_MENU_ACTIONS.reviewSafety) {
    return { id: "review-safety", label, to: "safety" as const };
  }
  if (label === GOAL_MENU_ACTIONS.help) return { id: "help", label, to: "help" as const };
  if (label === GOAL_MENU_ACTIONS.close) return { id: "close", label, close: true as const };
  const actions = new Map<string, GoalMenuAction>([
    [GOAL_MENU_ACTIONS.start, "start"],
    [GOAL_MENU_ACTIONS.pause, "pause"],
    [GOAL_MENU_ACTIONS.resume, "resume"],
    [GOAL_MENU_ACTIONS.edit, "edit"],
    [GOAL_MENU_ACTIONS.replace, "replace"],
    [GOAL_MENU_ACTIONS.settings, "settings"],
    [GOAL_MENU_ACTIONS.clear, "clear"],
  ]);
  return { id: actions.get(label) ?? label, label, action: actions.get(label) ?? "settings" };
}

function refreshGoalMenuState(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
  const goal = runtime.activeGoal;
  if (!goal) return;
  runtime.recordGoalUsage?.(goal, ctx);
  runtime.persistGoal?.(goal);
  runtime.updateStatus?.(ctx, goal);
}

async function startFromMenu(commands: GoalCommandController, ctx: ExtensionCommandContext) {
  const objective = (await ctx.ui.editor("Goal objective", ""))?.trim();
  if (!objective) return;
  await commands.startGoal(objective, undefined, ctx);
}

async function startBudgetedGoal(
  commands: GoalCommandController,
  ctx: ExtensionCommandContext,
  budget: number,
  automaticLimit: number | null,
  signal: AbortSignal,
  isMenuCurrent: () => boolean,
  cancelTransition: "stay" | "back",
) {
  const objective = (
    await ctx.ui.editor(
      `Goal objective · Token budget ${formatCompactTokenCount(budget)} · ${automaticLimit === null ? "Automatic Unlimited" : `Automatic limit ${automaticLimit}`}`,
      "",
    )
  )?.trim();
  if (signal.aborted || !isMenuCurrent()) return { kind: "close" as const };
  if (!objective) return { kind: cancelTransition } as const;
  await commands.startGoal(
    objective,
    budget,
    ctx,
    undefined,
    () => !signal.aborted && isMenuCurrent(),
    () => !signal.aborted && isMenuCurrent(),
  );
  return { kind: "close" as const };
}

function tokenBudgetGuidance(automaticLimit: number | null) {
  return [
    "Set the maximum cumulative token usage for this goal.",
    "The final model call may exceed the limit; this is not a dollar-cost cap.",
    automaticBudgetGuidance(automaticLimit),
  ];
}

function customTokenBudgetGuidance(automaticLimit: number | null) {
  return [
    "Enter the maximum cumulative token usage for this goal.",
    "Examples: 25k, 300k, 1.5m, or 300000.",
    "The final model call may exceed this value; this is not a dollar-cost cap.",
    automaticBudgetGuidance(automaticLimit),
  ];
}

function automaticBudgetGuidance(automaticLimit: number | null) {
  return automaticLimit === null
    ? "Automatic work has no response-count cap."
    : `Automatic work will also pause after ${automaticLimit} responses.`;
}

function increaseTokenBudgetGuidance(goal: ActiveGoal, automaticLimit: number | null) {
  return [
    `Current budget: ${formatBudgetDecisionValue(goal.tokenBudget ?? 0)}`,
    `Current usage: ${formatBudgetDecisionValue(goal.tokensUsed)}`,
    `Enter a new cumulative total greater than ${formatBudgetDecisionValue(goal.tokensUsed)}.`,
    "Examples: 300k, 1.5m, or 300000.",
    "The final model call may exceed the limit; this is not a dollar-cost cap.",
    automaticBudgetGuidance(automaticLimit),
  ];
}

function suggestedIncreasedBudget(goal: ActiveGoal) {
  const floor = Math.max(goal.tokensUsed, goal.tokenBudget ?? 0);
  for (const suggestion of [25_000, 100_000, 300_000, 500_000, 1_000_000]) {
    if (suggestion > floor) return formatCompactTokenCount(suggestion);
  }
  return formatCompactTokenCount(
    Math.min(Number.MAX_SAFE_INTEGER, Math.max(Math.floor(floor) + 1, Math.ceil(floor * 2))),
  );
}

function formatBudgetDecisionValue(value: number) {
  const compact = formatCompactTokenCount(value);
  if (value < 1_000 || value % 1_000 === 0) return compact;
  return `${compact} (${formatInteger(value)} tokens)`;
}

function increaseBudgetPreview(goal: ActiveGoal, budget: number, automaticLimit: number | null) {
  return [
    `Goal: ${safeGoalMenuText(goal.text, 4_000)}`,
    `Budget: ${formatCompactTokenCount(goal.tokenBudget ?? 0)} → ${formatCompactTokenCount(budget)}`,
    `Current usage: ${formatCompactTokenCount(goal.tokensUsed)}`,
    automaticLimit === null
      ? "Automatic work: Unlimited after resume"
      : `Automatic work: up to ${automaticLimit} more responses after resume`,
    "The goal will resume immediately.",
  ].join("\n");
}

async function editFromMenu(
  runtime: GoalMenuRuntimeView,
  commands: GoalCommandController,
  ctx: ExtensionCommandContext,
) {
  const goal = runtime.activeGoal;
  if (!goal) return;
  const objective = (await ctx.ui.editor("Edit goal objective", goal.text))?.trim();
  if (!objective || objective === goal.text) return;
  if (!requireCurrentMenuGoal(runtime, goal, ctx)) return;
  if (goal.status === "active") {
    const confirmed = await ctx.ui.confirm(
      "Apply goal edit?",
      `Current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\nUpdated goal:\n${safeGoalMenuText(objective, 4_000)}\n\nApplying this edit starts a new guarded goal instance.`,
    );
    if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
  }
  await commands.editGoal(objective, undefined, ctx);
}

async function confirmClear(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
  const goal = runtime.activeGoal;
  if (!goal) return false;
  return ctx.ui.confirm(
    "Clear goal?",
    `Remove this goal:\n\n${safeGoalMenuText(goal.text, 4_000)}\n\nThis cannot be undone.`,
  );
}

function requireCurrentBudgetPreview(
  runtime: GoalMenuRuntimeView,
  expectedGoal: ActiveGoal,
  expectedBudget: number | undefined,
  expectedUsage: number | undefined,
  expectedStatus: ActiveGoal["status"] | undefined,
  ctx: ExtensionCommandContext,
) {
  const current = runtime.activeGoal;
  if (
    current?.id === expectedGoal.id &&
    current.tokenBudget === expectedBudget &&
    current.tokensUsed === expectedUsage &&
    current.status === expectedStatus
  ) {
    return true;
  }
  notifyTerminal(
    ctx.ui,
    "The goal changed or its usage changed while the budget dialog was open. Reopen /goal and try again.",
    "warning",
  );
  return false;
}

function requireCurrentMenuGoal(runtime: GoalMenuRuntimeView, expected: ActiveGoal, ctx: ExtensionCommandContext) {
  if (runtime.activeGoal?.id === expected.id) return true;
  notifyTerminal(ctx.ui, "The active goal changed while the dialog was open. Reopen /goal and try again.", "warning");
  return false;
}

function displayStatus(status?: ActiveGoal["status"]) {
  if (!status) return "No goal";
  if (status === "usage_limited") return "Usage limited";
  if (status === "budget_limited") return "Budget limited";
  return status[0]?.toUpperCase() + status.slice(1);
}

function formatTokenCount(tokens: number) {
  return String(tokens);
}

function formatInteger(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function automaticPauseSummary(used: number, limit: number | null) {
  if (limit === null) {
    return `Goal paused after ${used} responses at its previous safety limit. Current limit: Unlimited.`;
  }
  if (used < limit) {
    return `Goal paused after ${used} responses at its previous safety limit. Current automatic-work limit: ${limit}.`;
  }
  return `Goal reached its ${used}-of-${limit} safety limit.`;
}

function goalHelp() {
  return [
    "Goal menu",
    "Use the menu for guided status, edits, settings, and confirmations.",
    "Direct routes remain available for deterministic workflows:",
    "/goal <objective>",
    "/goal status | pause | resume | edit | clear",
    "/goal --tokens 100k <objective>",
    "Escape cancels the current menu or input without changing goal state.",
  ].join("\n");
}
