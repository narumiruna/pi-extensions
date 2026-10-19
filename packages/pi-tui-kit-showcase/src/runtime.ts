import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type MenuCloseReason,
  runConfirmation,
  runDocumentReview,
  runLiveChoice,
  runMenu,
  runModelSelector,
  runMultiSelect,
  runQuestionnaire,
  runSecretInput,
  runTask,
  runThinkingSelector,
} from "@narumitw/pi-tui-kit";
import {
  appendLog,
  createInitialShowcaseState,
  createShowcaseMenu,
  type ShowcaseStandaloneInteraction,
  type ShowcaseState,
} from "./menu.js";

export interface ShowTuiKitShowcaseOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export async function showTuiKitShowcase(
  ctx: ExtensionCommandContext,
  options: ShowTuiKitShowcaseOptions,
): Promise<void> {
  const state = createInitialShowcaseState();
  let pendingStandalone: ShowcaseStandaloneInteraction | undefined;
  const menu = createShowcaseMenu({
    requestStandalone(interaction) {
      pendingStandalone = interaction;
    },
  });

  while (isCurrent(options)) {
    pendingStandalone = undefined;
    const result = await runMenu(ctx, menu, {
      getState: () => state,
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (_ctx, error) => {
        if (isCurrent(options)) notify(ctx, safeError(error), "error");
      },
      onUnsupportedMode: (_ctx, mode) => {
        notify(ctx, `Pi TUI Kit Showcase needs TUI mode and is unavailable in ${mode} mode.`, "warning");
      },
    });

    if (!pendingStandalone || result.kind !== "closed" || result.reason !== "close" || !isCurrent(options)) {
      return;
    }

    if (!(await runStandaloneInteraction(ctx, state, pendingStandalone, options))) return;
  }
}

async function runStandaloneInteraction(
  ctx: ExtensionCommandContext,
  state: ShowcaseState,
  interaction: ShowcaseStandaloneInteraction,
  options: ShowTuiKitShowcaseOptions,
): Promise<boolean> {
  const lifecycle = {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (_ctx: ExtensionCommandContext, error: unknown) => {
      if (isCurrent(options)) notify(ctx, safeError(error), "error");
    },
  };

  if (interaction === "task") {
    const result = await runTask(ctx, {
      ...lifecycle,
      label: "Running a short showcase task…",
      task: ({ signal }) => delay(250, signal),
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "completed") {
      appendLog(state, "Standalone task completed.");
      notify(ctx, "Showcase task completed.", "info");
    }
    return shouldReopen(result);
  }

  if (interaction === "confirmation") {
    const result = await runConfirmation(ctx, {
      ...lifecycle,
      title: "Confirm showcase action?",
      message: "This only writes an in-memory log line for the current demo session.",
      confirmLabel: "Record confirmation",
      cancelLabel: "Back",
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "confirmed") {
      appendLog(state, "Standalone confirmation accepted.");
      notify(ctx, "Confirmation recorded.", "info");
    } else if (result.kind === "closed") {
      appendLog(state, `Standalone confirmation closed with ${result.reason}.`);
    }
    return shouldReopen(result);
  }

  if (interaction === "documentReview") {
    const result = await runDocumentReview(ctx, {
      ...lifecycle,
      title: "Standalone document review",
      lines: ["Search this generated document. Confirmation only records an in-memory log line."],
      content: JSON.stringify({ demo: true, profile: state.profile, features: state.featureFlags }, null, 2),
      format: { kind: "code", language: "json" },
      viewportSize: "adaptive",
      enableSearch: true,
      confirmation: { label: "Record review" },
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "confirmed") {
      appendLog(state, "Standalone document review confirmed.");
      notify(ctx, "Document review recorded.", "info");
    }
    return shouldReopen(result);
  }

  if (interaction === "multiSelect") {
    const result = await runMultiSelect(ctx, {
      ...lifecycle,
      title: "Standalone multi-select",
      lines: ["Changes apply only after Apply demo. Back discards this selection."],
      items: [
        { id: "search", label: "Search field", selected: state.featureFlags.search, searchText: "filter query" },
        { id: "details", label: "Selected-row details", selected: state.featureFlags.details },
        { id: "bulk", label: "Bulk actions", selected: state.featureFlags.bulk },
        {
          id: "required",
          label: "Required demo feature",
          selected: true,
          disabled: true,
          disabledReason: "This feature stays selected.",
        },
      ],
      enableSearch: true,
      completionLabel: "Apply demo",
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "completed") {
      for (const feature of ["search", "details", "bulk"] as const) {
        state.featureFlags[feature] = result.selectedItemIds.includes(feature);
      }
      appendLog(state, "Standalone multi-select applied.");
      notify(ctx, "Demo feature selection applied.", "info");
    }
    return shouldReopen(result);
  }

  if (interaction === "secretInput") {
    const result = await runSecretInput(ctx, {
      ...lifecycle,
      title: "Demo secret — use sample text, not credentials",
      required: true,
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "submitted") {
      // Deliberately discard the value: even demo secrets must not reach logs or state.
      appendLog(state, "Masked demo input submitted and discarded.");
      notify(ctx, "Demo secret discarded.", "info");
    }
    return shouldReopen(result);
  }

  if (interaction === "modelSelector") {
    const result = await runModelSelector(ctx, {
      ...lifecycle,
      models: [
        { provider: "demo", id: "compact", name: "Demo Compact", searchText: "small" },
        { provider: "demo", id: "balanced", name: "Demo Balanced", searchText: "recommended" },
        { provider: "demo", id: "detailed", name: "Demo Detailed", searchText: "large" },
      ],
      currentModel: state.model,
      defaultModel: state.defaultModel,
      lines: ["Synthetic models only. Pi's active model and settings do not change."],
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "selected" || result.kind === "saveDefault") {
      state.model = result.model;
      if (result.kind === "saveDefault") state.defaultModel = result.model;
      appendLog(state, `Demo model ${result.kind}: ${result.model.id}.`);
    }
    return shouldReopen(result);
  }

  if (interaction === "thinkingSelector") {
    const result = await runThinkingSelector(ctx, {
      ...lifecycle,
      availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      currentLevel: state.thinkingLevel,
      defaultLevel: state.defaultThinkingLevel,
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "selected" || result.kind === "saveDefault") {
      state.thinkingLevel = result.level;
      if (result.kind === "saveDefault") state.defaultThinkingLevel = result.level;
      appendLog(state, `Demo thinking ${result.kind}: ${result.level}.`);
    }
    return shouldReopen(result);
  }

  if (interaction === "questionnaire") {
    const result = await runQuestionnaire(ctx, {
      ...lifecycle,
      questions: [
        {
          id: "layout",
          header: "Layout",
          prompt: "Which layout should this demo prefer?",
          options: [
            { label: "Compact", description: "Keep the presentation concise." },
            { label: "Spacious", description: "Leave more room for explanations." },
          ],
        },
        {
          id: "validation",
          header: "Validation",
          prompt: "How should the demo validate input?",
          options: [
            { label: "Strict", description: "Reject invalid input immediately." },
            { label: "Flexible", description: "Accept broader demonstration input." },
          ],
        },
      ],
      allowNotes: true,
      maxTextLength: 200,
    });
    if (!isCurrent(options)) return false;
    if (result.kind === "submitted") {
      appendLog(state, `Standalone questionnaire submitted ${result.answers.length} answers.`);
      notify(ctx, "Questionnaire submitted.", "info");
    } else if (result.kind === "closed") {
      appendLog(state, `Standalone questionnaire closed with ${result.reason}.`);
    }
    return shouldReopen(result);
  }

  const previousProfile = state.profile;
  const searchable = interaction === "liveChoiceSearch";
  const result = await runLiveChoice(ctx, {
    ...lifecycle,
    title: searchable ? "Searchable live choice" : "Live choice showcase",
    items: [
      { id: "Minimal", label: "Minimal", description: "Preview a compact profile", searchText: "small" },
      { id: "Balanced", label: "Balanced", description: "Preview the balanced default", searchText: "recommended" },
      { id: "Verbose", label: "Verbose", description: "Preview an annotated profile", searchText: "detailed" },
      { id: "Unavailable", label: "Unavailable", disabled: true, disabledReason: "Preview only; cannot apply." },
    ].map((item) => ({
      ...item,
      confirmationDisabled: item.id === previousProfile,
      confirmationDisabledReason:
        item.id === previousProfile ? "Already applied. Shortcuts remain available." : undefined,
    })),
    currentItemId: previousProfile,
    initialItemId: previousProfile,
    navigationLabel: "preview",
    confirmLabel: "apply profile",
    enableSearch: searchable,
    shortcuts: searchable ? [] : [{ id: "details", keys: ["d"], label: "note details" }],
    onSelectionChange: ({ item, signal }) => {
      if (!signal.aborted && isCurrent(options) && isShowcaseProfile(item.id)) state.profile = item.id;
    },
  });
  if (!isCurrent(options)) return false;

  if (result.kind === "selected" && isShowcaseProfile(result.itemId)) {
    state.profile = result.itemId;
    appendLog(state, `Live choice applied ${result.itemId}.`);
    notify(ctx, `Applied ${result.itemId}.`, "info");
  } else {
    state.profile = previousProfile;
    if (result.kind === "shortcut") appendLog(state, `Live choice shortcut ${result.shortcutId}.`);
    else if (result.kind === "closed") appendLog(state, `Live choice closed with ${result.reason}.`);
  }
  return shouldReopen(result);
}

function isCurrent(options: ShowTuiKitShowcaseOptions): boolean {
  return !options.signal.aborted && options.isCurrent();
}

function shouldReopen(result: { kind: string; reason?: MenuCloseReason }): boolean {
  return result.kind !== "stale" && result.reason !== "close";
}

function notify(ctx: ExtensionCommandContext, message: string, level: "error" | "info" | "warning") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Task was cancelled."));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Task was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isShowcaseProfile(value: string): value is ShowcaseState["profile"] {
  return value === "Minimal" || value === "Balanced" || value === "Verbose";
}
