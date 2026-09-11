import { stripVTControlCharacters } from "node:util";
import { type Focusable, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MenuScreen, ReviewScreen } from "../types.js";
import type { MenuKeybindings, MenuScreenComponent, MenuScreenComponentOptions } from "./contracts.js";
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
import { componentRows, fitCompactHintSegments, menuHint, renderHorizontalRule, safeMenuText } from "./rendering.js";

const DEFAULT_REVIEW_VIEWPORT_SIZE = 14;
const MIN_FRAMED_ROWS = 5;

export type ReviewOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "review" }>;
};

export function createReviewComponent<ScreenId extends string, ActionId extends string>(
  options: ReviewOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  let scrollOffset = 0;
  let lastMaximumScroll = 0;
  let lastViewportSize = reviewViewportSize(options.screen);
  let lastTerminalRows = options.tui.terminal.rows;
  let lastSearchActive = false;
  let disposed = false;
  let focused = false;
  let lastLines: readonly string[] = [];
  let lastSoftWrapAfter: readonly boolean[] = [];
  let lastIgnoreLeadingWhitespace: readonly boolean[] = [];
  let lastSearchSources: DocumentPresentation["searchSources"] = [];
  const documentLineCache = createDocumentLineCache(options.theme, Boolean(options.screen.enableSearch));
  const search = options.screen.enableSearch ? new DocumentSearchController() : undefined;
  const searchActivationAvailable = Boolean(
    search && documentSearchActivationAvailable(options.keybindings, Boolean(options.screen.confirm)),
  );

  const moveTo = (offset: number) => {
    scrollOffset = Math.max(0, Math.min(offset, lastMaximumScroll));
    options.tui.requestRender();
  };
  const moveToMatch = (row: number | undefined) => {
    if (row === undefined) return;
    if (row < scrollOffset) moveTo(row);
    else if (row >= scrollOffset + lastViewportSize) moveTo(row - lastViewportSize + 1);
  };

  const component: MenuScreenComponent & Partial<Focusable> = {
    render(width) {
      const safeWidth = Math.max(1, width);
      const presentation = documentLineCache.presentation(options.screen.content, options.screen.format, safeWidth);
      const allLines = presentation.lines.some((line) => stripVTControlCharacters(line).trim().length > 0)
        ? presentation.lines
        : [];
      lastLines = allLines.length > 0 ? presentation.searchLines : [];
      lastSoftWrapAfter = allLines.length > 0 ? presentation.softWrapAfter : [];
      lastIgnoreLeadingWhitespace = allLines.length > 0 ? presentation.ignoreLeadingWhitespace : [];
      lastSearchSources = allLines.length > 0 ? presentation.searchSources : [];
      const searchRebuilt = search?.updateLines(
        lastLines,
        lastSoftWrapAfter,
        lastIgnoreLeadingWhitespace,
        lastSearchSources,
      );
      const searchActive = search?.active ?? false;
      const terminalRows = options.tui.terminal.rows;
      const layoutChanged =
        Boolean(searchRebuilt) || terminalRows !== lastTerminalRows || searchActive !== lastSearchActive;
      const frameOptions: AdaptiveReviewFrameOptions<ActionId> = {
        screen: options.screen,
        allLines: search?.highlight(allLines, options.theme) ?? allLines,
        searchLine: searchActive ? search?.render(safeWidth) : undefined,
        searchEnabled: searchActivationAvailable,
        searchActive,
        width: safeWidth,
        terminalRows,
        maximumViewportSize:
          options.screen.viewportSize === "adaptive"
            ? undefined
            : Math.min(reviewViewportSize(options.screen), allLines.length),
        scrollOffset,
        theme: options.theme,
        keybindings: options.keybindings,
      };
      let frame = renderAdaptiveReviewFrame(frameOptions);
      if (
        (layoutChanged || frame.viewportSize !== lastViewportSize) &&
        searchActive &&
        search?.currentRow !== undefined
      ) {
        const correctedOffset = keepRowVisible(frame.scrollOffset, search.currentRow, Math.max(1, frame.viewportSize));
        if (correctedOffset !== frame.scrollOffset) {
          frame = renderAdaptiveReviewFrame({ ...frameOptions, scrollOffset: correctedOffset });
        }
      }
      lastTerminalRows = terminalRows;
      lastSearchActive = searchActive;
      scrollOffset = frame.scrollOffset;
      lastMaximumScroll = frame.maximumScroll;
      lastViewportSize = frame.viewportSize;
      return frame.lines;
    },
    invalidate() {
      documentLineCache.invalidate();
      search?.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      if (search?.active) {
        const routed = search.routeInput(
          data,
          (outsidePaste) => {
            if (matchesKey(outsidePaste, Key.ctrl("c"))) {
              options.onEvent({ kind: "close" });
              return false;
            }
            if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchClose")) {
              search.close();
              options.tui.requestRender();
              return false;
            }
            if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchNext")) {
              moveToMatch(search.next());
              options.tui.requestRender();
            } else if (options.keybindings.matches(outsidePaste, "tui.altScreen.searchPrevious")) {
              moveToMatch(search.previous());
              options.tui.requestRender();
            } else if (options.keybindings.matches(outsidePaste, "tui.select.up")) {
              moveTo(scrollOffset - 1);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.down")) {
              moveTo(scrollOffset + 1);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.pageUp")) {
              moveTo(scrollOffset - lastViewportSize);
            } else if (options.keybindings.matches(outsidePaste, "tui.select.pageDown")) {
              moveTo(scrollOffset + lastViewportSize);
            } else {
              if (search.handleInput(outsidePaste)) moveToMatch(search.currentRow);
              options.tui.requestRender();
            }
            return true;
          },
          (outsidePaste) =>
            matchesKey(outsidePaste, Key.ctrl("c")) || documentSearchActionMatches(options.keybindings, outsidePaste),
        );
        if (routed.changed && !routed.stopped) {
          moveToMatch(search.currentRow);
          options.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onEvent({ kind: options.screen.hint ?? "back" });
      } else if (options.keybindings.matches(data, "tui.select.up")) {
        moveTo(scrollOffset - 1);
      } else if (options.keybindings.matches(data, "tui.select.down")) {
        moveTo(scrollOffset + 1);
      } else if (options.keybindings.matches(data, "tui.select.pageUp")) {
        moveTo(scrollOffset - lastViewportSize);
      } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        moveTo(scrollOffset + lastViewportSize);
      } else if (matchesKey(data, Key.home)) moveTo(0);
      else if (matchesKey(data, Key.end)) moveTo(lastMaximumScroll);
      else if (options.screen.confirm && options.keybindings.matches(data, "tui.select.confirm")) {
        options.onEvent({ kind: "activate", itemId: options.screen.confirm.id });
      } else if (search && searchActivationAvailable && matchesKey(data, DOCUMENT_SEARCH_ACTIVATE_KEY)) {
        search.activate(lastLines, lastSoftWrapAfter, lastIgnoreLeadingWhitespace, lastSearchSources, scrollOffset);
        options.tui.requestRender();
      }
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      search?.dispose();
      options.onDispose?.();
    },
  };
  if (search) {
    Object.defineProperty(component, "focused", {
      get: () => focused,
      set: (value: boolean) => {
        focused = value;
        search.focused = value;
      },
      enumerable: true,
    });
  }
  return component;
}

interface AdaptiveReviewFrameOptions<ActionId extends string> {
  screen: ReviewScreen<ActionId>;
  allLines: readonly string[];
  searchLine?: string;
  searchEnabled: boolean;
  searchActive: boolean;
  width: number;
  terminalRows: number;
  maximumViewportSize?: number;
  scrollOffset: number;
  theme: MenuScreenComponentOptions<string, ActionId>["theme"];
  keybindings: MenuKeybindings;
}

interface AdaptiveReviewFrame {
  lines: string[];
  scrollOffset: number;
  maximumScroll: number;
  viewportSize: number;
}

interface AdaptiveReviewChrome {
  header: string[];
  separator: boolean;
  hint: string[];
  showPosition: boolean;
  viewportSize: number;
}

function renderAdaptiveReviewFrame<ActionId extends string>(
  options: AdaptiveReviewFrameOptions<ActionId>,
): AdaptiveReviewFrame {
  const totalRows = componentRows(options.terminalRows);
  const framed = totalRows >= MIN_FRAMED_ROWS;
  const availableRows = framed ? totalRows - 2 : totalRows;
  const searchRows = options.searchLine === undefined ? 0 : 1;
  const documentRows = Math.max(0, availableRows - searchRows);
  const destination = options.screen.hint ?? "back";
  const confirmAction = options.screen.confirm ? safeMenuText(options.screen.confirm.label) : "";
  const fullHeader = [
    ...wrapTextWithAnsi(
      options.theme.fg("accent", options.theme.bold(safeMenuText(options.screen.title))),
      options.width,
    ),
    ...(options.screen.lines ?? []).flatMap((line) =>
      wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), options.width),
    ),
  ].map((line) => truncateToWidth(line, options.width, ""));
  const hintText = reviewHint(
    options.keybindings,
    destination,
    confirmAction,
    options.searchEnabled,
    options.searchActive,
  );
  const fullHint = wrapTextWithAnsi(options.theme.fg("dim", hintText), options.width).map((line) =>
    truncateToWidth(line, options.width, ""),
  );
  const criticalHint = options.theme.fg(
    "dim",
    compactReviewHint(
      options.keybindings,
      destination,
      confirmAction,
      options.width,
      options.searchEnabled,
      options.searchActive,
    ),
  );

  let chrome =
    options.allLines.length === 0
      ? allocateEmptyReviewChrome(documentRows, fullHeader, fullHint, criticalHint)
      : allocateAdaptiveReviewChrome(
          documentRows,
          fullHeader,
          fullHint,
          criticalHint,
          false,
          options.maximumViewportSize,
        );
  if (documentRows >= 4 && options.allLines.length > chrome.viewportSize) {
    chrome = allocateAdaptiveReviewChrome(
      documentRows,
      fullHeader,
      fullHint,
      criticalHint,
      true,
      options.maximumViewportSize,
    );
  }

  const maximumScroll = Math.max(0, options.allLines.length - chrome.viewportSize);
  const scrollOffset = Math.max(0, Math.min(options.scrollOffset, maximumScroll));
  const visible = options.allLines.slice(scrollOffset, scrollOffset + chrome.viewportSize);
  const first = options.allLines.length === 0 ? 0 : scrollOffset + 1;
  const last = Math.min(options.allLines.length, scrollOffset + chrome.viewportSize);
  const position = chrome.showPosition ? [options.theme.fg("dim", `${first}-${last}/${options.allLines.length}`)] : [];
  const contentLines = [
    ...chrome.header,
    ...(options.searchLine === undefined ? [] : [options.searchLine]),
    ...(chrome.separator ? [""] : []),
    ...visible,
    ...position,
    ...chrome.hint,
  ].map((line) => truncateToWidth(line, options.width, ""));
  const lines = framed
    ? [
        renderHorizontalRule(options.width, options.theme),
        ...contentLines,
        renderHorizontalRule(options.width, options.theme),
      ]
    : contentLines;

  return { lines, scrollOffset, maximumScroll, viewportSize: chrome.viewportSize };
}

function allocateEmptyReviewChrome(
  availableRows: number,
  fullHeader: readonly string[],
  fullHint: readonly string[],
  criticalHint: string,
): AdaptiveReviewChrome {
  if (availableRows <= 0) {
    return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 0 };
  }
  const hint = fullHint.length > 0 && fullHint.length < availableRows ? [...fullHint] : [criticalHint];
  const header = fullHeader.slice(0, Math.max(0, availableRows - hint.length));
  return { header, separator: false, hint, showPosition: false, viewportSize: 0 };
}

function allocateAdaptiveReviewChrome(
  availableRows: number,
  fullHeader: readonly string[],
  fullHint: readonly string[],
  criticalHint: string,
  showPosition: boolean,
  maximumViewportSize?: number,
): AdaptiveReviewChrome {
  if (availableRows <= 0) {
    return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 0 };
  }
  if (availableRows === 1) {
    return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 1 };
  }
  const compactHeader = [fullHeader[0] ?? ""];
  if (availableRows === 2) {
    return {
      header: [],
      separator: false,
      hint: [criticalHint],
      showPosition: false,
      viewportSize: 1,
    };
  }
  if (availableRows === 3) {
    return {
      header: compactHeader,
      separator: false,
      hint: [criticalHint],
      showPosition: false,
      viewportSize: 1,
    };
  }

  let remainingRows = availableRows - 3 - Number(showPosition);
  const reservedViewportRows = Math.min(remainingRows, Math.max(0, (maximumViewportSize ?? 1) - 1));
  remainingRows -= reservedViewportRows;
  const extraHeaderCount = Math.min(remainingRows, Math.max(0, fullHeader.length - 1));
  const header = [...compactHeader, ...fullHeader.slice(1, 1 + extraHeaderCount)];
  remainingRows -= extraHeaderCount;

  let hint = [criticalHint];
  const fullHintExtraRows = Math.max(0, fullHint.length - 1);
  if (remainingRows > 0 && fullHint.length > 0 && fullHintExtraRows <= remainingRows) {
    hint = [...fullHint];
    remainingRows -= fullHintExtraRows;
  }

  const separator = remainingRows > 0;
  if (separator) remainingRows -= 1;
  return {
    header,
    separator,
    hint,
    showPosition,
    viewportSize: Math.min(
      1 + reservedViewportRows + remainingRows,
      maximumViewportSize === undefined ? Number.POSITIVE_INFINITY : maximumViewportSize,
    ),
  };
}

function reviewHint(
  keybindings: MenuKeybindings,
  destination: "back" | "close",
  confirmAction: string,
  searchEnabled: boolean,
  searchActive: boolean,
) {
  if (searchActive) {
    const next = reviewBindingText(keybindings, "tui.altScreen.searchNext");
    const previous = reviewBindingText(keybindings, "tui.altScreen.searchPrevious");
    const close = reviewBindingText(keybindings, "tui.altScreen.searchClose");
    return [
      ...(next ? [`${next} next`] : []),
      ...(previous ? [`${previous} previous`] : []),
      ...(close ? [`${close} close search`] : []),
      "ctrl+c close",
    ].join(" · ");
  }
  const base = menuHint(keybindings, destination, confirmAction);
  const search = searchEnabled ? DOCUMENT_SEARCH_ACTIVATE_KEY : "";
  return [base, ...(search ? [`${search} search`] : [])].filter(Boolean).join(" · ");
}

function compactReviewHint(
  keybindings: MenuKeybindings,
  destination: "back" | "close",
  confirmAction: string,
  width: number,
  searchEnabled: boolean,
  searchActive: boolean,
) {
  if (searchActive) {
    const close = reviewBindingText(keybindings, "tui.altScreen.searchClose");
    const next = reviewBindingText(keybindings, "tui.altScreen.searchNext");
    return fitCompactHintSegments(
      [...(close ? [`${close} close search`] : []), ...(next ? [`${next} next`] : []), "ctrl+c close"],
      width,
    );
  }
  const confirm = reviewBindingText(keybindings, "tui.select.confirm");
  const cancel = reviewBindingText(keybindings, "tui.select.cancel", "ctrl+c");
  const up = reviewBindingText(keybindings, "tui.select.up");
  const down = reviewBindingText(keybindings, "tui.select.down");
  const search = searchEnabled ? DOCUMENT_SEARCH_ACTIVATE_KEY : "";
  return fitCompactHintSegments(
    [
      ...(cancel ? [`${cancel} ${destination}`] : []),
      ...(destination === "back" || !cancel ? ["ctrl+c close"] : []),
      ...(confirm && confirmAction ? [`${confirm} ${confirmAction}`] : []),
      ...(up || down ? [`${[up, down].filter(Boolean).join("/")} navigate`] : []),
      ...(search ? [`${search} search`] : []),
    ],
    width,
  );
}

function keepRowVisible(offset: number, row: number, viewportRows: number) {
  if (row < offset) return row;
  if (row >= offset + viewportRows) return row - viewportRows + 1;
  return offset;
}

function reviewBindingText(
  keybindings: MenuKeybindings,
  binding: Parameters<MenuKeybindings["getKeys"]>[0],
  excluded?: string,
) {
  return keybindings
    .getKeys(binding)
    .filter((key) => key !== excluded)
    .map((key) => {
      if (key === "up") return "↑";
      if (key === "down") return "↓";
      if (key === "escape") return "esc";
      return safeMenuText(key);
    })
    .filter(Boolean)
    .join("/");
}

export function reviewDialogPages<ActionId extends string>(screen: ReviewScreen<ActionId>): string[][] {
  return documentDialogPages(screen.content, RPC_DOCUMENT_LINE_WIDTH, reviewDialogPageSize(screen));
}

function reviewViewportSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
  return typeof screen.viewportSize === "number" ? screen.viewportSize : DEFAULT_REVIEW_VIEWPORT_SIZE;
}

function reviewDialogPageSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
  return typeof screen.viewportSize === "number"
    ? Math.min(screen.viewportSize, RPC_DOCUMENT_PAGE_SIZE)
    : RPC_DOCUMENT_PAGE_SIZE;
}
