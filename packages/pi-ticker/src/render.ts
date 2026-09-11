import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Quote } from "./quotes.js";

export interface TickerItem {
  symbol: string;
  quote?: Quote;
  error?: string;
  stale?: boolean;
}

export interface TickerView {
  items: TickerItem[];
  loading: boolean;
  updatedAt?: number;
}

export function renderTickerWidget(view: TickerView, theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  if (renderWidth === 0) return [""];
  const heading = renderHeading(view, theme);
  const separator = theme.fg("dim", "  │  ");
  const quotes = packItems(
    view.items.map((item) => renderItem(item, theme)),
    separator,
    renderWidth,
  );
  return [theme.fg("borderMuted", "─".repeat(renderWidth)), ...fitLines(heading, renderWidth), ...quotes];
}

export function formatTickerPlain(view: TickerView): string[] {
  const status = view.loading
    ? "Stocks · updating"
    : view.updatedAt
      ? `Stocks · updated ${new Date(view.updatedAt).toLocaleTimeString()}`
      : "Stocks";
  return [status, ...view.items.map(formatItemPlain)];
}

export function mergeQuoteResults(
  current: readonly TickerItem[],
  results: ReadonlyArray<{ symbol: string; quote?: Quote; error?: string }>,
): TickerItem[] {
  const previous = new Map(current.map((item) => [item.symbol, item]));
  return results.map((result) => {
    if (result.quote) return { symbol: result.symbol, quote: result.quote };
    const existing = previous.get(result.symbol);
    return existing?.quote
      ? { symbol: result.symbol, quote: existing.quote, error: result.error, stale: true }
      : { symbol: result.symbol, error: result.error };
  });
}

function renderHeading(view: TickerView, theme: Theme): string {
  if (view.loading) return theme.fg("muted", "Stocks · updating…");
  if (view.updatedAt) {
    return theme.fg("muted", `Stocks · updated ${new Date(view.updatedAt).toLocaleTimeString()}`);
  }
  return theme.fg("muted", "Stocks");
}

function renderItem(item: TickerItem, theme: Theme): string {
  const symbol = theme.fg("accent", theme.bold(item.symbol));
  if (!item.quote) return `${symbol} ${theme.fg("error", "unavailable")}`;
  const changeRole = item.quote.change >= 0 ? "success" : "error";
  const content = `${symbol} ${theme.fg("text", formatPrice(item.quote))} ${theme.fg(
    changeRole,
    formatChange(item.quote),
  )}`;
  return item.stale ? `${content} ${theme.fg("warning", "stale")}` : content;
}

function formatItemPlain(item: TickerItem): string {
  if (!item.quote) return `${item.symbol} unavailable`;
  const content = `${item.symbol} ${formatPrice(item.quote)} ${formatChange(item.quote)}`;
  return item.stale ? `${content} stale` : content;
}

function formatPrice(quote: Quote): string {
  const value = formatMarketNumber(quote.price);
  if (quote.currency === "GBp") return `${value}p`;
  return `${currencyPrefix(quote.currency)}${value}`;
}

function formatChange(quote: Quote): string {
  const sign = quote.change >= 0 ? "+" : "";
  return `${sign}${formatMarketNumber(quote.change)} (${sign}${quote.changePercent.toFixed(2)}%)`;
}

function formatMarketNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute === 0) return "0.00";
  const magnitude = Math.floor(Math.log10(absolute));
  const significantDecimals = 6 - magnitude - 1;
  const formatted = significantDecimals > 8 ? value.toPrecision(6) : value.toFixed(Math.max(2, significantDecimals));
  return trimNumericZeros(formatted);
}

function trimNumericZeros(value: string): string {
  const [coefficient, exponent] = value.split("e");
  const [integer = value, fraction = ""] = coefficient?.split(".") ?? [value, ""];
  let trimmedFraction = fraction;
  const minimumFractionDigits = exponent === undefined ? 2 : 0;
  while (trimmedFraction.length > minimumFractionDigits && trimmedFraction.endsWith("0")) {
    trimmedFraction = trimmedFraction.slice(0, -1);
  }
  const trimmed = trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

function currencyPrefix(currency: string | undefined): string {
  switch (currency) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "JPY":
      return "¥";
    case "CAD":
      return "C$";
    case "HKD":
      return "HK$";
    case "TWD":
      return "NT$";
    default:
      return currency ? `${currency} ` : "";
  }
}

function packItems(items: readonly string[], separator: string, width: number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const item of items) {
    if (visibleWidth(item) > width) {
      if (current) rows.push(current);
      rows.push(...fitLines(item, width));
      current = "";
      continue;
    }
    const candidate = current ? `${current}${separator}${item}` : item;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    rows.push(current);
    current = item;
  }
  if (current) rows.push(current);
  return rows;
}

function fitLines(content: string, width: number): string[] {
  return wrapTextWithAnsi(content, width).map((line) => truncateToWidth(line, width, ""));
}
