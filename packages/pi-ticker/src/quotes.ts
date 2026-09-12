export const QUOTE_ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  currency?: string;
  marketTime?: number;
}

export interface QuoteResult {
  symbol: string;
  quote?: Quote;
  error?: string;
}

export class QuoteRequestTimeoutError extends Error {
  constructor() {
    super("Quote request timed out.");
    this.name = "QuoteRequestTimeoutError";
  }
}

export async function fetchQuotes(
  symbols: readonly string[],
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<QuoteResult[]> {
  return Promise.all(
    symbols.map(async (symbol): Promise<QuoteResult> => {
      try {
        const quote = await fetchQuote(symbol, signal, fetchImplementation);
        return { symbol, quote };
      } catch (error) {
        if (signal.aborted) {
          if (!(signal.reason instanceof QuoteRequestTimeoutError)) throw error;
          return { symbol, error: signal.reason.message };
        }
        return { symbol, error: errorMessage(error) };
      }
    }),
  );
}

async function fetchQuote(symbol: string, signal: AbortSignal, fetchImplementation: typeof fetch): Promise<Quote> {
  const url = `${QUOTE_ENDPOINT}/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const response = await fetchImplementation(url, {
    headers: { "User-Agent": "pi-ticker/1.0" },
    signal,
  });
  if (!response.ok) throw new Error(`Quote request failed with HTTP ${response.status}.`);
  return parseQuote(symbol, await response.json());
}

export function parseQuote(requestedSymbol: string, payload: unknown): Quote {
  const chart = asRecord(payload)?.chart;
  const result = asRecord(chart)?.result;
  const first = Array.isArray(result) ? asRecord(result[0]) : undefined;
  const meta = asRecord(first?.meta);
  const price = finiteNumber(meta?.regularMarketPrice);
  const previousClose = finiteNumber(meta?.previousClose) ?? finiteNumber(meta?.chartPreviousClose);
  if (price === undefined || previousClose === undefined || previousClose === 0) {
    throw new Error("Quote response did not include a usable price and previous close.");
  }
  const change = price - previousClose;
  const currency = safeCurrency(meta?.currency);
  const marketTimeSeconds = finiteNumber(meta?.regularMarketTime);
  return {
    symbol: requestedSymbol,
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    ...(currency ? { currency } : {}),
    ...(marketTimeSeconds === undefined ? {} : { marketTime: marketTimeSeconds * 1000 }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeCurrency(value: unknown): string | undefined {
  if (value === "GBp") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
