import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseSymbols } from "./settings.js";

type Screen = "tickers" | "order" | "move";
type Action = "toggle" | "addCustom" | "toggleWidget" | "chooseTicker" | "moveUp" | "moveDown" | "refresh";

export interface TickerMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getSymbols(): readonly string[];
  applySymbols(symbols: readonly string[], signal: AbortSignal): Promise<void>;
  getWidgetEnabled(): boolean;
  applyWidgetEnabled(widgetEnabled: boolean, signal: AbortSignal): Promise<void>;
  refresh(): void;
}

export async function showTickerMenu(ctx: ExtensionCommandContext, options: TickerMenuOptions): Promise<void> {
  if (options.signal.aborted || !options.isCurrent()) return;
  if (ctx.mode === "tui") {
    const { showTickerTuiMenu } = await import("./tui-menu.js");
    if (options.signal.aborted || !options.isCurrent()) return;
    await showTickerTuiMenu(ctx, options);
    return;
  }

  const { defineMenu, runMenu, sanitizeTerminalText } = await import("@narumitw/pi-tui-kit");
  if (options.signal.aborted || !options.isCurrent()) return;
  let menuCandidates = [...options.getSymbols()];
  let movingSymbol: string | undefined;
  const candidates = () => {
    for (const symbol of options.getSymbols()) {
      if (!menuCandidates.includes(symbol)) menuCandidates.push(symbol);
    }
    return menuCandidates;
  };
  const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
    start: "tickers",
    screens: {
      tickers: () => {
        const selected = new Set(options.getSymbols());
        return {
          kind: "multiSelect",
          title: "Manage tickers",
          lines: [`${selected.size} selected · uncheck to remove · changes save immediately`],
          items: candidates().map((symbol) => ({
            id: symbol,
            label: symbol,
            description: "Display this Yahoo Finance symbol in the editor widget.",
            selected: selected.has(symbol),
            searchText: symbol.replaceAll("-", " "),
          })),
          action: "toggle",
          enableSearch: true,
          viewportSize: 10,
          actions: [
            {
              id: "add-custom",
              label: "Add custom ticker…",
              description: "Add and select one Yahoo Finance symbol.",
              action: "addCustom",
            },
            ...(selected.size > 1
              ? [
                  {
                    id: "reorder",
                    label: "Reorder tickers…",
                    description: "Change the order shown in the editor widget.",
                    to: "order" as const,
                  },
                ]
              : []),
            {
              id: "widget-enabled",
              label: `Widget: ${options.getWidgetEnabled() ? "On" : "Off"}`,
              description: "Show or hide the editor widget and persist this setting.",
              action: "toggleWidget",
            },
            {
              id: "refresh",
              label: "Refresh now",
              description: options.getWidgetEnabled()
                ? "Fetch the selected symbols immediately."
                : "Enable the widget before refreshing.",
              action: "refresh",
            },
          ],
          hint: "close",
          doneLabel: "Close",
        };
      },
      order: () => ({
        kind: "choice",
        title: "Ticker order",
        lines: ["Choose a ticker to move."],
        items: options.getSymbols().map((symbol, index) => ({
          id: symbol,
          label: `${index + 1}. ${symbol}`,
          description: "Select this ticker, then move it up or down.",
        })),
        action: "chooseTicker",
        viewportSize: 10,
      }),
      move: () => {
        const symbols = options.getSymbols();
        const index = movingSymbol ? symbols.indexOf(movingSymbol) : -1;
        const available = index >= 0;
        return {
          kind: "actions",
          title: movingSymbol ? `Move ${movingSymbol}` : "Move ticker",
          lines: [
            available ? `Position ${index + 1} of ${symbols.length}` : "Ticker is no longer selected.",
            `Order: ${symbols.join(" · ")}`,
          ],
          items: [
            {
              id: "move-up",
              label: "Move up",
              description: "Move this ticker one position toward the start.",
              disabled: !available || index === 0,
              disabledReason: !available ? "Ticker is unavailable" : index === 0 ? "Already first" : undefined,
              action: "moveUp",
            },
            {
              id: "move-down",
              label: "Move down",
              description: "Move this ticker one position toward the end.",
              disabled: !available || index === symbols.length - 1,
              disabledReason: !available
                ? "Ticker is unavailable"
                : index === symbols.length - 1
                  ? "Already last"
                  : undefined,
              action: "moveDown",
            },
          ],
        };
      },
    },
    actions: {
      toggle: async ({ itemId, selected, signal }) => {
        if (!candidates().includes(itemId)) return { kind: "rejected" };
        const next = new Set(options.getSymbols());
        if (selected) next.add(itemId);
        else next.delete(itemId);
        await options.applySymbols(orderedSymbols(next, candidates()), signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "stay" };
        if (!selected) menuCandidates = menuCandidates.filter((symbol) => symbol !== itemId);
        return { kind: "stay" };
      },
      addCustom: async ({ ctx: actionCtx, signal }) => {
        const entered = await actionCtx.ui.input("Add custom ticker", "Yahoo symbol, for example MSFT or SOL-USD", {
          signal,
        });
        if (signal.aborted || !options.isCurrent()) return { kind: "stay" };
        if (!entered?.trim()) return { kind: "stay" };
        const parsed = parseSymbols([entered]);
        if (parsed.length !== 1) throw new Error("Enter exactly one Yahoo Finance symbol.");
        const symbol = parsed[0];
        if (!symbol) return { kind: "stay" };
        const selected = new Set(options.getSymbols());
        if (selected.has(symbol)) {
          actionCtx.ui.notify(`${symbol} is already selected.`, "info");
          return { kind: "stay" };
        }
        selected.add(symbol);
        await options.applySymbols([...selected], signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "stay" };
        if (!menuCandidates.includes(symbol)) menuCandidates.push(symbol);
        return { kind: "stay" };
      },
      toggleWidget: async ({ signal }) => {
        await options.applyWidgetEnabled(!options.getWidgetEnabled(), signal);
        if (signal.aborted || !options.isCurrent()) return { kind: "stay" };
        return { kind: "stay" };
      },
      chooseTicker: ({ itemId }) => {
        if (!options.getSymbols().includes(itemId)) return { kind: "rejected" };
        movingSymbol = itemId;
        return { kind: "to", screen: "move" };
      },
      moveUp: ({ signal }) => moveSelectedTicker(-1, signal),
      moveDown: ({ signal }) => moveSelectedTicker(1, signal),
      refresh: () => {
        options.refresh();
        return { kind: "stay" };
      },
    },
  });

  async function moveSelectedTicker(direction: -1 | 1, signal: AbortSignal) {
    const current = options.getSymbols();
    const from = movingSymbol ? current.indexOf(movingSymbol) : -1;
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return { kind: "rejected" } as const;
    const next = [...current];
    const [symbol] = next.splice(from, 1);
    if (!symbol) return { kind: "rejected" } as const;
    next.splice(to, 0, symbol);
    await options.applySymbols(next, signal);
    if (signal.aborted || !options.isCurrent()) return { kind: "stay" } as const;
    menuCandidates = [...next];
    return { kind: "stay" } as const;
  }

  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (menuCtx, error) => {
      if (!menuCtx.hasUI) return;
      const message = error instanceof Error ? error.message : String(error);
      menuCtx.ui.notify(sanitizeTerminalText(message), "error");
    },
    onUnsupportedMode: (menuCtx, mode) => {
      if (menuCtx.hasUI) menuCtx.ui.notify(`Ticker menu is unavailable in ${mode} mode.`, "warning");
    },
  });
}

function orderedSymbols(selected: ReadonlySet<string>, candidates: readonly string[]): string[] {
  return candidates.filter((symbol) => selected.has(symbol));
}
