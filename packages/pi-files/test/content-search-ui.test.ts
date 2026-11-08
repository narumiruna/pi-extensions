import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { FileQuoteExplorer } from "../src/file-context-explorer.js";

const CTRL_F = "\u0006";
const ALT_C = "\u001bc";
const ALT_F = "\u001bf";
const ESCAPE = "\u001b";

function createHarness(
  loadFile: (path: string, signal?: AbortSignal) => Promise<{ path: string; lines: string[] }> = async (path) => ({
    path,
    lines: [],
  }),
  onAddAndContinue?: (quote: unknown) => void,
) {
  const foreground: Array<{ color: string; text: string }> = [];
  const backgrounds: Array<{ color: string; text: string }> = [];
  let result: unknown = "pending";
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 18 }, requestRender() {} } as never,
    theme: {
      fg(color: string, text: string) {
        foreground.push({ color, text });
        return text;
      },
      bg(color: string, text: string) {
        backgrounds.push({ color, text });
        return text;
      },
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (
          (data === "up" && key === "tui.select.up") ||
          (data === "down" && key === "tui.select.down") ||
          (data === "enter" && key === "tui.select.confirm") ||
          (data === "tab" && key === "tui.input.tab")
        );
      },
    } as never,
    files: ["a.txt", "b.txt"],
    loadFile,
    onAddAndContinue,
    done: (value) => {
      result = value;
    },
  });
  return { explorer, foreground, backgrounds, getResult: () => result };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("content result cards highlight literal matches and open preview at the selected match", async () => {
  const loads: string[] = [];
  const { explorer, foreground, backgrounds } = createHarness(async (path) => {
    loads.push(path);
    return path === "a.txt" ? { path, lines: ["Hi narumi, this is your book."] } : { path, lines: ["This is a tree."] };
  });
  explorer.focused = true;
  assert.ok(explorer.render(100).some((line) => line.includes("Ctrl+F contents")));
  explorer.handleInput(CTRL_F);
  explorer.handleInput("this is");
  await flushAsyncWork();

  const resultRows = explorer.render(48);
  assert.ok(resultRows.some((line) => line.includes("Content Search")));
  assert.ok(resultRows.some((line) => line.includes("Case: off") && line.includes("Fuzzy: off")));
  assert.ok(resultRows.some((line) => line.includes("a.txt") && line.includes("L1")));
  assert.ok(resultRows.some((line) => line.includes("b.txt") && line.includes("L1")));
  assert.ok(foreground.some(({ color, text }) => color === "warning" && text === "this is"));
  assert.ok(foreground.some(({ color, text }) => color === "warning" && text === "This is"));
  assert.ok(backgrounds.some(({ color }) => color === "selectedBg"));
  assert.ok(resultRows.every((line) => visibleWidth(line) <= 48));

  explorer.handleInput("down");
  explorer.handleInput("enter");
  await flushAsyncWork();
  const previewRows = explorer.render(48);
  assert.ok(previewRows.some((line) => line.includes("b.txt")));
  assert.ok(previewRows.some((line) => line.includes("> 1") && line.includes("This is a tree.")));

  explorer.handleInput(ESCAPE);
  const restoredRows = explorer.render(48);
  assert.ok(restoredRows.some((line) => line.includes("Content Search")));
  assert.ok(restoredRows.some((line) => line.includes("this is")));
  explorer.handleInput("enter");
  await flushAsyncWork();
  assert.deepEqual(loads.slice(-2), ["b.txt", "b.txt"]);
});

test("add and continue returns to the originating content results with search state intact", async () => {
  const continued: unknown[] = [];
  const { explorer, getResult } = createHarness(
    async (path) => ({ path, lines: [path === "a.txt" ? "before needle after" : "no match"] }),
    (quote) => continued.push(quote),
  );
  explorer.handleInput(CTRL_F);
  explorer.handleInput("needle");
  await flushAsyncWork();
  explorer.handleInput("enter");
  await flushAsyncWork();
  explorer.handleInput("a");

  assert.deepEqual(continued, [
    {
      path: "a.txt",
      startLine: 1,
      endLine: 1,
      text: "before needle after",
    },
  ]);
  assert.equal(getResult(), "pending");
  const restored = explorer.render(48).join("\n");
  assert.match(restored, /Content Search/u);
  assert.match(restored, /needle/u);
  assert.match(restored, /a\.txt/u);
});

test("content result cards keep a distant match visible within narrow context", async () => {
  const { explorer } = createHarness(async (path) => ({
    path,
    lines: [path === "a.txt" ? `${"x".repeat(80)}needle tail` : "no match"],
  }));
  explorer.handleInput(CTRL_F);
  explorer.handleInput("needle");
  await flushAsyncWork();

  const rows = explorer.render(32);
  assert.ok(rows.some((line) => line.includes("needle tail")));
  assert.ok(rows.every((line) => visibleWidth(line) <= 32));
});

test("content search forwards focus for IME and sanitizes matched terminal controls", async () => {
  const { explorer } = createHarness(async (path) => ({
    path,
    lines: [path === "a.txt" ? "before \u001b[31mthis is after" : "no match"],
  }));
  explorer.focused = true;
  explorer.handleInput(CTRL_F);
  assert.ok(explorer.render(48).some((line) => line.includes(CURSOR_MARKER)));
  explorer.handleInput("this is");
  await flushAsyncWork();

  const rows = explorer.render(48);
  assert.ok(rows.every((line) => !line.includes("\u001b[31m")));
  assert.ok(rows.some((line) => line.includes("\\x1b[31mthis is")));
});

test("content search toggles case sensitivity and fuzzy matching with visible state", async () => {
  const load = async (path: string) =>
    path === "a.txt" ? { path, lines: ["Hi narumi, this is your book."] } : { path, lines: ["This is a tree."] };
  const caseHarness = createHarness(load);
  caseHarness.explorer.handleInput(CTRL_F);
  caseHarness.explorer.handleInput("this is");
  caseHarness.explorer.handleInput(ALT_C);
  await flushAsyncWork();
  let rows = caseHarness.explorer.render(60);
  assert.ok(rows.some((line) => line.includes("Case: on")));
  assert.ok(rows.some((line) => line.includes("a.txt")));
  assert.ok(rows.every((line) => !line.includes("b.txt")));

  const fuzzyHarness = createHarness(load);
  fuzzyHarness.explorer.handleInput(CTRL_F);
  fuzzyHarness.explorer.handleInput("thisis");
  await flushAsyncWork();
  rows = fuzzyHarness.explorer.render(60);
  assert.ok(rows.some((line) => line.includes('No matches for "thisis"')));
  fuzzyHarness.explorer.handleInput(ALT_F);
  await flushAsyncWork();
  rows = fuzzyHarness.explorer.render(60);
  assert.ok(rows.some((line) => line.includes("Fuzzy: on")));
  assert.ok(rows.some((line) => line.includes("a.txt")));
  assert.ok(rows.some((line) => line.includes("b.txt")));
});

test("content results keep file-open failures actionable", async () => {
  let calls = 0;
  const { explorer } = createHarness(async (path) => {
    calls += 1;
    if (calls > 2) throw new Error("cannot open selected file");
    return { path, lines: ["needle"] };
  });
  explorer.handleInput(CTRL_F);
  explorer.handleInput("needle");
  await flushAsyncWork();
  explorer.handleInput("enter");
  await flushAsyncWork();
  assert.ok(explorer.render(60).some((line) => line.includes("cannot open selected file")));
  explorer.handleInput("x");
  await flushAsyncWork();
  assert.ok(explorer.render(60).every((line) => !line.includes("cannot open selected file")));
});

test("content results preserve whole-file references and cancel without a selection", async () => {
  const referenceHarness = createHarness(async (path) => ({ path, lines: ["needle"] }));
  referenceHarness.explorer.handleInput(CTRL_F);
  referenceHarness.explorer.handleInput("needle");
  await flushAsyncWork();
  referenceHarness.explorer.handleInput("tab");
  assert.deepEqual(referenceHarness.getResult(), { kind: "reference", path: "a.txt" });

  const cancelHarness = createHarness();
  cancelHarness.explorer.handleInput(CTRL_F);
  cancelHarness.explorer.handleInput(ESCAPE);
  assert.equal(cancelHarness.getResult(), undefined);
});

test("content search cancellation and disposal reject stale async results", async () => {
  let resolveSearch: ((file: { path: string; lines: string[] }) => void) | undefined;
  let searchSignal: AbortSignal | undefined;
  const pendingSearch = new Promise<{ path: string; lines: string[] }>((resolve) => {
    resolveSearch = resolve;
  });
  const disposedHarness = createHarness(async (path, signal) => {
    searchSignal = signal;
    if (path === "a.txt") return pendingSearch;
    return { path, lines: [] };
  });
  disposedHarness.explorer.handleInput(CTRL_F);
  disposedHarness.explorer.handleInput("needle");
  await Promise.resolve();
  disposedHarness.explorer.dispose();
  assert.equal(searchSignal?.aborted, true);
  resolveSearch?.({ path: "a.txt", lines: ["needle"] });
  await flushAsyncWork();
  assert.ok(disposedHarness.explorer.render(60).every((line) => !line.includes("a.txt · L1")));

  let resolveOpen: ((file: { path: string; lines: string[] }) => void) | undefined;
  let openSignal: AbortSignal | undefined;
  let calls = 0;
  const staleOpenHarness = createHarness(async (path, signal) => {
    calls += 1;
    if (calls === 3) {
      openSignal = signal;
      return new Promise((resolve) => {
        resolveOpen = resolve;
      });
    }
    return { path, lines: ["needle"] };
  });
  staleOpenHarness.explorer.handleInput(CTRL_F);
  staleOpenHarness.explorer.handleInput("needle");
  await flushAsyncWork();
  staleOpenHarness.explorer.handleInput("enter");
  staleOpenHarness.explorer.handleInput("x");
  assert.equal(openSignal?.aborted, true);
  resolveOpen?.({ path: "a.txt", lines: ["needle"] });
  await flushAsyncWork();
  assert.ok(staleOpenHarness.explorer.render(60).some((line) => line.includes("Content Search")));
});
