import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import type { EditorStatusItemHandle } from "@narumitw/pi-tui-kit/editor-status-collection";
import type { EditorStatusMode, EditorStatusTrigger } from "@narumitw/pi-tui-kit/editor-status-view";
import { sanitizeProgressText } from "./progress-renderer.js";
import type { ProgressStep } from "./progress-state.js";
import type { ProgressSettings } from "./settings.js";

export interface ProgressMenuState {
  settings: ProgressSettings;
  settingsPath: string;
  widget: "disabled" | "hidden" | "empty" | "visible";
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  view: EditorStatusMode;
  pinned: boolean;
  trigger: EditorStatusTrigger;
  items: readonly { id: string; value: ProgressStep; mode: "expanded" | "compact" }[];
}

interface ProgressMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getState(): ProgressMenuState;
  hideWidget(): void;
  setView(mode: EditorStatusMode): void;
  setPinned(pinned: boolean): void;
  setTrigger(trigger: EditorStatusTrigger): void;
  item(id: string): EditorStatusItemHandle | undefined;
  refresh(): void;
  showSettings(signal: AbortSignal): Promise<"back" | "close" | "stale">;
}

export async function showProgressMenu(ctx: ExtensionCommandContext, options: ProgressMenuOptions): Promise<void> {
  let selected: { label: string; handle: EditorStatusItemHandle } | undefined;
  const menu = defineMenu<
    ProgressMenuState,
    "main" | "status" | "help" | "view" | "trigger" | "items" | "item",
    "settings" | "hide" | "view" | "pin" | "trigger" | "select-item" | "item"
  >({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Progress",
        lines: [`Widget: ${state.widget} · ${state.completed}/${state.total} steps completed`],
        items: [
          { id: "hide", label: "Clear widget", description: "Keep saved progress unchanged", action: "hide" },
          { id: "settings", label: "Settings", action: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          {
            id: "view",
            label: "Widget view",
            description: `${state.view}${state.pinned ? " · pinned" : ""}`,
            to: "view",
          },
          {
            id: "items",
            label: "Task items",
            description: `${state.items.length} displayed · ${state.total - state.items.length} removed`,
            to: "items",
          },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      view: ({ state }) => ({
        kind: "actions",
        title: "Progress Widget View",
        lines: [
          `View: ${state.view} · ${state.pinned ? "pinned" : "unpinned"} · trigger: ${state.trigger}`,
          "Session-local display only. Saved progress is unchanged.",
        ],
        items: [
          { id: "default", label: "Show default view", action: "view" },
          { id: "expanded", label: "Show detailed view", action: "view" },
          { id: "compact", label: "Show compact view", action: "view" },
          { id: "hidden", label: state.view === "hidden" ? "Show widget" : "Hide widget", action: "view" },
          {
            id: "pin",
            label: state.pinned ? "Unpin widget" : "Pin widget",
            description: "Pause completion expiry and automatic compaction",
            action: "pin",
          },
          { id: "trigger", label: "Automatic compaction", description: "Opt-in; consumed once", to: "trigger" },
        ],
      }),
      trigger: ({ state }) => ({
        kind: "actions",
        title: "Progress Automatic Compaction",
        lines: [
          `Selected: ${state.trigger}`,
          "Blocked work and pins prevent automatic compaction.",
          "User messages include extension-generated user messages.",
        ],
        items: [
          { id: "manual", label: "Manual only", action: "trigger" },
          { id: "user-message", label: "Next consumed user message", action: "trigger" },
          {
            id: "settled-cycle",
            label: "Next eligible future user cycle settled",
            description: "Exclude the current cycle; wait through retries and queued work",
            action: "trigger",
          },
        ],
      }),
      items: ({ state }) => ({
        kind: "choice",
        title: "Progress Task Items",
        lines: [
          `${state.total} saved · ${state.total - state.items.length} removed from display`,
          "Item controls never edit saved steps. Branch navigation resets them.",
        ],
        items: state.items.map((item, index) => ({
          id: item.id,
          label: `${index + 1}. ${sanitizeProgressText(item.value.text) || "(text hidden after sanitization)"}`,
          description: `${item.value.status} · ${item.mode}`,
        })),
        action: "select-item",
      }),
      item: () => ({
        kind: "actions",
        title: "Progress Task Item",
        lines: [selected?.label ?? "Item is no longer available", "Display only; this does not change or cancel work."],
        items: [
          { id: "compact", label: "Compact item", action: "item" },
          { id: "expand", label: "Expand item", action: "item" },
          { id: "remove", label: "Remove item from display", action: "item" },
        ],
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Progress Status",
        lines: [
          `Widget: ${state.widget}`,
          `View: ${state.view} · ${state.pinned ? "pinned" : "unpinned"} · trigger: ${state.trigger}`,
          `Display items: ${state.items.length} · removed: ${state.total - state.items.length}`,
          `Steps: ${state.total} total, ${state.completed} completed, ${state.inProgress} in progress, ${state.blocked} blocked`,
          `Enabled: ${state.settings.enabled}`,
          `Display mode: ${state.settings.displayMode}`,
          `Show completed: ${state.settings.showCompleted}`,
          `Visible item limit: ${state.settings.maxVisibleItems ?? "none"}`,
          `Show completion count: ${state.settings.showProgress}`,
          `User settings: ${sanitizeProgressText(state.settingsPath)}`,
        ],
      }),
      help: () => ({
        kind: "detail",
        title: "Progress Help",
        lines: [
          "/progress opens this menu.",
          "Settings edits user display preferences in TUI mode; RPC reports the file path.",
          "Successful settings saves apply immediately. Manual edits require /reload.",
          "Clear widget keeps saved progress unchanged. Updates or branch navigation can show it again; reload can show incomplete progress again.",
          "/progress settings opens the same settings screen directly.",
          "/progress clear hides the widget directly.",
          "Widget view controls detail, compact, sticky hide/show, pin, and opt-in automatic compaction.",
          "Task items controls display only. Session start and branch navigation reset all view and item choices.",
          "The model updates steps through update_progress; there is no manual progress editor.",
        ],
      }),
    },
    actions: {
      view: ({ signal, itemId, state }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        options.setView(itemId === "hidden" && state.view === "hidden" ? "default" : (itemId as EditorStatusMode));
        return { kind: "stay" };
      },
      pin: ({ signal, state }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        options.setPinned(!state.pinned);
        return { kind: "stay" };
      },
      trigger: ({ signal, itemId }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        options.setTrigger(itemId as EditorStatusTrigger);
        return { kind: "stay" };
      },
      "select-item": ({ signal, itemId, state }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        const item = state.items.find((item) => item.id === itemId);
        const handle = options.item(itemId);
        if (!item || !handle) return { kind: "stay" };
        selected = { label: sanitizeProgressText(item.value.text), handle };
        return { kind: "to", screen: "item" };
      },
      item: ({ signal, itemId }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        const changed =
          itemId === "remove"
            ? selected?.handle.remove()
            : itemId === "compact"
              ? selected?.handle.compact()
              : selected?.handle.expand();
        if (changed) options.refresh();
        else ctx.ui.notify("Item unchanged or replaced. Select the current item again if needed.", "info");
        return itemId === "remove" ? { kind: "back" } : { kind: "stay" };
      },
      settings: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        const reason = await options.showSettings(signal);
        if (signal.aborted || !options.isCurrent() || reason !== "back") return { kind: "close" };
        return { kind: "stay" };
      },
      hide: ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        options.hideWidget();
        return { kind: "stay" };
      },
    },
  });
  await runMenu(ctx, menu, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    getState: options.getState,
    onError: (_ctx, error) => {
      if (options.signal.aborted || !options.isCurrent()) return;
      ctx.ui.notify(
        sanitizeProgressText(`Progress menu failed: ${error instanceof Error ? error.message : String(error)}`),
        "error",
      );
    },
  });
}
