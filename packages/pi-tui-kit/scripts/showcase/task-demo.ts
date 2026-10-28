import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runTask } from "@narumitw/pi-tui-kit";
import { appendLog, type ShowcaseState } from "./menu.js";
import type { ShowTuiKitShowcaseOptions } from "./runtime.js";

export type ShowcaseTaskScenario = "task" | "taskFailure" | "taskCancel";

export async function runShowcaseTask(
  ctx: ExtensionCommandContext,
  state: ShowcaseState,
  scenario: ShowcaseTaskScenario,
  options: ShowTuiKitShowcaseOptions,
): Promise<void> {
  const label =
    scenario === "taskFailure"
      ? "Synthetic failure in 250 ms — reopen to retry…"
      : scenario === "taskCancel"
        ? "Cancel this synthetic task (4-second safety deadline)…"
        : "Running a short showcase task…";
  const result = await runTask(ctx, {
    label,
    ...options,
    task: async ({ signal }) => {
      await boundedDelay(scenario === "taskCancel" ? 4000 : 250, signal);
      if (signal.aborted || !options.isCurrent()) return;
      if (scenario === "taskFailure") throw new Error("Expected synthetic task failure.");
    },
    onError: () => {
      if (!options.signal.aborted && options.isCurrent() && ctx.hasUI) {
        ctx.ui.notify("Expected synthetic task failure. Reopen the example to retry.", "error");
      }
    },
  });
  if (options.signal.aborted || !options.isCurrent() || result.kind === "stale") return;
  if (result.kind === "completed") {
    appendLog(
      state,
      scenario === "taskCancel" ? "Cancellation task reached its safety deadline." : "Standalone task completed.",
    );
    if (ctx.hasUI) ctx.ui.notify("Showcase task completed.", "info");
  } else if (result.kind === "cancelled") {
    appendLog(state, "Synthetic task cancelled; owned timer released. Reopen to retry.");
  } else if (result.kind === "error") {
    appendLog(state, "Synthetic task failed; reopen to retry.");
  }
}

function boundedDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
