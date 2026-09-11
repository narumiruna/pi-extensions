import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { HorizontalRule } from "../src/horizontal-rule.js";

test("horizontal rules fill the available width with optional symmetric padding", () => {
  assert.deepEqual(new HorizontalRule().render(12), ["─".repeat(12)]);
  assert.deepEqual(new HorizontalRule({ paddingX: 2 }).render(12), [`  ${"─".repeat(8)}  `]);
  assert.deepEqual(new HorizontalRule({ paddingX: 20 }).render(3), [" ─ "]);
});

test("labeled horizontal rules support left, center, and right alignment", () => {
  assert.deepEqual(new HorizontalRule({ label: "Title", labelAlignment: "left" }).render(16), ["─ Title ────────"]);
  assert.deepEqual(new HorizontalRule({ label: "Title" }).render(16), ["──── Title ─────"]);
  assert.deepEqual(new HorizontalRule({ label: "Title", labelAlignment: "right" }).render(16), ["──────── Title ─"]);
});

test("horizontal rules remain cell-width safe for narrow and wide-character labels", () => {
  const rules = [
    new HorizontalRule({ label: "A label that does not fit", paddingX: 2 }),
    new HorizontalRule({ label: "狀態 🧭", labelAlignment: "right" }),
  ];
  for (const width of [0, 1, 2, 3, 4, 8, 20]) {
    for (const rule of rules) {
      const lines = rule.render(width);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0] ?? "") <= width);
      if (width > 0) assert.equal(visibleWidth(lines[0] ?? ""), width);
    }
  }
});

test("horizontal rule labels strip terminal and bidirectional controls", () => {
  const rendered = new HorizontalRule({
    label: "Unsafe\u001b]8;;https://example.com\u0007 title\u202eraw",
  }).render(40)[0];
  assert.ok(rendered);
  assert.equal(rendered, stripVTControlCharacters(rendered));
  assert.equal(rendered.includes("\u202e"), false);
  assert.match(rendered, /Unsafe title.*raw/);
});

test("horizontal rule styling callbacks run during each render", () => {
  let color = 31;
  const rule = new HorizontalRule({
    label: "Status",
    ruleStyle: (text) => `\u001b[${color}m${text}\u001b[0m`,
    labelStyle: (text) => `\u001b[1m${text}\u001b[22m`,
  });
  const first = rule.render(20)[0] ?? "";
  assert.equal(first.includes("\u001b[31m"), true);
  assert.equal(visibleWidth(first), 20);

  color = 32;
  rule.invalidate();
  const second = rule.render(20)[0] ?? "";
  assert.equal(second.includes("\u001b[32m"), true);
  assert.equal(visibleWidth(second), 20);
});
