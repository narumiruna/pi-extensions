import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { formatDocumentLines, formatDocumentPresentation } from "../src/components/document-formatting.js";
import { DocumentSearchController } from "../src/components/document-search.js";
import { prepareMermaidRenderer } from "../src/components/mermaid.js";

initTheme("dark", false);

const theme = {
  fg: (_role: string, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_role: string, text: string) => `\u001b[43m${text}\u001b[49m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
  underline: (text: string) => `\u001b[4m${text}\u001b[24m`,
};

function search(lines: readonly string[], query: string) {
  const controller = new DocumentSearchController();
  controller.focused = true;
  controller.activate(lines);
  controller.handleInput(query);
  return controller;
}

test("matches case-insensitive literals across rendered whitespace", () => {
  const controller = search(["Alpha", "  beta", "ALPHA beta"], "alpha beta");
  assert.equal(controller.count, 2);
  assert.equal(controller.current, 1);
  assert.equal(controller.currentRow, 0);
  assert.equal(controller.next(), 2);
  assert.equal(controller.previous(), 0);
  const highlighted = controller.highlight(["Alpha", "  beta", "ALPHA beta"], theme);
  assert.equal(highlighted[0]?.includes("\u001b[1m"), true);
  assert.equal(highlighted[0]?.includes("\u001b[7m"), true);
  assert.equal(highlighted[2]?.includes("\u001b[4m"), true);
});

test("preserves literal matches across exact-document soft wraps", () => {
  const wrapped = formatDocumentPresentation("abcdefgh", { kind: "text" }, 4, theme);
  assert.deepEqual(wrapped.softWrapAfter, [true, false]);
  const controller = search(wrapped.searchLines, "def");
  controller.updateLines(wrapped.searchLines, wrapped.softWrapAfter);
  assert.equal(controller.count, 1);
  assert.deepEqual(controller.highlight(wrapped.lines, theme).map(stripVTControlCharacters), ["abcd", "efgh"]);

  const explicitLines = formatDocumentPresentation("abcd\nefgh", { kind: "text" }, 4, theme);
  controller.updateLines(explicitLines.searchLines, explicitLines.softWrapAfter);
  assert.equal(controller.count, 0);
});

test("preserves Markdown tokens across soft wraps without joining source lines", () => {
  const wrapped = formatDocumentPresentation("abcdefgh", { kind: "markdown" }, 4, theme);
  assert.deepEqual(wrapped.softWrapAfter, [true, false]);
  const controller = search(wrapped.searchLines, "def");
  controller.updateLines(wrapped.searchLines, wrapped.softWrapAfter, wrapped.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);

  const list = formatDocumentPresentation("- abcdefgh", { kind: "markdown" }, 4, theme);
  controller.updateLines(list.searchLines, list.softWrapAfter, list.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);

  const quote = formatDocumentPresentation("> abcdefghijklmnop", { kind: "markdown" }, 6, theme);
  assert.deepEqual(quote.softWrapAfter, [true, true, true, false]);
  controller.updateLines(quote.searchLines, quote.softWrapAfter, quote.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);

  const nestedQuote = formatDocumentPresentation("- > abcdefghijklmnopqrstuvwxyz", { kind: "markdown" }, 20, theme);
  const nestedQuoteSearch = search(nestedQuote.searchLines, "pqr");
  nestedQuoteSearch.updateLines(
    nestedQuote.searchLines,
    nestedQuote.softWrapAfter,
    nestedQuote.ignoreLeadingWhitespace,
  );
  assert.equal(nestedQuoteSearch.count, 1);

  const explicitQuote = formatDocumentPresentation("> abcd\n> efgh", { kind: "markdown" }, 6, theme);
  assert.deepEqual(explicitQuote.softWrapAfter, [false, false]);
  controller.updateLines(explicitQuote.searchLines, explicitQuote.softWrapAfter, explicitQuote.ignoreLeadingWhitespace);
  assert.equal(controller.count, 0);

  const table = formatDocumentPresentation(
    "| a | b |\n|---|---|\n| abcdefgh | qrstuvwxyz |",
    { kind: "markdown" },
    10,
    theme,
  );
  controller.updateLines(table.searchLines, table.softWrapAfter, table.ignoreLeadingWhitespace, table.searchSources);
  assert.equal(controller.count, 1);

  const spacedTable = formatDocumentPresentation("| value |\n|---|\n| alpha beta |", { kind: "markdown" }, 8, theme);
  const spacedSearch = search(spacedTable.searchLines, "alpha beta");
  spacedSearch.updateLines(
    spacedTable.searchLines,
    spacedTable.softWrapAfter,
    spacedTable.ignoreLeadingWhitespace,
    spacedTable.searchSources,
  );
  assert.equal(spacedSearch.count, 1);
  spacedSearch.close();
  spacedSearch.activate(
    spacedTable.searchLines,
    spacedTable.softWrapAfter,
    spacedTable.ignoreLeadingWhitespace,
    spacedTable.searchSources,
  );
  spacedSearch.handleInput("hab");
  assert.equal(spacedSearch.count, 0);

  const decoratedTable = formatDocumentPresentation(
    "| a | b |\n|---|---|\n| abc│defgh | xyz |",
    { kind: "markdown" },
    10,
    theme,
  );
  const decoratedSearch = search(decoratedTable.searchLines, "c│d");
  decoratedSearch.updateLines(
    decoratedTable.searchLines,
    decoratedTable.softWrapAfter,
    decoratedTable.ignoreLeadingWhitespace,
    decoratedTable.searchSources,
  );
  assert.equal(decoratedSearch.count, 1);

  for (const [content, query] of [
    ["> | value |\n> |---|\n> | abcdefghijklmnopqrstuvwxyz |", "nop"],
    ["- | value |\n  |---|\n  | abcdefghijklmnopqrstuvwxyz |", "nop"],
    ["- > | value |\n  > |---|\n  > | abcdefghijklmnopqrstuvwxyz |", "lmn"],
  ] as const) {
    const nestedTable = formatDocumentPresentation(content, { kind: "markdown" }, 20, theme);
    const nestedTableSearch = search(nestedTable.searchLines, query);
    nestedTableSearch.updateLines(
      nestedTable.searchLines,
      nestedTable.softWrapAfter,
      nestedTable.ignoreLeadingWhitespace,
      nestedTable.searchSources,
    );
    assert.equal(nestedTableSearch.count, 1);
    assert.deepEqual(
      nestedTableSearch.highlight(nestedTable.lines, theme).map(stripVTControlCharacters),
      nestedTable.lines.map(stripVTControlCharacters),
    );
  }

  const explicitLines = formatDocumentPresentation("abcd\nefgh", { kind: "markdown" }, 4, theme);
  assert.deepEqual(explicitLines.softWrapAfter, [false, false]);
  controller.updateLines(explicitLines.searchLines, explicitLines.softWrapAfter, explicitLines.ignoreLeadingWhitespace);
  assert.equal(controller.count, 0);

  const repeated = formatDocumentPresentation("abcd\nefgh\n\nabcdefgh", { kind: "markdown" }, 4, theme);
  controller.updateLines(repeated.searchLines, repeated.softWrapAfter, repeated.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);
});

test("uses one width-sensitive Markdown transform for display and search metadata", async () => {
  await prepareMermaidRenderer();
  const presentation = formatDocumentPresentation(
    "```mermaid\nflowchart LR\n abcdefghijklmnop --> qrstuvwxyz\n```",
    { kind: "markdown" },
    10,
    theme,
  );
  const controller = search(presentation.searchLines, "jkl");
  controller.updateLines(presentation.searchLines, presentation.softWrapAfter, presentation.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);
});

test("bounds Markdown reference rendering without losing capped-wrap matches", () => {
  const token = `${"a".repeat(497)}XYZ${"b".repeat(100)}`;
  const content = [token, ...Array.from({ length: 500 }, () => "short")].join("\n");
  const presentation = formatDocumentPresentation(content, { kind: "markdown" }, 20, theme);
  const controller = search(presentation.searchLines, "XYZb");
  controller.updateLines(presentation.searchLines, presentation.softWrapAfter, presentation.ignoreLeadingWhitespace);
  assert.equal(controller.count, 1);
});

test("keeps explicit Markdown lines separate under the reference-render cap", () => {
  const explicitContent = ["a".repeat(499), "b", ...Array.from({ length: 499 }, () => "short")].join("\n");
  const explicitPresentation = formatDocumentPresentation(explicitContent, { kind: "markdown" }, 20, theme);
  const explicitSearch = search(explicitPresentation.searchLines, "ab");
  explicitSearch.updateLines(
    explicitPresentation.searchLines,
    explicitPresentation.softWrapAfter,
    explicitPresentation.ignoreLeadingWhitespace,
  );
  assert.equal(explicitSearch.count, 0);
});

test("preserves capped Markdown table-cell matches", () => {
  const tableToken = `${"a".repeat(493)}XYZb`;
  const tableContent = ["| value |", "|---|", `| ${tableToken} |`, ...Array.from({ length: 498 }, () => "short")].join(
    "\n",
  );
  const tablePresentation = formatDocumentPresentation(tableContent, { kind: "markdown" }, 20, theme);
  const tableSearch = search(tablePresentation.searchLines, "XYZb");
  tableSearch.updateLines(
    tablePresentation.searchLines,
    tablePresentation.softWrapAfter,
    tablePresentation.ignoreLeadingWhitespace,
    tablePresentation.searchSources,
  );
  assert.equal(tableSearch.count, 1);
});

test("maps combining and wide graphemes to ANSI-safe cell ranges", () => {
  const lines = ["x e\u0301你🙂 y"];
  const controller = search(lines, "e\u0301你");
  const highlighted = controller.highlight(lines, theme);
  assert.equal(controller.count, 1);
  assert.equal(stripVTControlCharacters(highlighted[0] ?? ""), lines[0]);
  assert.equal(visibleWidth(highlighted[0] ?? ""), visibleWidth(lines[0] ?? ""));
  assert.equal(highlighted[0]?.includes("\u001b[43m"), true);
  assert.equal(highlighted[0]?.includes("\u001b[1m"), true);
  assert.equal(highlighted[0]?.includes("\u001b[7m"), true);
  assert.equal(highlighted[0]?.includes("\u001b[4m"), false);
});

test("searches ANSI-formatted text, code, diff, and rendered Markdown", () => {
  for (const [content, format, query] of [
    ["const value = 1;", { kind: "code", language: "typescript" } as const, "VALUE"],
    ["+added value", { kind: "diff" } as const, "added"],
    ["# Heading\n\nbody value", { kind: "markdown" } as const, "body"],
  ] as const) {
    const lines = formatDocumentLines(content, format, 40, theme);
    const controller = search(lines, query);
    assert.equal(controller.count, 1);
    assert.deepEqual(
      controller.highlight(lines, theme).map(stripVTControlCharacters),
      lines.map(stripVTControlCharacters),
    );
  }
});

test("handles empty, absent, repeated, resized, invalidated, and sanitized queries", () => {
  const controller = search(["one one", "two"], "one");
  assert.equal(controller.count, 2);
  controller.updateLines(["one", "one", "two"]);
  assert.equal(controller.count, 2);
  controller.invalidate();
  controller.updateLines(["one"]);
  assert.equal(controller.count, 1);
  controller.close();
  assert.equal(controller.count, 0);
  controller.activate(["safe text"]);
  controller.handleInput("\u001b[200~safe\u001b]8;;https://unsafe.example\u0007\u001b[201~");
  assert.equal(controller.input.getValue(), "safe");
  assert.equal(controller.count, 1);
  controller.close();
  controller.activate(["safelink"]);
  controller.handleInput("\u001b[200~safe\u001b]8;;https://exa");
  controller.handleInput("mple.test\u0007link\u001b[201~");
  assert.equal(controller.input.getValue(), "safelink");
  assert.equal(controller.count, 1);
  controller.close();
  controller.activate(["a.b a-b"]);
  controller.handleInput("a.b");
  assert.equal(controller.count, 1);
  controller.close();
  controller.activate(["same"]);
  assert.equal(controller.count, 0);
});

test("sanitizes unbracketed and Kitty-encoded search input before rendering", () => {
  const controller = new DocumentSearchController();
  controller.activate(["safelink"]);
  controller.handleInput("safe\u202e");
  controller.handleInput("\u001b[8238u");
  controller.handleInput("\u001b[108u");
  controller.handleInput("ink");
  assert.equal(controller.input.getValue(), "safelink");
  assert.equal(controller.count, 1);
});

test("clears search input history when closing", () => {
  const controller = new DocumentSearchController();
  controller.activate(["a b"]);
  controller.handleInput("a");
  controller.handleInput(" ");
  controller.handleInput("b");
  assert.equal(controller.count, 1);
  controller.close();
  controller.activate(["a b"]);
  controller.handleInput("\u001f");
  assert.equal(controller.input.getValue(), "");
  assert.equal(controller.count, 0);
});

test("normalizes whitespace for matching without moving the input cursor", () => {
  const controller = new DocumentSearchController();
  controller.activate(["a xb"]);
  controller.handleInput("ab");
  controller.handleInput("\u001b[D");
  controller.handleInput("  ");
  controller.handleInput("x");
  assert.equal(controller.input.getValue(), "a  xb");
  assert.equal(controller.count, 1);
});

test("anchors rebuilt matches at the current or visible row", () => {
  const controller = new DocumentSearchController();
  controller.activate(["alpha", "other", "alphabet"], [], [], [], 2);
  controller.handleInput("a");
  assert.equal(controller.currentRow, 2);
  controller.previous();
  assert.equal(controller.currentRow, 0);
  controller.handleInput("l");
  assert.equal(controller.currentRow, 0);
});

test("defers corpus allocation until search activation and releases it on close", () => {
  const controller = new DocumentSearchController();
  const lines = ["a".repeat(100_000)];
  controller.updateLines(lines);
  assert.equal((controller as unknown as { cells: { rows: Uint32Array } }).cells.rows.length, 0);
  controller.activate(lines);
  assert.equal((controller as unknown as { cells: { rows: Uint32Array } }).cells.rows.length, 100_000);
  controller.close();
  assert.equal((controller as unknown as { cells: { rows: Uint32Array } }).cells.rows.length, 0);
});

test("indexes repetitive documents compactly while retaining count and navigation", () => {
  const line = "a".repeat(200_000);
  const controller = new DocumentSearchController();
  controller.activate(
    [line],
    [],
    [],
    [
      [
        { row: 0, column: 0, text: "z" },
        { row: 0, column: 1, text: "z" },
      ],
    ],
  );
  controller.handleInput("a");
  assert.equal(controller.count, 200_000);
  assert.equal(controller.current, 1);
  controller.previous();
  assert.equal(controller.current, 200_000);
  controller.next();
  assert.equal(controller.current, 1);
  assert.equal(controller.highlight([line], theme).length, 1);
});

test("keeps repetitive alternate table matches compact", () => {
  const tableLine = "a".repeat(20_000);
  const tablePresentation = formatDocumentPresentation(
    `| token |\n|---|\n| ${tableLine} |`,
    { kind: "markdown" },
    20,
    theme,
  );
  const tableController = search(tablePresentation.searchLines, "a");
  tableController.updateLines(
    tablePresentation.searchLines,
    tablePresentation.softWrapAfter,
    tablePresentation.ignoreLeadingWhitespace,
    tablePresentation.searchSources,
  );
  assert.equal(tableController.count, 20_000);
  assert.equal((tableController as unknown as { compactMatchGroups: unknown[] }).compactMatchGroups.length, 1);
});

test("keeps logical table matches stable across wrapping widths", () => {
  const content = `| left | value |\n|---|---|\n| x | ${"a".repeat(500)} |`;
  for (const width of [600, 83]) {
    const presentation = formatDocumentPresentation(content, { kind: "markdown" }, width, theme);
    const controller = search(presentation.searchLines, "aaaaa");
    controller.updateLines(
      presentation.searchLines,
      presentation.softWrapAfter,
      presentation.ignoreLeadingWhitespace,
      presentation.searchSources,
    );
    assert.equal(controller.count, 100);
    const currentTheme = { ...theme, bold: (text: string) => `<current>${text}</current>` };
    for (let index = 0; index < controller.count; index += 1) {
      assert.match(controller.highlight(presentation.lines, currentTheme).join("\n"), /<current>/u);
      controller.next();
    }
  }
});

test("preserves distinct rendered matches that start inside a logical table source", () => {
  const presentation = formatDocumentPresentation(
    "| left | right |\n|---|---|\n| foo │ bar xxxx foo | zzzz zzzz bar |",
    { kind: "markdown" },
    28,
    theme,
  );
  const controller = search(presentation.searchLines, "foo │ bar");
  controller.updateLines(
    presentation.searchLines,
    presentation.softWrapAfter,
    presentation.ignoreLeadingWhitespace,
    presentation.searchSources,
  );
  assert.equal(controller.count, 2);
  const currentTheme = { ...theme, bold: (text: string) => `<current>${text}</current>` };
  for (let index = 0; index < controller.count; index += 1) {
    assert.match(controller.highlight(presentation.lines, currentTheme).join("\n"), /<current>/u);
    controller.next();
  }
});

test("bounds the stored query across typed and pasted input", () => {
  const controller = new DocumentSearchController();
  controller.activate(["x".repeat(4_096)]);
  controller.handleInput("x".repeat(4_096));
  controller.handleInput("y");
  assert.equal(controller.input.getValue(), "x".repeat(4_096));
  assert.equal(controller.count, 1);

  controller.handleInput("\u0301");
  assert.equal(controller.input.getValue(), "x".repeat(4_096));
  assert.equal(controller.count, 1);
  controller.handleInput("\u001b[200~\u0301\u001b[201~");
  assert.equal(controller.input.getValue(), "x".repeat(4_096));
  assert.equal(controller.count, 1);

  controller.handleInput("\u001b[H");
  controller.handleInput("z");
  assert.equal(controller.input.getValue(), `z${"x".repeat(4_095)}`);
  assert.equal(controller.input.getValue().length, 4_096);

  for (const suffix of ["🙂", "e\u0301"]) {
    controller.close();
    controller.activate(["short"]);
    controller.handleInput("x".repeat(4_095));
    controller.handleInput(suffix);
    assert.equal(controller.input.getValue(), "x".repeat(4_095));

    controller.close();
    controller.activate(["short"]);
    controller.handleInput(`\u001b[200~${"x".repeat(4_095)}${suffix}\u001b[201~`);
    assert.equal(controller.input.getValue(), "x".repeat(4_095));
  }

  const exactGraphemeBoundary = `${"x".repeat(4_094)}🙂`;
  controller.close();
  controller.activate([exactGraphemeBoundary]);
  controller.handleInput(exactGraphemeBoundary);
  assert.equal(controller.input.getValue(), exactGraphemeBoundary);
  assert.equal(controller.input.getValue().length, 4_096);
  assert.equal(controller.count, 1);

  controller.close();
  controller.activate(["short"]);
  controller.handleInput("x".repeat(100_000));
  assert.equal(controller.input.getValue().length, 4_096);
  assert.equal(controller.count, 0);

  controller.close();
  controller.activate(["short"]);
  controller.handleInput(`\u001b[200~${"x".repeat(100_000)}`);
  assert.equal(controller.input.getValue(), "");
  controller.handleInput("\u001b[201~");
  assert.equal(controller.input.getValue().length, 4_096);
  assert.equal(controller.count, 0);
});

test("routes only pasted bytes across split markers ahead of surrounding shortcuts", () => {
  const pasteStart = "\u001b[200~";
  for (let split = 1; split < pasteStart.length; split += 1) {
    const splitController = new DocumentSearchController();
    const splitOutsidePaste: string[] = [];
    splitController.activate(["needle"]);
    splitController.routeInput(pasteStart.slice(0, split), (data) => {
      splitOutsidePaste.push(data);
      return true;
    });
    splitController.routeInput(`${pasteStart.slice(split)}needle\u001b[201~`, (data) => {
      splitOutsidePaste.push(data);
      return true;
    });
    assert.equal(splitController.input.getValue(), "needle");
    assert.deepEqual(splitOutsidePaste, []);
  }

  const controller = new DocumentSearchController();
  const outsidePaste: string[] = [];
  controller.activate(["needle"]);
  controller.routeInput("before\u001b[20", (data) => {
    outsidePaste.push(data);
    return true;
  });
  controller.routeInput("0~nee", (data) => {
    outsidePaste.push(data);
    return true;
  });
  controller.routeInput("dle\u001b[20", (data) => {
    outsidePaste.push(data);
    return true;
  });
  const routed = controller.routeInput("1~\u0003", (data) => {
    outsidePaste.push(data);
    return false;
  });
  assert.equal(controller.input.getValue(), "needle");
  assert.deepEqual(outsidePaste, ["before", "\u0003"]);
  assert.deepEqual(routed, { changed: true, stopped: true });
});

test("reuses unchanged line content and bounds its compact input", () => {
  const lines = ["repeat repeat"];
  const controller = search(lines, "repeat");
  controller.updateLines([...lines]);
  assert.equal(controller.count, 2);
  assert.ok(visibleWidth(controller.render(8)) <= 8);
});
