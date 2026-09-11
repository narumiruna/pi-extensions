import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TickerMenuOptions } from "./menu.js";
import { parseSymbols } from "./settings.js";

type TuiMenuResult = "add" | "close";
type TickerRow = { kind: "ticker"; id: string; symbol: string };
type ActionRow = {
  kind: "action";
  id: "add" | "widget" | "refresh";
  label: string;
  description: string;
};
type Row = TickerRow | ActionRow;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// Keep these aligned with Input.handleInput so configured editing actions beat additive reorder.
const RESERVED_INPUT_BINDINGS = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.editor.undo",
  "tui.input.submit",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
] as const;

// Pi TUI Kit multi-select screens do not expose in-place row-reorder shortcuts.
// This specialized TUI keeps the same search, toggle, action, binding, and cancellation behavior
// while RPC mode continues to use the Kit's declarative adapter in menu.ts.
export async function showTickerTuiMenu(ctx: ExtensionCommandContext, options: TickerMenuOptions): Promise<void> {
  const { formatInteractionHints, HorizontalRule, runCustomInteraction, sanitizeTerminalText } = await import(
    "@narumitw/pi-tui-kit"
  );

  while (!options.signal.aborted && options.isCurrent()) {
    const result = await runCustomInteraction<TuiMenuResult>(ctx, {
      signal: options.signal,
      isCurrent: options.isCurrent,
      onError: (errorCtx, error) => {
        if (!errorCtx.hasUI) return;
        const message = error instanceof Error ? error.message : String(error);
        errorCtx.ui.notify(sanitizeTerminalText(message), "error");
      },
      create: ({ tui, theme, keybindings, complete }) => {
        let symbols = [...options.getSymbols()];
        let widgetEnabled = options.getWidgetEnabled();
        const rawSearchInput = new Input();
        const searchInput = new Input();
        let selectedIndex = 0;
        let rows: Row[] = [];
        let busy = false;
        let disposed = false;
        let pasteActive = false;
        let errorMessage: string | undefined;
        let pending = Promise.resolve();
        const shortcutUp = shortcutAvailable(keybindings, "shift+up");
        const shortcutDown = shortcutAvailable(keybindings, "shift+down");
        const activationHint = (label: string) =>
          formatInteractionHints(keybindings, [{ bindings: ["tui.select.confirm"], keys: ["space"], label }]);
        const reorderKeys = [shortcutUp, shortcutDown].filter(
          (shortcut): shortcut is "shift+up" | "shift+down" => shortcut !== undefined,
        );
        const tickerDescription = `${[
          activationHint("removes this ticker"),
          ...(reorderKeys.length > 0 ? [`${reorderKeys.join("/")} changes its order`] : []),
        ].join("; ")}.`;
        const topRule = new HorizontalRule({
          label: "Manage tickers",
          labelAlignment: "left",
          ruleStyle: (text) => theme.fg("borderMuted", text),
          labelStyle: (text) => theme.fg("accent", text),
        });
        const bottomRule = new HorizontalRule({
          ruleStyle: (text) => theme.fg("borderMuted", text),
        });
        const hint = formatInteractionHints(keybindings, [
          { bindings: ["tui.select.up", "tui.select.down"], label: "select" },
          ...(shortcutUp ? [{ keys: [shortcutUp], label: "move up" }] : []),
          ...(shortcutDown ? [{ keys: [shortcutDown], label: "move down" }] : []),
          { bindings: ["tui.select.confirm"], keys: ["space"], label: "toggle/select" },
          {
            bindings: ["tui.select.cancel"],
            excludeKeys: ["ctrl+c"],
            label: "close",
          },
          { keys: ["ctrl+c"], label: "close" },
        ]);

        const actionRows = (directSymbol?: string): ActionRow[] => [
          {
            kind: "action",
            id: "add",
            label: directSymbol ? `Add ${sanitizeTerminalText(directSymbol)}` : "Add custom ticker…",
            description: directSymbol
              ? `${activationHint(`adds ${sanitizeTerminalText(directSymbol)} directly`)}.`
              : "Add and select one Yahoo Finance symbol.",
          },
          {
            kind: "action",
            id: "widget",
            label: `Widget: ${widgetEnabled ? "On" : "Off"}`,
            description: "Show or hide the editor widget and persist this setting.",
          },
          {
            kind: "action",
            id: "refresh",
            label: "Refresh now",
            description: widgetEnabled
              ? "Fetch the selected symbols immediately."
              : "Enable the widget before refreshing.",
          },
        ];
        const buildRows = (): Row[] => {
          const tickerRows = symbols.map((symbol): TickerRow => ({ kind: "ticker", id: symbol, symbol }));
          const query = searchInput.getValue().toLowerCase();
          const filtered = fuzzyFilter(tickerRows, query, (row) =>
            sanitizeTerminalText(row.symbol.replaceAll("-", " ")).toLowerCase(),
          );
          const directSymbol = filtered.length === 0 ? tryDirectSymbol(rawSearchInput.getValue()) : undefined;
          return [...filtered, ...actionRows(directSymbol)];
        };
        const selectedRow = () => rows[selectedIndex];
        const rebuild = (preferredId?: string, fallbackIndex = selectedIndex) => {
          rows = buildRows();
          const preferredIndex = preferredId ? rows.findIndex((row) => row.id === preferredId) : -1;
          selectedIndex = preferredIndex >= 0 ? preferredIndex : Math.max(0, Math.min(fallbackIndex, rows.length - 1));
          tui.requestRender();
        };
        rebuild();

        const select = (index: number, wrap: boolean) => {
          if (rows.length === 0) return;
          selectedIndex = wrap ? (index + rows.length) % rows.length : Math.max(0, Math.min(index, rows.length - 1));
          tui.requestRender();
        };
        const persist = (
          nextSymbols: readonly string[],
          previousSymbols: readonly string[],
          preferredId: string | undefined,
          previousIndex: number,
          clearSearchOnSuccess = false,
        ) => {
          busy = true;
          errorMessage = undefined;
          symbols = [...nextSymbols];
          rebuild(preferredId, previousIndex);
          pending = (async () => {
            try {
              await options.applySymbols(symbols, options.signal);
              if (options.signal.aborted || !options.isCurrent()) return;
              symbols = [...options.getSymbols()];
              if (clearSearchOnSuccess) {
                rawSearchInput.setValue("");
                searchInput.setValue("");
              }
            } catch (error) {
              if (options.signal.aborted || !options.isCurrent()) return;
              symbols = [...previousSymbols];
              errorMessage = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
              ctx.ui.notify(`Ticker settings were not saved: ${errorMessage}`, "error");
            } finally {
              busy = false;
              if (!disposed && !options.signal.aborted && options.isCurrent()) {
                rebuild(preferredId, previousIndex);
              }
            }
          })();
        };
        const persistWidgetEnabled = (nextWidgetEnabled: boolean) => {
          const previousWidgetEnabled = widgetEnabled;
          widgetEnabled = nextWidgetEnabled;
          busy = true;
          errorMessage = undefined;
          rebuild("widget");
          pending = (async () => {
            try {
              await options.applyWidgetEnabled(nextWidgetEnabled, options.signal);
              if (options.signal.aborted || !options.isCurrent()) return;
              widgetEnabled = options.getWidgetEnabled();
            } catch (error) {
              if (options.signal.aborted || !options.isCurrent()) return;
              widgetEnabled = previousWidgetEnabled;
              errorMessage = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
              ctx.ui.notify(`Ticker settings were not saved: ${errorMessage}`, "error");
            } finally {
              busy = false;
              if (!disposed && !options.signal.aborted && options.isCurrent()) rebuild("widget");
            }
          })();
        };
        const toggle = () => {
          if (busy || disposed) return;
          const row = selectedRow();
          if (row?.kind !== "ticker") return;
          const previous = [...symbols];
          const next = symbols.filter((symbol) => symbol !== row.symbol);
          persist(next, previous, undefined, selectedIndex);
        };
        const moveTicker = (direction: -1 | 1) => {
          if (busy || disposed || rawSearchInput.getValue() || options.signal.aborted || !options.isCurrent()) {
            return;
          }
          const row = selectedRow();
          if (row?.kind !== "ticker") return;
          const from = symbols.indexOf(row.symbol);
          const to = from + direction;
          if (from < 0 || to < 0 || to >= symbols.length) return;
          const previous = [...symbols];
          const next = [...symbols];
          const [symbol] = next.splice(from, 1);
          if (!symbol) return;
          next.splice(to, 0, symbol);
          persist(next, previous, symbol, selectedIndex);
        };
        const activate = () => {
          if (busy || disposed) return;
          const row = selectedRow();
          if (!row) return;
          if (row.kind === "ticker") {
            toggle();
            return;
          }
          if (row.id === "add") {
            const query = rawSearchInput.getValue();
            const hasTickerMatch = rows.some((candidate) => candidate.kind === "ticker");
            if (query.trim() && !hasTickerMatch) {
              let symbol: string;
              try {
                symbol = parseDirectSymbol(query);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errorMessage = sanitizeTerminalText(message);
                ctx.ui.notify(errorMessage, "error");
                tui.requestRender();
                return;
              }
              if (symbols.includes(symbol)) {
                ctx.ui.notify(`${symbol} is already selected.`, "info");
                return;
              }
              persist([...symbols, symbol], [...symbols], symbol, selectedIndex, true);
              return;
            }
            complete("add");
          } else if (row.id === "widget") persistWidgetEnabled(!widgetEnabled);
          else options.refresh();
        };
        const handleSearch = (data: string) => {
          const previousId = selectedRow()?.id;
          errorMessage = undefined;
          rawSearchInput.handleInput(data);
          searchInput.handleInput(data);
          searchInput.setValue(sanitizeTerminalText(rawSearchInput.getValue()));
          rebuild(previousId, 0);
        };

        return {
          render(width: number) {
            const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
            if (safeWidth === 0) return [""];
            const viewportSize = availableRows(tui.terminal.rows, rows.length);
            const viewportStart = Math.max(
              0,
              Math.min(selectedIndex - Math.floor(viewportSize / 2), rows.length - viewportSize),
            );
            const visibleRows = rows.slice(viewportStart, viewportStart + viewportSize);
            const content = visibleRows.map((row, offset) => {
              const index = viewportStart + offset;
              const focused = index === selectedIndex;
              const label =
                row.kind === "ticker"
                  ? `${focused ? "›" : " "} [x] ${sanitizeTerminalText(row.symbol)}`
                  : `${focused ? "›" : " "} ${row.label}`;
              const bounded = truncateToWidth(label, safeWidth, safeWidth > 1 ? "…" : "");
              return focused ? theme.fg("accent", bounded) : bounded;
            });
            if (viewportSize < rows.length) {
              content.push(theme.fg("dim", truncateToWidth(`  (${selectedIndex + 1}/${rows.length})`, safeWidth, "")));
            }
            const row = selectedRow();
            const description =
              row?.kind === "ticker"
                ? rawSearchInput.getValue()
                  ? "Clear search before reordering."
                  : tickerDescription
                : row?.description;
            const status = errorMessage
              ? theme.fg("error", errorMessage)
              : busy
                ? theme.fg("muted", "Saving changes…")
                : undefined;
            return [
              ...topRule.render(safeWidth),
              theme.fg(
                "muted",
                truncateToWidth(`${symbols.length} selected · changes save immediately`, safeWidth, ""),
              ),
              ...searchInput.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, "")),
              ...content,
              ...(description ? [theme.fg("dim", truncateToWidth(`  ${description}`, safeWidth, ""))] : []),
              ...(status ? [truncateToWidth(status, safeWidth, "")] : []),
              ...bottomRule.render(safeWidth),
              theme.fg("dim", truncateToWidth(hint, safeWidth, "")),
            ];
          },
          invalidate() {
            searchInput.invalidate();
          },
          handleInput(data: string) {
            if (pasteActive || data.includes(PASTE_START)) {
              pasteActive = !data.includes(PASTE_END);
              handleSearch(data);
              return;
            }
            if (matchesKey(data, Key.ctrl("c"))) {
              complete("close");
              return;
            }
            if (keybindings.matches(data, "tui.select.cancel")) {
              complete("close");
              return;
            }
            if (keybindings.matches(data, "tui.select.up")) {
              select(selectedIndex - 1, true);
              return;
            }
            if (keybindings.matches(data, "tui.select.down")) {
              select(selectedIndex + 1, true);
              return;
            }
            if (keybindings.matches(data, "tui.select.pageUp")) {
              select(selectedIndex - availableRows(tui.terminal.rows, rows.length), false);
              return;
            }
            if (keybindings.matches(data, "tui.select.pageDown")) {
              select(selectedIndex + availableRows(tui.terminal.rows, rows.length), false);
              return;
            }
            if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
              activate();
              return;
            }
            if (shortcutUp && matchesKey(data, shortcutUp)) {
              moveTicker(-1);
              return;
            }
            if (shortcutDown && matchesKey(data, shortcutDown)) {
              moveTicker(1);
              return;
            }
            handleSearch(data);
          },
          async waitForPending() {
            await pending;
          },
          dispose() {
            disposed = true;
          },
          get focused() {
            return searchInput.focused;
          },
          set focused(value: boolean) {
            searchInput.focused = value;
          },
        };
      },
    });

    if (result.kind !== "completed" || result.value === "close") return;
    const entered = await ctx.ui.input("Add custom ticker", "Yahoo symbol, for example MSFT or SOL-USD", {
      signal: options.signal,
    });
    if (options.signal.aborted || !options.isCurrent()) return;
    if (!entered?.trim()) continue;
    try {
      const parsed = parseSymbols([entered]);
      if (parsed.length !== 1) throw new Error("Enter exactly one Yahoo Finance symbol.");
      const symbol = parsed[0];
      if (!symbol) continue;
      const current = options.getSymbols();
      if (current.includes(symbol)) {
        ctx.ui.notify(`${symbol} is already selected.`, "info");
        continue;
      }
      await options.applySymbols([...current, symbol], options.signal);
      if (options.signal.aborted || !options.isCurrent()) return;
    } catch (error) {
      if (options.signal.aborted || !options.isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(sanitizeTerminalText(message), "error");
    }
  }
}

function parseDirectSymbol(value: string): string {
  const parsed = parseSymbols([value]);
  if (parsed.length !== 1) throw new Error("Enter exactly one Yahoo Finance symbol.");
  const symbol = parsed[0];
  if (!symbol) throw new Error("Enter one Yahoo Finance symbol.");
  return symbol;
}

function tryDirectSymbol(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    return parseDirectSymbol(value);
  } catch {
    return undefined;
  }
}

function availableRows(terminalRows: number, rowCount: number): number {
  const boundedRows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows) - 9) : 10;
  return Math.max(1, Math.min(rowCount, boundedRows, 12));
}

function shortcutAvailable(
  keybindings: {
    getKeys(binding: string): readonly string[];
  },
  shortcut: "shift+up" | "shift+down",
): typeof shortcut | undefined {
  const unavailable = new Set(
    [
      "ctrl+c",
      "home",
      "end",
      "space",
      ...RESERVED_INPUT_BINDINGS.flatMap((binding) => keybindings.getKeys(binding)),
    ].map(canonicalKey),
  );
  return unavailable.has(canonicalKey(shortcut)) ? undefined : shortcut;
}

function canonicalKey(value: string): string {
  const parts = value.toLowerCase().split("+");
  const base = parts.at(-1) ?? "";
  const canonicalBase = base === "escape" ? "esc" : base === "return" ? "enter" : base;
  const modifiers = ["ctrl", "shift", "alt", "super"].filter((modifier) => parts.includes(modifier));
  return [...modifiers, canonicalBase].join("+");
}
