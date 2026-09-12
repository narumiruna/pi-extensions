import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runSecretInput, runThinkingSelector, type ThinkingLevel } from "../../src/index.js";

interface SmokeState {
  enabled: boolean;
  mode: string;
}

type Screen = "main" | "choice" | "input" | "review" | "multi" | "settings";
type Action = "apply" | "saveInput" | "setMode" | "toggle" | "setting";

async function runCapabilityMenu(ctx: ExtensionCommandContext) {
  const state: SmokeState = { enabled: false, mode: "Balanced" };
  const menu = defineMenu<SmokeState, Screen, Action>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Pi TUI Kit capability smoke",
        lines: ["Use keyboard and mouse; resize the terminal before returning."],
        items: [
          { id: "choice", label: "Searchable choice", to: "choice" },
          { id: "input", label: "Prefilled input", to: "input" },
          { id: "review", label: "Intraline diff review", to: "review" },
          { id: "multi", label: "Searchable multi-select", to: "multi" },
          { id: "settings", label: "Settings rollback", to: "settings" },
        ],
        hint: "close",
      }),
      choice: ({ state: current }) => ({
        kind: "choice",
        title: "Searchable choice",
        lines: [`Current: ${current.mode}`],
        enableSearch: true,
        items: [
          { id: "Focused", label: "Focused", searchText: "small precise" },
          { id: "Balanced", label: "Balanced", searchText: "recommended default" },
          { id: "Unavailable", label: "Unavailable", disabled: true, disabledReason: "Smoke-only policy" },
        ],
        action: "setMode",
        currentItemId: current.mode,
        initialItemId: current.mode,
      }),
      input: () => ({
        kind: "input",
        title: "Prefilled input",
        lines: ["Edit the initial draft; only a value ending in -ok is accepted."],
        initialValue: "draft",
        placeholder: "draft-ok",
        action: "saveInput",
      }),
      review: () => ({
        kind: "review",
        title: "Intraline diff review",
        content: "@@ smoke\n-const mode = 'old';\n+const mode = 'new';\n unchanged",
        format: { kind: "diff" },
        enableSearch: true,
        viewportSize: "adaptive",
        confirm: { id: "apply", label: "Return", action: "apply" },
      }),
      multi: ({ state: current }) => ({
        kind: "multiSelect",
        title: "Searchable multi-select",
        enableSearch: true,
        items: [
          { id: "enabled", label: "Enabled option", selected: current.enabled, searchText: "active" },
          {
            id: "blocked",
            label: "Blocked option",
            selected: false,
            disabled: true,
            disabledReason: "Smoke-only policy",
          },
        ],
        action: "toggle",
      }),
      settings: ({ state: current }) => ({
        kind: "settings",
        title: "Settings rollback",
        lines: ["Changing this row is intentionally rejected."],
        items: [
          {
            id: "mode",
            label: "Mode",
            currentValue: current.mode,
            values: ["Focused", "Balanced"],
            action: "setting",
          },
        ],
      }),
    },
    actions: {
      apply: async () => ({ kind: "back" }),
      saveInput: async ({ value }) => (value?.endsWith("-ok") ? { kind: "back" } : { kind: "rejected" }),
      setMode: async ({ itemId }) => {
        if (itemId !== "Focused" && itemId !== "Balanced") return { kind: "rejected" };
        state.mode = itemId;
        return { kind: "back" };
      },
      toggle: async ({ itemId, selected }) => {
        if (itemId !== "enabled" || selected === undefined) return { kind: "rejected" };
        state.enabled = selected;
        return { kind: "stay" };
      },
      setting: async () => ({ kind: "rejected" }),
    },
  });
  await runMenu(ctx, menu, { getState: () => state });
}

async function runSelectorSmoke(ctx: ExtensionCommandContext) {
  const result = await runThinkingSelector(ctx, {
    availableLevels: ["off", "minimal", "low", "medium", "high"] as ThinkingLevel[],
    currentLevel: "medium",
    defaultLevel: "low",
  });
  if (result.kind === "selected" || result.kind === "saveDefault") {
    ctx.ui.notify(`Selector result: ${result.kind} ${result.level}`, "info");
  }
}

async function runSecretSmoke(ctx: ExtensionCommandContext) {
  const result = await runSecretInput(ctx, {
    title: "Smoke-only secret",
    required: false,
    onUnsupportedMode: (currentCtx) => {
      currentCtx.ui.notify("Masked secret input requires TUI mode; no plaintext fallback was opened.", "warning");
    },
  });
  if (result.kind === "submitted") ctx.ui.notify("Secret received without displaying or storing it.", "info");
}

export default function interactionSmoke(pi: ExtensionAPI) {
  pi.registerCommand("kit-capabilities-smoke", {
    description: "Exercise Pi TUI Kit screen capabilities",
    handler: async (_args, ctx) => runCapabilityMenu(ctx),
  });
  pi.registerCommand("kit-selector-smoke", {
    description: "Exercise Pi TUI Kit thinking selector",
    handler: async (_args, ctx) => runSelectorSmoke(ctx),
  });
  pi.registerCommand("kit-secret-smoke", {
    description: "Exercise Pi TUI Kit masked secret input",
    handler: async (_args, ctx) => runSecretSmoke(ctx),
  });
}
