import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createProgressPresentation, type ProgressPresentation, WIDGET_KEY } from "./progress-presentation.js";
import { renderProgressWidget, sanitizeProgressText } from "./progress-renderer.js";

export { COMPLETION_SUMMARY_MS, WIDGET_KEY } from "./progress-presentation.js";

import { showProgressSettings } from "./progress-settings-ui.js";
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
  prepareProgressArguments,
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
  progressSettingsPath,
  saveProgressSettings,
} from "./settings.js";

export interface ProgressWidgetDependencies {
  loadSettings?: typeof loadProgressSettings;
  saveSettings?: typeof saveProgressSettings;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type CyclePhase = "idle" | "maintenance" | "unconfirmed" | "auto-preparing" | "preparing" | "running";

export default function progressWidgetExtension(pi: ExtensionAPI, dependencies: ProgressWidgetDependencies = {}): void {
  const readSettings = dependencies.loadSettings ?? loadProgressSettings;
  const writeSettings = dependencies.saveSettings ?? saveProgressSettings;
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let presentation: ProgressPresentation | undefined;
  let steps: ProgressStep[] = [];
  let settings = cloneDefaultSettings();
  let restoredBoundary: { summaryEpoch: string; content: string } | undefined;
  let settingsController = new AbortController();
  let controlsController = new AbortController();
  let displayGeneration = 0;
  let cyclePhase: CyclePhase = "idle";
  let cycleFailed = false;
  let settingsReady = false;
  let settingsScreenOpen = false;
  const settingsTasks = new Set<Promise<void>>();
  let generation = 0;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const disposePresentation = (): void => {
    try {
      // Clear the exact key before invalidating its owner, even when UI cleanup fails.
      presentation?.dispose();
    } finally {
      presentation = undefined;
      displayGeneration += 1;
    }
  };

  const releaseSession = (): void => {
    try {
      disposePresentation();
    } finally {
      settingsController.abort();
      controlsController.abort();
      settingsReady = false;
      settingsScreenOpen = false;
      generation += 1;
      steps = [];
      settings = cloneDefaultSettings();
      restoredBoundary = undefined;
      activeSession = undefined;
      cyclePhase = "idle";
      cycleFailed = false;
    }
  };

  const publish = (ctx: ExtensionContext): void => {
    if (ownsSession(ctx)) presentation?.update(steps, settings);
  };

  const finishCycle = (eligible: boolean): void => {
    try {
      presentation?.view.settled(eligible);
    } finally {
      cyclePhase = "idle";
      cycleFailed = false;
    }
  };

  const startCycle = (phase: Exclude<CyclePhase, "idle" | "maintenance">): void => {
    if (cyclePhase === "idle" || cyclePhase === "maintenance") cycleFailed = false;
    cyclePhase = phase;
    presentation?.view.agentStarted();
  };

  const syncActiveCycle = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx)) return;
    if (ctx.isIdle()) {
      // Preparation and maintenance can end without agent_settled.
      if (cyclePhase !== "idle" && cyclePhase !== "running") finishCycle(false);
    } else if (cyclePhase === "idle" || cyclePhase === "maintenance") {
      // An earlier extension can still hold before_agent_start. Keep this
      // provisional exclusion until a public run or maintenance hook identifies it.
      startCycle(ctx.signal === undefined ? "unconfirmed" : "running");
    }
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Progress",
    description:
      "Replace the current session progress state with the complete supplied steps using update_progress. Keep at most one step in_progress; send an empty steps array only to intentionally clear the state.",
    promptSnippet: "Show users what has been done, what is happening now, and what is planned next",
    promptGuidelines: [
      "Use update_progress for multi-step work when meaningful progress changes; skip simple tasks and avoid redundant updates.",
      "Report actual progress. Use blocked when work depends on an external action or condition, include what is needed to continue in the step text, and do not mark blocked work completed.",
      "Progress reporting does not prescribe the workflow or require tool calls before work or replies.",
    ],
    parameters: ProgressParameters,
    prepareArguments: prepareProgressArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ownsSession(ctx)) {
        throw new Error("Cannot update progress because the session changed.");
      }
      const nextSteps = validateProgressArguments(params).steps;
      const wasComplete = allProgressCompleted(steps);
      presentation?.showOnUpdate();
      steps = cloneProgressSteps(nextSteps);
      const becameComplete = steps.length > 0 && allProgressCompleted(steps) && !wasComplete;
      presentation?.update(steps, settings, becameComplete);

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

  const openSettings = async (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<"back" | "close" | "stale"> => {
    if (signal.aborted || !isCurrent()) return "stale";
    if (ctx.mode !== "tui") {
      ctx.ui.notify(sanitizeProgressText(`Edit settings manually: ${progressSettingsPath()}; then /reload.`), "info");
      return "back";
    }
    return showProgressSettings(ctx, {
      signal,
      isCurrent,
      get: () => cloneSettings(settings),
      save: (patch, ownedSignal) => writeSettings(patch, undefined, ownedSignal),
      apply: (next) => {
        // A committed save still applies after the interaction closes, not after owner replacement.
        if (!isCurrent()) return;
        settings = cloneSettings(next);
        publish(ctx);
      },
    });
  };

  const hideWidget = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx)) return;
    presentation?.clear();
    ctx.ui.notify("Progress widget cleared. Saved progress is unchanged.", "info");
  };

  pi.registerCommand("progress", {
    description: "Manage the progress widget",
    getArgumentCompletions: (prefix) => {
      const matches = [
        { value: "clear", label: "clear", description: "Hide the widget without changing saved progress" },
        { value: "settings", label: "settings", description: "Configure progress display settings" },
      ].filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/progress requires TUI or RPC mode.");
      const route = args.trim();
      if (route !== "" && route !== "clear" && route !== "settings") {
        ctx.ui.notify("Usage: /progress | /progress clear | /progress settings", "warning");
        return;
      }
      if (!ownsSession(ctx)) {
        ctx.ui.notify("Cannot manage progress because the session changed.", "warning");
        return;
      }
      if (route === "clear") {
        hideWidget(ctx);
        return;
      }
      if (!settingsReady || settingsScreenOpen) {
        ctx.ui.notify("Progress controls are loading or already open.", "warning");
        return;
      }
      settingsScreenOpen = true;
      const ownerGeneration = generation;
      const ownerDisplay = displayGeneration;
      const ownerSignal = controlsController.signal;
      const isCurrent = () =>
        displayGeneration === ownerDisplay &&
        generation === ownerGeneration &&
        !ownerSignal.aborted &&
        ownsSession(ctx);
      const task = (async () => {
        if (route === "settings") {
          await openSettings(ctx, ownerSignal, isCurrent);
          return;
        }
        const { showProgressMenu } = await import("./progress-menu.js");
        if (!isCurrent()) return;
        await showProgressMenu(ctx, {
          signal: ownerSignal,
          isCurrent,
          getState: () => ({
            settings: cloneSettings(settings),
            settingsPath: progressSettingsPath(),
            widget: !settings.enabled
              ? "disabled"
              : presentation?.hidden
                ? "hidden"
                : steps.length === 0
                  ? "empty"
                  : "visible",
            view: presentation?.view.mode ?? "default",
            pinned: presentation?.view.pinned ?? false,
            trigger: presentation?.view.trigger ?? "manual",
            items: presentation?.items() ?? [],
            total: steps.length,
            completed: steps.filter((step) => step.status === "completed").length,
            inProgress: steps.filter((step) => step.status === "in_progress").length,
            blocked: steps.filter((step) => step.status === "blocked").length,
          }),
          hideWidget: () => {
            if (isCurrent()) hideWidget(ctx);
          },
          showSettings: (signal) => openSettings(ctx, signal, isCurrent),
          setView: (mode) => {
            if (isCurrent()) presentation?.show(mode);
          },
          setPinned: (pinned) => {
            if (isCurrent()) presentation?.view.setPinned(pinned);
          },
          setTrigger: (trigger) => {
            if (!isCurrent()) return;
            syncActiveCycle(ctx);
            presentation?.view.setTrigger(trigger);
          },
          item: (id) => (isCurrent() ? presentation?.item(id) : undefined),
          refresh: () => {
            if (isCurrent()) presentation?.refresh();
          },
        });
      })();
      settingsTasks.add(task);
      try {
        await task;
      } finally {
        settingsTasks.delete(task);
        if (isCurrent()) settingsScreenOpen = false;
      }
    },
  });

  const restoreBranchState = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    steps = reconstructProgress(branch);
    restoredBoundary = reconstructRestoredProgressBoundary(branch);
  };

  pi.on("session_start", async (_event, ctx) => {
    // A failed old-owner clear invalidates pending reads but must not acquire new UI.
    releaseSession();
    controlsController = new AbortController();
    settingsController = new AbortController();
    const ownerController = settingsController;
    const ownerGeneration = generation;
    activeSession = ctx.sessionManager;
    // Clear leftovers at owner acquisition, not on ordinary publications.
    if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc")) ctx.ui.setWidget(WIDGET_KEY, undefined);
    cyclePhase = ctx.signal === undefined ? "idle" : "running";
    cycleFailed = false;
    settings = cloneDefaultSettings();
    restoreBranchState(ctx);
    const ownerDisplay = displayGeneration;
    presentation = createProgressPresentation({
      context: ctx,
      isCurrent: () => displayGeneration === ownerDisplay && ownsSession(ctx),
      settings,
      setTimeout: scheduleTimeout,
      clearTimeout: cancelTimeout,
    });
    // Do not publish defaults before the settings read completes.
    presentation.reset(steps, true, false);
    if (cyclePhase !== "idle") presentation.view.agentStarted();

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
    // Startup can attach after agent_start, or a run can begin while settings
    // load. Seed the current cycle before a user can arm a "future cycle" rule.
    syncActiveCycle(ctx);
    settings = cloneSettings(loaded.settings);
    settingsReady = true;
    if (loaded.kind === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        sanitizeProgressText(`Invalid progress settings at ${loaded.path}; using defaults. ${loaded.issue}`),
        "warning",
      );
    }
    publish(ctx);
  });

  // A cycle spans retries and queued continuations until agent_settled. Input
  // submission is not consumption; custom messages are not user-role messages.
  pi.on("before_agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    // This hook starts a new high-level run. Only its earlier automatic
    // compaction belongs to the same preparation; an unfinished prior run does not.
    if (cyclePhase !== "auto-preparing" && cyclePhase !== "unconfirmed") finishCycle(false);
    startCycle("preparing");
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!ownsSession(ctx)) return;
    if (event.reason === "manual") {
      finishCycle(false);
      cyclePhase = "maintenance";
    } else {
      if (cyclePhase === "preparing" || cyclePhase === "maintenance") finishCycle(false);
      if (cyclePhase === "idle" || cyclePhase === "unconfirmed") startCycle("auto-preparing");
    }
  });
  pi.on("session_before_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    finishCycle(false);
    cyclePhase = "maintenance";
  });
  pi.on("input", (_event, ctx) => {
    // Observe idle recovery only. Input is not accepted-message evidence.
    if (ownsSession(ctx) && ctx.isIdle()) finishCycle(false);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ownsSession(ctx)) startCycle("running");
  });
  pi.on("message_start", (event, ctx) => {
    if (ownsSession(ctx) && event.message.role === "user") presentation?.view.userMessage();
  });
  pi.on("message_end", (event, ctx) => {
    if (ownsSession(ctx) && event.message.role === "assistant") {
      cycleFailed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    }
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!ownsSession(ctx)) return;
    finishCycle(!event.aborted && !cycleFailed);
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
    finishCycle(false);
    cyclePhase = "maintenance";
    // Abort menus before resetting handles and the branch presentation generation.
    controlsController.abort();
    try {
      disposePresentation();
    } catch (error) {
      // Failed branch cleanup cannot retain a startup read tied to the old context.
      settingsController.abort();
      generation += 1;
      throw error;
    } finally {
      settingsScreenOpen = false;
    }
    controlsController = new AbortController();
    const ownerDisplay = displayGeneration;
    restoreBranchState(ctx);
    presentation = createProgressPresentation({
      context: ctx,
      isCurrent: () => displayGeneration === ownerDisplay && ownsSession(ctx),
      settings,
      setTimeout: scheduleTimeout,
      clearTimeout: cancelTimeout,
    });
    presentation.reset(steps, false, settingsReady);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    const failures: unknown[] = [];
    try {
      releaseSession();
    } catch (error) {
      failures.push(error);
    }
    // Ignored cancellation can leave persistence or a menu pending. Join it even
    // after display cleanup fails, then report every failure to the lifecycle caller.
    const results = await Promise.allSettled([...settingsTasks]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Progress shutdown failed");
  });
}

export {
  LEGACY_TODO_CONTEXT_MESSAGE_TYPE,
  LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
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
  return { ...DEFAULT_PROGRESS_SETTINGS };
}

function cloneSettings(value: Readonly<ProgressSettings>): ProgressSettings {
  return { ...value };
}
