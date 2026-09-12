import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

const loader = vi.hoisted(() => ({ calls: 0 }));

vi.mock("grok-mermaid", () => {
  loader.calls += 1;
  return { render: () => null };
});

test("only top-level enabled Mermaid fences load the renderer", async () => {
  for (const screen of [
    {
      kind: "review" as const,
      title: "Ordinary Markdown",
      content: "# Formula\n\n$x^2$",
      format: { kind: "markdown" as const },
    },
    {
      kind: "review" as const,
      title: "Disabled Mermaid",
      content: "```mermaid\nflowchart LR\n A --> B\n```",
      format: { kind: "markdown" as const, renderMermaid: false },
    },
    {
      kind: "review" as const,
      title: "Nested literal fence",
      content: "````markdown\n```mermaid\nflowchart LR\n A --> B\n```\n````",
      format: { kind: "markdown" as const },
    },
    {
      kind: "review" as const,
      title: "Tab-indented code",
      content: "\t```mermaid\n\tflowchart LR\n\t A --> B\n\t```",
      format: { kind: "markdown" as const },
    },
  ]) {
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const menu = defineMenu<undefined, "review", "unused">({
      start: "review",
      screens: { review: () => screen },
      actions: { unused: async () => ({ kind: "close" }) },
    });
    const running = runMenu(context.ctx, menu, { getState: () => undefined });
    await tui.waitForOpen();
    tui.render();
    tui.press("tui.select.cancel");
    assert.deepEqual(await running, { kind: "closed", reason: "back" });
  }
  assert.equal(loader.calls, 0);
});
