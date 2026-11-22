import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { getDraftChanges, renderDraftChanges } from "../src/plan-pane-diff.js";

test("draft patches retain unified hunk markers, blank lines and missing final newlines", () => {
  const context = Array.from({ length: 12 }, (_, index) => `keep ${index}\n`).join("");
  const rows = getDraftChanges(`head\n-removed\n${context}tail`, `head\n${context}\n+added\ntail\n`);
  assert.ok(rows);
  assert.equal(rows.filter((row) => row.startsWith("@@ ")).length, 2);
  assert.ok(rows.includes("--removed"));
  assert.ok(rows.includes("++added"));
  assert.ok(rows.includes("+"));
  assert.ok(rows.includes("\\ No newline at end of file"));
  assert.equal(getDraftChanges("same\n", "same\n"), undefined);
});

test.each([
  ["keep\n", "keep\nnew\n", "+new"],
  ["keep\nold\n", "keep\n", "-old"],
])("patch from %j to %j shows %s without opposite markers", (oldText, newText, change) => {
  assert.deepEqual(
    getDraftChanges(oldText, newText)?.filter((row) => /^[+-]/u.test(row)),
    [change],
  );
});

test("diff rows preserve display whitespace and stay within the cell budget before theming", () => {
  const roles: string[] = [];
  const theme: Pick<Theme, "fg"> = {
    fg: (role, text) => {
      roles.push(role);
      return text;
    },
  };
  const rows = ["@@ -1 +1 @@", "-   old  ", "+\t新🙂  ", " context"];
  assert.deepEqual(renderDraftChanges(rows, 0, theme), []);
  assert.deepEqual(renderDraftChanges(rows, 40, theme), ["@@ -1 +1 @@", "-   old  ", "+   新🙂  ", " context"]);
  assert.deepEqual(roles, ["toolDiffContext", "toolDiffRemoved", "toolDiffAdded", "toolDiffContext"]);
  for (const width of [1, 2, 3, 5]) {
    const wrapped = renderDraftChanges(rows, width, theme);
    assert.ok(wrapped.every((row) => visibleWidth(row) <= width));
    assert.ok(wrapped.some((row) => row.startsWith("+")));
    assert.ok(wrapped.some((row) => row.startsWith("-")));
  }
});
