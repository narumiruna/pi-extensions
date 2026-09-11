import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { formatTickerPlain, mergeQuoteResults, renderTickerWidget } from "../src/render.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const quote = {
  symbol: "NVDA",
  price: 110,
  previousClose: 100,
  change: 10,
  changePercent: 10,
  currency: "USD",
};

test("renders every widget line within the supplied width", () => {
  const lines = renderTickerWidget(
    {
      items: [
        { symbol: "NVDA", quote },
        { symbol: "AAPL", quote: { ...quote, symbol: "AAPL", change: -2, changePercent: -2 } },
      ],
      loading: false,
      updatedAt: 1_700_000_000_000,
    },
    theme,
    32,
  );
  assert.equal(stripTerminalSequences(lines[0] ?? ""), "─".repeat(32));
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
  assert.ok(lines.some((line) => stripTerminalSequences(line) === "NVDA $110.00 +10.00 (+10.00%)"));
  assert.ok(lines.some((line) => stripTerminalSequences(line).startsWith("AAPL $110.00")));
});

test("renders Yahoo pence prices without treating them as pounds", () => {
  const plain = formatTickerPlain({
    items: [{ symbol: "VOD.L", quote: { ...quote, symbol: "VOD.L", price: 75, currency: "GBp" } }],
    loading: false,
  });
  assert.match(plain[1] ?? "", /VOD\.L 75\.00p/);
  assert.doesNotMatch(plain[1] ?? "", /£75/);
});

test("preserves meaningful precision for low-priced and FX quotes", () => {
  const plain = formatTickerPlain({
    items: [
      {
        symbol: "MICRO",
        quote: {
          ...quote,
          symbol: "MICRO",
          price: 0.000012,
          change: 0.000001,
          changePercent: 9.09,
        },
      },
      {
        symbol: "EURUSD=X",
        quote: {
          ...quote,
          symbol: "EURUSD=X",
          price: 1.08437,
          change: 0.00123,
          changePercent: 0.11,
        },
      },
    ],
    loading: false,
  });

  assert.match(plain[1] ?? "", /MICRO \$0\.000012 \+0\.000001/);
  assert.match(plain[2] ?? "", /EURUSD=X \$1\.08437 \+0\.00123/);
});

test("keeps the previous quote as stale when one refresh fails", () => {
  const merged = mergeQuoteResults([{ symbol: "NVDA", quote }], [{ symbol: "NVDA", error: "network unavailable" }]);
  assert.deepEqual(merged, [{ symbol: "NVDA", quote, error: "network unavailable", stale: true }]);
  assert.match(formatTickerPlain({ items: merged, loading: false })[1] ?? "", /stale/);
});
