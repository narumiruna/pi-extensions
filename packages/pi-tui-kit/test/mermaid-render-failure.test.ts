import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

const mermaid = vi.hoisted(() => ({ renderCalls: 0 }));

vi.mock("grok-mermaid", () => ({
  render: () => {
    mermaid.renderCalls += 1;
    throw new Error("simulated Mermaid render failure");
  },
}));

test("a Mermaid render failure preserves the fenced source", async () => {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const menu = defineMenu<undefined, "review", "unused">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Mermaid fallback",
        content: "```mermaid\nflowchart LR\n A --> B\n```",
        format: { kind: "markdown" },
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });

  const running = runMenu(context.ctx, menu, { getState: () => undefined });
  await tui.waitForOpen();
  const rendered = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(rendered, /```mermaid/u);
  assert.match(rendered, /flowchart LR/u);
  assert.equal(mermaid.renderCalls, 1);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});
