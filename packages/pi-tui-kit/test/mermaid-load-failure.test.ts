import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

vi.mock("grok-mermaid", () => {
  throw new Error("simulated Mermaid module load failure");
});

test("a Mermaid module load failure degrades to sanitized fenced source", async () => {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const menu = defineMenu<undefined, "review", "unused">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Mermaid fallback",
        content: "```mermaid\nflowchart LR\n A[unsafe\u001b]8;;https://unsafe.example\u0007text] --> B\n```",
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
  assert.match(rendered, /unsafetext/u);
  assert.doesNotMatch(rendered, /https:\/\/unsafe\.example/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});
