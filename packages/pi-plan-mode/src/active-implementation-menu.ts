import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface ActiveImplementationMenuOptions {
  statusText: string;
  getExportDestination: PlanExportDestinationProvider;
  signal: AbortSignal;
  isCurrent(): boolean;
  show(): void;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  settings(signal: AbortSignal): Promise<boolean>;
  startNew(): void;
  clear(): void;
}

export async function showActiveImplementationMenu(ctx: ExtensionContext, options: ActiveImplementationMenuOptions) {
  type Screen = "active" | "export";
  type Action = "show" | "export" | "settings" | "start-new" | "clear";
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "active",
    screens: {
      active: () => ({
        kind: "actions",
        title: "Active implementation plan",
        lines: [options.statusText],
        items: [
          { id: "show", label: "Show active implementation plan", action: "show" },
          { id: "export", label: "Export plan…", to: "export" },
          { id: "settings", label: "Settings", action: "settings" },
          { id: "start-new", label: "Start a new plan", action: "start-new" },
          { id: "clear", label: "Clear active implementation plan", action: "clear" },
        ],
        hint: "close",
      }),
      export: () => planExportInputScreen(options.getExportDestination),
    },
    actions: {
      show: async () => {
        options.show();
        return { kind: "close" };
      },
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      settings: async ({ signal }) => {
        const close = await options.settings(signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        return close ? { kind: "close" } : { kind: "stay" };
      },
      "start-new": async () => {
        options.startNew();
        return { kind: "close" };
      },
      clear: async () => {
        options.clear();
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
}
