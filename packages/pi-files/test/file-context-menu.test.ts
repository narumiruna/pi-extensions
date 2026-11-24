import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type FileContextMenuOptions,
  type FileContextMenuQuote,
  showFileContextMenu,
} from "../src/file-context-menu.js";

function quote(id: string, overrides: Partial<FileContextMenuQuote> = {}): FileContextMenuQuote {
  return {
    id,
    path: "src/example.ts",
    startLine: 1,
    endLine: 1,
    text: "const example = true;",
    ...overrides,
  };
}

function fixture(width: number, rows: number, options: Pick<FileContextMenuOptions, "getState" | "removeQuote">) {
  const tui = createTuiHarness({ width, rows });
  const base = createMockContext({ mode: "tui", custom: tui.custom });
  const controller = new AbortController();
  const running = showFileContextMenu(base.ctx, {
    ...options,
    isCurrent: () => !controller.signal.aborted,
    signal: controller.signal,
  });
  const close = async () => {
    controller.abort();
    tui.dispose();
    await running;
  };
  return { tui, running, close, notifications: base.notifications };
}

test("reviews exact snippets before repeatedly removing them by stable ID", async () => {
  let quotes = [
    quote("quote-1", { text: "first snapshot\n  with  details" }),
    quote("quote-2", { text: "second snapshot\nwith details" }),
  ];
  const removedIds: string[] = [];
  const { tui, running, close, notifications } = fixture(40, 12, {
    getState: () => ({ quotes }),
    removeQuote: (id) => {
      const selected = quotes.find((item) => item.id === id);
      if (!selected) return { kind: "missing" };
      removedIds.push(id);
      quotes = quotes.filter((item) => item.id !== id);
      return { kind: "removed", quote: selected, remaining: quotes.length };
    },
  });
  try {
    await tui.waitForOpen();
    const firstChoice = tui.render().join("\n");
    assert.match(firstChoice, /src\/example\.ts/u);
    assert.match(firstChoice, /Lines 1-1/u);
    assert.equal(removedIds.length, 0);

    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const firstReview = tui.render().join("\n");
    assert.match(firstReview, /Review context snippet/u);
    assert.match(firstReview, /first snapshot/u);
    tui.press("tui.select.down");
    const scrolledReview = tui.render().join("\n");
    assert.match(scrolledReview, / {2}with {2}details/u);
    assert.match(scrolledReview, /Remove from next\s+prompt/u);
    assert.equal(removedIds.length, 0);

    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Selected context/u);
    assert.equal(removedIds.length, 0);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /second snapshot/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Review context snippet/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.deepEqual(removedIds, ["quote-1", "quote-2"]);
    assert.match(tui.render().join("\n"), /No context selected for the next prompt/u);
    assert.equal(notifications.filter(({ message }) => /Removed from next prompt context/u.test(message)).length, 2);
    tui.press("ctrl+c");
    await running;
  } finally {
    await close();
  }
});

test("sanitizes untrusted snapshot text and keeps cancellation side-effect free", async () => {
  const unsafe = quote("quote-unsafe", {
    path: "src/unsafe\u001b[31m.ts",
    text: "first\u0000 line\nsecond",
  });
  let removeCalls = 0;
  const { tui, running, close } = fixture(32, 12, {
    getState: () => ({ quotes: [unsafe] }),
    removeQuote: () => {
      removeCalls += 1;
      return { kind: "missing" };
    },
  });
  try {
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const frame = tui.render();
    assert.ok(frame.every((line) => visibleWidth(line) <= 32));
    assert.ok(frame.every((line) => !line.includes("\u001b[31m") && !line.includes("\u0000")));
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.equal(removeCalls, 0);
    tui.press("ctrl+c");
    await running;
  } finally {
    await close();
  }
});

test("does not remove a replacement snapshot if the reviewed snapshot was consumed", async () => {
  let quotes = [quote("first")];
  const removedIds: string[] = [];
  const { tui, close, notifications } = fixture(80, 24, {
    getState: () => ({ quotes }),
    removeQuote: (id) => {
      removedIds.push(id);
      quotes = [quote("replacement")];
      return { kind: "missing" };
    },
  });
  try {
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Remove from next prompt/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.deepEqual(removedIds, ["first"]);
    assert.match(notifications.at(-1)?.message ?? "", /no longer selected/u);
    assert.match(tui.render().join("\n"), /no longer selected/u);
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Selected context/u);
  } finally {
    await close();
  }
});
