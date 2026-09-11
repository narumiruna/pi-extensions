import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

export interface PlanLaunchTool {
  name: string;
  label?: string;
  description: string;
  searchText: string;
  disabled: boolean;
  disabledReason?: string;
}

interface PlanLaunchMenuOptions {
  statusText: string;
  toolSummary(selectedNames: ReadonlySet<string>): string;
  getSelectedNames(): ReadonlySet<string>;
  tools: readonly PlanLaunchTool[];
  signal: AbortSignal;
  isCurrent(): boolean;
  initialScreen?: "main" | "tools";
  start(signal: AbortSignal): void;
  startWithTools(toolNames: string[], signal: AbortSignal): void;
  settings(signal: AbortSignal): Promise<boolean>;
}

export async function showPlanLaunchMenu(ctx: ExtensionContext, options: PlanLaunchMenuOptions) {
  type Screen = "main" | "tools" | "help";
  type Action = "start" | "toggle-tool" | "start-with-tools" | "settings";
  const selectedNames = new Set(options.getSelectedNames());
  const toolItems = options.tools.map((tool, index) => ({
    id: `plan-tool:${index}`,
    tool,
  }));
  const toolsByItemId = new Map(toolItems.map(({ id, tool }) => [id, tool]));
  let draftChanged = false;
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: options.initialScreen ?? "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Plan mode",
        lines: [options.statusText, options.toolSummary(selectedNames)],
        items: [
          { id: "start", label: "Start Plan mode", action: "start" },
          { id: "tools", label: "Choose tools, then start…", to: "tools" },
          { id: "settings", label: "Settings", action: "settings" },
          { id: "help", label: "How Plan mode works", to: "help" },
        ],
        hint: "close",
      }),
      tools: () => ({
        kind: "multiSelect",
        title: "Choose Plan policy allowlist",
        lines: [
          "Policy changes apply only when you start Plan mode; first use may also reveal Plan helpers.",
          options.toolSummary(selectedNames),
          "Active tools can be chosen now; retained names resolve before the first request.",
          "Plan mode never activates tools, and non-built-ins run at user risk.",
        ],
        enableSearch: true,
        viewportSize: 10,
        items: toolItems.map(({ id, tool }) => ({
          id,
          label: tool.label ?? tool.name,
          description: tool.description,
          searchText: tool.searchText,
          selected: selectedNames.has(tool.name),
          disabled: tool.disabled,
          disabledReason: tool.disabledReason,
        })),
        action: "toggle-tool",
        actions: [
          {
            id: "start-with-tools",
            label: "Done — start with this policy",
            action: "start-with-tools",
          },
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "How Plan mode works",
        lines: [
          "Plan mode uses read-only exploration to understand the project before implementation.",
          "The agent can ask important decision questions, then returns a complete implementation-ready plan.",
          "File mutation stays blocked until you explicitly choose to implement the completed plan.",
        ],
        hint: "back",
      }),
    },
    actions: {
      start: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        options.start(signal);
        return { kind: "close" };
      },
      "toggle-tool": async ({ itemId, selected, signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        const tool = itemId ? toolsByItemId.get(itemId) : undefined;
        if (!tool || tool.disabled) return { kind: "rejected" };
        if (selected) selectedNames.add(tool.name);
        else selectedNames.delete(tool.name);
        draftChanged = true;
        return { kind: "stay" };
      },
      "start-with-tools": async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        options.startWithTools(Array.from(selectedNames), signal);
        return { kind: "close" };
      },
      settings: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        const close = await options.settings(signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
        if (close) return { kind: "close" };
        if (!draftChanged) {
          selectedNames.clear();
          for (const name of options.getSelectedNames()) selectedNames.add(name);
        }
        return { kind: "stay" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
}
