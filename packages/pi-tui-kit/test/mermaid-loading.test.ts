import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { defineMenu, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

const loader = vi.hoisted(() => {
  let reportStarted!: () => void;
  let release!: () => void;
  return {
    calls: 0,
    started: new Promise<void>((resolve) => {
      reportStarted = resolve;
    }),
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
    reportStarted: () => reportStarted(),
    release: () => release(),
  };
});

vi.mock("grok-mermaid", async () => {
  loader.calls += 1;
  loader.reportStarted();
  await loader.gate;
  return { render: () => null };
});

const menu = defineMenu<undefined, "review", "unused">({
  start: "review",
  screens: {
    review: () => ({
      kind: "review",
      title: "Mermaid loading",
      content: "```mermaid\nflowchart LR\n A --> B\n```",
      format: { kind: "markdown" },
    }),
  },
  actions: { unused: async () => ({ kind: "close" }) },
});

test("concurrent Mermaid preparation loads once and revalidates stale owners", async () => {
  const staleOwner = new AbortController();
  let staleCustomCalls = 0;
  const staleContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async () => {
      staleCustomCalls += 1;
      throw new Error("A stale Mermaid screen must not open");
    },
  });
  const activeTui = createTuiHarness({ width: 80, rows: 24 });
  const activeContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: activeTui.custom,
  });

  const staleRun = runMenu(staleContext.ctx, menu, {
    getState: () => undefined,
    signal: staleOwner.signal,
  });
  const activeRun = runMenu(activeContext.ctx, menu, { getState: () => undefined });
  await loader.started;
  staleOwner.abort(new DOMException("Session replaced", "AbortError"));
  loader.release();

  assert.deepEqual(await staleRun, { kind: "stale" });
  assert.equal(staleCustomCalls, 0);
  await activeTui.waitForOpen();
  assert.match(stripVTControlCharacters(activeTui.render().join("\n")), /flowchart LR/u);
  activeTui.press("tui.select.cancel");
  assert.deepEqual(await activeRun, { kind: "closed", reason: "back" });
  assert.equal(loader.calls, 1);
});
