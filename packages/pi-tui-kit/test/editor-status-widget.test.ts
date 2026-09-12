import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { EditorStatusWidget } from "../src/editor-status-widget.js";

test("frames extension-owned body rows with the standard muted editor divider", () => {
  const roles: string[] = [];
  const widths: number[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as Pick<Theme, "fg">;
  const widget = new EditorStatusWidget({
    theme,
    renderBody(width) {
      widths.push(width);
      return ["Todo · 1/2 complete", "▶ Implement the shared primitive"];
    },
  });

  assert.deepEqual(widget.render(24).map(stripVTControlCharacters), [
    "─".repeat(24),
    "Todo · 1/2 complete",
    "▶ Implement the shared p",
  ]);
  assert.deepEqual(widths, [24]);
  assert.deepEqual(roles, ["borderMuted"]);
});

test("normalizes hostile widths and bounds every terminal-formatted body row", () => {
  const seenWidths: number[] = [];
  const theme = { fg: (_role: string, text: string) => text } as Pick<Theme, "fg">;
  const widget = new EditorStatusWidget({
    theme,
    renderBody(width) {
      seenWidths.push(width);
      return ["界界界", "\u001b[31mcolored content\u001b[0m"];
    },
  });

  for (const width of [Number.NaN, -1, 0, 5.9]) {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const lines = widget.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 5) {
      assert.deepEqual(lines.map(stripVTControlCharacters), ["─".repeat(5), "界界", "color"]);
    }
  }
  assert.deepEqual(seenWidths, [0, 0, 0, 5]);
});

test("renders fresh theme and body output after invalidation without owning consumer state", () => {
  let color = 31;
  let value = "first";
  const theme = {
    fg: (_role: string, text: string) => `\u001b[${color}m${text}\u001b[0m`,
  } as Pick<Theme, "fg">;
  const widget = new EditorStatusWidget({ theme, renderBody: () => [value] });

  assert.equal(widget.render(20)[0]?.includes("\u001b[31m"), true);
  assert.equal(widget.render(20)[1], "first");

  color = 32;
  value = "second";
  widget.invalidate();
  assert.equal(widget.render(20)[0]?.includes("\u001b[32m"), true);
  assert.equal(widget.render(20)[1], "second");
});
