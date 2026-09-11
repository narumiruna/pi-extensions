import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type BrowseDetailDocument,
  type BrowseScreen,
  defineMenu,
  formatInteractionHints,
  hardWrapTerminalDocument,
  type InputScreen,
  type MenuCloseReason,
  type MultiSelectScreen,
  type ReviewScreen,
  type RunLiveChoiceResult,
  type RunQuestionnaireResult,
  runCustomInteraction,
  runLiveChoice,
  runMenu,
  runQuestionnaire,
  sanitizeTerminalDocument,
} from "../src/index.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

type Screen = "main" | "profile" | "settings";
type Action = "refresh" | "setMode" | "setProfile";
interface State {
  mode: "Safe" | "Fast";
  profile: "Minimal" | "Balanced" | "Custom";
}

declare function refreshDomainState(signal: AbortSignal): Promise<void>;
declare function saveMode(mode: State["mode"], signal: AbortSignal): Promise<void>;
declare function saveProfile(profile: string, signal: AbortSignal): Promise<void>;
declare function loadState(signal: AbortSignal): Promise<State>;
declare function currentGeneration(): number;
declare function currentSessionSignal(): AbortSignal;
declare function formatError(error: unknown): string;

const schemaDocument: BrowseDetailDocument = {
  content: '{\n  "type": "object"\n}',
  format: { kind: "code", language: "json" },
};

const modulesScreen: BrowseScreen = {
  kind: "browse",
  title: "Modules",
  items: [
    {
      id: "model",
      label: "model",
      statusText: "Showing",
      description: "Current model",
      searchText: "provider llm",
      details: ["Preview: claude"],
    },
    {
      id: "schema",
      label: "schema",
      searchText: "configuration object",
      detailDocument: schemaDocument,
    },
  ],
  viewportSize: "adaptive",
  enableDetailSearch: true,
};
void modulesScreen;

const searchableToolsScreen: MultiSelectScreen<Screen, Action> = {
  kind: "multiSelect",
  title: "Tool permissions",
  enableSearch: true,
  items: [
    {
      id: "read",
      label: "read",
      searchText: "built-in filesystem inspection",
      selected: true,
    },
  ],
  action: "refresh",
};
void searchableToolsScreen;

const boundedInputScreen: InputScreen<Action> = {
  kind: "input",
  title: "Refresh label",
  placeholder: "Label",
  action: "refresh",
};
void boundedInputScreen;

const reviewChangesScreen: ReviewScreen<Action> = {
  kind: "review",
  title: "Review changes",
  content: "+1 enabled=true",
  format: { kind: "diff", filePath: "settings.json" },
  viewportSize: "adaptive",
  enableSearch: true,
  confirm: { id: "apply", label: "Apply", action: "refresh" },
};
void reviewChangesScreen;

const safeDocument = sanitizeTerminalDocument("first\r\nsecond");
const wrappedDocument = hardWrapTerminalDocument(safeDocument, 40);
void wrappedDocument;

const markdownScreen: ReviewScreen<Action> = {
  kind: "review",
  title: "Rendered document",
  content: "# Formula\n\n$x^2$\n\n```mermaid\nflowchart LR\n A --> B\n```",
  format: { kind: "markdown", renderLatex: true, renderMermaid: false },
};
void markdownScreen;

const menu = defineMenu<State, Screen, Action>({
  start: "main",
  screens: {
    main: ({ state }) => ({
      kind: "actions",
      title: "Example extension",
      lines: [`Current mode: ${state.mode}`],
      items: [
        { id: "refresh", label: "Refresh", action: "refresh", busyLabel: "Refreshing" },
        { id: "profile", label: "Profile", to: "profile" },
        { id: "settings", label: "Settings", to: "settings" },
        { id: "close", label: "Close", close: true },
      ],
      hint: "close",
    }),
    profile: ({ state }) => ({
      kind: "choice",
      title: "Profile",
      items: [
        { id: "minimal", label: "Minimal", details: ["Only essential information"] },
        { id: "balanced", label: "Balanced", details: ["Recommended information"] },
      ],
      action: "setProfile",
      currentItemId: state.profile.toLowerCase(),
      initialItemId: state.profile === "Custom" ? "balanced" : state.profile.toLowerCase(),
    }),
    settings: ({ state }) => ({
      kind: "settings",
      title: "Settings",
      items: [
        {
          id: "mode",
          label: "Mode",
          currentValue: state.mode,
          values: ["Safe", "Fast"],
          action: "setMode",
        },
      ],
    }),
  },
  actions: {
    refresh: async ({ signal }) => {
      await refreshDomainState(signal);
      return { kind: "stay" };
    },
    setMode: async ({ value, signal }) => {
      await saveMode(value === "Fast" ? "Fast" : "Safe", signal);
      return { kind: "stay" };
    },
    setProfile: async ({ itemId, signal }) => {
      await saveProfile(itemId, signal);
      return { kind: "back" };
    },
  },
});

export async function showMenu(ctx: ExtensionCommandContext, generation: number) {
  const result = await runMenu(ctx, menu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
    onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
    onUnsupportedMode: (_ctx, mode) => {
      ctx.ui.notify(`The menu is unavailable in ${mode} mode.`, "warning");
    },
  });
  if (result.kind === "closed") {
    const reason: MenuCloseReason = result.reason;
    if (reason === "back") ctx.ui.notify("Returned from the root menu", "info");
  }
  return result;
}

declare const consumerContext: ExtensionCommandContext;

export function showSpecializedView(ctx: ExtensionCommandContext, generation: number) {
  return runCustomInteraction<{ kind: "back" | "close" }>(ctx, {
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
    create: ({ keybindings, signal, complete }) => {
      const hint = formatInteractionHints(keybindings, [
        { bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
        { keys: ["e"], label: "edit" },
      ]);
      return {
        render: () => [signal.aborted ? "Closing…" : `Specialized view · ${hint}`],
        invalidate() {},
        handleInput(data: string) {
          if (keybindings.matches(data, "tui.select.cancel")) complete({ kind: "back" });
        },
      };
    },
  });
}

export async function askReleaseQuestions(
  ctx: ExtensionCommandContext,
  generation: number,
): Promise<RunQuestionnaireResult<"scope">> {
  return runQuestionnaire(ctx, {
    questions: [
      {
        id: "scope",
        header: "Scope",
        prompt: "How broad should this release be?",
        options: [
          { label: "Patch", description: "Ship only the fix" },
          { label: "Minor", description: "Include compatible features" },
        ],
      },
    ],
    allowNotes: true,
    maxTextLength: 4_000,
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
  });
}

export async function choosePreset(ctx: ExtensionCommandContext, generation: number) {
  const previousPreview = "minimal";
  let preview = previousPreview;
  let result: RunLiveChoiceResult<"minimal" | "full", "customize"> | undefined;
  try {
    result = await runLiveChoice(ctx, {
      title: "Preset",
      items: [
        { id: "minimal", label: "Minimal" },
        { id: "full", label: "Full" },
      ],
      currentItemId: "minimal",
      shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
      signal: currentSessionSignal(),
      isCurrent: () => generation === currentGeneration(),
      onSelectionChange: ({ item, signal }) => {
        if (!signal.aborted) preview = item.id;
      },
    });
  } finally {
    preview = previousPreview;
  }
  return { result, preview };
}

export async function driveMenuWithSupportedTuiHarness() {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const ctx = {
    ...consumerContext,
    mode: "tui" as const,
    hasUI: true,
    ui: { ...consumerContext.ui, custom: tui.custom },
  };
  const running = runMenu(ctx, menu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("12");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  tui.resize({ width: 60, rows: 12 });
  const frame = tui.render();
  const result = await running;
  return { frame, result };
}

export async function driveMenuWithSupportedRpcHarness() {
  const rpc = createRpcHarness([
    { kind: "input", title: "Value", placeholder: "", response: "not-a-number" },
    { kind: "input", title: "Value", placeholder: "", response: "12" },
    { kind: "select", options: ["Apply", "Back"], response: "Apply" },
  ]);
  const ctx = {
    ...consumerContext,
    mode: "rpc" as const,
    hasUI: true,
    ui: { ...consumerContext.ui, ...rpc.ui },
  };
  const result = await runMenu(ctx, menu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
  });
  rpc.assertConsumed();
  return result;
}
