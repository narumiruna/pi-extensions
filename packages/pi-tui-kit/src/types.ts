import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Common, version-neutral Pi context capabilities used by the menu runtime. */
export interface MenuContext {
  mode: ExtensionContext["mode"];
  hasUI: boolean;
  ui: object;
}

export type MenuCloseReason = "back" | "close";

export type MenuTransition<ScreenId extends string> =
  | { kind: "stay" }
  | { kind: "back" }
  | { kind: "close" }
  | { kind: "to"; screen: ScreenId };

export type MenuActionResult<ScreenId extends string> =
  | MenuTransition<ScreenId>
  | { kind: "rejected"; error?: unknown }
  | undefined;

export interface MenuActionContext<State, Context extends MenuContext = ExtensionCommandContext> {
  ctx: Context;
  state: State;
  signal: AbortSignal;
  itemId: string;
  value?: string;
  selected?: boolean;
}

export type MenuActionHandler<State, ScreenId extends string, Context extends MenuContext = ExtensionCommandContext> = (
  context: MenuActionContext<State, Context>,
) => MenuActionResult<ScreenId> | Promise<MenuActionResult<ScreenId>>;

interface MenuItemBase {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

type ActionMenuItemBase = MenuItemBase & {
  disabledReason?: string;
};

export type ActionMenuItem<ScreenId extends string, ActionId extends string> =
  | (ActionMenuItemBase & { to: ScreenId; action?: never; close?: never })
  | (ActionMenuItemBase & {
      action: ActionId;
      to?: never;
      close?: never;
      busyLabel?: string;
    })
  | (ActionMenuItemBase & { close: true; to?: never; action?: never });

export interface ActionsScreen<ScreenId extends string, ActionId extends string> {
  kind: "actions";
  title: string;
  lines?: readonly string[];
  items: readonly ActionMenuItem<ScreenId, ActionId>[];
  hint?: "back" | "close";
}

export interface DetailScreen {
  kind: "detail";
  title: string;
  lines: readonly string[];
  hint?: "back" | "close";
}

export interface MenuChoiceItem extends MenuItemBase {
  details?: readonly string[];
  disabledReason?: string;
  /** Additional non-rendered text used by optional TUI fuzzy search. */
  searchText?: string;
}

export interface ChoiceScreen<ActionId extends string> {
  kind: "choice";
  title: string;
  lines?: readonly string[];
  items: readonly MenuChoiceItem[];
  action: ActionId;
  currentItemId?: string;
  initialItemId?: string;
  /** Enables TUI-only fuzzy filtering while RPC keeps one deterministic unfiltered list. */
  enableSearch?: boolean;
  viewportSize?: number;
  hint?: "back" | "close";
}

export type ReviewFormat =
  | { kind: "text" }
  | { kind: "code"; language?: string; filePath?: string }
  | { kind: "diff"; filePath?: string }
  | { kind: "markdown"; renderLatex?: boolean; renderMermaid?: boolean };

/** Exact full-body content for a browse detail view. */
export interface BrowseDetailDocument {
  content: string;
  format?: ReviewFormat;
}

export interface MenuBrowseItem {
  id: string;
  label: string;
  description?: string;
  /** Textual state shown with the row and in legacy detail. */
  statusText?: string;
  /** Additional non-rendered text used by TUI fuzzy search. */
  searchText?: string;
  /** Legacy prose lines normalized for display. Ignored when detailDocument is present. */
  details?: readonly string[];
  /** Exact full detail body. Content is not included in fuzzy search. */
  detailDocument?: BrowseDetailDocument;
}

export interface BrowseScreen {
  kind: "browse";
  title: string;
  lines?: readonly string[];
  items: readonly MenuBrowseItem[];
  /** Omitted or "adaptive" fills the live terminal budget; a number caps visible item rows. */
  viewportSize?: number | "adaptive";
  /** Enable TUI-only literal search after opening an item's detail view. */
  enableDetailSearch?: boolean;
  hint?: "back" | "close";
}

export interface MenuSettingItem<ActionId extends string> extends MenuItemBase {
  currentValue: string;
  values?: readonly string[];
  action: ActionId;
}

export interface SettingsScreen<ActionId extends string> {
  kind: "settings";
  title: string;
  lines?: readonly string[];
  items: readonly MenuSettingItem<ActionId>[];
}

export interface InputScreen<ActionId extends string> {
  kind: "input";
  title: string;
  lines?: readonly string[];
  placeholder?: string;
  /** Initial TUI draft; the cursor starts at the end. RPC dialogs cannot prefill this value. */
  initialValue?: string;
  action: ActionId;
  hint?: "back" | "close";
}

export const MAX_REVIEW_VIEWPORT_SIZE = 50;

export interface ReviewConfirmation<ActionId extends string> {
  id: string;
  label: string;
  action: ActionId;
}

export interface ReviewScreen<ActionId extends string> {
  kind: "review";
  title: string;
  lines?: readonly string[];
  content: string;
  format?: ReviewFormat;
  viewportSize?: number | "adaptive";
  /** Enable TUI-only literal search over displayed document text. */
  enableSearch?: boolean;
  confirm?: ReviewConfirmation<ActionId>;
  hint?: "back" | "close";
}

export interface MenuMultiSelectItem extends MenuItemBase {
  selected: boolean;
  disabledReason?: string;
  /** Additional non-rendered text used by optional TUI fuzzy search. */
  searchText?: string;
}

export interface MultiSelectScreen<ScreenId extends string, ActionId extends string> {
  kind: "multiSelect";
  title: string;
  lines?: readonly string[];
  items: readonly MenuMultiSelectItem[];
  action: ActionId;
  /** Enables TUI-only fuzzy filtering over labels and item search text. */
  enableSearch?: boolean;
  viewportSize?: number;
  actions?: readonly ActionMenuItem<ScreenId, ActionId>[];
  hint?: "back" | "close";
  doneLabel?: string;
}

export type MenuScreen<ScreenId extends string, ActionId extends string> =
  | ActionsScreen<ScreenId, ActionId>
  | DetailScreen
  | BrowseScreen
  | ChoiceScreen<ActionId>
  | SettingsScreen<ActionId>
  | InputScreen<ActionId>
  | ReviewScreen<ActionId>
  | MultiSelectScreen<ScreenId, ActionId>;

export interface MenuScreenContext<State> {
  state: State;
}

export type MenuScreenFactory<State, ScreenId extends string, ActionId extends string> = (
  context: MenuScreenContext<State>,
) => MenuScreen<ScreenId, ActionId>;

export interface MenuDefinition<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
> {
  start: ScreenId;
  screens: Record<ScreenId, MenuScreenFactory<State, ScreenId, ActionId>>;
  actions: Record<ActionId, MenuActionHandler<State, ScreenId, Context>>;
}
