import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { test } from "vitest";
import { formatTickerPlain, mergeQuoteResults, renderTickerBody, type TickerView } from "../src/render.js";

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

function createWidget(view: TickerView) {
  return new EditorStatusWidget({ theme, renderBody: (width) => renderTickerBody(view, theme, width) });
}

test("renders every widget line within the supplied width", () => {
  const lines = createWidget({
    items: [
      { symbol: "NVDA", quote },
      { symbol: "AAPL", quote: { ...quote, symbol: "AAPL", change: -2, changePercent: -2 } },
    ],
    loading: false,
    updatedAt: 1_700_000_000_000,
  }).render(32);
  assert.equal(stripTerminalSequences(lines[0] ?? ""), "─".repeat(32));
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
  assert.ok(lines.some((line) => stripTerminalSequences(line) === "NVDA $110.00 +10.00 (+10.00%)"));
  assert.ok(lines.some((line) => stripTerminalSequences(line).startsWith("AAPL $110.00")));
});

test("packs complete quotes together and wraps them only when they do not fit", () => {
  const widget = createWidget({
    items: [
      { symbol: "NVDA", quote },
      { symbol: "AAPL", quote: { ...quote, symbol: "AAPL" } },
    ],
    loading: false,
  });
  const item = "NVDA $110.00 +10.00 (+10.00%)";
  const second = item.replace("NVDA", "AAPL");
  assert.deepEqual(widget.render(80), ["─".repeat(80), "Stocks", `${item}  │  ${second}`]);
  assert.deepEqual(widget.render(32), ["─".repeat(32), "Stocks", item, second]);
  assert.deepEqual(widget.render(16), [
    "─".repeat(16),
    "Stocks",
    "NVDA $110.00",
    "+10.00 (+10.00%)",
    "AAPL $110.00",
    "+10.00 (+10.00%)",
  ]);
  assert.deepEqual(widget.render(80), ["─".repeat(80), "Stocks", `${item}  │  ${second}`]);
});

test.each([80, 32, 7, 2, 1, 0, -1, 0.9, 7.9, Number.NaN, Infinity, -Infinity])(
  "bounds wide content at width %s",
  (width) => {
    const widget = createWidget({
      items: [{ symbol: "東京📈e\u0301", quote: { ...quote, currency: "円" }, stale: true }],
      loading: true,
    });
    const lines = widget.render(width);
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    assert.equal(lines[0], "─".repeat(normalized));
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 0) assert.deepEqual(lines, [""]);
    else assert.ok(lines.length > 1);
    if (normalized === 80) assert.match(lines[2] ?? "", /東京📈e\u0301 円 110\.00 .* stale/);
  },
);

test("sanitizes raw display values before styling and packing without changing the snapshot", () => {
  const view: TickerView = {
    items: [
      {
        symbol: "\u001b]0;owned\u0007NV\u202eDA\nX",
        quote: { ...quote, currency: "\u001b[31mUSD\u001b[0m\u0007" },
      },
    ],
    loading: false,
  };
  const original = structuredClone(view);
  const calls: string[] = [];
  const callbackTheme = {
    fg: (_role: string, text: string) => {
      calls.push(text);
      return text;
    },
    bold: (text: string) => {
      calls.push(text);
      return text;
    },
  } as unknown as Theme;
  const widget = new EditorStatusWidget({
    theme: callbackTheme,
    renderBody: (width) => renderTickerBody(view, callbackTheme, width),
  });
  const plain = ["Stocks", "NVDA X USD 110.00 +10.00 (+10.00%)"];
  assert.deepEqual(widget.render(80), ["─".repeat(80), ...plain]);
  assert.deepEqual(formatTickerPlain(view), plain);
  assert.ok(calls.includes("NVDA X"));
  assert.ok(calls.every((text) => ["\u001b", "\u0007", "\u202e", "\n"].every((control) => !text.includes(control))));
  assert.deepEqual(view, original);
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
