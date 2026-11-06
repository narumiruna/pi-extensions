import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { fetchQuotes, parseQuote, QUOTE_ENDPOINT, QuoteRequestTimeoutError } from "../src/quotes.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quotePayload(symbol: string, price = 110, previousClose = 100, currency = "usd"): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            regularMarketPrice: price,
            previousClose,
            currency,
            regularMarketTime: 1_700_000_000,
          },
        },
      ],
    },
  };
}

test("parses a quote and computes its daily change", () => {
  assert.deepEqual(parseQuote("NVDA", quotePayload("NVDA")), {
    symbol: "NVDA",
    price: 110,
    previousClose: 100,
    change: 10,
    changePercent: 10,
    currency: "USD",
    marketTime: 1_700_000_000_000,
  });
});

test("preserves Yahoo's case-sensitive pence currency unit", () => {
  assert.equal(parseQuote("VOD.L", quotePayload("VOD.L", 75, 74, "GBp")).currency, "GBp");
});

test("fetches symbols independently and retains partial failures", async () => {
  const fetchImplementation = vi.fn<typeof fetch>(async (input) =>
    input === `${QUOTE_ENDPOINT}/AAPL?interval=1m&range=1d` ? response({}, 503) : response(quotePayload("NVDA")),
  );
  const controller = new AbortController();
  const results = await fetchQuotes(["NVDA", "AAPL"], controller.signal, fetchImplementation);

  assert.deepEqual(
    fetchImplementation.mock.calls.map(([input]) => input),
    [`${QUOTE_ENDPOINT}/NVDA?interval=1m&range=1d`, `${QUOTE_ENDPOINT}/AAPL?interval=1m&range=1d`],
  );
  assert.equal(results[0]?.quote?.symbol, "NVDA");
  assert.equal(results[1]?.error, "Quote request failed with HTTP 503.");
});

test("retains settled quotes when another request reaches the shared timeout", async () => {
  const controller = new AbortController();
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    if (input === `${QUOTE_ENDPOINT}/NVDA?interval=1m&range=1d`) return response(quotePayload("NVDA"));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const pending = fetchQuotes(["NVDA", "AAPL"], controller.signal, fetchImplementation);
  controller.abort(new QuoteRequestTimeoutError());
  const results = await pending;

  assert.equal(results[0]?.quote?.symbol, "NVDA");
  assert.equal(results[1]?.error, "Quote request timed out.");
});

test("rejects malformed quote payloads", () => {
  assert.throws(
    () => parseQuote("NVDA", { chart: { result: [] } }),
    new Error("Quote response did not include a usable price and previous close."),
  );
});

test("propagates cancellation instead of converting it into quote errors", async () => {
  const controller = new AbortController();
  const fetchImplementation = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const pending = fetchQuotes(["NVDA"], controller.signal, fetchImplementation);
  controller.abort();
  await assert.rejects(pending, new Error("aborted"));
});
