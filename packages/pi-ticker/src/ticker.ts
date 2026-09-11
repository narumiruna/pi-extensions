import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { fetchQuotes, QuoteRequestTimeoutError } from "./quotes.js";
import {
  formatTickerPlain,
  mergeQuoteResults,
  renderTickerWidget,
  type TickerItem,
  type TickerView,
} from "./render.js";
import { createSettingsWriter, loadSettings, normalizeSymbols, parseSymbols } from "./settings.js";

export interface StockTickerDependencies {
  createSettingsWriter: typeof createSettingsWriter;
  loadSettings: typeof loadSettings;
}

export const WIDGET_KEY = "ticker";
export const SETTINGS_FILE_NAME = "pi-ticker.json";
export const POLL_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;

const HELP = "Usage: /ticker [SYMBOL ...] | /ticker refresh | /ticker reset | /ticker help";
const COMPLETIONS: AutocompleteItem[] = [
  { value: "refresh", label: "refresh", description: "Refresh quotes now" },
  { value: "reset", label: "reset", description: "Explain why no default reset is available" },
  { value: "help", label: "help", description: "Show command usage" },
];

export default function stockTicker(pi: ExtensionAPI, dependencies: Partial<StockTickerDependencies> = {}): void {
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let generation = 0;
  let cycleVersion = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let sessionController: AbortController | undefined;
  const activeMenus = new Set<Promise<void>>();
  let symbols: string[] = [];
  let widgetEnabled = true;
  let view: TickerView = createInitialView(symbols);
  const settingsWriter = (dependencies.createSettingsWriter ?? createSettingsWriter)();
  const readSettings = dependencies.loadSettings ?? loadSettings;

  const ownsSession = (ctx: ExtensionContext, expectedGeneration = generation): boolean =>
    ctx.sessionManager === activeSession && expectedGeneration === generation;

  const publish = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !ownsSession(ctx)) return;
    if (!widgetEnabled || view.items.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const snapshot = cloneView(view);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui: unknown, theme: Theme) => ({
          render: (width: number) => renderTickerWidget(snapshot, theme, width),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, formatTickerPlain(snapshot), { placement: "aboveEditor" });
  };

  const stopPolling = (): void => {
    cycleVersion += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    requestController?.abort();
    requestController = undefined;
  };

  const clearWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const runCycle = async (ctx: ExtensionContext, expectedGeneration: number, expectedCycle: number): Promise<void> => {
    if (!ownsSession(ctx, expectedGeneration) || expectedCycle !== cycleVersion) return;
    view = { ...view, loading: true };
    publish(ctx);

    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new QuoteRequestTimeoutError());
    }, REQUEST_TIMEOUT_MS);
    try {
      const results = await fetchQuotes(symbols, controller.signal);
      if (!ownsSession(ctx, expectedGeneration) || expectedCycle !== cycleVersion) return;
      view = {
        items: mergeQuoteResults(view.items, results),
        loading: false,
        updatedAt: results.some((result) => result.quote) ? Date.now() : view.updatedAt,
      };
      publish(ctx);
    } catch {
      if (!controller.signal.aborted && ownsSession(ctx, expectedGeneration) && expectedCycle === cycleVersion) {
        view = {
          items: view.items.map((item) => ({
            ...item,
            stale: Boolean(item.quote),
            error: "unavailable",
          })),
          loading: false,
          updatedAt: view.updatedAt,
        };
        publish(ctx);
      }
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = undefined;
    }
  };

  const startCycle = (ctx: ExtensionContext, expectedGeneration = generation): void => {
    if (!ownsSession(ctx, expectedGeneration)) return;
    if (!widgetEnabled || symbols.length === 0) {
      stopPolling();
      publish(ctx);
      return;
    }
    if (pollTimer) clearTimeout(pollTimer);
    requestController?.abort();
    const expectedCycle = ++cycleVersion;
    void runCycle(ctx, expectedGeneration, expectedCycle).finally(() => {
      if (!ownsSession(ctx, expectedGeneration) || expectedCycle !== cycleVersion) return;
      pollTimer = setTimeout(() => startCycle(ctx, expectedGeneration), POLL_INTERVAL_MS);
    });
  };

  const openMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const controller = sessionController;
    const expectedGeneration = generation;
    if (!controller || controller.signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
    const running = (async () => {
      const { showTickerMenu } = await import("./menu.js");
      if (controller.signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
      await showTickerMenu(ctx, {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted && ownsSession(ctx, expectedGeneration),
        getSymbols: () => [...symbols],
        applySymbols: async (nextSymbols, signal) => {
          if (signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
          const normalized = normalizeSymbols(nextSymbols, true);
          await settingsWriter.save(settingsPath(), normalized);
          if (signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
          symbols = normalized;
          view = createInitialView(symbols);
          publish(ctx);
          startCycle(ctx, expectedGeneration);
        },
        getWidgetEnabled: () => widgetEnabled,
        applyWidgetEnabled: async (nextWidgetEnabled, signal) => {
          if (signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
          await settingsWriter.saveWidgetEnabled(settingsPath(), nextWidgetEnabled);
          if (signal.aborted || !ownsSession(ctx, expectedGeneration)) return;
          widgetEnabled = nextWidgetEnabled;
          if (!widgetEnabled) stopPolling();
          publish(ctx);
          if (widgetEnabled) startCycle(ctx, expectedGeneration);
        },
        refresh: () => {
          if (!ownsSession(ctx, expectedGeneration)) return;
          if (!widgetEnabled) {
            notify(ctx, "Ticker widget is disabled. Enable it before refreshing.", "warning");
            return;
          }
          startCycle(ctx, expectedGeneration);
        },
      });
    })();
    activeMenus.add(running);
    try {
      await running;
    } finally {
      activeMenus.delete(running);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionController?.abort();
    stopPolling();
    activeSession = ctx.sessionManager;
    sessionController = new AbortController();
    const expectedGeneration = ++generation;
    symbols = [];
    widgetEnabled = true;
    view = createInitialView(symbols);
    publish(ctx);

    await settingsWriter.flush();
    if (!ownsSession(ctx, expectedGeneration)) return;
    const loaded = await readSettings(settingsPath());
    if (!ownsSession(ctx, expectedGeneration)) return;
    symbols = loaded.settings.symbols;
    widgetEnabled = loaded.settings.widgetEnabled;
    view = createInitialView(symbols);
    publish(ctx);
    if (loaded.warning) notify(ctx, loaded.warning, "warning");
    if (ctx.hasUI && widgetEnabled && symbols.length > 0) startCycle(ctx, expectedGeneration);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    sessionController?.abort();
    stopPolling();
    clearWidget(ctx);
    activeSession = undefined;
    sessionController = undefined;
    generation += 1;
    await Promise.allSettled([...activeMenus]);
    await settingsWriter.flush();
  });

  pi.registerCommand("ticker", {
    description: "Show or change the stock ticker symbols",
    getArgumentCompletions: completeArguments,
    handler: async (argumentsText, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("The /ticker command requires TUI or RPC mode.");
      }
      const input = argumentsText.trim();
      if (!input) {
        await openMenu(ctx);
        return;
      }

      const words = input.split(/\s+/);
      const route = words[0]?.toLowerCase();
      if (["help", "refresh", "reset"].includes(route ?? "") && words.length > 1) {
        notify(ctx, `${route} does not accept trailing arguments.`, "error");
        return;
      }
      if (route === "help") {
        notify(ctx, HELP);
        return;
      }
      if (route === "refresh") {
        if (!widgetEnabled) {
          notify(ctx, "Ticker widget is disabled. Enable it with /ticker before refreshing.", "warning");
          return;
        }
        if (ownsSession(ctx)) startCycle(ctx);
        notify(ctx, "Refreshing stock quotes.");
        return;
      }

      if (route === "reset") {
        notify(ctx, "No default ticker list is configured. Use /ticker SYMBOL ... instead.", "error");
        return;
      }

      let nextSymbols: string[];
      try {
        nextSymbols = parseSymbols([input]);
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
        return;
      }
      try {
        await settingsWriter.save(settingsPath(), nextSymbols);
      } catch (error) {
        notify(ctx, `Could not save stock ticker settings: ${errorMessage(error)}`, "error");
        return;
      }
      if (!ownsSession(ctx)) return;
      symbols = nextSymbols;
      view = createInitialView(symbols);
      publish(ctx);
      startCycle(ctx);
      notify(ctx, `Stock ticker symbols: ${symbols.join(" ")}`);
    },
  });
}

export function settingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILE_NAME);
}

export function completeArguments(prefix: string): AutocompleteItem[] | null {
  if (/\s/.test(prefix)) return null;
  const normalized = prefix.toLowerCase();
  const matches = COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

function createInitialView(symbols: readonly string[]): TickerView {
  return {
    items: symbols.map((symbol): TickerItem => ({ symbol })),
    loading: true,
  };
}

function cloneView(view: TickerView): TickerView {
  return {
    ...view,
    items: view.items.map((item) => ({ ...item, quote: item.quote && { ...item.quote } })),
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(sanitizeTerminalText(message), type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
