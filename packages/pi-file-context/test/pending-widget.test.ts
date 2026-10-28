import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createFileQuoteSnapshot, publishPendingQuoteWidget } from "../src/file-context.js";
import { createPendingWidget } from "./widget-support.js";

const quote = createFileQuoteSnapshot("src/界界e\u0301.ts", 2, 3, "first\nsecond");

test("frames pending quotes with the callback theme across resize and invalidation", () => {
  const context = createMockContext({
    mode: "tui",
    theme: {
      fg: () => {
        throw new Error("TUI rendering must use the callback theme");
      },
    },
  });
  publishPendingQuoteWidget(context.ctx, [quote]);
  const roles: string[] = [];
  let color = 31;
  const component = createPendingWidget(context.widgets.get("file-context"), {
    fg(role, text) {
      roles.push(role);
      return `\u001b[${color}m${text}\u001b[0m`;
    },
  });
  for (const width of [
    120,
    40,
    12,
    2,
    1,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.9,
    40.9,
    120,
  ]) {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    roles.length = 0;
    component.invalidate();
    const lines = component.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= normalized),
      `width ${width}`,
    );
    assert.equal(stripTerminalSequences(lines[0] ?? ""), "─".repeat(normalized));
    if (normalized === 0) {
      assert.ok(lines.every((line) => line === ""));
      assert.deepEqual(roles, []);
    } else {
      assert.ok(roles.includes("borderMuted"));
      assert.ok(roles.includes("accent"));
      assert.ok(roles.includes("muted"));
    }
  }
  assert.match(component.render(120).map(stripTerminalSequences).join("\n"), /src\/界界e\u0301\.ts · lines 2-3/u);
  assert.ok(component.render(120).every((line) => line.includes("\u001b[31m")));
  color = 32;
  component.invalidate();
  const lines = component.render(120);
  assert.ok(lines.every((line) => line.includes("\u001b[32m")));
  assert.ok(lines.every((line) => !line.includes("\u001b[31m")));
});

test("captures pending quote display snapshots without changing raw paths or content", () => {
  const snapshot = createFileQuoteSnapshot("src/unsafe\u001b[31m\n.txt", 1, 1, "raw\u001b[2J text");
  const original = { ...snapshot };
  const quotes = [snapshot];
  const context = createMockContext({ mode: "tui" });
  publishPendingQuoteWidget(context.ctx, quotes);
  const component = createPendingWidget(context.widgets.get("file-context"));
  const before = component.render(160);
  assert.equal(before[0], "─".repeat(160));
  assert.match(before[1] ?? "", /Next prompt context · 1 snippet/u);
  assert.ok(before[2]?.includes("src/unsafe\\x1b[31m\\x0a.txt"));
  assert.ok(before.every((line) => !line.includes("\u001b")));
  assert.deepEqual(snapshot, original);

  snapshot.path = "replacement.txt";
  snapshot.text = "different";
  quotes.push(quote);
  component.invalidate();
  assert.deepEqual(component.render(160), before);
  publishPendingQuoteWidget(context.ctx, quotes);
  const next = createPendingWidget(context.widgets.get("file-context")).render(160);
  assert.match(next[1] ?? "", /2 snippets/u);
  assert.match(next[2] ?? "", /replacement\.txt/u);
});

test.each(["tui", "rpc"])("removes display-direction controls before styling in %s mode", (mode) => {
  const directions = String.fromCodePoint(
    0x061c,
    0x200e,
    0x200f,
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
  );
  const unsafeQuote = createFileQuoteSnapshot(`src/${directions}note\u2028\u2029.txt`, 1, 1, "unchanged");
  const original = { ...unsafeQuote };
  const styled: string[] = [];
  const theme = {
    fg(_role: string, text: string) {
      styled.push(text);
      return text;
    },
  };
  const context = createMockContext({ mode, theme });
  publishPendingQuoteWidget(context.ctx, [unsafeQuote]);
  const value = context.widgets.get("file-context");
  const lines = mode === "tui" ? createPendingWidget(value, theme).render(160) : (value as string[]);
  assert.ok(lines.some((line) => line.includes("src/note  .txt")));
  for (const text of [...styled, ...lines]) {
    for (const control of `${directions}\u2028\u2029`) assert.ok(!text.includes(control));
  }
  assert.deepEqual(unsafeQuote, original);
});

test("preserves plain RPC rows without a component factory or separator", () => {
  const context = createMockContext({ mode: "rpc" });
  publishPendingQuoteWidget(context.ctx, [createFileQuoteSnapshot("example.txt", 1, 1, "example")]);
  assert.deepEqual(context.widgets.get("file-context"), [
    "Next prompt context · 1 snippet · ~2 tokens · /file-context to review",
    "1. example.txt · lines 1-1 · ~2 tokens",
  ]);
});

test.each(["tui", "rpc"])("clears only the pending widget key in %s mode", (mode) => {
  const context = createMockContext({ mode });
  context.widgets.set("unrelated", ["keep"]);
  publishPendingQuoteWidget(context.ctx, [quote]);
  assert.notEqual(context.widgets.get("file-context"), undefined);
  publishPendingQuoteWidget(context.ctx, []);
  assert.equal(context.widgets.get("file-context"), undefined);
  assert.deepEqual(context.widgets.get("unrelated"), ["keep"]);
});

test.each(["print", "json"])("does not publish widgets in %s mode", (mode) => {
  const context = createMockContext({ mode });
  publishPendingQuoteWidget(context.ctx, [quote]);
  publishPendingQuoteWidget(context.ctx, []);
  assert.equal(context.widgets.size, 0);
});
