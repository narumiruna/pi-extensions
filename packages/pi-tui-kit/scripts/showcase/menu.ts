import {
  defineMenu,
  type MenuChoiceItem,
  type MenuDefinition,
  type ModelSelectorItem,
  type ThinkingLevel,
} from "@narumitw/pi-tui-kit";
import { runtimeInfoLines, type ShowcaseRuntimeInfo } from "./runtime-info.js";

export type ShowcaseScreen =
  | "main"
  | "actions"
  | "detail"
  | "browse"
  | "choice"
  | "settings"
  | "input"
  | "review"
  | "multiSelect"
  | "runtime"
  | "prefill";

export type ShowcaseAction =
  | "recordAction"
  | "setProfile"
  | "setSetting"
  | "submitInput"
  | "applyReview"
  | "toggleFeature"
  | "selectAllFeatures"
  | "resetFeatures"
  | "submitPrefill"
  | "openExample";

export type ShowcaseStandaloneInteraction =
  | "task"
  | "taskFailure"
  | "taskCancel"
  | "confirmation"
  | "liveChoice"
  | "questionnaire"
  | "secret"
  | "model"
  | "thinking"
  | "theme"
  | "native"
  | "copy";

export interface ShowcaseState {
  profile: "Minimal" | "Balanced" | "Verbose";
  density: "Comfortable" | "Compact";
  accent: "Blue" | "Green" | "Purple";
  inputText: string;
  reviewApplied: boolean;
  featureFlags: Record<"search" | "details" | "bulk", boolean>;
  log: readonly string[];
  runtimeInfo?: ShowcaseRuntimeInfo;
  prefillText: string;
  model: ModelSelectorItem;
  defaultModel: ModelSelectorItem;
  thinking: ThinkingLevel;
  defaultThinking: ThinkingLevel;
}

export interface ShowcaseMenuRuntime {
  requestStandalone(interaction: ShowcaseStandaloneInteraction): void;
}

type ShowcaseMenuItem = MenuChoiceItem &
  ({ to: ShowcaseScreen } | { interaction: ShowcaseStandaloneInteraction } | { close: true });

const SHOWCASE_ITEMS: readonly ShowcaseMenuItem[] = [
  {
    id: "actions",
    label: "Actions screen",
    description: "Navigation, busy labels, disabled rows",
    to: "actions",
  },
  {
    id: "detail",
    label: "Detail screen",
    description: "Read-only wrapped prose",
    to: "detail",
  },
  {
    id: "browse",
    label: "Browse screen",
    description: "Searchable read-only catalog with exact details",
    to: "browse",
  },
  {
    id: "choice",
    label: "Choice screen",
    description: "Single selected value with details",
    to: "choice",
  },
  {
    id: "settings",
    label: "Settings screen",
    description: "In-memory settings-list presentation",
    to: "settings",
  },
  {
    id: "input",
    label: "Input screen",
    description: "Single-line value entry",
    to: "input",
  },
  {
    id: "review",
    label: "Review screen",
    description: "Exact text, code, or diff review with confirmation",
    to: "review",
  },
  {
    id: "multi-select",
    label: "Multi-select screen",
    description: "Toggles, search, and bulk actions",
    to: "multiSelect",
  },
  {
    id: "questionnaire",
    label: "Questionnaire",
    description: "Closes this menu, shows runQuestionnaire(), then reopens",
    interaction: "questionnaire",
  },
  {
    id: "task",
    label: "Task loader",
    description: "Closes this menu, shows runTask(), then reopens",
    interaction: "task",
  },
  {
    id: "confirmation",
    label: "Confirmation",
    description: "Closes this menu, shows runConfirmation(), then reopens",
    interaction: "confirmation",
  },
  {
    id: "live-choice",
    label: "Live choice",
    description: "Closes this menu, shows runLiveChoice(), then reopens",
    interaction: "liveChoice",
  },
  {
    id: "runtime",
    label: "Runtime information",
    description: "Version, API, and actual built module origin",
    to: "runtime",
  },
  {
    id: "prefill",
    label: "Editable prefill",
    description: "Edit a synthetic draft; memory only",
    to: "prefill",
  },
  {
    id: "secret",
    label: "Synthetic secret input",
    description: "Use fake text only; no payload in history",
    interaction: "secret",
  },
  {
    id: "model",
    label: "Synthetic model selector",
    description: "Current, default, selection, and memory-only save intent",
    interaction: "model",
  },
  {
    id: "thinking",
    label: "Synthetic thinking selector",
    description: "No real thinking-level or settings change",
    interaction: "thinking",
  },
  {
    id: "theme",
    label: "Theme and style samples",
    description: "Active host roles versus sample palettes; no host changes",
    interaction: "theme",
  },
  {
    id: "taskFailure",
    label: "Task failure and retry",
    description: "Bounded synthetic failure; select again to retry",
    interaction: "taskFailure",
  },
  {
    id: "taskCancel",
    label: "Task cancellation",
    description: "Cancel before a bounded safety deadline",
    interaction: "taskCancel",
  },
  {
    id: "native",
    label: "Native pointer, wheel, and overlays",
    description: "Native routing demo with keyboard alternatives",
    interaction: "native",
  },
  {
    id: "copy",
    label: "In-memory copy capture",
    description: "Synthetic exact source, failure/retry; NO OS clipboard",
    interaction: "copy",
  },
  { id: "close", label: "Close", close: true },
];

export function createInitialShowcaseState(): ShowcaseState {
  return {
    profile: "Balanced",
    density: "Comfortable",
    accent: "Blue",
    inputText: "",
    prefillText: "Synthetic editable draft",
    model: { provider: "demo-alpha", id: "synthetic-fast" },
    defaultModel: { provider: "demo-beta", id: "synthetic-deep" },
    thinking: "medium",
    defaultThinking: "high",
    reviewApplied: false,
    featureFlags: {
      search: true,
      details: true,
      bulk: false,
    },
    log: ["Open any row to inspect that Kit pattern."],
  };
}

export function createShowcaseMenu(
  runtime: ShowcaseMenuRuntime,
): MenuDefinition<ShowcaseState, ShowcaseScreen, ShowcaseAction> {
  return defineMenu<ShowcaseState, ShowcaseScreen, ShowcaseAction>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "choice",
        title: "Pi TUI Kit Showcase",
        lines: [
          "Local demo for maintainers.",
          "It stores no settings and uses only public @narumitw/pi-tui-kit exports.",
          `Current demo state: ${state.profile} · ${state.density} · ${state.accent}`,
          `Synthetic model: ${state.model.id} · default: ${state.defaultModel.id}`,
          `Synthetic thinking: ${state.thinking} · default: ${state.defaultThinking}`,
        ],
        items: SHOWCASE_ITEMS,
        action: "openExample",
        enableSearch: true,
        hint: "close",
      }),
      runtime: ({ state }) => ({
        kind: "detail",
        title: "Kit runtime information",
        lines: [
          ...runtimeInfoLines(state.runtimeInfo),
          "The launcher builds the local workspace before Pi loads this menu.",
        ],
        hint: "back",
      }),
      prefill: ({ state }) => ({
        kind: "input",
        title: "Editable synthetic prefill",
        lines: [
          "Synthetic text only. Editing and paste use Kit's native Input behavior.",
          "Submission keeps this draft in memory; cancellation keeps the previous draft.",
        ],
        initialValue: state.prefillText,
        action: "submitPrefill",
        hint: "back",
      }),
      actions: ({ state }) => ({
        kind: "actions",
        title: "Actions screen",
        lines: latestLogLines(state),
        items: [
          {
            id: "record",
            label: "Record an action",
            description: "Adds a log line and stays here",
            action: "recordAction",
            busyLabel: "Recording",
          },
          {
            id: "disabled",
            label: "Disabled row",
            description: "Focusable explanation without side effects",
            disabled: true,
            disabledReason: "This row exists only to show unavailable styling.",
            action: "recordAction",
          },
          { id: "back", label: "Back to showcase", to: "main" },
        ],
        hint: "back",
      }),
      detail: ({ state }) => ({
        kind: "detail",
        title: "Detail screen",
        lines: [
          "Detail screens are for read-only explanations.",
          "They preserve simple navigation and keep domain actions elsewhere.",
          `Last input: ${state.inputText || "none yet"}`,
          ...latestLogLines(state),
        ],
        hint: "back",
      }),
      browse: () => ({
        kind: "browse",
        title: "Browse screen",
        lines: ["Search the list, press Enter for details, Escape returns to the list."],
        items: [
          {
            id: "json",
            label: "Exact JSON document",
            statusText: "code",
            description: "Whitespace-sensitive browse detailDocument",
            searchText: "schema exact code json",
            detailDocument: {
              content: JSON.stringify({ package: "@narumitw/pi-tui-kit", screen: "browse", exact: true }, null, 2),
              format: { kind: "code", language: "json" },
            },
          },
          {
            id: "legacy",
            label: "Legacy prose details",
            statusText: "text",
            description: "Status and description are included in detail output",
            searchText: "wrapped details prose",
            details: ["First detail line.", "Second detail line with enough words to wrap on narrow terminals."],
          },
          {
            id: "diff",
            label: "Diff detail document",
            statusText: "diff",
            description: "Exact diff rendering",
            searchText: "patch review",
            detailDocument: {
              content: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old();\n+newShowcase();\n",
              format: { kind: "diff", filePath: "demo.ts" },
            },
          },
        ],
        viewportSize: "adaptive",
        enableDetailSearch: true,
        hint: "back",
      }),
      choice: ({ state }) => ({
        kind: "choice",
        title: "Choice screen",
        lines: ["Pick one profile. Search is TUI-only; RPC would keep a deterministic selector."],
        items: [
          {
            id: "Minimal",
            label: "Minimal",
            description: "Few rows",
            details: ["Best for tiny terminals."],
            searchText: "small short",
          },
          {
            id: "Balanced",
            label: "Balanced",
            description: "Default",
            details: ["Shows context without crowding the screen."],
            searchText: "recommended default",
          },
          {
            id: "Verbose",
            label: "Verbose",
            description: "More annotations",
            details: ["Useful when demonstrating wrapping and selected-row details."],
            searchText: "full annotated",
          },
        ],
        action: "setProfile",
        currentItemId: state.profile,
        initialItemId: state.profile,
        enableSearch: true,
        viewportSize: 6,
        hint: "back",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Settings screen",
        lines: ["Demo settings are in memory only. Back does not roll them back."],
        items: [
          {
            id: "density",
            label: "Density",
            description: "Controls copy density in demo text.",
            currentValue: state.density,
            values: ["Comfortable", "Compact"],
            action: "setSetting",
          },
          {
            id: "accent",
            label: "Accent",
            description: "Shows ordinary bounded enum rows.",
            currentValue: state.accent,
            values: ["Blue", "Green", "Purple"],
            action: "setSetting",
          },
        ],
      }),
      input: ({ state }) => ({
        kind: "input",
        title: "Input screen",
        lines: [`Current draft: ${state.inputText || "empty"}`],
        placeholder: "Type any short demo note",
        action: "submitInput",
        hint: "back",
      }),
      review: ({ state }) => ({
        kind: "review",
        title: "Review screen",
        lines: [
          state.reviewApplied
            ? "The demo apply action was already accepted."
            : "Review preserves indentation and hard-wraps exact content.",
        ],
        content:
          "diff --git a/showcase.txt b/showcase.txt\n--- a/showcase.txt\n+++ b/showcase.txt\n@@ -1,3 +1,4 @@\n actions\n detail\n browse\n+review\n",
        format: { kind: "diff", filePath: "showcase.txt" },
        viewportSize: "adaptive",
        enableSearch: true,
        confirm: {
          id: "apply",
          label: state.reviewApplied ? "Apply again" : "Apply demo",
          action: "applyReview",
        },
        hint: "back",
      }),
      multiSelect: ({ state }) => ({
        kind: "multiSelect",
        title: "Multi-select screen",
        lines: ["Toggle rows optimistically; bulk actions stay below filtered results."],
        items: [
          {
            id: "search",
            label: "Search field",
            description: "Shows fuzzy filtering over safe metadata.",
            selected: state.featureFlags.search,
            searchText: "filter query",
          },
          {
            id: "details",
            label: "Selected-row details",
            description: "Keeps explanation near the current row.",
            selected: state.featureFlags.details,
            searchText: "description help",
          },
          {
            id: "bulk",
            label: "Bulk actions",
            description: "Adds select-all and reset rows below items.",
            selected: state.featureFlags.bulk,
            searchText: "select all reset",
          },
          {
            id: "blocked",
            label: "Unavailable option",
            description: "Disabled rows remain visible.",
            selected: false,
            disabled: true,
            disabledReason: "Disabled rows cannot be toggled.",
            searchText: "disabled unavailable",
          },
        ],
        action: "toggleFeature",
        enableSearch: true,
        viewportSize: 6,
        actions: [
          { id: "select-all", label: "Select all available", action: "selectAllFeatures" },
          { id: "reset", label: "Reset demo toggles", action: "resetFeatures" },
        ],
        doneLabel: "Back to showcase",
        hint: "back",
      }),
    },
    actions: {
      openExample: ({ itemId }) => {
        const item = SHOWCASE_ITEMS.find((candidate) => candidate.id === itemId);
        if (!item) return { kind: "rejected" };
        if ("to" in item) return { kind: "to", screen: item.to };
        if ("interaction" in item) runtime.requestStandalone(item.interaction);
        return { kind: "close" };
      },
      submitPrefill: ({ state, value }) => {
        state.prefillText = value ?? "";
        appendLog(state, "Synthetic prefill submitted (payload omitted).");
        return { kind: "back" };
      },
      recordAction: ({ state, ctx }) => {
        appendLog(state, "Actions screen row activated.");
        if (ctx.hasUI) ctx.ui.notify?.("Recorded an in-memory showcase action.", "info");
        return { kind: "stay" };
      },
      setProfile: ({ state, itemId }) => {
        if (isProfile(itemId)) state.profile = itemId;
        appendLog(state, `Choice profile set to ${state.profile}.`);
        return { kind: "back" };
      },
      setSetting: ({ state, itemId, value }) => {
        if (itemId === "density" && isDensity(value)) state.density = value;
        if (itemId === "accent" && isAccent(value)) state.accent = value;
        appendLog(state, `Setting ${itemId} changed to ${value ?? "unknown"}.`);
        return { kind: "stay" };
      },
      submitInput: ({ state, value }) => {
        state.inputText = (value ?? "").trim();
        appendLog(state, `Input submitted: ${state.inputText || "empty"}.`);
        return { kind: "back" };
      },
      applyReview: ({ state }) => {
        state.reviewApplied = true;
        appendLog(state, "Review confirmation accepted.");
        return { kind: "back" };
      },
      toggleFeature: ({ state, itemId, selected }) => {
        if (isFeature(itemId)) state.featureFlags[itemId] = selected ?? !state.featureFlags[itemId];
        appendLog(state, `Multi-select ${itemId} is ${selected ? "on" : "off"}.`);
        return { kind: "stay" };
      },
      selectAllFeatures: ({ state }) => {
        for (const feature of FEATURE_IDS) state.featureFlags[feature] = true;
        appendLog(state, "All available multi-select rows enabled.");
        return { kind: "stay" };
      },
      resetFeatures: ({ state }) => {
        state.featureFlags.search = true;
        state.featureFlags.details = true;
        state.featureFlags.bulk = false;
        appendLog(state, "Multi-select rows reset.");
        return { kind: "stay" };
      },
    },
  });
}

const FEATURE_IDS = ["search", "details", "bulk"] as const;

function latestLogLines(state: ShowcaseState): string[] {
  return state.log.slice(-3).map((line) => `Log: ${line}`);
}

export function appendLog(state: ShowcaseState, line: string): void {
  state.log = [...state.log, line].slice(-8);
}

function isProfile(value: string | undefined): value is ShowcaseState["profile"] {
  return value === "Minimal" || value === "Balanced" || value === "Verbose";
}

function isDensity(value: string | undefined): value is ShowcaseState["density"] {
  return value === "Comfortable" || value === "Compact";
}

function isAccent(value: string | undefined): value is ShowcaseState["accent"] {
  return value === "Blue" || value === "Green" || value === "Purple";
}

function isFeature(value: string): value is keyof ShowcaseState["featureFlags"] {
  return FEATURE_IDS.includes(value as keyof ShowcaseState["featureFlags"]);
}
