import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { defineMenu, runMenu } from "../src/index.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

function context(tui: ReturnType<typeof createTuiHarness>) {
  return {
    mode: "tui" as const,
    hasUI: true,
    ui: { custom: tui.custom, notify() {} },
  } as unknown as ExtensionCommandContext;
}

test("searchable choice filters safe metadata and confirms the raw stable id", async () => {
  let selected: string | undefined;
  const menu = defineMenu<undefined, "choice", "select">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Resume",
        enableSearch: true,
        items: [
          { id: "raw-one", label: "Duplicate", description: "Older", searchText: "alpha" },
          {
            id: "raw-two",
            label: "Duplicate",
            description: "Newer",
            searchText: "beta\u001b[31m needle",
          },
        ],
        action: "select",
        initialItemId: "raw-one",
      }),
    },
    actions: {
      select: async ({ itemId }) => {
        selected = itemId;
        return { kind: "close" };
      },
    },
  });
  const tui = createTuiHarness({ width: 32, rows: 16 });
  const running = runMenu(context(tui), menu, { getState: () => undefined });
  await tui.waitForOpen();
  tui.setFocused(true);
  assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
  tui.type("needle");
  const filtered = tui.render();
  assert.match(filtered.join("\n"), /→ Duplicate/u);
  assert.equal(filtered.join("\n").includes("\u001b[31m"), false);
  assert.ok(filtered.every((line) => visibleWidth(line) <= 32));
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
  assert.equal(selected, "raw-two");
});

test("searchable choice retains query and stable selection after rejection", async () => {
  let attempts = 0;
  const menu = defineMenu<undefined, "choice", "select">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Records",
        enableSearch: true,
        items: [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
        action: "select",
      }),
    },
    actions: {
      select: async () => {
        attempts += 1;
        return attempts === 1 ? { kind: "rejected" } : { kind: "close" };
      },
    },
  });
  const tui = createTuiHarness();
  const running = runMenu(context(tui), menu, { getState: () => undefined });
  await tui.waitForOpen();
  tui.type("second");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const retry = tui.render().join("\n");
  assert.match(retry, /→ Second/u);
  assert.doesNotMatch(retry, /First/u);
  tui.send("\u007f");
  tui.type("d");
  const editedRetry = tui.render().join("\n");
  assert.match(editedRetry, /→ Second/u);
  assert.doesNotMatch(editedRetry, /First/u);
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
  assert.equal(attempts, 2);
});

test("searchable choice distinguishes owner abort and external disposal", async () => {
  const menu = defineMenu<undefined, "choice", "select">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Records",
        enableSearch: true,
        items: [{ id: "first", label: "First" }],
        action: "select",
      }),
    },
    actions: { select: async () => ({ kind: "close" }) },
  });

  const owner = new AbortController();
  const abortedTui = createTuiHarness();
  const aborted = runMenu(context(abortedTui), menu, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await abortedTui.waitForOpen();
  owner.abort();
  assert.deepEqual(await aborted, { kind: "stale" });
  assert.equal(abortedTui.isOpen, false);

  const disposedTui = createTuiHarness();
  const disposed = runMenu(context(disposedTui), menu, { getState: () => undefined });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "closed", reason: "close" });
});

test("RPC searchable choice remains one deterministic unfiltered selector", async () => {
  let selected: string | undefined;
  const menu = defineMenu<undefined, "choice", "select">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Records",
        enableSearch: true,
        items: [
          { id: "first", label: "Same", searchText: "private first" },
          { id: "second", label: "Same", searchText: "private second" },
        ],
        action: "select",
      }),
    },
    actions: {
      select: async ({ itemId }) => {
        selected = itemId;
        return { kind: "close" };
      },
    },
  });
  const rpc = createRpcHarness([{ kind: "select", options: ["Same", "Same [2]", "Back"], response: "Same [2]" }]);
  const ctx = {
    mode: "rpc" as const,
    hasUI: true,
    ui: rpc.ui,
  } as unknown as ExtensionCommandContext;
  assert.deepEqual(await runMenu(ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(selected, "second");
  rpc.assertConsumed();
});

test("searchable choice exposes no-match recovery, disabled explanation, and exact exits", async () => {
  const menu = defineMenu<undefined, "choice", "select">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Records",
        enableSearch: true,
        items: [
          {
            id: "disabled",
            label: "Unavailable",
            disabled: true,
            disabledReason: "Policy blocked",
          },
        ],
        action: "select",
        hint: "back",
      }),
    },
    actions: { select: async () => assert.fail("disabled choice must stay inert") },
  });
  const tui = createTuiHarness({ width: 32, rows: 12 });
  const running = runMenu(context(tui), menu, { getState: () => undefined });
  await tui.waitForOpen();
  tui.type("missing");
  assert.match(tui.render().join("\n"), /No matching choices/u);
  for (let index = 0; index < 7; index += 1) tui.send("\u007f");
  assert.match(tui.render().join("\n"), /Policy\s+blocked/u);
  tui.press("tui.select.confirm");
  assert.equal(tui.isOpen, true);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});
