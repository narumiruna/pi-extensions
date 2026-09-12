import {
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ActionMenuItem, MenuMultiSelectItem } from "../types.js";
import type { MenuChangeResponse, MenuScreenComponent, MultiSelectOptions } from "./contracts.js";
import {
  actionMenuItemPresentation,
  actionMenuUnavailableDescription,
  handleSearchInput,
  renderFrameLayout,
  safeMenuText,
} from "./rendering.js";

type ToggleRow = { kind: "toggle"; item: MenuMultiSelectItem };
type ActionRow<ScreenId extends string, ActionId extends string> = {
  kind: "action";
  item: ActionMenuItem<ScreenId, ActionId>;
};
type MultiSelectRow<ScreenId extends string, ActionId extends string> = ToggleRow | ActionRow<ScreenId, ActionId>;

export function createMultiSelectComponent<ScreenId extends string, ActionId extends string>(
  options: MultiSelectOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const searchInput = new Input();
  const toggleRows: ToggleRow[] = options.screen.items.map((item) => ({ kind: "toggle", item }));
  const actionRows: ActionRow<ScreenId, ActionId>[] = (options.screen.actions ?? []).map((item) => ({
    kind: "action",
    item,
  }));
  const searchableRows = toggleRows.map((row) => ({
    row,
    text: [safeMenuText(row.item.label), safeMenuText(row.item.searchText ?? "")].filter(Boolean).join(" "),
  }));
  let rows: MultiSelectRow<ScreenId, ActionId>[] = [...toggleRows, ...actionRows];
  const selected = new Map(options.screen.items.map((item) => [item.id, item.selected]));
  const committedSelected = new Map(selected);
  const revisions = new Map<string, number>();
  let selectedIndex = Math.max(
    0,
    rows.findIndex(({ item }) => item.id === options.selectedItemId),
  );
  let restoreItemId: string | undefined;
  let pending = Promise.resolve();
  let closing = false;
  let disposed = false;
  let mousePressedIndex: number | undefined;
  let mouseLayout:
    | {
        width: number;
        inputFrameRow?: number;
        itemByFrameRow: ReadonlyMap<number, number>;
      }
    | undefined;
  const selectedRow = () => rows[selectedIndex];
  const closeAfterPending = (kind: "back" | "close") => {
    if (closing || disposed) return;
    closing = true;
    void pending.then(() => {
      if (!disposed) options.onEvent({ kind });
    });
  };
  const setSelectedIndex = (index: number, rememberUserSelection: boolean) => {
    if (rows.length === 0) {
      selectedIndex = 0;
      return;
    }
    selectedIndex = Math.max(0, Math.min(index, rows.length - 1));
    const row = selectedRow();
    if (!row) return;
    if (rememberUserSelection) restoreItemId = undefined;
    options.onSelectionChange?.(row.item.id);
  };
  const selectIndex = (index: number) => setSelectedIndex(index, true);
  const move = (delta: number) => {
    if (rows.length === 0) return;
    selectIndex((selectedIndex + delta + rows.length) % rows.length);
  };
  const applyFilter = () => {
    if (!options.screen.enableSearch) return;
    mousePressedIndex = undefined;
    const previouslySelectedId = selectedRow()?.item.id;
    const filteredRows = fuzzyFilter(searchableRows, searchInput.getValue(), (candidate) => candidate.text).map(
      (candidate) => candidate.row,
    );
    rows = [...filteredRows, ...actionRows];
    if (rows.length === 0) {
      if (previouslySelectedId) restoreItemId ??= previouslySelectedId;
      selectedIndex = 0;
      return;
    }
    const previousIndex = rows.findIndex((row) => row.item.id === previouslySelectedId);
    if (previousIndex < 0 && previouslySelectedId) restoreItemId ??= previouslySelectedId;
    const restoreIndex = rows.findIndex((row) => row.item.id === restoreItemId);
    const nextIndex = restoreIndex >= 0 ? restoreIndex : previousIndex >= 0 ? previousIndex : 0;
    if (restoreIndex >= 0) restoreItemId = undefined;
    setSelectedIndex(nextIndex, false);
  };
  const activate = () => {
    const row = selectedRow();
    if (!row || row.item.disabled) return;
    restoreItemId = undefined;
    if (row.kind === "action") {
      if (closing || disposed) return;
      closing = true;
      void pending.then(() => {
        if (!disposed) options.onEvent({ kind: "activate", itemId: row.item.id });
      });
      return;
    }
    const item = row.item;
    const previousSelected = selected.get(item.id) ?? false;
    const nextSelected = !previousSelected;
    selected.set(item.id, nextSelected);
    const revision = (revisions.get(item.id) ?? 0) + 1;
    revisions.set(item.id, revision);
    const operation = pending.then(async () => {
      if (disposed) return;
      let response: MenuChangeResponse<ScreenId> = false;
      try {
        response =
          (await options.onMultiSelectChange?.({
            itemId: item.id,
            selected: nextSelected,
            previousSelected,
          })) ?? false;
      } catch (error) {
        options.onError?.(error);
      }
      if (disposed) return;
      const accepted = typeof response === "boolean" ? response : response.accepted;
      if (accepted) committedSelected.set(item.id, nextSelected);
      else if (revisions.get(item.id) === revision) {
        selected.set(item.id, committedSelected.get(item.id) ?? false);
      }
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
  const component: MenuScreenComponent & Partial<Focusable> = {
    render(width) {
      const safeWidth = Math.max(1, width);
      const requestedViewport = options.screen.viewportSize ?? 13;
      const viewportSize = Math.min(requestedViewport, rows.length);
      const viewportStart = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(viewportSize / 2), rows.length - viewportSize),
      );
      const visibleRows = rows.slice(viewportStart, viewportStart + viewportSize);
      const rowContent = visibleRows.map((row, offset) => {
        const index = viewportStart + offset;
        const isSelected = index === selectedIndex;
        const prefix = isSelected ? "› " : "  ";
        const label =
          row.kind === "action"
            ? `${prefix}${actionMenuItemPresentation(row.item).label}`
            : `${prefix}${
                row.item.disabled ? "[-]" : selected.get(row.item.id) ? "[x]" : "[ ]"
              } ${safeMenuText(row.item.label)}${row.item.disabled ? " (unavailable)" : ""}`;
        const boundedLabel =
          row.kind === "action" ? truncateToWidth(label, safeWidth, safeWidth > 1 ? "…" : "") : label;
        if (isSelected) return options.theme.fg("accent", boundedLabel);
        return row.item.disabled ? options.theme.fg("dim", boundedLabel) : boundedLabel;
      });
      if (viewportSize < rows.length) {
        rowContent.push(options.theme.fg("dim", `  (${selectedIndex + 1}/${rows.length})`));
      }
      const row = selectedRow();
      const descriptions = row
        ? row.kind === "action"
          ? [actionMenuUnavailableDescription(row.item), actionMenuItemPresentation(row.item).description].filter(
              (value): value is string => Boolean(value),
            )
          : [
              row.item.description,
              row.item.disabled
                ? row.item.disabledReason
                  ? `Unavailable: ${row.item.disabledReason}`
                  : "Unavailable"
                : undefined,
            ].filter((value): value is string => Boolean(value))
        : [];
      const descriptionRows = descriptions.flatMap((description) =>
        wrapTextWithAnsi(options.theme.fg("dim", `  ${safeMenuText(description)}`), safeWidth),
      );
      if (descriptionRows.length > 0) rowContent.push("", ...descriptionRows);
      const hasMatchingItems = rows.some((candidate) => candidate.kind === "toggle");
      const searchEmptyStateRows =
        options.screen.enableSearch && (options.screen.items.length === 0 || !hasMatchingItems) ? 1 : 0;
      const content = options.screen.enableSearch
        ? [
            ...searchInput.render(safeWidth),
            "",
            ...(options.screen.items.length === 0
              ? [options.theme.fg("dim", "  No items available")]
              : !hasMatchingItems
                ? [options.theme.fg("dim", "  No matching items")]
                : []),
            ...rowContent,
            ...(hasMatchingItems ? [options.theme.fg("dim", "Type to search")] : []),
          ]
        : rowContent;
      const frame = renderFrameLayout(
        options.screen.title,
        options.screen.lines ?? [],
        content,
        options.screen.hint ?? "back",
        width,
        options,
        {
          compactOverflowText: rows.length > 1 ? `  (${selectedIndex + 1}/${rows.length})` : undefined,
          confirmAction: row?.kind === "action" ? "select" : "toggle",
          pinnedContentRows: options.screen.enableSearch ? (hasMatchingItems ? 1 : 2) : 0,
          priorityTailRows: descriptionRows.length + (options.screen.enableSearch && hasMatchingItems ? 1 : 0),
        },
      );
      const rowContentStart = options.screen.enableSearch ? 2 + searchEmptyStateRows : 0;
      mouseLayout = {
        width: safeWidth,
        inputFrameRow: options.screen.enableSearch
          ? frame.contentRows.find(({ contentIndex }) => contentIndex === 0)?.frameIndex
          : undefined,
        itemByFrameRow: new Map(
          visibleRows.flatMap((_, offset) => {
            const frameRow = frame.contentRows.find(
              ({ contentIndex }) => contentIndex === rowContentStart + offset,
            )?.frameIndex;
            return frameRow === undefined ? [] : [[frameRow, viewportStart + offset] as const];
          }),
        ),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      if (options.screen.enableSearch) searchInput.invalidate();
    },
    handleInput(data) {
      if (disposed || closing) return;
      mousePressedIndex = undefined;
      if (matchesKey(data, Key.ctrl("c"))) closeAfterPending("close");
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        closeAfterPending(options.screen.hint ?? "back");
      } else if (options.keybindings.matches(data, "tui.select.up")) move(-1);
      else if (options.keybindings.matches(data, "tui.select.down")) move(1);
      else if (options.keybindings.matches(data, "tui.select.pageUp")) {
        selectIndex(selectedIndex - (options.screen.viewportSize ?? 13));
      } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        selectIndex(selectedIndex + (options.screen.viewportSize ?? 13));
      } else if (options.keybindings.matches(data, "tui.select.confirm") || data === " ") {
        activate();
      } else if (options.screen.enableSearch) {
        handleSearchInput(searchInput, data);
        applyFilter();
      }
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed || closing || !mouseLayout || event.width !== mouseLayout.width) return undefined;
      if (options.screen.enableSearch && event.y === mouseLayout.inputFrameRow) {
        return searchInput.handleMouse({ ...event, y: 0, width: mouseLayout.width, height: 1 });
      }
      return routeRowsMouse(event);
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
  if (options.screen.enableSearch) {
    Object.defineProperty(component, "focused", {
      get: () => searchInput.focused,
      set: (value: boolean) => {
        searchInput.focused = value;
      },
    });
  }
  function routeRowsMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!mouseLayout || rows.length === 0) return undefined;
    const mappedIndex = mouseLayout.itemByFrameRow.get(event.y);
    if (mappedIndex === undefined) return undefined;
    const itemIndex = event.type === "click" ? (mousePressedIndex ?? mappedIndex) : mappedIndex;
    if (itemIndex < 0 || itemIndex >= rows.length) return undefined;
    if (event.type === "wheel" && event.wheelDelta) {
      const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + (event.wheelDelta < 0 ? -1 : 1)));
      const changed = next !== selectedIndex;
      if (changed) selectIndex(next);
      return { handled: true, render: changed };
    }
    if (event.type === "move") return { handled: true };
    if (event.button !== "left") return undefined;
    if (event.type === "press") {
      mousePressedIndex = itemIndex;
      const changed = itemIndex !== selectedIndex;
      if (changed) selectIndex(itemIndex);
      return { handled: true, focus: true, render: changed };
    }
    if (event.type === "click") {
      mousePressedIndex = undefined;
      if (itemIndex !== selectedIndex) selectIndex(itemIndex);
      activate();
      return { handled: true };
    }
    return undefined;
  }

  return component;
}
