import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportStoredPlan, planExportDestination } from "./plan-export.js";
import { configuredPlanExportPath, type PlanModeSettings } from "./settings.js";
import type { PlanModeState } from "./state.js";

interface PlanExportControllerOptions {
  getState(): PlanModeState;
  getSettings(): PlanModeSettings;
  finishReady(ctx: ExtensionContext): void;
}

export function createPlanExportController(options: PlanExportControllerOptions) {
  return {
    export(path: string | undefined, ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean) {
      const state = options.getState();
      return exportStoredPlan(
        state,
        path,
        ctx,
        {
          signal,
          isCurrent,
          getState: options.getState,
          finishReady: () => options.finishReady(ctx),
        },
        configuredPlanExportPath(options.getSettings()),
      );
    },
    getDestination(ctx: ExtensionContext) {
      return planExportDestination(configuredPlanExportPath(options.getSettings()), ctx.cwd);
    },
  };
}
