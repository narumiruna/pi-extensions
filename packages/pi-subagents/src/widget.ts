import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createEditorStatusCollection,
  type EditorStatusCollection,
  type EditorStatusItemHandle,
} from "@narumitw/pi-tui-kit/editor-status-collection";
import { createEditorStatusPublisher, type EditorStatusPublisher } from "@narumitw/pi-tui-kit/editor-status-publisher";
import {
  createEditorStatusView,
  type EditorStatusMode,
  type EditorStatusTrigger,
  type EditorStatusView,
} from "@narumitw/pi-tui-kit/editor-status-view";
import type { ActiveJobDisplay, SubagentRuntime } from "./runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./settings.js";
import {
  renderSubagentWidgetSnapshot,
  type SubagentWidgetSnapshot,
  subagentWidgetRowBudget,
} from "./widget-renderer.js";

export { renderSubagentWidget } from "./widget-renderer.js";
export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_WIDGET_REFRESH_INTERVAL_MS = 1_000;

export interface SubagentWidgetControls {
  state(): { mode: EditorStatusMode; pinned: boolean; trigger: EditorStatusTrigger };
  setMode(mode: EditorStatusMode): void;
  setPinned(pinned: boolean): void;
  setTrigger(trigger: EditorStatusTrigger): void;
  resetItems(): void;
  item(jobId: string): EditorStatusItemHandle | undefined;
}

export type SubagentCyclePhase = "idle" | "maintenance" | "unconfirmed" | "auto-preparing" | "preparing" | "running";

export interface SubagentWidgetController {
  start(ctx: ExtensionContext, settings?: SubagentSettings, phase?: SubagentCyclePhase): void;
  update(ctx: ExtensionContext, settings: SubagentSettings): void;
  shutdown(ctx: ExtensionContext): void;
  controls(ctx: ExtensionContext): SubagentWidgetControls | undefined;
  preparing(ctx: ExtensionContext): void;
  automaticCompaction(ctx: ExtensionContext): void;
  clearCycle(ctx: ExtensionContext): void;
  maintenance(ctx: ExtensionContext): void;
  agentStarted(ctx: ExtensionContext): void;
  userMessage(ctx: ExtensionContext): void;
  turnEnded(ctx: ExtensionContext, stopReason: string): void;
  settled(ctx: ExtensionContext, aborted: boolean): void;
}

function createCollection(): EditorStatusCollection<ActiveJobDisplay> {
  return createEditorStatusCollection({
    maxItems: 8, // Runtime accepts at most eight active jobs.
    // 50 KiB task + 64 tool names (128 UTF-16 units each) + 16 KiB model selection, plus metadata.
    maxContentSize: 128 * 1024,
    measure: (job) =>
      Buffer.byteLength(
        [job.jobId, job.task, job.provider ?? "", job.model ?? "", job.thinkingLevel, ...job.tools].join("\0"),
        "utf8",
      ) + 128,
  });
}

export function createSubagentWidgetController(runtime: SubagentRuntime): SubagentWidgetController {
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeJobs: (() => void) | undefined;
  let publisher: EditorStatusPublisher<SubagentWidgetSnapshot> | undefined;
  let collection: EditorStatusCollection<ActiveJobDisplay> | undefined;
  let view: EditorStatusView | undefined;
  let controls: SubagentWidgetControls | undefined;
  let jobs: readonly ActiveJobDisplay[] = [];
  let publishedValue: string | undefined;
  let cyclePhase: SubagentCyclePhase = "idle";
  let lastOutcome: string | undefined;
  let settings = { ...DEFAULT_SUBAGENT_SETTINGS };

  const ownsSession = (ctx: ExtensionContext): boolean =>
    activeSession !== undefined && ctx.sessionManager === activeSession;
  const stop = (errors: unknown[] = []): void => {
    try {
      for (const release of [
        () => {
          if (refreshTimer) clearInterval(refreshTimer);
        },
        () => unsubscribeJobs?.(),
        () => view?.dispose(),
        () => collection?.dispose(),
        // The publisher must still own its key when it attempts to clear it.
        () => publisher?.dispose(),
      ]) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      generation++;
      activeSession = undefined;
      refreshTimer = undefined;
      unsubscribeJobs = undefined;
      view = undefined;
      collection = undefined;
      publisher = undefined;
      controls = undefined;
      jobs = [];
      publishedValue = undefined;
      cyclePhase = "idle";
      lastOutcome = undefined;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Subagent widget cleanup failed");
  };

  const publish = (): void => {
    if (!view || !collection || !publisher) return;
    const items = collection.snapshot();
    const value = JSON.stringify([settings, view.mode, jobs, items]);
    if (value === publishedValue) return;
    publisher.publish(
      settings.showWidget && view.mode !== "hidden" && items.length > 0
        ? { jobs, items, settings: { ...settings }, mode: view.mode }
        : undefined,
    );
    publishedValue = value;
  };
  const refresh = (): void => {
    if (!view || !collection) return;
    const next = runtime.activeJobsForDisplay().map((job) => ({ ...job, tools: [...job.tools] }));
    const entries = next.map((job) => ({ id: job.jobId, value: job, revision: semanticRevision(job) }));
    // Capacity validation is atomic; do not change the published owner snapshot on failure.
    collection.replace(entries);
    jobs = next;
    view.revision(JSON.stringify(entries.map(({ id, revision }) => [id, revision])));
    publish();
  };

  const finishCycle = (eligible: boolean): void => {
    try {
      view?.settled(eligible);
    } finally {
      cyclePhase = "idle";
      lastOutcome = undefined;
    }
  };
  const startCycle = (phase: Exclude<SubagentCyclePhase, "idle" | "maintenance">): void => {
    if (cyclePhase === "idle" || cyclePhase === "maintenance") lastOutcome = undefined;
    cyclePhase = phase;
    view?.agentStarted();
  };
  const syncActiveCycle = (ctx: ExtensionContext): void => {
    if (ctx.isIdle()) {
      if (cyclePhase !== "idle" && cyclePhase !== "running") finishCycle(false);
    } else if (cyclePhase === "idle" || cyclePhase === "maintenance") {
      // Earlier extension handlers can hold preparation before this owner sees
      // it. Public maintenance hooks or positive idle discard this provisional cycle.
      startCycle(ctx.signal === undefined ? "unconfirmed" : "running");
    }
  };

  return {
    start(ctx, preferences = DEFAULT_SUBAGENT_SETTINGS, phase = "idle") {
      // Dispose while the old publisher still owns its key, then transfer ownership.
      stop();
      const token = generation;
      const isCurrent = () => token === generation && ownsSession(ctx);
      try {
        activeSession = ctx.sessionManager;
        settings = { ...preferences };
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        collection = createCollection();
        view = createEditorStatusView({ onChange: publish, canCompact: () => settings.showWidget && jobs.length > 0 });
        publisher = createEditorStatusPublisher({
          key: SUBAGENT_WIDGET_KEY,
          context: ctx,
          isCurrent,
          render: (snapshot, theme, width, rows) =>
            renderSubagentWidgetSnapshot(snapshot, theme, width, subagentWidgetRowBudget(rows)),
        });
        // The owner records public preparation/run hooks while settings load.
        // General busy state also includes navigation and manual compaction.
        if (phase === "maintenance") cyclePhase = phase;
        else if (phase !== "idle") startCycle(phase);
        syncActiveCycle(ctx);
        const ownedView = view;
        controls = {
          state: () => ({ mode: ownedView.mode, pinned: ownedView.pinned, trigger: ownedView.trigger }),
          setMode: (mode) => {
            if (isCurrent()) ownedView.setMode(mode);
          },
          setPinned: (pinned) => {
            if (isCurrent()) ownedView.setPinned(pinned);
          },
          setTrigger: (trigger) => {
            if (!isCurrent()) return;
            syncActiveCycle(ctx);
            ownedView.setTrigger(trigger);
          },
          resetItems() {
            if (!isCurrent()) return;
            collection?.dispose();
            collection = createCollection();
            refresh();
          },
          item(jobId) {
            if (!isCurrent()) return undefined;
            const handle = collection?.item(jobId);
            if (!handle) return undefined;
            const apply = (action: "compact" | "expand" | "remove") => {
              if (!isCurrent() || !handle[action]()) return false;
              publish();
              return true;
            };
            return { compact: () => apply("compact"), expand: () => apply("expand"), remove: () => apply("remove") };
          },
        };
        unsubscribeJobs = runtime.subscribeJobs(() => {
          if (isCurrent()) refresh();
        });
        refreshTimer = setInterval(() => {
          if (isCurrent()) refresh();
        }, SUBAGENT_WIDGET_REFRESH_INTERVAL_MS);
        refreshTimer.unref();
        refresh();
      } catch (error) {
        stop([error]);
      }
    },
    update(ctx, preferences) {
      if (!ownsSession(ctx)) return;
      settings = { ...preferences };
      if (ctx.mode === "tui") refresh();
    },
    shutdown(ctx) {
      if (!ownsSession(ctx)) return;
      stop();
    },
    controls(ctx) {
      return ownsSession(ctx) && ctx.mode === "tui" ? controls : undefined;
    },
    preparing(ctx) {
      if (!ownsSession(ctx) || !view) return;
      // A new preparation closes a failed prior preparation without consuming
      // the rule. Earlier automatic compaction is part of this same run.
      if (cyclePhase !== "auto-preparing" && cyclePhase !== "unconfirmed") finishCycle(false);
      startCycle("preparing");
    },
    automaticCompaction(ctx) {
      if (!ownsSession(ctx) || !view) return;
      if (cyclePhase === "preparing" || cyclePhase === "maintenance") finishCycle(false);
      if (cyclePhase === "idle" || cyclePhase === "unconfirmed") startCycle("auto-preparing");
    },
    clearCycle(ctx) {
      if (ownsSession(ctx)) finishCycle(false);
    },
    maintenance(ctx) {
      if (!ownsSession(ctx)) return;
      finishCycle(false);
      cyclePhase = "maintenance";
    },
    agentStarted(ctx) {
      if (ownsSession(ctx) && view) startCycle("running");
    },
    userMessage(ctx) {
      if (ownsSession(ctx)) view?.userMessage();
    },
    turnEnded(ctx, stopReason) {
      if (ownsSession(ctx) && cyclePhase !== "idle" && cyclePhase !== "maintenance") lastOutcome = stopReason;
    },
    settled(ctx, aborted) {
      if (!ownsSession(ctx) || !view) return;
      // A non-aborted idle boundary alone does not establish a successful response.
      const eligible = !aborted && lastOutcome !== undefined && lastOutcome !== "error" && lastOutcome !== "aborted";
      finishCycle(eligible);
    },
  };
}

function semanticRevision(job: ActiveJobDisplay): string {
  const { elapsedMs: _elapsedMs, ...semantic } = job;
  return JSON.stringify(semantic);
}
