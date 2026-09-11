import assert from "node:assert/strict";
import { test } from "vitest";
import { formatInteractionHints } from "../src/index.js";

const keybindings = {
  getKeys(binding: string): readonly string[] {
    const keys: Record<string, readonly string[]> = {
      "tui.select.up": ["up", "k", "up"],
      "tui.select.down": ["down", "j"],
      "tui.select.confirm": ["return", "enter"],
      "tui.select.cancel": ["escape", "ctrl+c", "escape"],
    };
    return keys[binding] ?? [];
  },
};

test("formatInteractionHints formats injected bindings, literal shortcuts, and safe labels", () => {
  const result = formatInteractionHints(keybindings, [
    {
      bindings: ["tui.select.up", "tui.select.down"],
      label: "live\u0007 preview",
    },
    { bindings: ["tui.select.confirm"], label: "apply" },
    {
      bindings: ["tui.select.cancel"],
      excludeKeys: ["ctrl+c"],
      label: "back",
    },
    { keys: ["e", "e"], label: "customize" },
    { keys: ["ctrl+c"], label: "close" },
  ]);

  assert.equal(result, "↑/k/↓/j live preview • enter apply • esc back • e customize • ctrl+c close");
  assert.equal(result.includes("\u001b"), false);
  assert.equal(result.includes("\u0007"), false);
});

test("formatInteractionHints supports a sanitized custom separator", () => {
  assert.equal(
    formatInteractionHints(
      keybindings,
      [
        { keys: ["x"], label: "first" },
        { keys: ["y"], label: "second" },
      ],
      { separator: "\u0007·" },
    ),
    "x first · y second",
  );
});

test("formatInteractionHints omits empty key and label groups", () => {
  assert.equal(
    formatInteractionHints(keybindings, [
      { bindings: ["tui.select.pageUp"], label: "page" },
      { keys: ["\u0007"], label: "unsafe" },
      { keys: ["x"], label: "\u0007" },
    ]),
    "",
  );
});
