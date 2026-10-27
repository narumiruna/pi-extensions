import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runConfirmation, runMenu, runTask, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { EditorStatusItemHandle } from "@narumitw/pi-tui-kit/editor-status-collection";
import type { SubagentSettings } from "./settings.js";
import { JOB_STATES, type JobSummary } from "./types.js";
import type { SubagentWidgetControls } from "./widget.js";

interface SubagentsMenuState {
  settings: SubagentSettings;
  settingsPath: string;
  jobs: JobSummary[];
  omitted: number;
}

interface SubagentsMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getState(): SubagentsMenuState;
  cancelJob(jobId: string, signal: AbortSignal): Promise<void>;
  showSettings(signal: AbortSignal): Promise<"back" | "close" | "stale">;
  widget?: SubagentWidgetControls;
}

export async function showSubagentsMenu(ctx: ExtensionCommandContext, options: SubagentsMenuOptions): Promise<void> {
  if (options.signal.aborted || !options.isCurrent()) return;
  let selectedJobId: string | undefined;
  let selectedItem: EditorStatusItemHandle | undefined;
  const widget = ctx.mode === "tui" ? options.widget : undefined;
  const current = (signal: AbortSignal) => !signal.aborted && options.isCurrent();
  const menu = defineMenu<
    SubagentsMenuState,
    "main" | "jobs" | "job" | "status" | "help" | "view" | "trigger",
    "selectJob" | "cancelJob" | "settings" | "view" | "trigger" | "itemView"
  >({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Subagents",
        lines: [jobCounts(state)],
        items: [
          { id: "jobs", label: "Jobs", to: "jobs" },
          { id: "settings", label: "Settings", action: "settings" },
          ...(widget ? [{ id: "view", label: "Widget view", to: "view" as const }] : []),
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      jobs: ({ state }) => ({
        kind: "choice",
        title: "Subagent Jobs",
        lines: [jobCounts(state), ...(state.jobs.length === 0 ? ["No jobs in this session."] : [])],
        items: state.jobs.map((job) => ({
          id: job.jobId,
          label: sanitizeTerminalText(job.jobId),
          description: sanitizeTerminalText(job.state),
        })),
        action: "selectJob",
        hint: "back",
      }),
      job: ({ state }) => {
        const job = state.jobs.find((candidate) => candidate.jobId === selectedJobId);
        return {
          kind: "actions",
          title: "Subagent Job",
          lines: job ? jobLines(job) : ["This job is no longer available."],
          items:
            job && isActive(job)
              ? [
                  { id: "cancel", label: "Cancel job…", action: "cancelJob" },
                  ...(widget && selectedItem
                    ? [
                        { id: "expand", label: "Widget: job details", action: "itemView" as const },
                        { id: "compact", label: "Widget: job summary", action: "itemView" as const },
                        { id: "remove", label: "Remove from widget (keep job)", action: "itemView" as const },
                      ]
                    : []),
                ]
              : [],
          hint: "back",
        };
      },
      view: ({ state }) => ({
        kind: "actions",
        title: "Subagents Widget View",
        lines: [
          `View: ${widget?.state().mode ?? "default"} · pinned: ${widget?.state().pinned ?? false}`,
          `Automatic compaction: ${widget?.state().trigger ?? "manual"}`,
          ...(state.settings.showWidget ? [] : ["Disabled by Settings. View controls do not enable the widget."]),
          "Display changes never cancel jobs. No completed-job history is shown.",
        ],
        items: [
          { id: "expanded", label: "Show details", action: "view" },
          { id: "compact", label: "Show summary", action: "view" },
          {
            id: "visibility",
            label: widget?.state().mode === "hidden" ? "Show widget" : "Hide widget",
            action: "view",
          },
          { id: "pin", label: widget?.state().pinned ? "Unpin view" : "Pin view", action: "view" },
          { id: "trigger", label: "Automatic compaction", to: "trigger" },
          { id: "reset-items", label: "Reset item views", action: "view" },
        ],
        hint: "back",
      }),
      trigger: () => ({
        kind: "actions",
        title: "Subagents Automatic Compaction",
        lines: [
          "Opt-in. A pending rule rearms on meaningful active-job changes, not timing ticks.",
          "User messages count only when consumed, including extension-generated user messages.",
          "Settlement requires a non-aborted cycle with an observed non-error, non-aborted final turn.",
          "A later cycle needs its own post-arm consumed user message; queued batches can share a cycle.",
          "The cycle already active when armed is excluded. Pins and disabled/hidden views prevent compaction.",
        ],
        items: [
          { id: "manual", label: "Manual only", action: "trigger" },
          { id: "user-message", label: "Next consumed user message", action: "trigger" },
          { id: "settled-cycle", label: "Next eligible settled cycle", action: "trigger" },
        ],
        hint: "back",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Subagents Status",
        lines: [
          "Runtime: active for this session",
          `Retained jobs: ${state.jobs.length}`,
          `Active jobs: ${state.jobs.filter(isActive).length}`,
          `Omitted jobs: ${state.omitted}`,
          ...JOB_STATES.map((status) => `${status}: ${state.jobs.filter((job) => job.state === status).length}`),
          `Show widget: ${state.settings.showWidget}`,
          `Show job ID: ${state.settings.showJobId}`,
          `Show tools: ${state.settings.showTools}`,
          `Show timing: ${state.settings.showTiming}`,
          `User settings: ${sanitizeTerminalText(state.settingsPath)}`,
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Subagents Help",
        lines: [
          "/subagents opens the job manager.",
          "/subagents settings opens the same settings screen directly.",
          "Jobs shows this session's job summaries. Only queued or running jobs can be cancelled, after confirmation.",
          "The model uses subagent_spawn to start jobs, subagent_inspect to check them, and subagent_wait to wait for results.",
          "subagent_send sends a message; subagent_cancel cancels a job.",
          "Jobs are session-only. The runtime retains up to 32 terminal jobs for up to 24 hours.",
          "Settings changes display preferences only. All four settings default to true.",
          "Successful saves apply immediately. Use /reload after manual settings edits.",
          "In RPC mode, Settings reports the user settings file path.",
        ],
        hint: "back",
      }),
    },
    actions: {
      view: ({ itemId, signal }) => {
        if (!current(signal)) return { kind: "close" };
        if (!widget) return { kind: "stay" };
        if (itemId === "expanded" || itemId === "compact") widget.setMode(itemId);
        else if (itemId === "visibility") widget.setMode(widget.state().mode === "hidden" ? "expanded" : "hidden");
        else if (itemId === "pin") widget.setPinned(!widget.state().pinned);
        else if (itemId === "reset-items") widget.resetItems();
        return { kind: "stay" };
      },
      trigger: ({ itemId, signal }) => {
        if (!current(signal)) return { kind: "close" };
        if (itemId === "manual" || itemId === "user-message" || itemId === "settled-cycle") widget?.setTrigger(itemId);
        return { kind: "stay" };
      },
      itemView: ({ itemId, signal }) => {
        if (!current(signal)) return { kind: "close" };
        if (itemId === "compact" || itemId === "expand" || itemId === "remove") selectedItem?.[itemId]();
        selectedItem = selectedJobId === undefined ? undefined : widget?.item(selectedJobId);
        return { kind: "stay" };
      },
      selectJob: ({ itemId, signal }) => {
        if (!current(signal)) return { kind: "close" };
        if (!options.getState().jobs.some((job) => job.jobId === itemId)) return { kind: "stay" };
        selectedJobId = itemId;
        selectedItem = widget?.item(itemId);
        return { kind: "to", screen: "job" };
      },
      settings: async ({ signal }) => {
        if (!current(signal)) return { kind: "close" };
        const reason = await options.showSettings(signal);
        return { kind: current(signal) && reason === "back" ? "stay" : "close" };
      },
      cancelJob: async ({ signal }) => {
        if (!current(signal)) return { kind: "close" };
        const jobId = selectedJobId;
        const job = options.getState().jobs.find((candidate) => candidate.jobId === jobId);
        if (!job || !isActive(job)) return { kind: "stay" };
        const confirmation = await runConfirmation(ctx, {
          title: "Cancel subagent job?",
          message: `Cancel job ${sanitizeTerminalText(job.jobId)} (${sanitizeTerminalText(job.state)})?`,
          confirmLabel: "Cancel job",
          cancelLabel: "Keep job",
          signal,
          isCurrent: options.isCurrent,
          onError: () => undefined,
        });
        if (!current(signal)) return { kind: "close" };
        if (confirmation.kind === "closed") {
          return { kind: confirmation.reason === "close" ? "close" : "stay" };
        }
        if (confirmation.kind === "error") throw confirmation.error;
        if (confirmation.kind !== "confirmed") return { kind: "close" };
        // The runtime can finish or remove a job while its confirmation is open.
        const latest = options.getState().jobs.find((candidate) => candidate.jobId === jobId);
        if (selectedJobId !== jobId || !latest || !isActive(latest)) return { kind: "stay" };
        const result = await runTask(ctx, {
          label: "Cancelling subagent job…",
          signal,
          isCurrent: options.isCurrent,
          task: ({ signal: taskSignal }) => options.cancelJob(latest.jobId, taskSignal),
          onError: () => undefined,
        });
        if (!current(signal)) return { kind: "close" };
        if (result.kind === "error") throw result.error;
        if (result.kind === "stale") return { kind: "close" };
        if (result.kind === "cancelled") return { kind: "close" };
        return { kind: "stay" };
      },
    },
  });
  await runMenu(ctx, menu, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    getState: options.getState,
    onError: (_ctx, error) => {
      if (!options.signal.aborted && options.isCurrent() && ctx.hasUI) {
        ctx.ui.notify(
          sanitizeTerminalText(`Subagents menu failed: ${error instanceof Error ? error.message : String(error)}`),
          "error",
        );
      }
    },
  });
}

function isActive(job: JobSummary): boolean {
  return job.state === "queued" || job.state === "running";
}

function jobCounts(state: SubagentsMenuState): string {
  return `Jobs: ${state.jobs.length} shown, ${state.jobs.filter(isActive).length} active, ${state.omitted} omitted`;
}

function jobLines(job: JobSummary): string[] {
  return [
    `Job ID: ${sanitizeTerminalText(job.jobId)}`,
    `State: ${sanitizeTerminalText(job.state)}`,
    `Created: ${timestamp(job.createdAt)}`,
    ...(job.startedAt === undefined ? [] : [`Started: ${timestamp(job.startedAt)}`]),
    ...(job.finishedAt === undefined ? [] : [`Finished: ${timestamp(job.finishedAt)}`]),
    ...(job.timeout === undefined ? [] : [`Timeout: ${job.timeout} seconds`]),
  ];
}

function timestamp(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}
