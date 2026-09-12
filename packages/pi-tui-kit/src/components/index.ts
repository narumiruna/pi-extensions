import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MenuScreen, MenuSettingItem } from "../types.js";
import { createBrowseComponent } from "./browse.js";
import type {
  BrowseOptions,
  MenuChangeResponse,
  MenuKeybindings,
  MenuScreenComponent,
  MenuScreenComponentOptions,
  MultiSelectOptions,
} from "./contracts.js";
import { createInputComponent, type InputOptions } from "./input.js";
import { createMultiSelectComponent } from "./multi-select.js";
import {
  actionMenuItemPresentation,
  actionMenuUnavailableDescription,
  handleSearchInput,
  renderFrame,
  renderFrameLayout,
  safeMenuText,
} from "./rendering.js";
import { createReviewComponent, type ReviewOptions } from "./review.js";

export { browseDialogLabel, browseDialogPages } from "./browse.js";
export type {
  MenuInputSubmit,
  MenuMultiSelectChange,
  MenuScreenComponent,
  MenuScreenComponentOptions,
  MenuScreenEvent,
  MenuSettingChange,
} from "./contracts.js";
export { prepareMenuScreenRendering } from "./mermaid.js";
export { actionMenuDialogLabel, safeMenuText } from "./rendering.js";
export { reviewDialogPages } from "./review.js";

export function createMenuScreenComponent<ScreenId extends string, ActionId extends string>(
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  let component: MenuScreenComponent;
  switch (options.screen.kind) {
    case "actions":
      component = createActionsComponent(options as ActionsOptions<ScreenId, ActionId>);
      break;
    case "detail":
      component = createDetailComponent(options as DetailOptions<ScreenId, ActionId>);
      break;
    case "browse":
      component = createBrowseComponent(options as BrowseOptions<ScreenId, ActionId>);
      break;
    case "choice":
      component = createChoiceComponent(options as ChoiceOptions<ScreenId, ActionId>);
      break;
    case "settings":
      component = createSettingsComponent(options as SettingsOptions<ScreenId, ActionId>);
      break;
    case "input":
      component = createInputComponent(options as InputOptions<ScreenId, ActionId>);
      break;
    case "review":
      component = createReviewComponent(options as ReviewOptions<ScreenId, ActionId>);
      break;
    case "multiSelect":
      component = createMultiSelectComponent(options as MultiSelectOptions<ScreenId, ActionId>);
      break;
  }
  Object.defineProperty(component, "__piTuiKitScreen", { value: true });
  return component;
}

type ActionsOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "actions" }>;
};
type DetailOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "detail" }>;
};
type ChoiceOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "choice" }>;
};
type SettingsOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "settings" }>;
};
function createActionsComponent<ScreenId extends string, ActionId extends string>(
  options: ActionsOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const items: SelectItem[] = options.screen.items.map((item) => ({
    value: item.id,
    ...actionMenuItemPresentation(item),
  }));
  const widestPrimary = Math.max(1, ...items.map((item) => visibleWidth(item.label))) + 2;
  const list = new SelectList(items, Math.min(items.length, 10), selectTheme(options.theme), {
    minPrimaryColumnWidth: Math.min(32, widestPrimary),
    maxPrimaryColumnWidth: widestPrimary,
    truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, maxWidth > 1 ? "…" : ""),
  });
  setInitialSelection(list, items, options.selectedItemId);
  return commonListComponent(
    options,
    list,
    items,
    options.screen.lines ?? [],
    options.screen.hint ?? "back",
    (itemId) => {
      const source = options.screen.items.find((candidate) => candidate.id === itemId);
      if (!source?.disabled) options.onEvent({ kind: "activate", itemId });
    },
    (itemId) => {
      const source = options.screen.items.find((candidate) => candidate.id === itemId);
      if (!source) return [];
      const unavailable = actionMenuUnavailableDescription(source);
      return unavailable ? [unavailable] : [];
    },
  );
}

function createDetailComponent<ScreenId extends string, ActionId extends string>(
  options: DetailOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  let disposed = false;
  return {
    render(width) {
      return renderFrame(
        options.screen.title,
        options.screen.lines,
        [],
        options.screen.hint ?? "back",
        width,
        options,
        { confirmAction: "", navigation: false },
      );
    },
    invalidate() {},
    handleInput(data) {
      if (disposed) return;
      if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onEvent({ kind: options.screen.hint ?? "back" });
      }
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      options.onDispose?.();
    },
  };
}

function createChoiceComponent<ScreenId extends string, ActionId extends string>(
  options: ChoiceOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const searchInput = new Input();
  const restoredSearchQuery = options.searchQuery ?? "";
  if (restoredSearchQuery) handleSearchInput(searchInput, restoredSearchQuery);
  const allItems = options.screen.items.map((item) => {
    const current = item.id === options.screen.currentItemId ? " ✓ current" : "";
    const unavailable = item.disabled
      ? `unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""}`
      : undefined;
    const label = safeMenuText(item.label);
    const description = item.description ? safeMenuText(item.description) : "";
    return {
      item,
      selectItem: {
        value: item.id,
        label: `${item.disabled ? "[-] " : ""}${label}${current}`,
        description:
          [unavailable, description].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
      } satisfies SelectItem,
      searchText: [
        safeChoiceText(item.label),
        safeChoiceText(item.description ?? ""),
        safeChoiceText(item.searchText ?? ""),
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
  let filteredItems = options.screen.enableSearch
    ? fuzzyFilter(allItems, searchInput.getValue(), (candidate) => candidate.searchText)
    : [...allItems];
  let selectedIndex = Math.max(
    0,
    filteredItems.findIndex(({ item }) => item.id === options.selectedItemId),
  );
  let restoreItemId: string | undefined;
  let disposed = false;
  let mousePressedIndex: number | undefined;
  let mouseLayout: ListMouseLayout | undefined;
  let list = createList();

  function pageSize() {
    return Math.min(filteredItems.length, options.screen.viewportSize ?? 10);
  }
  function createList() {
    const items = filteredItems.map(({ selectItem }) => selectItem);
    const next = new SelectList(
      items,
      Math.min(items.length, options.screen.viewportSize ?? 10),
      selectTheme(options.theme),
    );
    setInitialSelection(next, items, filteredItems[selectedIndex]?.item.id);
    return next;
  }
  const selected = () => filteredItems[selectedIndex]?.item;
  const setSelectedIndex = (index: number, wrap: boolean, rememberUserSelection: boolean) => {
    if (filteredItems.length === 0) {
      selectedIndex = 0;
      return;
    }
    selectedIndex = wrap
      ? (index + filteredItems.length) % filteredItems.length
      : Math.max(0, Math.min(index, filteredItems.length - 1));
    if (rememberUserSelection) restoreItemId = undefined;
    list.setSelectedIndex(selectedIndex);
    const item = selected();
    if (item) options.onSelectionChange?.(item.id);
  };
  const move = (delta: number) => setSelectedIndex(selectedIndex + delta, true, true);
  const applyFilter = () => {
    if (!options.screen.enableSearch) return;
    mousePressedIndex = undefined;
    const previouslySelectedId = selected()?.id;
    filteredItems = fuzzyFilter(allItems, searchInput.getValue(), (candidate) => candidate.searchText);
    if (filteredItems.length === 0) {
      if (previouslySelectedId) restoreItemId ??= previouslySelectedId;
      selectedIndex = 0;
      list = createList();
      return;
    }
    const previousIndex = filteredItems.findIndex(({ item }) => item.id === previouslySelectedId);
    if (previousIndex < 0 && previouslySelectedId) restoreItemId ??= previouslySelectedId;
    const restoreIndex = filteredItems.findIndex(({ item }) => item.id === restoreItemId);
    selectedIndex = restoreIndex >= 0 ? restoreIndex : previousIndex >= 0 ? previousIndex : 0;
    if (restoreIndex >= 0) restoreItemId = undefined;
    list = createList();
    const item = selected();
    if (item) options.onSelectionChange?.(item.id);
  };
  const activate = () => {
    const item = selected();
    if (item && !item.disabled) options.onEvent({ kind: "activate", itemId: item.id });
  };
  const component: MenuScreenComponent & Partial<Focusable> = {
    render(width) {
      const safeWidth = Math.max(1, width);
      const selectedItem = selected();
      const details = [
        ...(selectedItem?.disabledReason ? [`Unavailable: ${safeMenuText(selectedItem.disabledReason)}`] : []),
        ...(selectedItem?.details ?? []).map(safeMenuText),
      ];
      const detailRows = details.flatMap((line) => wrapTextWithAnsi(options.theme.fg("muted", line), safeWidth));
      const choices =
        allItems.length === 0
          ? [options.theme.fg("dim", "  No choices available")]
          : filteredItems.length === 0
            ? [options.theme.fg("dim", "  No matching choices")]
            : [...list.render(safeWidth), ...(detailRows.length > 0 ? ["", ...detailRows] : [])];
      const search = options.screen.enableSearch
        ? [
            ...renderChoiceSearchInput(searchInput, safeWidth),
            "",
            ...choices,
            ...(filteredItems.length > 0 ? [options.theme.fg("dim", "Type to search")] : []),
          ]
        : choices;
      const frame = renderFrameLayout(
        options.screen.title,
        options.screen.lines ?? [],
        search,
        options.screen.hint ?? "back",
        safeWidth,
        options,
        {
          compactOverflowText:
            filteredItems.length > 1 ? `  (${selectedIndex + 1}/${filteredItems.length})` : undefined,
          confirmAction: "select",
          pinnedContentRows: options.screen.enableSearch ? 1 : 0,
          priorityTailRows: detailRows.length + (options.screen.enableSearch ? 1 : 0),
        },
      );
      const listContentStart = options.screen.enableSearch ? 2 : 0;
      const visibleCount = Math.min(filteredItems.length, options.screen.viewportSize ?? 10);
      const viewportStart = listWindowStart(selectedIndex, filteredItems.length, visibleCount);
      mouseLayout = {
        width: safeWidth,
        inputFrameRow: options.screen.enableSearch ? frameRowForContent(frame, 0) : undefined,
        itemByFrameRow: itemRowsForFrame(frame, listContentStart, viewportStart, visibleCount),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      list.invalidate();
      if (options.screen.enableSearch) searchInput.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      mousePressedIndex = undefined;
      if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onEvent({ kind: options.screen.hint ?? "back" });
      } else if (options.keybindings.matches(data, "tui.select.up")) move(-1);
      else if (options.keybindings.matches(data, "tui.select.down")) move(1);
      else if (options.keybindings.matches(data, "tui.select.pageUp")) {
        setSelectedIndex(selectedIndex - Math.max(1, pageSize()), false, true);
      } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        setSelectedIndex(selectedIndex + Math.max(1, pageSize()), false, true);
      } else if (matchesKey(data, Key.home)) setSelectedIndex(0, false, true);
      else if (matchesKey(data, Key.end)) {
        setSelectedIndex(filteredItems.length - 1, false, true);
      } else if (
        options.keybindings.matches(data, "tui.select.confirm") ||
        (!options.screen.enableSearch && data === " ")
      ) {
        activate();
      } else if (options.screen.enableSearch) {
        handleSearchInput(searchInput, data);
        options.onSearchQueryChange?.(searchInput.getValue());
        applyFilter();
      }
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed) return undefined;
      const inputResult = routeInputMouse(searchInput, event, mouseLayout, options.screen.enableSearch ? 8 : 0);
      if (inputResult) return inputResult;
      return routeListMouse(event, mouseLayout, {
        selectedIndex,
        itemCount: filteredItems.length,
        onSelect: (index) => setSelectedIndex(index, false, true),
        onActivate: activate,
        getPressedIndex: () => mousePressedIndex,
        setPressedIndex: (index) => {
          mousePressedIndex = index;
        },
      });
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      mousePressedIndex = undefined;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
  if (options.screen.enableSearch) {
    Object.defineProperty(component, "focused", {
      get: () => searchInput.focused,
      set: (value: boolean) => {
        searchInput.focused = value;
      },
    });
  }
  return component;
}

function safeChoiceText(value: unknown): string {
  return safeMenuText(stripVTControlCharacters(String(value)));
}

function renderChoiceSearchInput(input: Input, width: number): string[] {
  const prefix = "Search: ";
  const inputWidth = Math.max(1, width - visibleWidth(prefix));
  return input.render(inputWidth).map((line) => truncateToWidth(`${prefix}${line}`, width, ""));
}

// Pi's current SettingsList cannot initialize its cursor, enforce disabled rows, expose search
// focus, or await rejected saves. Keep this adapter local while matching its public presentation.
function createSettingsComponent<ScreenId extends string, ActionId extends string>(
  options: SettingsOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const searchInput = new Input();
  const searchableItems = options.screen.items.map((item) => ({
    item,
    label: safeMenuText(item.label),
  }));
  let filteredItems = searchableItems;
  const committed = new Map(options.screen.items.map((item) => [item.id, item.currentValue]));
  const displayed = new Map(committed);
  const revisions = new Map<string, number>();
  let selectedIndex = Math.max(
    0,
    filteredItems.findIndex(({ item }) => item.id === options.selectedItemId),
  );
  let pending = Promise.resolve();
  let disposed = false;
  let closing = false;
  let mousePressedIndex: number | undefined;
  let mouseLayout: ListMouseLayout | undefined;
  const selectedItem = () => filteredItems[selectedIndex]?.item;
  const closeAfterPending = (kind: "back" | "close") => {
    if (closing || disposed) return;
    closing = true;
    void pending.then(() => {
      if (!disposed) options.onEvent({ kind });
    });
  };
  const select = (index: number) => {
    if (filteredItems.length === 0) return;
    selectedIndex = (index + filteredItems.length) % filteredItems.length;
    const item = selectedItem();
    if (item) options.onSelectionChange?.(item.id);
  };
  const applyFilter = () => {
    mousePressedIndex = undefined;
    filteredItems = fuzzyFilter(searchableItems, searchInput.getValue(), (candidate) => candidate.label);
    selectedIndex = 0;
    const item = selectedItem();
    if (item) options.onSelectionChange?.(item.id);
  };
  const activate = () => {
    const item = selectedItem();
    if (!item || item.disabled || closing || disposed) return;
    const values = item.values ?? [item.currentValue];
    if (values.length === 0) return;
    const currentValue = displayed.get(item.id) ?? item.currentValue;
    const currentIndex = values.indexOf(currentValue);
    const value = values[(currentIndex + 1) % values.length] ?? currentValue;
    displayed.set(item.id, value);
    const revision = (revisions.get(item.id) ?? 0) + 1;
    revisions.set(item.id, revision);
    const operation = pending.then(async () => {
      if (disposed) return;
      const previousValue = committed.get(item.id) ?? item.currentValue;
      let response: MenuChangeResponse<ScreenId> = false;
      try {
        response =
          (await options.onSettingChange?.({
            itemId: item.id,
            value,
            previousValue,
          })) ?? false;
      } catch (error) {
        options.onError?.(error);
      }
      if (disposed) return;
      const accepted = typeof response === "boolean" ? response : response.accepted;
      if (accepted) committed.set(item.id, value);
      else if (revisions.get(item.id) === revision) displayed.set(item.id, previousValue);
      options.tui.requestRender();
      if (accepted && typeof response !== "boolean") {
        closing = true;
        void pending.then(() => {
          if (!disposed) options.onTransition?.(response.transition);
        });
      }
    });
    pending = operation.catch(() => undefined);
  };
  const component: MenuScreenComponent & Focusable = {
    get focused() {
      return searchInput.focused;
    },
    set focused(value: boolean) {
      searchInput.focused = value;
    },
    render(width) {
      const safeWidth = Math.max(1, width);
      const settingsRows = renderSettingsRows(
        filteredItems,
        searchableItems,
        selectedIndex,
        displayed,
        safeWidth,
        options,
      );
      const content = [...searchInput.render(safeWidth), "", ...settingsRows.lines, ""];
      const frame = renderFrameLayout(
        options.screen.title,
        options.screen.lines ?? [],
        content,
        "back",
        safeWidth,
        options,
        {
          compactOverflowText:
            filteredItems.length > 1 ? `  (${selectedIndex + 1}/${filteredItems.length})` : undefined,
          confirmAction: "change",
          hint: settingsHint(options.keybindings),
          pinnedContentRows: 1,
          priorityTailRows: settingsRows.priorityTailRows,
        },
      );
      mouseLayout = {
        width: safeWidth,
        inputFrameRow: frameRowForContent(frame, 0),
        itemByFrameRow: itemRowsForFrame(frame, 2, settingsRows.viewportStart, settingsRows.visibleCount),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      searchInput.invalidate();
    },
    handleInput(data) {
      if (disposed || closing) return;
      mousePressedIndex = undefined;
      if (matchesKey(data, Key.ctrl("c"))) closeAfterPending("close");
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        closeAfterPending("back");
      } else if (options.keybindings.matches(data, "tui.select.up")) {
        select(selectedIndex - 1);
      } else if (options.keybindings.matches(data, "tui.select.down")) {
        select(selectedIndex + 1);
      } else if (options.keybindings.matches(data, "tui.select.pageUp")) select(0);
      else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        select(filteredItems.length - 1);
      } else if (options.keybindings.matches(data, "tui.select.confirm") || data === " ") {
        activate();
      } else {
        handleSearchInput(searchInput, data);
        applyFilter();
      }
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed || closing) return undefined;
      const inputResult = routeInputMouse(searchInput, event, mouseLayout, 0);
      if (inputResult) return inputResult;
      return routeListMouse(event, mouseLayout, {
        selectedIndex,
        itemCount: filteredItems.length,
        onSelect: select,
        onActivate: activate,
        getPressedIndex: () => mousePressedIndex,
        setPressedIndex: (index) => {
          mousePressedIndex = index;
        },
      });
    },
    waitForPending: () => pending,
    dispose() {
      if (disposed) return;
      disposed = true;
      mousePressedIndex = undefined;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
  return component;
}

function renderSettingsRows<ScreenId extends string, ActionId extends string>(
  filteredItems: readonly { item: MenuSettingItem<ActionId>; label: string }[],
  allItems: readonly { item: MenuSettingItem<ActionId>; label: string }[],
  selectedIndex: number,
  displayed: ReadonlyMap<string, string>,
  width: number,
  options: SettingsOptions<ScreenId, ActionId>,
): { lines: string[]; priorityTailRows: number; viewportStart: number; visibleCount: number } {
  if (allItems.length === 0) {
    return {
      lines: [options.theme.fg("dim", "  No settings available")],
      priorityTailRows: 1,
      viewportStart: 0,
      visibleCount: 0,
    };
  }
  if (filteredItems.length === 0) {
    return {
      lines: [options.theme.fg("dim", "  No matching settings")],
      priorityTailRows: 1,
      viewportStart: 0,
      visibleCount: 0,
    };
  }

  const maxVisible = Math.min(filteredItems.length, 10);
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
  );
  const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);
  const maxLabelWidth = Math.min(30, Math.max(...allItems.map((candidate) => visibleWidth(candidate.label))));
  const lines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const candidate = filteredItems[index];
    if (!candidate) continue;
    const { item, label } = candidate;
    const selected = index === selectedIndex;
    const prefix = selected ? options.theme.fg("accent", "→ ") : "  ";
    const labelPadded = label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(label)));
    const currentValue = safeMenuText(displayed.get(item.id) ?? item.currentValue);
    const value = item.disabled ? `(unavailable) ${currentValue}` : currentValue;
    const valueWidth = Math.max(0, width - visibleWidth(prefix) - maxLabelWidth - 2);
    let labelText = labelPadded;
    let valueText = truncateToWidth(value, valueWidth, "");
    if (selected) {
      labelText = options.theme.fg("accent", labelText);
      valueText = options.theme.fg("accent", valueText);
    } else if (item.disabled) {
      labelText = options.theme.fg("dim", labelText);
      valueText = options.theme.fg("dim", valueText);
    } else {
      valueText = options.theme.fg("muted", valueText);
    }
    lines.push(truncateToWidth(`${prefix}${labelText}  ${valueText}`, width, ""));
  }
  if (startIndex > 0 || endIndex < filteredItems.length) {
    lines.push(options.theme.fg("dim", `  (${selectedIndex + 1}/${filteredItems.length})`));
  }
  let priorityTailRows = 0;
  const selected = filteredItems[selectedIndex]?.item;
  if (selected?.description) {
    lines.push("");
    for (const line of wrapTextWithAnsi(safeMenuText(selected.description), Math.max(1, width - 4))) {
      lines.push(options.theme.fg("dim", `  ${line}`));
      priorityTailRows += 1;
    }
  }
  return { lines, priorityTailRows, viewportStart: startIndex, visibleCount: endIndex - startIndex };
}

function settingsHint(keybindings: MenuKeybindings) {
  const confirmKeys = uniqueHintKeys([...keybindings.getKeys("tui.select.confirm"), "space"]);
  const cancelKeys = uniqueHintKeys(keybindings.getKeys("tui.select.cancel").filter((key) => key !== "ctrl+c"));
  return [
    "Type to search",
    ...(confirmKeys ? [`${confirmKeys} to change`] : []),
    ...(cancelKeys ? [`${cancelKeys} to go back`] : []),
    "Ctrl+C to close",
  ].join(" · ");
}

function uniqueHintKeys(keys: readonly string[]) {
  return [...new Set(keys.map(displayHintKey).filter(Boolean))].join("/");
}

function displayHintKey(key: string) {
  if (key === "enter") return "Enter";
  if (key === "space") return "Space";
  if (key === "escape") return "Esc";
  if (key === "ctrl+c") return "Ctrl+C";
  if (key === "up") return "↑";
  if (key === "down") return "↓";
  return safeMenuText(key);
}

interface ListMouseLayout {
  width: number;
  inputFrameRow?: number;
  itemByFrameRow: ReadonlyMap<number, number>;
}

interface FrameContentLayout {
  contentRows: readonly { contentIndex: number; frameIndex: number }[];
}

interface ListMouseActions {
  selectedIndex: number;
  itemCount: number;
  onSelect(index: number): void;
  onActivate(): void;
  getPressedIndex(): number | undefined;
  setPressedIndex(index: number | undefined): void;
}

function frameRowForContent(frame: FrameContentLayout, contentIndex: number) {
  return frame.contentRows.find((row) => row.contentIndex === contentIndex)?.frameIndex;
}

function itemRowsForFrame(
  frame: FrameContentLayout,
  contentStart: number,
  viewportStart: number,
  visibleCount: number,
) {
  return new Map(
    Array.from({ length: visibleCount }, (_, offset) => {
      const frameRow = frameRowForContent(frame, contentStart + offset);
      return frameRow === undefined ? undefined : ([frameRow, viewportStart + offset] as const);
    }).filter((entry): entry is readonly [number, number] => entry !== undefined),
  );
}

function listWindowStart(selectedIndex: number, itemCount: number, viewportSize: number) {
  if (itemCount <= viewportSize) return 0;
  return Math.max(0, Math.min(selectedIndex - Math.floor(viewportSize / 2), itemCount - viewportSize));
}

function routeInputMouse(
  input: Input,
  event: TuiMouseEvent,
  layout: ListMouseLayout | undefined,
  xOffset: number,
): TuiMouseEventResult | undefined {
  if (!layout || event.width !== layout.width || event.y !== layout.inputFrameRow) return undefined;
  const inputWidth = Math.max(1, layout.width - xOffset);
  if (event.x < xOffset || event.x >= xOffset + inputWidth) return undefined;
  return input.handleMouse({ ...event, x: event.x - xOffset, y: 0, width: inputWidth, height: 1 });
}

function routeListMouse(
  event: TuiMouseEvent,
  layout: ListMouseLayout | undefined,
  actions: ListMouseActions,
): TuiMouseEventResult | undefined {
  if (!layout || event.width !== layout.width || actions.itemCount === 0) return undefined;
  const mappedIndex = layout.itemByFrameRow.get(event.y);
  if (mappedIndex === undefined) return undefined;
  const itemIndex = event.type === "click" ? (actions.getPressedIndex() ?? mappedIndex) : mappedIndex;
  if (itemIndex < 0 || itemIndex >= actions.itemCount) return undefined;
  if (event.type === "wheel" && event.wheelDelta) {
    const next = Math.max(0, Math.min(actions.itemCount - 1, actions.selectedIndex + (event.wheelDelta < 0 ? -1 : 1)));
    const changed = next !== actions.selectedIndex;
    if (changed) actions.onSelect(next);
    return { handled: true, render: changed };
  }
  if (event.type === "move") return { handled: true };
  if (event.button !== "left") return undefined;
  if (event.type === "press") {
    actions.setPressedIndex(itemIndex);
    const changed = itemIndex !== actions.selectedIndex;
    if (changed) actions.onSelect(itemIndex);
    return { handled: true, focus: true, render: changed };
  }
  if (event.type === "click") {
    actions.setPressedIndex(undefined);
    if (itemIndex !== actions.selectedIndex) actions.onSelect(itemIndex);
    actions.onActivate();
    return { handled: true };
  }
  return undefined;
}

function commonListComponent<ScreenId extends string, ActionId extends string>(
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
  list: SelectList,
  items: readonly SelectItem[],
  lines: readonly string[],
  destination: "back" | "close",
  onActivate: (itemId: string) => void,
  selectedDetails?: (itemId: string) => readonly string[],
): MenuScreenComponent {
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === options.selectedItemId),
  );
  let selectedIndex = initialIndex;
  let disposed = false;
  let mousePressedIndex: number | undefined;
  let mouseLayout: ListMouseLayout | undefined;
  const select = (index: number, wrap: boolean) => {
    if (items.length === 0) return;
    selectedIndex = wrap ? (index + items.length) % items.length : Math.max(0, Math.min(index, items.length - 1));
    list.setSelectedIndex(selectedIndex);
    const itemId = items[selectedIndex]?.value;
    if (itemId) options.onSelectionChange?.(itemId);
  };
  return {
    render(width) {
      const safeWidth = Math.max(1, width);
      const selectedId = items[selectedIndex]?.value;
      const details = selectedId ? (selectedDetails?.(selectedId) ?? []) : [];
      const detailRows = details.flatMap((detail) =>
        wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(detail)), safeWidth),
      );
      const content = [...list.render(safeWidth), ...(detailRows.length > 0 ? ["", ...detailRows] : [])];
      const frame = renderFrameLayout(options.screen.title, lines, content, destination, width, options, {
        compactOverflowText: items.length > 1 ? `  (${selectedIndex + 1}/${items.length})` : undefined,
        priorityTailRows: detailRows.length,
      });
      const visibleCount = Math.min(items.length, 10);
      mouseLayout = {
        width: safeWidth,
        itemByFrameRow: itemRowsForFrame(
          frame,
          0,
          listWindowStart(selectedIndex, items.length, visibleCount),
          visibleCount,
        ),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      list.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      mousePressedIndex = undefined;
      if (matchesKey(data, Key.ctrl("c"))) {
        options.onEvent({ kind: "close" });
        return;
      }
      if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onEvent({ kind: destination });
        return;
      }
      if (options.keybindings.matches(data, "tui.select.up")) select(selectedIndex - 1, true);
      else if (options.keybindings.matches(data, "tui.select.down")) {
        select(selectedIndex + 1, true);
      } else if (options.keybindings.matches(data, "tui.select.pageUp")) {
        select(selectedIndex - Math.max(1, Math.min(items.length, 10)), false);
      } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        select(selectedIndex + Math.max(1, Math.min(items.length, 10)), false);
      } else if (matchesKey(data, Key.home)) select(0, false);
      else if (matchesKey(data, Key.end)) select(items.length - 1, false);
      else if (options.keybindings.matches(data, "tui.select.confirm")) {
        const itemId = items[selectedIndex]?.value;
        if (itemId) onActivate(itemId);
      }
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed) return undefined;
      return routeListMouse(event, mouseLayout, {
        selectedIndex,
        itemCount: items.length,
        onSelect: (index) => select(index, false),
        onActivate: () => {
          const itemId = items[selectedIndex]?.value;
          if (itemId) onActivate(itemId);
        },
        getPressedIndex: () => mousePressedIndex,
        setPressedIndex: (index) => {
          mousePressedIndex = index;
        },
      });
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      mousePressedIndex = undefined;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
}

function selectTheme(theme: Pick<Theme, "fg">) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function setInitialSelection(list: SelectList, items: readonly SelectItem[], selectedId?: string) {
  if (!selectedId) return;
  const index = items.findIndex((item) => item.value === selectedId);
  if (index >= 0) list.setSelectedIndex(index);
}

export function settingForAction<ActionId extends string>(
  screen: Extract<MenuScreen<string, ActionId>, { kind: "settings" }>,
  itemId: string,
): MenuSettingItem<ActionId> | undefined {
  return screen.items.find((item) => item.id === itemId);
}
