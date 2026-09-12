import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

const loader = vi.hoisted(() => ({ calls: 0 }));

vi.mock("grok-mermaid", () => {
  loader.calls += 1;
  return {
    render: () => ({
      width: 3,
      plain: ["ART"],
      styled: [[{ cls: "text" as const, text: "ART" }]],
      warnings: [],
    }),
  };
});

test("a top-level Mermaid fence after normalized line endings loads and renders", async () => {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const menu = defineMenu<undefined, "review", "unused">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Normalized Mermaid",
        content: "Introduction\r```mermaid\rflowchart LR\r A --> B\r```",
        format: { kind: "markdown" },
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });

  const running = runMenu(context.ctx, menu, { getState: () => undefined });
  await tui.waitForOpen();
  const rendered = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(rendered, /ART/u);
  assert.doesNotMatch(rendered, /flowchart LR/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
  assert.equal(loader.calls, 1);
});
