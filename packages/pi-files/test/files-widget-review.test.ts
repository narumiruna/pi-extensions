import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HorizontalRule } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createFileQuoteSnapshot, type FileQuote } from "../src/file-context.js";
import { publishFilesWidget } from "../src/files-widget.js";
import type { ScopeView } from "../src/scope/menu.js";
import { createPendingWidget, widgetClick } from "./widget-support.js";

const active: ScopeView = {
  state: "active",
  cwd: "/workspace",
  targets: [{ path: "/workspace/a.ts", canonical: "/workspace/a.ts" }],
};
const blocked: ScopeView = { ...active, state: "blocked", error: "Selected file unavailable" };
const quote = createFileQuoteSnapshot("example.txt", 1, 1, "example");
const activeRows = ["Editing limited to 1 file · /files off", '"/workspace/a.ts"'];
const blockedRows = ["Edit Scope unavailable · edits blocked · /files off", '"/workspace/a.ts"'];
const quoteRows = [
  "Next prompt context · 1 snippet · ~2 tokens · /file-context to review",
  "1. example.txt · lines 1-1 · ~2 tokens",
];
const divider = (width: number, collapsed = false) =>
  new HorizontalRule({
    label: `${collapsed ? "▸" : "▾"} Files`,
    labelAlignment: "left",
  }).render(width)[0];

const cases: Array<{ name: string; scope?: ScopeView; quotes: readonly FileQuote[]; body: string[] }> = [
  { name: "active scope", scope: active, quotes: [], body: activeRows },
  { name: "blocked scope", scope: blocked, quotes: [], body: blockedRows },
  { name: "quotes", quotes: [quote], body: quoteRows },
  { name: "active scope and quotes", scope: active, quotes: [quote], body: [...activeRows, ...quoteRows] },
  { name: "blocked scope and quotes", scope: blocked, quotes: [quote], body: [...blockedRows, ...quoteRows] },
  { name: "empty", quotes: [], body: [] },
  { name: "inactive scope", scope: { ...active, state: "inactive" }, quotes: [], body: [] },
];

test.each(cases)("keeps one Files title and all restriction/context rows for $name", ({ scope, quotes, body }) => {
  for (const mode of ["tui", "rpc"] as const) {
    const context = createMockContext({ mode, theme: { fg: (_role: string, text: string) => text } });
    context.widgets.set("other", ["keep"]);
    const before = structuredClone({ scope, quotes });
    const state = { collapsed: false };
    publishFilesWidget(context.ctx, quotes, scope, state);
    const value = context.widgets.get("files");
    if (!body.length) {
      assert.equal(value, undefined);
    } else if (mode === "rpc") {
      assert.deepEqual(value, body, "RPC retains unframed restriction and context rows");
    } else {
      const roles: string[] = [];
      const component = createPendingWidget(value, {
        fg(role, text) {
          roles.push(role);
          return text;
        },
      });
      const expanded = [divider(160), ...body];
      assert.deepEqual(component.render(160), expanded, "only the divider contains the widget title");
      assert.ok(roles.includes("borderMuted"));
      assert.equal(roles.includes("error"), scope?.state === "blocked");
      for (const width of [0, 1, 2, 12, 40, 160]) {
        const lines = component.render(width);
        assert.equal(lines[0], divider(width));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width === 0) assert.deepEqual(lines, ["", ...body.map(() => "")]);
      }
      component.invalidate();
      assert.deepEqual(component.render(160), expanded);
      assert.deepEqual(widgetClick(component, 159, body.length, expanded.length, 160), {
        handled: true,
        render: true,
      });
      assert.deepEqual(component.render(160), [divider(160, true)]);
      assert.deepEqual(widgetClick(component, 0, 0, 1, 160), { handled: true, render: true });
      assert.deepEqual(component.render(160), expanded);
      component.dispose?.();
      assert.equal(widgetClick(component, 0, 0, expanded.length, 160), undefined);
      assert.equal(state.collapsed, false);
    }
    assert.deepEqual({ scope, quotes }, before);
    assert.deepEqual(context.widgets.get("other"), ["keep"]);
  }
});
