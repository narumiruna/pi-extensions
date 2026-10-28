import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditorStatusCollection } from "@narumitw/pi-tui-kit/editor-status-collection";
import { createEditorStatusPublisher } from "@narumitw/pi-tui-kit/editor-status-publisher";
import { createEditorStatusView } from "@narumitw/pi-tui-kit/editor-status-view";
import { renderCompletionSummary, renderProgressWidget, widgetRowBudget } from "./progress-renderer.js";
import {
  allProgressCompleted,
  cloneProgressSteps,
  MAX_PROGRESS_STEPS,
  MAX_PROGRESS_TEXT_LENGTH,
  type ProgressStep,
  progressTextLength,
} from "./progress-state.js";
import type { ProgressSettings } from "./settings.js";

export const COMPLETION_SUMMARY_MS = 3_000;
export const WIDGET_KEY = "progress";

/** Raw text plus its duplicate occurrence is a presentation identity, not a model-visible ID. */
export function progressDisplayItems(steps: readonly ProgressStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((value) => {
    const occurrence = occurrences.get(value.text) ?? 0;
    occurrences.set(value.text, occurrence + 1);
    return { id: JSON.stringify([value.text, occurrence]), value, revision: JSON.stringify(value) };
  });
}

function newCollection() {
  return createEditorStatusCollection<ProgressStep>({
    maxItems: MAX_PROGRESS_STEPS,
    // The schema bounds grapheme clusters, not bytes or UTF-16 code units. Count
    // the same clusters here; a long combining sequence remains valid model data.
    maxContentSize: MAX_PROGRESS_TEXT_LENGTH,
    measure: (step) => progressTextLength(step.text),
  });
}

export function createProgressPresentation(options: {
  context: ExtensionContext;
  isCurrent(): boolean;
  settings: Readonly<ProgressSettings>;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}) {
  let settings = { ...options.settings };
  let steps: ProgressStep[] = [];
  let collection = newCollection();
  let revision = "";
  let disposed = false;
  let hidden = false;
  let completion = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let timerToken = 0;
  const current = () => !disposed && options.isCurrent();
  const cancelTimer = () => {
    timerToken++;
    if (timer !== undefined) options.clearTimeout(timer);
    timer = undefined;
  };
  type Snapshot = {
    steps: ProgressStep[];
    settings: ProgressSettings;
    items: ReturnType<typeof collection.snapshot>;
    mode: typeof view.mode;
    completion: boolean;
  };
  const publisher = createEditorStatusPublisher<Snapshot>({
    key: WIDGET_KEY,
    context: options.context,
    isCurrent: current,
    render: (snapshot, theme, width, rows) => {
      const terminalRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 36;
      const maxRows = Math.min(terminalRows, widgetRowBudget(terminalRows));
      if (snapshot.completion && snapshot.mode === "default") {
        return renderCompletionSummary(snapshot.steps.length, theme, width, maxRows);
      }
      return renderProgressWidget(snapshot.steps, theme, width, {
        settings: snapshot.settings,
        terminalRows: rows,
        maxRows,
        viewMode: snapshot.mode,
        items: snapshot.items,
      });
    },
  });
  let lastSnapshot: Snapshot | undefined;
  let lastFingerprint: string | undefined;
  const publish = () => {
    if (!current()) return;
    const items = collection.snapshot();
    if (!settings.enabled || hidden || view.mode === "hidden" || steps.length === 0 || items.length === 0) {
      lastSnapshot = undefined;
      lastFingerprint = undefined;
      publisher.publish(undefined);
      return;
    }
    const fingerprint = JSON.stringify([revision, settings, items, view.mode, completion]);
    if (lastFingerprint !== fingerprint) {
      lastSnapshot = {
        steps: cloneProgressSteps(steps),
        settings: { ...settings },
        items,
        mode: view.mode,
        completion,
      };
      lastFingerprint = fingerprint;
    }
    // Reuse immutable snapshots for no-op updates, but let a host-disposed
    // publisher remount even if the display content has not changed.
    publisher.publish(lastSnapshot);
  };
  const startTimer = () => {
    cancelTimer();
    if (
      !current() ||
      !options.context.hasUI ||
      (options.context.mode !== "tui" && options.context.mode !== "rpc") ||
      !completion ||
      hidden ||
      view.pinned ||
      !settings.enabled ||
      view.mode === "hidden"
    )
      return;
    const token = timerToken;
    const completedRevision = revision;
    timer = options.setTimeout(() => {
      if (
        !current() ||
        token !== timerToken ||
        completedRevision !== revision ||
        view.pinned ||
        !allProgressCompleted(steps)
      )
        return;
      timer = undefined;
      hidden = true;
      publish();
    }, COMPLETION_SUMMARY_MS);
  };
  let lastPinned = false;
  const view = createEditorStatusView({
    canCompact: () =>
      current() && settings.enabled && steps.length > 0 && !steps.some((step) => step.status === "blocked"),
    onChange: () => {
      if (!current()) return;
      const pinChanged = lastPinned !== view.pinned;
      lastPinned = view.pinned;
      if (pinChanged) startTimer();
      publish();
    },
  });

  return {
    view,
    get hidden() {
      return hidden || view.mode === "hidden" || (steps.length > 0 && collection.snapshot().length === 0);
    },
    items: () => collection.snapshot(),
    item: (id: string) => collection.item(id),
    refresh: publish,
    update(next: readonly ProgressStep[], nextSettings: Readonly<ProgressSettings>, becameComplete = false) {
      if (!current()) return;
      const nextRevision = JSON.stringify(next);
      const changed = revision !== nextRevision;
      const enabledChanged = settings.enabled !== nextSettings.enabled;
      // Validate the complete collection before changing any effective state.
      if (changed) collection.replace(progressDisplayItems(cloneProgressSteps(next)));
      settings = { ...nextSettings };
      if (changed) {
        steps = cloneProgressSteps(next);
        revision = nextRevision;
        view.revision(revision);
        completion = allProgressCompleted(steps) && (becameComplete || completion);
        hidden = false;
        startTimer();
      } else if (enabledChanged) {
        startTimer();
      }
      publish();
    },
    // Compatibility clear is transient; unlike manual view hide, a tool update
    // (including an identical snapshot) can show the saved data again.
    showOnUpdate() {
      if (!current()) return;
      if (hidden) completion = false;
      hidden = false;
    },
    clear() {
      if (!current()) return;
      cancelTimer();
      completion = false;
      hidden = true;
      publish();
    },
    show(mode: "default" | "expanded" | "compact" | "hidden") {
      if (!current()) return;
      hidden = false;
      view.setMode(mode);
      if (mode === "hidden") cancelTimer();
      else if (completion && timer === undefined) startTimer();
      publish();
    },
    reset(next: readonly ProgressStep[], hideCompleted = false, publishNow = true) {
      if (!current()) return;
      cancelTimer();
      completion = false;
      collection.dispose();
      collection = newCollection();
      steps = cloneProgressSteps(next);
      revision = JSON.stringify(steps);
      collection.replace(progressDisplayItems(steps));
      hidden = hideCompleted && allProgressCompleted(steps);
      view.reset();
      view.revision(revision);
      lastPinned = false;
      if (publishNow) publish();
    },
    dispose() {
      if (disposed) return;
      try {
        cancelTimer();
        view.dispose();
        collection.dispose();
        // Dispose the publisher while its owner generation still owns the key.
        publisher.dispose();
      } finally {
        // A failed UI clear must not leave callbacks or public methods live.
        disposed = true;
      }
    },
  };
}

export type ProgressPresentation = ReturnType<typeof createProgressPresentation>;
