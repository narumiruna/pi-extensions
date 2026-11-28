import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type RunDocumentReviewOptions, runDocumentReview } from "../src/document-review.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

function tuiContext(tui: ReturnType<typeof createTuiHarness>) {
  return createMockContext({ mode: "tui", hasUI: true, custom: tui.custom }).ctx;
}

const formats: Pick<RunDocumentReviewOptions, "content" | "format">[] = [
  { content: "plain\ttext", format: { kind: "text" } },
  { content: "const answer: number = 42;", format: { kind: "code", filePath: "answer.ts" } },
  { content: "@@ -1 +1 @@\n-old\n+new", format: { kind: "diff", filePath: "answer.ts" } },
  { content: "# Heading\n\n**body**", format: { kind: "markdown" } },
];

test("runDocumentReview renders every document format at exact widths and cancels", async () => {
  for (const entry of formats) {
    const tui = createTuiHarness({ width: 40 });
    const running = runDocumentReview(tuiContext(tui), {
      title: "Review document",
      ...entry,
      enableSearch: true,
    });
    await tui.waitForOpen();
    for (const width of [1, 2, 8, 40, 80]) {
      assert.ok(
        tui.render(width).every((line) => visibleWidth(line) <= width),
        `${entry.format?.kind} at ${width}`,
      );
    }
    tui.press("tui.select.cancel");
    assert.deepEqual(await running, { kind: "cancelled", reason: "back" });
  }
});

test("runDocumentReview uses custom keybindings, search, mouse scrolling, and optional confirmation", async () => {
  const bindings: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.confirm": "l",
    "tui.select.cancel": "q",
    "tui.altScreen.searchNext": "n",
    "tui.altScreen.searchPrevious": "p",
    "tui.altScreen.searchClose": "x",
  };
  const tui = createTuiHarness({
    rows: 12,
    keybindings: {
      matches: (data, binding) => data === bindings[binding],
      getKeys: (binding) => (bindings[binding] ? [bindings[binding] as KeyId] : []),
    },
  });
  const running = runDocumentReview(tuiContext(tui), {
    title: "Review",
    content: Array.from({ length: 30 }, (_, index) => `row ${index + 1}`).join("\n"),
    format: { kind: "text" },
    viewportSize: "adaptive",
    enableSearch: true,
    confirmation: { label: "Apply" },
  });
  await tui.waitForOpen();
  const frame = tui.render();
  const documentRow = frame.findIndex((line) => stripVTControlCharacters(line).includes("row 1"));
  assert.ok(documentRow >= 0);
  tui.mouse({ type: "wheel", x: 1, y: documentRow, wheelDelta: 1 });
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /row 2/u);

  tui.send(" ");
  tui.type("row 20");
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /1\/1/u);
  tui.send("x");
  tui.send("l");
  assert.deepEqual(await running, { kind: "confirmed" });
});

test("runDocumentReview preserves Close and classifies disposal or owner abort as stale", async () => {
  const closeTui = createTuiHarness();
  const closing = runDocumentReview(tuiContext(closeTui), { title: "Review", content: "body" });
  await closeTui.waitForOpen();
  closeTui.press("ctrl+c");
  assert.deepEqual(await closing, { kind: "cancelled", reason: "close" });

  const disposedTui = createTuiHarness();
  const disposed = runDocumentReview(tuiContext(disposedTui), { title: "Review", content: "body" });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });

  const abortTui = createTuiHarness();
  const controller = new AbortController();
  const aborted = runDocumentReview(tuiContext(abortTui), {
    title: "Review",
    content: "body",
    signal: controller.signal,
  });
  await abortTui.waitForOpen();
  controller.abort();
  assert.deepEqual(await aborted, { kind: "stale" });
});

test("runDocumentReview adapts paginated review and confirmation to RPC", async () => {
  const content = Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n");
  const rpc = createRpcHarness([
    { kind: "select", response: "Next" },
    { kind: "select", response: "Apply" },
  ]);
  const ctx = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select }).ctx;
  const result = await runDocumentReview(ctx, {
    title: "Review",
    content,
    presentation: "floating",
    viewportSize: 4,
    confirmation: { label: "Apply" },
    enableSearch: true,
  });
  assert.deepEqual(result, { kind: "confirmed" });
  assert.equal(rpc.dialogs.length, 2);
  assert.match(rpc.dialogs[0]?.title ?? "", /row 1[\s\S]*Page 1\/3/u);
  assert.match(rpc.dialogs[1]?.title ?? "", /row 5[\s\S]*Page 2\/3/u);
  rpc.assertConsumed();
});

test("runDocumentReview returns typed RPC cancellation, unsupported, validation, and stale results", async () => {
  const rpc = createRpcHarness([{ kind: "select", response: undefined }]);
  const rpcCtx = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select }).ctx;
  assert.deepEqual(await runDocumentReview(rpcCtx, { title: "Review", content: "body", hint: "close" }), {
    kind: "cancelled",
    reason: "close",
  });

  const unexpectedCtx = createMockContext({ mode: "rpc", hasUI: true, select: async () => "not offered" }).ctx;
  const unexpected = await runDocumentReview(unexpectedCtx, { title: "Review", content: "body" });
  assert.equal(unexpected.kind, "error");
  assert.match(unexpected.kind === "error" ? String(unexpected.error) : "", /option that was not offered/u);

  const printCtx = createMockContext({ mode: "print", hasUI: false }).ctx;
  assert.deepEqual(await runDocumentReview(printCtx, { title: "Review", content: "body" }), {
    kind: "unsupported",
    mode: "print",
  });
  for (const invalidOptions of [
    { title: "\u0001", content: "body" },
    { title: "Review", content: "body", confirmation: { label: "\u0001" } },
  ]) {
    const invalid = await runDocumentReview(printCtx, invalidOptions);
    assert.equal(invalid.kind, "error");
  }

  let current = true;
  const staleRpc = createRpcHarness([{ kind: "select", response: "Back" }]);
  const staleCtx = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (...args: unknown[]) => {
      const result = await (staleRpc.ui.select as (...values: unknown[]) => Promise<string | undefined>)(...args);
      current = false;
      return result;
    },
  }).ctx;
  assert.deepEqual(await runDocumentReview(staleCtx, { title: "Review", content: "body", isCurrent: () => current }), {
    kind: "stale",
  });
});

test("runDocumentReview prepares enabled Mermaid documents before opening safely", async () => {
  const tui = createTuiHarness();
  const running = runDocumentReview(tuiContext(tui), {
    title: "Diagram",
    content: "```mermaid\nflowchart LR\n A --> B\n```",
    format: { kind: "markdown", renderMermaid: true },
  });
  await tui.waitForOpen();
  const rendered = stripVTControlCharacters(tui.render(80).join("\n"));
  assert.match(rendered, /[┌╭].*[┐╮]|flowchart LR/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "cancelled", reason: "back" });
});
