import { stripVTControlCharacters } from "node:util";
import {
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatInteractionHints } from "../interaction-hints.js";
import type { MenuBrowseItem } from "../types.js";
import type { BrowseOptions, MenuKeybindings, MenuScreenComponent } from "./contracts.js";
import {
  createDocumentLineCache,
  type DocumentPresentation,
  documentDialogPages,
  RPC_DOCUMENT_LINE_WIDTH,
  RPC_DOCUMENT_PAGE_SIZE,
} from "./document-formatting.js";
import {
  DOCUMENT_SEARCH_ACTIVATE_KEY,
  DocumentSearchController,
  documentSearchActionMatches,
  documentSearchActivationAvailable,
} from "./document-search.js";
import { componentRows, handleSearchInput, renderHorizontalRule, safeMenuText } from "./rendering.js";
import { reviewDialogPages } from "./review.js";

const MAX_CONTEXT_ROWS = 2;
const MIN_FRAMED_ROWS = 5;

type BrowseView = "list" | "detail";

interface SearchableItem {
  item: MenuBrowseItem;
  label: string;
  statusText: string;
  description: string;
  searchText: string;
}

export function createBrowseComponent<ScreenId extends string, ActionId extends string>(
  options: BrowseOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const searchInput = new Input();
  const detailSearch = options.screen.enableDetailSearch ? new DocumentSearchController() : undefined;
  const detailSearchActivationAvailable = Boolean(
    detailSearch && documentSearchActivationAvailable(options.keybindings, false),
  );
  const allItems: SearchableItem[] = options.screen.items.map((item) => ({
    item,
    label: safeBrowseText(item.label),
    statusText: safeBrowseText(item.statusText ?? ""),
    description: safeBrowseText(item.description ?? ""),
    searchText: safeBrowseText(item.searchText ?? ""),
  }));
  let filteredItems = [...allItems];
  let selectedIndex = Math.max(
    0,
    filteredItems.findIndex(({ item }) => item.id === options.selectedItemId),
  );
  let restoreItemId: string | undefined;
  let listViewportRows = 1;
  let searchInputVisible = true;
  let detailScrollOffset = 0;
  let detailViewportRows = 1;
  let detailMaximumScroll = 0;
  let lastDetailLines: readonly string[] = [];
  let lastDetailSoftWrapAfter: readonly boolean[] = [];
  let lastDetailIgnoreLeadingWhitespace: readonly boolean[] = [];
  let lastDetailSearchSources: DocumentPresentation["searchSources"] = [];
  let view: BrowseView = "list";
  let focused = false;
  let disposed = false;
  const detailLineCache = createDocumentLineCache(options.theme, Boolean(options.screen.enableDetailSearch));
  const selected = () => filteredItems[selectedIndex];
  const syncFocus = () => {
    searchInput.focused = focused && view === "list" && searchInputVisible;
    if (detailSearch) detailSearch.focused = focused && view === "detail";
  };
  const moveToDetailMatch = (row: number | undefined) => {
    if (row === undefined) return;
    if (row < detailScrollOffset) detailScrollOffset = row;
    else if (row >= detailScrollOffset + detailViewportRows) {
      detailScrollOffset = row - detailViewportRows + 1;
    }
  };
  const setSelectedIndex = (index: number, wrap: boolean, rememberUserSelection: boolean) => {
    if (filteredItems.length === 0) {
      selectedIndex = 0;
      return;
    }
    selectedIndex = wrap
      ? (index + filteredItems.length) % filteredItems.length
      : Math.max(0, Math.min(index, filteredItems.length - 1));
    if (rememberUserSelection) restoreItemId = undefined;
    const itemId = selected()?.item.id;
    if (itemId) options.onSelectionChange?.(itemId);
  };
  const move = (delta: number) => setSelectedIndex(selectedIndex + delta, true, true);
  const page = (delta: number) => setSelectedIndex(selectedIndex + delta * Math.max(1, listViewportRows), false, true);
  const applyFilter = () => {
    const previouslySelectedId = selected()?.item.id;
    filteredItems = fuzzyFilter(allItems, searchInput.getValue(), (candidate) =>
      [candidate.label, candidate.statusText, candidate.description, candidate.searchText].filter(Boolean).join(" "),
    );
    if (filteredItems.length === 0) {
      if (previouslySelectedId) restoreItemId ??= previouslySelectedId;
      selectedIndex = 0;
      return;
    }
    const previousIndex = filteredItems.findIndex((candidate) => candidate.item.id === previouslySelectedId);
    if (previousIndex < 0 && previouslySelectedId) restoreItemId ??= previouslySelectedId;
    const restoreIndex = filteredItems.findIndex((candidate) => candidate.item.id === restoreItemId);
    const nextIndex = restoreIndex >= 0 ? restoreIndex : previousIndex >= 0 ? previousIndex : 0;
    if (restoreIndex >= 0) restoreItemId = undefined;
    setSelectedIndex(nextIndex, false, false);
  };
  const component: MenuScreenComponent & Focusable = {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      syncFocus();
    },
    render(width) {
      const safeWidth = Math.max(1, width);
      const availableRows = componentRows(options.tui.terminal.rows);
      const contentRows = framedContentRows(availableRows);
      if (view === "detail") {
        const selectedItem = selected()?.item;
        const presentation = selectedItem?.detailDocument
          ? detailLineCache.presentation(
              selectedItem.detailDocument.content,
              selectedItem.detailDocument.format,
              safeWidth,
            )
          : legacyDetailPresentation(selectedItem, safeWidth);
        const content = presentation.lines;
        lastDetailLines = presentation.searchLines;
        lastDetailSoftWrapAfter = presentation.softWrapAfter;
        lastDetailIgnoreLeadingWhitespace = presentation.ignoreLeadingWhitespace;
        lastDetailSearchSources = presentation.searchSources;
        const searchRebuilt = detailSearch?.updateLines(
          lastDetailLines,
          lastDetailSoftWrapAfter,
          lastDetailIgnoreLeadingWhitespace,
          lastDetailSearchSources,
        );
        const displayedContent = detailSearch?.highlight(content, options.theme) ?? content;
        const layout = detailLayout(contentRows, content.length, detailSearch?.active ?? false);
        const viewportChanged = layout.contentRows !== detailViewportRows;
        detailViewportRows = layout.contentRows;
        detailMaximumScroll = Math.max(0, content.length - layout.contentRows);
        if ((searchRebuilt || viewportChanged) && detailSearch?.active && detailSearch.currentRow !== undefined) {
          detailScrollOffset = keepRowVisible(
            detailScrollOffset,
            detailSearch.currentRow,
            Math.max(1, detailViewportRows),
          );
        }
        detailScrollOffset = clamp(detailScrollOffset, 0, detailMaximumScroll);
        const lines = [
          ...(layout.titleRows ? [options.theme.fg("accent", options.theme.bold(selected()?.label || "Details"))] : []),
          ...(layout.searchRows && detailSearch ? [detailSearch.render(safeWidth)] : []),
          ...displayedContent.slice(detailScrollOffset, detailScrollOffset + layout.contentRows),
          ...(layout.positionRows
            ? [options.theme.fg("dim", positionText(detailScrollOffset, layout.contentRows, content.length))]
            : []),
          ...(layout.hintRows
            ? [
                options.theme.fg(
                  "dim",
                  detailHint(options.keybindings, detailSearchActivationAvailable, detailSearch?.active ?? false),
                ),
              ]
            : []),
        ];
        return boundedFrame(lines, safeWidth, availableRows, options.theme);
      }

      const context = (options.screen.lines ?? []).flatMap((line) =>
        wrapTextWithAnsi(options.theme.fg("muted", safeBrowseText(line)), safeWidth),
      );
      const layout = listLayout(contentRows, context.length, filteredItems.length, options.screen.viewportSize);
      listViewportRows = layout.itemRows;
      searchInputVisible = layout.searchRows > 0;
      syncFocus();
      const viewportStart = listWindowStart(selectedIndex, filteredItems.length, layout.itemRows);
      const rows = listRows(filteredItems, selectedIndex, viewportStart, layout.itemRows, safeWidth, options);
      const description = selected()?.description;
      const lines = [
        ...(layout.titleRows
          ? [options.theme.fg("accent", options.theme.bold(safeBrowseText(options.screen.title)))]
          : []),
        ...context.slice(0, layout.contextRows),
        ...(layout.searchRows ? renderSearchInput(searchInput, safeWidth) : []),
        ...rows,
        ...(layout.positionRows
          ? [options.theme.fg("dim", positionText(viewportStart, layout.itemRows, filteredItems.length))]
          : []),
        ...(layout.descriptionRows && description ? [options.theme.fg("muted", description)] : []),
        ...(layout.hintRows
          ? [options.theme.fg("dim", browseHint(options.keybindings, options.screen.hint ?? "back"))]
          : []),
      ];
      return boundedFrame(lines, safeWidth, availableRows, options.theme);
    },
    invalidate() {
      detailLineCache.invalidate();
      searchInput.invalidate();
      detailSearch?.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      if (view === "detail" && detailSearch?.active) {
        const routed = detailSearch.routeInput(
          data,
          (outsidePaste) => {
            if (matchesKey(outsidePaste, Key.ctrl("c"))) {
              options.onEvent({ kind: "close" });
              return false;
            }
            if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchClose")) {
              detailSearch.close();
              return false;
            }
            if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchNext")) {
              moveToDetailMatch(detailSearch.next());
            } else if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchPrevious")) {
              moveToDetailMatch(detailSearch.previous());
            } else if (options.keybindings.matches(outsidePaste, "tui.select.up")) {
              detailScrollOffset = clamp(detailScrollOffset - 1, 0, detailMaximumScroll);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.down")) {
              detailScrollOffset = clamp(detailScrollOffset + 1, 0, detailMaximumScroll);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.pageUp")) {
              detailScrollOffset = clamp(detailScrollOffset - detailViewportRows, 0, detailMaximumScroll);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.pageDown")) {
              detailScrollOffset = clamp(detailScrollOffset + detailViewportRows, 0, detailMaximumScroll);
            } else if (detailSearch.handleInput(outsidePaste)) {
              moveToDetailMatch(detailSearch.currentRow);
            }
            return true;
          },
          (outsidePaste) =>
            matchesKey(outsidePaste, Key.ctrl("c")) || documentSearchActionMatches(options.keybindings, outsidePaste),
        );
        if (routed.changed && !routed.stopped) moveToDetailMatch(detailSearch.currentRow);
        options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        options.onEvent({ kind: "close" });
      } else if (options.keybindings.matches(data, "tui.select.cancel")) {
        if (view === "detail") {
          view = "list";
          detailScrollOffset = 0;
          lastDetailLines = [];
          lastDetailSoftWrapAfter = [];
          lastDetailIgnoreLeadingWhitespace = [];
          lastDetailSearchSources = [];
          detailSearch?.close();
          syncFocus();
        } else options.onEvent({ kind: options.screen.hint ?? "back" });
      } else if (view === "detail") {
        if (options.keybindings.matches(data, "tui.select.up")) {
          detailScrollOffset = clamp(detailScrollOffset - 1, 0, detailMaximumScroll);
        } else if (options.keybindings.matches(data, "tui.select.down")) {
          detailScrollOffset = clamp(detailScrollOffset + 1, 0, detailMaximumScroll);
        } else if (options.keybindings.matches(data, "tui.select.pageUp")) {
          detailScrollOffset = clamp(detailScrollOffset - detailViewportRows, 0, detailMaximumScroll);
        } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
          detailScrollOffset = clamp(detailScrollOffset + detailViewportRows, 0, detailMaximumScroll);
        } else if (matchesKey(data, Key.home)) detailScrollOffset = 0;
        else if (matchesKey(data, Key.end)) detailScrollOffset = detailMaximumScroll;
        else if (detailSearch && detailSearchActivationAvailable && matchesKey(data, DOCUMENT_SEARCH_ACTIVATE_KEY)) {
          detailSearch.activate(
            lastDetailLines,
            lastDetailSoftWrapAfter,
            lastDetailIgnoreLeadingWhitespace,
            lastDetailSearchSources,
            detailScrollOffset,
          );
        }
      } else if (options.keybindings.matches(data, "tui.select.up")) move(-1);
      else if (options.keybindings.matches(data, "tui.select.down")) move(1);
      else if (options.keybindings.matches(data, "tui.select.pageUp")) page(-1);
      else if (options.keybindings.matches(data, "tui.select.pageDown")) page(1);
      else if (matchesKey(data, Key.home)) setSelectedIndex(0, false, true);
      else if (matchesKey(data, Key.end)) {
        setSelectedIndex(filteredItems.length - 1, false, true);
      } else if (options.keybindings.matches(data, "tui.select.confirm")) {
        if (selected()) {
          view = "detail";
          detailScrollOffset = 0;
          lastDetailLines = [];
          lastDetailSoftWrapAfter = [];
          lastDetailIgnoreLeadingWhitespace = [];
          lastDetailSearchSources = [];
          detailSearch?.close();
          syncFocus();
        }
      } else if (searchInputVisible) {
        handleSearchInput(searchInput, data);
        applyFilter();
      }
      options.tui.requestRender();
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      searchInput.focused = false;
      detailSearch?.dispose();
      options.onDispose?.();
    },
  };
  return component;
}

function listRows<ScreenId extends string, ActionId extends string>(
  items: readonly SearchableItem[],
  selectedIndex: number,
  viewportStart: number,
  viewportRows: number,
  width: number,
  options: BrowseOptions<ScreenId, ActionId>,
): string[] {
  if (options.screen.items.length === 0) {
    return [options.theme.fg("dim", "  No items available")];
  }
  if (items.length === 0) return [options.theme.fg("dim", "  No matching items")];
  return items.slice(viewportStart, viewportStart + viewportRows).map((candidate, offset) => {
    const index = viewportStart + offset;
    const prefix = index === selectedIndex ? "› " : "  ";
    const suffix = candidate.statusText ? `  [${candidate.statusText}]` : "";
    const labelWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
    const label = truncateToWidth(candidate.label, labelWidth, "");
    const line = truncateToWidth(`${prefix}${label}${suffix}`, width, "");
    return index === selectedIndex ? options.theme.fg("accent", line) : line;
  });
}

function legacyDetailPresentation(item: MenuBrowseItem | undefined, width: number): DocumentPresentation {
  const sourceLines = item ? browseDetailSource(item) : ["No matching item."];
  const lines: string[] = [];
  const softWrapAfter: boolean[] = [];
  for (const source of sourceLines) {
    const wrapped = source ? wrapTextWithAnsi(source, width) : [""];
    let sourceOffset = 0;
    for (const [index, line] of wrapped.entries()) {
      lines.push(line);
      const plain = stripVTControlCharacters(line).trimEnd();
      const found = source.indexOf(plain, sourceOffset);
      if (found >= 0) sourceOffset = found + plain.length;
      softWrapAfter.push(
        index < wrapped.length - 1 && sourceOffset < source.length && !/\s/u.test(source[sourceOffset] ?? ""),
      );
    }
  }
  return {
    lines,
    searchLines: lines,
    softWrapAfter,
    ignoreLeadingWhitespace: lines.map(() => false),
    searchSources: [],
  };
}

export function browseDialogLabel(item: MenuBrowseItem) {
  const label = safeBrowseText(item.label);
  const status = safeBrowseText(item.statusText ?? "");
  return status ? `${label} [${status}]` : label;
}

export function browseDialogPages(item: MenuBrowseItem) {
  if (item.detailDocument) {
    return documentDialogPages(item.detailDocument.content, RPC_DOCUMENT_LINE_WIDTH, RPC_DOCUMENT_PAGE_SIZE);
  }
  return reviewDialogPages({
    kind: "review",
    title: safeBrowseText(item.label),
    content: browseDetailSource(item).join("\n"),
    viewportSize: "adaptive",
  });
}

function browseDetailSource(item: MenuBrowseItem) {
  const lines = [
    ...(item.statusText ? [`Status: ${safeBrowseText(item.statusText)}`] : []),
    ...(item.description ? [safeBrowseText(item.description)] : []),
    ...(item.details ?? []).map(safeBrowseText),
  ];
  return lines.length > 0 ? lines : ["No details available."];
}

function renderSearchInput(input: Input, width: number): string[] {
  const prefix = "Search: ";
  const inputWidth = Math.max(1, width - visibleWidth(prefix));
  return input.render(inputWidth).map((line) => truncateToWidth(`${prefix}${line}`, width, ""));
}

interface BrowseListLayout {
  titleRows: number;
  contextRows: number;
  searchRows: number;
  itemRows: number;
  positionRows: number;
  descriptionRows: number;
  hintRows: number;
}

function listLayout(
  availableRows: number,
  contextLength: number,
  itemCount: number,
  requestedViewport: number | "adaptive" | undefined,
): BrowseListLayout {
  if (availableRows === 1) {
    return {
      titleRows: 0,
      contextRows: 0,
      searchRows: 0,
      itemRows: 1,
      positionRows: 0,
      descriptionRows: 0,
      hintRows: 0,
    };
  }
  const titleRows = availableRows >= 4 ? 1 : 0;
  const searchRows = availableRows >= 3 ? 1 : 0;
  const hintRows = availableRows >= 3 ? 1 : 0;
  const descriptionRows = availableRows >= 7 ? 1 : 0;
  const baseRows = titleRows + searchRows + hintRows + descriptionRows;
  const contextRows =
    availableRows >= 8 ? Math.min(contextLength, MAX_CONTEXT_ROWS, Math.max(0, availableRows - baseRows - 1)) : 0;
  const itemBudget = Math.max(1, availableRows - baseRows - contextRows);
  let itemRows = typeof requestedViewport === "number" ? Math.min(itemBudget, requestedViewport) : itemBudget;
  let positionRows = 0;
  if (itemCount > itemRows) {
    if (itemBudget > itemRows) positionRows = 1;
    else if (itemRows >= 2) {
      positionRows = 1;
      itemRows -= 1;
    }
  }
  return {
    titleRows,
    contextRows,
    searchRows,
    itemRows,
    positionRows,
    descriptionRows,
    hintRows,
  };
}

interface BrowseDetailLayout {
  titleRows: number;
  searchRows: number;
  contentRows: number;
  positionRows: number;
  hintRows: number;
}

function detailLayout(availableRows: number, contentLength: number, searchActive: boolean): BrowseDetailLayout {
  if (availableRows === 1) {
    return {
      titleRows: 0,
      searchRows: searchActive ? 1 : 0,
      contentRows: searchActive ? 0 : 1,
      positionRows: 0,
      hintRows: 0,
    };
  }
  const searchRows = searchActive ? 1 : 0;
  const titleRows = availableRows >= 4 + searchRows ? 1 : 0;
  const hintRows = availableRows >= 3 + searchRows ? 1 : 0;
  let contentRows = Math.max(1, availableRows - titleRows - hintRows - searchRows);
  const positionRows = contentLength > contentRows && contentRows >= 2 ? 1 : 0;
  contentRows -= positionRows;
  return { titleRows, searchRows, contentRows, positionRows, hintRows };
}

function listWindowStart(selectedIndex: number, itemCount: number, viewportSize: number) {
  if (itemCount <= viewportSize) return 0;
  return Math.max(0, Math.min(selectedIndex - Math.floor(viewportSize / 2), itemCount - viewportSize));
}

function positionText(offset: number, viewportSize: number, itemCount: number) {
  if (itemCount === 0) return "0/0";
  return `${offset + 1}-${Math.min(itemCount, offset + viewportSize)}/${itemCount}`;
}

function framedContentRows(rows: number) {
  return rows >= MIN_FRAMED_ROWS ? rows - 2 : rows;
}

function boundedFrame(
  lines: readonly string[],
  width: number,
  rows: number,
  theme: BrowseOptions<string, string>["theme"],
) {
  if (rows < MIN_FRAMED_ROWS) return boundedLines(lines, width, rows);
  const rule = renderHorizontalRule(width, theme);
  return [rule, ...boundedLines(lines, width, rows - 2), rule];
}

function boundedLines(lines: readonly string[], width: number, rows: number) {
  return lines.slice(0, rows).map((line) => truncateToWidth(line, width, ""));
}

function browseHint(keybindings: MenuKeybindings, destination: "back" | "close") {
  const controls = formatInteractionHints(
    keybindings,
    [
      { bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
      { bindings: ["tui.select.confirm"], label: "details" },
      {
        bindings: ["tui.select.cancel"],
        excludeKeys: ["ctrl+c"],
        label: destination,
      },
      ...(destination === "back" ? [{ keys: ["ctrl+c"], label: "close" }] : []),
    ],
    { separator: "·" },
  );
  return ["type to search", controls].filter(Boolean).join(" · ");
}

function detailHint(keybindings: MenuKeybindings, searchEnabled: boolean, searchActive: boolean) {
  return formatInteractionHints(
    keybindings,
    searchActive
      ? [
          { bindings: ["tui.altScreen.searchNext"], label: "next" },
          { bindings: ["tui.altScreen.searchPrevious"], label: "previous" },
          { bindings: ["tui.altScreen.searchClose"], label: "close search" },
          { keys: ["ctrl+c"], label: "close" },
        ]
      : [
          { bindings: ["tui.select.up", "tui.select.down"], label: "scroll" },
          { bindings: ["tui.select.pageUp", "tui.select.pageDown"], label: "page" },
          ...(searchEnabled ? [{ keys: [DOCUMENT_SEARCH_ACTIVATE_KEY], label: "search" }] : []),
          {
            bindings: ["tui.select.cancel"],
            excludeKeys: ["ctrl+c"],
            label: "back",
          },
          { keys: ["ctrl+c"], label: "close" },
        ],
    { separator: "·" },
  );
}

function safeBrowseText(value: unknown) {
  return safeMenuText(stripVTControlCharacters(String(value)));
}

function keepRowVisible(offset: number, row: number, viewportRows: number) {
  if (row < offset) return row;
  if (row >= offset + viewportRows) return row - viewportRows + 1;
  return offset;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
