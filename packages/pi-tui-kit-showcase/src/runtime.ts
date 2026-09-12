import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runConfirmation, runLiveChoice, runMenu, runQuestionnaire, runTask } from "@narumitw/pi-tui-kit";
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

  while (!options.signal.aborted && options.isCurrent()) {
    pendingStandalone = undefined;
    const result = await runMenu(ctx, menu, {
      getState: () => state,
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (_ctx, error) => notify(ctx, safeError(error), "error"),
      onUnsupportedMode: (_ctx, mode) => {
        notify(ctx, `Pi TUI Kit Showcase needs TUI mode and is unavailable in ${mode} mode.`, "warning");
      },
    });

    if (
      !pendingStandalone ||
      result.kind !== "closed" ||
      result.reason !== "close" ||
      options.signal.aborted ||
      !options.isCurrent()
    ) {
      return;
    }

    await runStandaloneInteraction(ctx, state, pendingStandalone, options);
  }
}

async function runStandaloneInteraction(
  ctx: ExtensionCommandContext,
  state: ShowcaseState,
  interaction: ShowcaseStandaloneInteraction,
  options: ShowTuiKitShowcaseOptions,
): Promise<void> {
  if (interaction === "task") {
    const result = await runTask(ctx, {
      label: "Running a short showcase task…",
      signal: options.signal,
      isCurrent: options.isCurrent,
      task: ({ signal }) => delay(250, signal),
      onError: (_ctx, error) => notify(ctx, safeError(error), "error"),
    });
    if (options.signal.aborted || !options.isCurrent()) return;
    if (result.kind === "completed") {
      appendLog(state, "Standalone task completed.");
      notify(ctx, "Showcase task completed.", "info");
    }
    return;
  }

  if (interaction === "confirmation") {
    const result = await runConfirmation(ctx, {
      title: "Confirm showcase action?",
      message: "This only writes an in-memory log line for the current demo session.",
      confirmLabel: "Record confirmation",
      cancelLabel: "Back",
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (_ctx, error) => notify(ctx, safeError(error), "error"),
    });
    if (options.signal.aborted || !options.isCurrent()) return;
    if (result.kind === "confirmed") {
      appendLog(state, "Standalone confirmation accepted.");
      notify(ctx, "Confirmation recorded.", "info");
    } else if (result.kind === "closed") {
      appendLog(state, `Standalone confirmation closed with ${result.reason}.`);
    }
    return;
  }

  if (interaction === "questionnaire") {
    const result = await runQuestionnaire(ctx, {
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
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (_ctx, error) => notify(ctx, safeError(error), "error"),
    });
    if (options.signal.aborted || !options.isCurrent()) return;
    if (result.kind === "submitted") {
      appendLog(state, `Standalone questionnaire submitted ${result.answers.length} answers.`);
      notify(ctx, "Questionnaire submitted.", "info");
    } else if (result.kind === "closed") {
      appendLog(state, `Standalone questionnaire closed with ${result.reason}.`);
    }
    return;
  }

  const previousProfile = state.profile;
  const result = await runLiveChoice(ctx, {
    title: "Live choice showcase",
    items: [
      { id: "Minimal", label: "Minimal", description: "Preview a compact profile" },
      { id: "Balanced", label: "Balanced", description: "Preview the balanced default" },
      { id: "Verbose", label: "Verbose", description: "Preview an annotated profile" },
    ],
    currentItemId: state.profile,
    initialItemId: state.profile,
    navigationLabel: "preview",
    confirmLabel: "apply profile",
    shortcuts: [{ id: "details", keys: ["d"], label: "note details" }],
    signal: options.signal,
    isCurrent: options.isCurrent,
    onSelectionChange: ({ item, signal }) => {
      if (!signal.aborted && isShowcaseProfile(item.id)) state.profile = item.id;
    },
    onError: (_ctx, error) => notify(ctx, safeError(error), "error"),
  });
  if (options.signal.aborted || !options.isCurrent()) return;

  if (result.kind === "selected" && isShowcaseProfile(result.itemId)) {
    state.profile = result.itemId;
    appendLog(state, `Live choice applied ${result.itemId}.`);
    notify(ctx, `Applied ${result.itemId}.`, "info");
    return;
  }

  state.profile = previousProfile;
  if (result.kind === "shortcut") appendLog(state, `Live choice shortcut ${result.shortcutId}.`);
  else if (result.kind === "closed") appendLog(state, `Live choice closed with ${result.reason}.`);
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
