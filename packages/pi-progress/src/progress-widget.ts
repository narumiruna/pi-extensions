import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderCompletionSummary, renderProgressWidget, sanitizeProgressText } from "./progress-renderer.js";
import {
  allProgressCompleted,
  cloneProgressSteps,
  leadingSummaryEpoch,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE,
  PROGRESS_RESTORED_BOUNDARY_VERSION,
  type ProgressDetails,
  ProgressParameters,
  type ProgressStep,
  progressBoundaryContent,
  reconcileProgressContext,
  reconstructProgress,
  reconstructRestoredProgressBoundary,
  TOOL_NAME,
  validateProgressArguments,
} from "./progress-state.js";
import {
  DEFAULT_PROGRESS_SETTINGS,
  loadProgressSettings,
  type ProgressSettings,
  type ProgressSettingsLoadResult,
} from "./settings.js";

export const WIDGET_KEY = "progress";
export const COMPLETION_SUMMARY_MS = 3_000;
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;

export interface ProgressWidgetDependencies {
  loadSettings?: typeof loadProgressSettings;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export default function progressWidgetExtension(pi: ExtensionAPI, dependencies: ProgressWidgetDependencies = {}): void {
  const readSettings = dependencies.loadSettings ?? loadProgressSettings;
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let activeWidgetOwner: { sessionManager: ExtensionContext["sessionManager"]; clear(): void } | undefined;
  let steps: ProgressStep[] = [];
  let settings = cloneDefaultSettings();
  let restoredBoundary: { summaryEpoch: string; content: string } | undefined;
  let settingsController = new AbortController();
  let generation = 0;
  let completionTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let completionToken = 0;
  let completionSummaryHidden = false;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const clearActiveWidget = (): void => {
    activeWidgetOwner?.clear();
    activeWidgetOwner = undefined;
  };

  const cancelCompletionSummary = (): void => {
    completionToken += 1;
    if (completionTimer !== undefined) cancelTimeout(completionTimer);
    completionTimer = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx) || ctx.mode !== "tui") return;
    if (!settings.widget.enabled || steps.length === 0 || completionSummaryHidden) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const snapshot = cloneProgressSteps(steps);
    const widgetSettings = { ...settings.widget };
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => ({
        render: (width) =>
          renderProgressWidget(snapshot, theme, width, {
            settings: widgetSettings,
            terminalRows: tui.terminal.rows,
          }),
        invalidate: () => {},
      }),
      WIDGET_OPTIONS,
    );
  };

  const publishCompletionSummary = (ctx: ExtensionContext): void => {
    cancelCompletionSummary();
    completionSummaryHidden = false;
    if (!ownsSession(ctx) || ctx.mode !== "tui" || !settings.widget.enabled) {
      publish(ctx);
      return;
    }

    const total = steps.length;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width) => renderCompletionSummary(total, theme, width),
        invalidate: () => {},
      }),
      WIDGET_OPTIONS,
    );
    const ownerSession = activeSession;
    const token = completionToken;
    completionTimer = scheduleTimeout(() => {
      if (
        completionToken !== token ||
        activeSession !== ownerSession ||
        ctx.sessionManager !== ownerSession ||
        !settings.widget.enabled ||
        !allProgressCompleted(steps)
      ) {
        return;
      }
      completionTimer = undefined;
      completionSummaryHidden = true;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }, COMPLETION_SUMMARY_MS);
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Progress",
    description:
      "Replace the current session progress state with the complete supplied steps. Call update_progress whenever actual step state changes; keep at most one step in_progress, require a reason for each blocked step, and send an empty steps array to clear it.",
    promptSnippet: "Maintain the complete session progress state as multi-step work progresses",
    promptGuidelines: [
      "Use update_progress to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
      "Use update_progress to keep the progress state aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the steps before continuing when the plan changes.",
      "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
      "Before a progress report or final response, call update_progress to reconcile every step with actual work; do not report completion while the progress state is stale.",
      "On every update_progress call, send the complete current steps array, keep at most one step in_progress, and send an empty steps array when no tracked work remains.",
    ],
    parameters: ProgressParameters,
    prepareArguments: validateProgressArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ownsSession(ctx)) {
        throw new Error("Cannot update progress because the session changed.");
      }
      const nextSteps = validateProgressArguments(params).steps;
      const wasComplete = allProgressCompleted(steps);
      cancelCompletionSummary();
      completionSummaryHidden = false;
      steps = cloneProgressSteps(nextSteps);
      const becameComplete = steps.length > 0 && allProgressCompleted(steps) && !wasComplete;
      if (becameComplete) publishCompletionSummary(ctx);
      else publish(ctx);

      const details: ProgressDetails = {
        version: PROGRESS_DETAILS_VERSION,
        steps: cloneProgressSteps(steps),
      };
      if (steps.length === 0) {
        return {
          content: [{ type: "text", text: "Progress cleared." }],
          details,
        };
      }

      const completed = steps.filter((step) => step.status === "completed").length;
      const inProgress = steps.some((step) => step.status === "in_progress");
      const blocked = steps.filter((step) => step.status === "blocked").length;
      const suffixes = [...(inProgress ? ["1 in progress"] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
      return {
        content: [
          {
            type: "text",
            text: `Progress updated: ${completed} of ${steps.length} complete${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}.`,
          },
        ],
        details,
      };
    },
  });

  const restoreBranchState = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    steps = reconstructProgress(branch);
    restoredBoundary = reconstructRestoredProgressBoundary(branch);
  };

  pi.on("session_start", async (_event, ctx) => {
    settingsController.abort();
    cancelCompletionSummary();
    clearActiveWidget();

    settingsController = new AbortController();
    const ownerController = settingsController;
    generation += 1;
    const ownerGeneration = generation;
    activeSession = ctx.sessionManager;
    if (ctx.mode === "tui") {
      const ownerSession = ctx.sessionManager;
      activeWidgetOwner = {
        sessionManager: ownerSession,
        clear: () => ctx.ui.setWidget(WIDGET_KEY, undefined),
      };
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    completionSummaryHidden = false;
    settings = cloneDefaultSettings();
    restoreBranchState(ctx);

    let loaded: ProgressSettingsLoadResult;
    try {
      loaded = await readSettings(undefined, ownerController.signal);
    } catch (error) {
      if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) return;
      loaded = {
        kind: "invalid",
        path: "pi-progress.json",
        settings: cloneDefaultSettings(),
        issue: error instanceof Error ? error.message : String(error),
      };
    }
    if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) return;
    settings = cloneSettings(loaded.settings);
    if (loaded.kind === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        sanitizeProgressText(`Invalid progress settings at ${loaded.path}; using defaults. ${loaded.issue}`),
        "warning",
      );
    }
    publish(ctx);
  });

  pi.on("context", (event: ContextEvent, ctx) => {
    if (!ownsSession(ctx)) return;
    const summaryEpoch = leadingSummaryEpoch(event.messages);
    if (restoredBoundary?.summaryEpoch !== summaryEpoch) restoredBoundary = undefined;
    const messages = reconcileProgressContext(event.messages, steps, restoredBoundary?.content);
    if (restoredBoundary === undefined && summaryEpoch) {
      const content = progressBoundaryContent(messages);
      if (content !== undefined) {
        restoredBoundary = { summaryEpoch, content };
        pi.appendEntry(PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE, {
          version: PROGRESS_RESTORED_BOUNDARY_VERSION,
          ...restoredBoundary,
        });
      }
    }
    if (messages !== event.messages) return { messages };
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cancelCompletionSummary();
    completionSummaryHidden = false;
    restoreBranchState(ctx);
    publish(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    settingsController.abort();
    generation += 1;
    cancelCompletionSummary();
    if (activeWidgetOwner?.sessionManager === ctx.sessionManager) clearActiveWidget();
    steps = [];
    settings = cloneDefaultSettings();
    restoredBoundary = undefined;
    completionSummaryHidden = false;
    activeSession = undefined;
  });
}

export {
  LEGACY_TODO_CONTEXT_MESSAGE_TYPE,
  LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
  MAX_PROGRESS_REASON_LENGTH,
  MAX_PROGRESS_STEPS,
  MAX_PROGRESS_TEXT_LENGTH,
  PROGRESS_CONTEXT_MESSAGE_TYPE,
  PROGRESS_CONTEXT_VERSION,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE,
  type ProgressDetails,
  type ProgressStep,
  reconcileProgressContext,
  TOOL_NAME,
  validateProgressArguments,
} from "./progress-state.js";
export { renderProgressWidget, sanitizeProgressText as sanitizeProgressStep };

function cloneDefaultSettings(): ProgressSettings {
  return { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget } };
}

function cloneSettings(value: Readonly<ProgressSettings>): ProgressSettings {
  return { widget: { ...value.widget } };
}
