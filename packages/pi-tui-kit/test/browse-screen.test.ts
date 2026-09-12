import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMenuScreenComponent, type MenuScreenComponent, type MenuScreenEvent } from "../src/components/index.js";
import type { BrowseDetailDocument, MenuBrowseItem, MenuScreen } from "../src/types.js";

initTheme("dark", false);

type ScreenId = "browse";
type ActionId = "unused";

const keybindings = {
  matches(data: string, binding: string) {
    const inputs: Record<string, string> = {
      "tui.select.up": "k",
      "tui.select.down": "j",
      "tui.select.pageUp": "u",
      "tui.select.pageDown": "d",
      "tui.select.confirm": "y",
      "tui.select.cancel": "q",
      "tui.altScreen.search": "s",
      "tui.altScreen.searchNext": "n",
      "tui.altScreen.searchPrevious": "p",
      "tui.altScreen.searchClose": "x",
    };
    return data === inputs[binding];
  },
  getKeys(binding: string) {
    const key = {
      "tui.select.up": "k",
      "tui.select.down": "j",
      "tui.select.pageUp": "u",
      "tui.select.pageDown": "d",
      "tui.select.confirm": "y",
      "tui.select.cancel": "q",
      "tui.altScreen.search": "s",
      "tui.altScreen.searchNext": "n",
      "tui.altScreen.searchPrevious": "p",
      "tui.altScreen.searchClose": "x",
    }[binding];
    return key ? [key] : [];
  },
};

function browseScreen(): MenuScreen<ScreenId, ActionId> {
  return {
    kind: "browse",
    title: "Module browser",
    lines: ["Inspect supported modules without changing settings."],
    items: [
      {
        id: "model-raw",
        label: "Model",
        statusText: "Showing",
        description: "Current model",
        searchText: "provider llm",
        details: ["Preview: claude", "Variables: model"],
      },
      {
        id: "git-raw",
        label: "Git\u001b]8;;unsafe\u0007 branch",
        statusText: "Empty\u001b[31m",
        description: "Current Git branch",
        searchText: "repository vcs",
        details: [
          "Preview: none",
          "Reason: no repository",
          "Unsafe\u001b]8;;detail\u0007 text",
          "Style: cyan",
          "Root: referenced",
          "Reachable: yes",
        ],
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `module-${index}`,
        label: `Module ${index}`,
        statusText: index % 2 === 0 ? "Disabled" : "Not in format",
        description: `Description ${index}`,
        details: [`Detail ${index}`],
      })),
    ],
    viewportSize: "adaptive",
    hint: "back",
  } as unknown as MenuScreen<ScreenId, ActionId>;
}

test("browse searches catalog metadata and preserves query and selection across detail", () => {
  const harness = componentHarness(browseScreen(), { rows: 14, selectedItemId: "model-raw" });
  const focusable = harness.component as MenuScreenComponent & Focusable;
  assert.equal("focused" in focusable, true);
  focusable.focused = true;
  assert.equal(harness.component.render(48).join("\n").includes(CURSOR_MARKER), true);

  harness.component.handleInput("\u001b[200~repository\u0007 vcs\u001b[201~");
  let rendered = plainRender(harness.component, 48).join("\n");
  assert.match(rendered, /Git branch.*\[Empty\]/u);
  assert.doesNotMatch(rendered, /Model|Module 0/u);
  assert.equal(harness.selectionChanges.at(-1), "git-raw");

  harness.component.handleInput("y");
  rendered = plainRender(harness.component, 48).join("\n");
  assert.match(rendered, /Status: Empty/u);
  assert.match(rendered, /Current Git branch/u);
  assert.match(rendered, /Preview: none/u);
  const rawDetail = harness.component.render(48).join("\n");
  assert.equal(rawDetail.includes(CURSOR_MARKER), false);
  assert.equal(rawDetail.includes("\u001b]8;;detail"), false);
  assert.equal(rawDetail.includes("\u001b[31m"), false);

  harness.component.handleInput("d");
  assert.match(plainRender(harness.component, 48).join("\n"), /Reachable: yes/u);
  harness.component.handleInput("q");
  rendered = plainRender(harness.component, 48).join("\n");
  assert.match(rendered, /repository.*vcs/u);
  assert.match(rendered, /Git branch/u);
  assert.equal(harness.component.render(48).join("\n").includes(CURSOR_MARKER), true);
});

test("browse legacy details retain normalized ordering and empty fallback", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Legacy browse",
    items: [
      {
        id: "legacy",
        label: "Legacy",
        statusText: "  Ready   state  ",
        description: " Legacy\tdescription ",
        details: ["  nested   prose  ", ""],
      },
      { id: "empty", label: "Empty" },
    ],
    hint: "back",
  };
  const harness = componentHarness(screen, { rows: 24, selectedItemId: "legacy" });
  harness.component.handleInput("y");
  assert.deepEqual(plainRender(harness.component, 80), [
    "─".repeat(80),
    "Legacy",
    "Status: Ready state",
    "Legacy description",
    "nested prose",
    "",
    "k/j scroll · u/d page · q back · ctrl+c close",
    "─".repeat(80),
  ]);
  harness.component.handleInput("q");
  harness.component.handleInput("j");
  harness.component.handleInput("y");
  assert.match(plainRender(harness.component, 80).join("\n"), /No details available\./u);
});

test("browse exact details preserve documents, precedence, search identity, and scrolling", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Schemas",
    items: [
      {
        id: "schema-alpha",
        label: "Schema",
        searchText: "alpha",
        detailDocument: { content: "private-document-token" },
      },
      {
        id: "schema-beta",
        label: "Schema",
        statusText: "Ready",
        description: "Legacy description",
        searchText: "beta alias",
        details: ["legacy detail must not render"],
        detailDocument: {
          content: [
            "  two spaces",
            "    four spaces",
            "\ttabbed",
            "你🙂wide",
            "unsafe\u001b]8;;https://unsafe.example\u0007text",
            ...Array.from({ length: 10 }, (_, index) => `tail ${index + 1}`),
          ].join("\n"),
          format: { kind: "text" },
        },
      },
    ],
    viewportSize: "adaptive",
    hint: "back",
  };
  const harness = componentHarness(screen, { rows: 14, selectedItemId: "schema-alpha" });
  const focusable = harness.component as MenuScreenComponent & Focusable;
  focusable.focused = true;
  for (const input of "beta") harness.component.handleInput(input);
  assert.equal(harness.selectionChanges.at(-1), "schema-beta");

  harness.component.handleInput("y");
  let rendered = plainRender(harness.component, 40).join("\n");
  assert.match(rendered, /^Schemas?$/mu);
  assert.match(rendered, /^ {2}two spaces$/mu);
  assert.match(rendered, /^ {4}four spaces$/mu);
  assert.match(rendered, /^ {4}tabbed$/mu);
  assert.match(rendered, /^你🙂wide$/mu);
  assert.doesNotMatch(rendered, /Status:|Legacy description|legacy detail must not render/u);
  assert.equal(harness.component.render(40).join("\n").includes("https://unsafe.example"), false);
  assert.equal(
    harness.component.render(8).every((line) => visibleWidth(line) <= 8),
    true,
  );

  const graphemes = componentHarness(
    {
      kind: "browse",
      title: "Wide",
      items: [{ id: "wide", label: "Wide", detailDocument: { content: "你🙂x" } }],
    } as MenuScreen<ScreenId, ActionId>,
    { rows: 24 },
  );
  graphemes.component.handleInput("y");
  const narrow = plainRender(graphemes.component, 2);
  assert.equal(narrow.includes("你"), true);
  assert.equal(narrow.includes("🙂"), true);
  assert.equal(narrow.includes("x"), true);
  assert.equal(
    narrow.every((line) => visibleWidth(line) <= 2),
    true,
  );

  harness.component.handleInput("d");
  harness.component.handleInput("d");
  assert.match(plainRender(harness.component, 40).join("\n"), /tail 10/u);
  harness.component.handleInput("q");
  rendered = plainRender(harness.component, 40).join("\n");
  assert.match(rendered, /beta/u);
  assert.equal(harness.component.render(40).join("\n").includes(CURSOR_MARKER), true);
  assert.equal(harness.selectionChanges.at(-1), "schema-beta");

  const privateSearch = componentHarness(screen, { rows: 14 });
  for (const input of "private-document-token") privateSearch.component.handleInput(input);
  assert.match(plainRender(privateSearch.component, 40).join("\n"), /No matching items/u);
});

test("browse detail documents share semantic Markdown and LaTeX rendering", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Guides",
    items: [
      {
        id: "markdown",
        label: "Rendered guide",
        searchText: "formula math",
        detailDocument: {
          content: "# Formula guide\n\nThe result is $x^2$.\n\n```ts\nconst answer = 42;\n```",
          format: { kind: "markdown", renderMermaid: false },
        },
      },
    ],
    viewportSize: "adaptive",
    hint: "back",
  };
  const harness = componentHarness(screen, { rows: 16 });
  const focusable = harness.component as MenuScreenComponent & Focusable;
  focusable.focused = true;
  for (const input of "math") harness.component.handleInput(input);
  harness.component.handleInput("y");

  for (const width of [10, 24, 60]) {
    assert.ok(harness.component.render(width).every((line) => visibleWidth(line) <= width));
  }
  const rendered = plainRender(harness.component, 60).join("\n");
  assert.match(rendered, /^Formula guide\s*$/mu);
  assert.match(rendered, /The result is x²\./u);
  assert.match(rendered, /const answer = 42;/u);
  assert.match(rendered, /```ts/u);
  assert.doesNotMatch(rendered, /# Formula guide/u);

  harness.component.handleInput("q");
  assert.match(plainRender(harness.component, 60).join("\n"), /math/u);
  assert.equal(harness.component.render(60).join("\n").includes(CURSOR_MARKER), true);
  assert.equal(harness.selectionChanges.at(-1), "markdown");
});

test("browse exact details apply shared code and diff formatting", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    items: [
      {
        id: "code",
        label: "Code",
        detailDocument: {
          content: "const answer: number = 42;",
          format: { kind: "code", filePath: "answer.ts" },
        },
      },
      {
        id: "diff",
        label: "Diff",
        detailDocument: {
          content: "@@ header\n-old\n+new\n same",
          format: { kind: "diff", filePath: "settings.json" },
        },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 24, themed: true });
  harness.component.handleInput("y");
  let rendered = harness.component.render(200).join("\n");
  assert.match(rendered, /syntaxKeyword:const/u);
  assert.match(rendered, /syntaxType:number/u);
  assert.match(rendered, /syntaxNumber:42/u);
  harness.component.handleInput("q");
  harness.component.handleInput("j");
  harness.component.handleInput("y");
  rendered = harness.component.render(200).join("\n");
  assert.match(rendered, /toolDiffRemoved:-old/u);
  assert.match(rendered, /toolDiffAdded:\+new/u);
  assert.match(rendered, /accent:@@ header/u);
});

test("browse caches exact detail formatting until its inputs or theme change", () => {
  const colorCalls: string[] = [];
  const detailDocument: BrowseDetailDocument = {
    content: Array.from({ length: 12 }, (_, index) => `document line ${index + 1}`).join("\n"),
    format: { kind: "text" },
  };
  const item: MenuBrowseItem = { id: "document", label: "Document", detailDocument };
  const harness = componentHarness(
    { kind: "browse", title: "Documents", items: [item] },
    { rows: 10, onColor: (color) => colorCalls.push(color) },
  );
  harness.component.handleInput("y");

  harness.component.render(40);
  const initialTextCalls = colorCalls.filter((color) => color === "text").length;
  assert.equal(initialTextCalls, 12);
  harness.component.handleInput("j");
  harness.component.render(40);
  assert.equal(colorCalls.filter((color) => color === "text").length, initialTextCalls);

  harness.component.render(12);
  const resizedTextCalls = colorCalls.filter((color) => color === "text").length;
  assert.ok(resizedTextCalls > initialTextCalls);
  harness.component.render(12);
  assert.equal(colorCalls.filter((color) => color === "text").length, resizedTextCalls);

  detailDocument.content += "\nchanged content";
  harness.component.render(12);
  const changedContentCalls = colorCalls.filter((color) => color === "text").length;
  assert.ok(changedContentCalls > resizedTextCalls);

  detailDocument.format = { kind: "diff" };
  harness.component.render(12);
  const changedFormatCalls = colorCalls.filter((color) => color === "toolDiffContext").length;
  assert.ok(changedFormatCalls > 0);
  harness.component.render(12);
  assert.equal(colorCalls.filter((color) => color === "toolDiffContext").length, changedFormatCalls);

  harness.component.invalidate();
  harness.component.render(12);
  assert.ok(colorCalls.filter((color) => color === "toolDiffContext").length > changedFormatCalls);
});

test("browse is adaptively bounded, handles empty searches, and distinguishes Back from Close", () => {
  const harness = componentHarness(browseScreen(), { rows: 10 });
  for (const { width, rows } of [
    { width: 60, rows: 16 },
    { width: 24, rows: 8 },
    { width: 8, rows: 4 },
    { width: 1, rows: 1 },
  ]) {
    harness.host.terminal.rows = rows;
    const lines = harness.component.render(width);
    assert.ok(lines.length <= Math.max(1, rows - 3), `${width}x${rows}`);
    if (rows >= 8) {
      const plain = lines.map((line) => stripVTControlCharacters(line));
      assert.equal(plain[0], "─".repeat(width));
      assert.equal(plain.at(-1), "─".repeat(width));
    }
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `${width}x${rows}`,
    );
  }

  const capped = componentHarness({ ...browseScreen(), viewportSize: 2 } as MenuScreen<ScreenId, ActionId>, {
    rows: 20,
  });
  const cappedFrame = plainRender(capped.component, 60).join("\n");
  assert.match(cappedFrame, /Model[\s\S]*Git branch/u);
  assert.doesNotMatch(cappedFrame, /Module 0/u);
  assert.match(cappedFrame, /1-2\/12/u);

  harness.host.terminal.rows = 12;
  harness.component.render(40);
  for (const input of ["z", "z", "z"]) harness.component.handleInput(input);
  assert.match(plainRender(harness.component, 40).join("\n"), /No matching items/u);
  harness.component.handleInput("q");
  assert.deepEqual(harness.events, [{ kind: "back" }]);

  const close = componentHarness({ ...browseScreen(), hint: "close" } as MenuScreen<ScreenId, ActionId>);
  close.component.handleInput("\u0003");
  assert.deepEqual(close.events, [{ kind: "close" }]);
});

test("browse detail search stays independent from list filtering", () => {
  const colors: string[] = [];
  const screen = {
    ...browseScreen(),
    enableDetailSearch: true,
    items: [
      {
        id: "legacy",
        label: "Legacy",
        searchText: "catalog-only",
        details: ["first needle", "second needle", "abcdefgh"],
      },
    ],
  } as MenuScreen<ScreenId, ActionId>;
  const harness = componentHarness(screen, { rows: 12, onColor: (color) => colors.push(color) });
  const focusable = harness.component as MenuScreenComponent & Focusable;
  focusable.focused = true;
  harness.component.render(40);
  harness.component.handleInput("catalog");
  harness.component.handleInput("y");
  harness.component.render(40);
  harness.component.handleInput("s");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
  harness.component.handleInput("\u001b[32u");
  harness.component.handleInput("\u001b[20");
  harness.component.handleInput("0~");
  harness.component.handleInput("n");
  harness.component.handleInput("eedle\u001b[201~");
  assert.match(plainRender(harness.component, 40).join("\n"), /Find:/u);
  assert.ok(colors.includes("searchMatchText"));
  harness.component.handleInput("n");
  harness.component.handleInput("x");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
  harness.component.render(4);
  harness.component.handleInput(" ");
  harness.component.handleInput("def");
  colors.length = 0;
  harness.component.render(4);
  assert.ok(colors.includes("searchMatchText"));
  harness.component.handleInput("x");
  harness.component.handleInput(" ");
  harness.component.handleInput("\u001b[200~");
  harness.component.handleInput("\u0003");
  harness.component.handleInput("\u001b[201~");
  assert.deepEqual(harness.events, []);
  harness.component.handleInput("x");
  harness.component.handleInput("q");
  assert.match(plainRender(harness.component, 40).join("\n"), /Legacy/u);
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /No matching items/u);
  harness.component.handleInput("y");
  harness.component.render(40);
  harness.component.handleInput(" ");
  harness.component.handleInput("\u001b[200~needle");
  harness.component.handleInput("\u001b[201~\u0003");
  assert.deepEqual(harness.events, [{ kind: "close" }]);
});

test("browse detail gives a configured Space action priority over search", () => {
  const remappedKeybindings = {
    matches(data: string, binding: string) {
      if (binding === "tui.select.down") return data === " ";
      if (binding === "tui.altScreen.searchClose") return data === "\u001b";
      return keybindings.matches(data, binding);
    },
    getKeys(binding: string) {
      if (binding === "tui.select.down") return ["space"];
      if (binding === "tui.altScreen.searchClose") return ["escape"];
      return keybindings.getKeys(binding);
    },
  };
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [
      {
        id: "exact",
        label: "Exact",
        detailDocument: { content: "needle\nsecond row\nthird row" },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 10, keybindings: remappedKeybindings });
  harness.component.render(40);
  harness.component.handleInput("y");
  const inactive = plainRender(harness.component, 40).join("\n");
  assert.doesNotMatch(inactive, /space search/u);
  harness.component.handleInput(" ");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
});

test("browse detail closes Space-activated search immediately on Escape", () => {
  const escapeKeybindings = {
    ...keybindings,
    matches(data: string, binding: string) {
      if (binding === "tui.altScreen.searchClose") return data === "\u001b";
      return keybindings.matches(data, binding);
    },
    getKeys(binding: string) {
      if (binding === "tui.altScreen.searchClose") return ["escape"];
      return keybindings.getKeys(binding);
    },
  };
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [{ id: "exact", label: "Exact", detailDocument: { content: "needle" } }],
  };
  const harness = componentHarness(screen, { rows: 10, keybindings: escapeKeybindings });
  harness.component.render(40);
  harness.component.handleInput("y");
  assert.match(plainRender(harness.component, 40).join("\n"), /space search/u);
  harness.component.handleInput(" ");
  assert.match(plainRender(harness.component, 40).join("\n"), /Find:/u);
  harness.component.handleInput("\u001b");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
  harness.component.handleInput("a");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
});

test("browse detail dispatches Escape when it is remapped to next search match", () => {
  const escapeNextKeybindings = {
    ...keybindings,
    matches(data: string, binding: string) {
      if (binding === "tui.altScreen.searchNext") return data === "\u001b";
      return keybindings.matches(data, binding);
    },
    getKeys(binding: string) {
      if (binding === "tui.altScreen.searchNext") return ["escape"];
      return keybindings.getKeys(binding);
    },
  };
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [
      {
        id: "exact",
        label: "Exact",
        detailDocument: { content: "needle\nother\nneedle" },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 10, keybindings: escapeNextKeybindings });
  harness.component.render(40);
  harness.component.handleInput("y");
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.match(plainRender(harness.component, 40).join("\n"), /1\/2/u);
  harness.component.handleInput("\u001b");
  assert.match(plainRender(harness.component, 40).join("\n"), /2\/2/u);
});

test("browse keeps the current detail match visible after rewrapping", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [
      {
        id: "exact",
        label: "Exact",
        detailDocument: { content: `${"prefix ".repeat(12)}\nneedle` },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 8 });
  harness.component.render(80);
  harness.component.handleInput("y");
  harness.component.render(80);
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.equal(plainRender(harness.component, 80).includes("needle"), true);
  assert.equal(plainRender(harness.component, 12).includes("needle"), true);
  harness.host.terminal.rows = 6;
  assert.equal(plainRender(harness.component, 12).includes("needle"), true);
});

test("browse forwards Home and End to the active detail search input", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [{ id: "exact", label: "Exact", detailDocument: { content: "zabcd" } }],
  };
  const harness = componentHarness(screen, { rows: 8 });
  harness.component.render(30);
  harness.component.handleInput("y");
  harness.component.render(30);
  harness.component.handleInput(" ");
  harness.component.handleInput("abcd");
  harness.component.handleInput("\u001b[H");
  harness.component.handleInput("z");
  assert.match(plainRender(harness.component, 30).join("\n"), /Find:.*zabcd.*1\/1/u);
  harness.component.handleInput("\u001b[F");
  harness.component.handleInput("y");
  assert.match(plainRender(harness.component, 30).join("\n"), /Find:.*zabcdy.*0\/0/u);
});

test("browse preserves manual detail scrolling while search is active", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [
      {
        id: "exact",
        label: "Exact",
        detailDocument: {
          content: ["needle", ...Array.from({ length: 12 }, (_, index) => `row ${index + 1}`)].join("\n"),
        },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 8 });
  harness.component.render(30);
  harness.component.handleInput("y");
  harness.component.render(30);
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.match(plainRender(harness.component, 30).join("\n"), /needle/u);
  harness.component.handleInput("d");
  const scrolled = plainRender(harness.component, 30);
  assert.equal(scrolled.includes("needle"), false);
  assert.match(scrolled.join("\n"), /row 1/u);
});

test("browse mouse routes search editing, stable row activation, and list wheel selection", () => {
  const harness = componentHarness(browseScreen(), { rows: 14, selectedItemId: "model-raw" });
  let frame = plainRender(harness.component, 48);
  const searchRow = frame.findIndex((line) => line.includes("Search:"));
  assert.notEqual(searchRow, -1);
  harness.component.handleInput("Mdel");
  frame = plainRender(harness.component, 48);
  mouse(harness.component, frame, { type: "press", x: 11, y: searchRow }, 48);
  harness.component.handleInput("o");
  frame = plainRender(harness.component, 48);
  assert.match(frame.join("\n"), /Model.*\[Showing\]/u);

  let itemRow = frame.findIndex((line) => line.includes("› Model"));
  mouse(harness.component, frame, { type: "press", x: 3, y: itemRow }, 48);
  frame = plainRender(harness.component, 48);
  itemRow = frame.findIndex((line) => line.includes("› Model"));
  mouse(harness.component, frame, { type: "click", x: 3, y: itemRow }, 48);
  assert.match(plainRender(harness.component, 48).join("\n"), /Preview: claude/u);

  const wheelHarness = componentHarness(browseScreen(), { rows: 14, selectedItemId: "model-raw" });
  frame = plainRender(wheelHarness.component, 48);
  itemRow = frame.findIndex((line) => line.includes("› Model"));
  mouse(wheelHarness.component, frame, { type: "wheel", x: 3, y: itemRow, wheelDelta: 1 }, 48);
  assert.equal(wheelHarness.selectionChanges.at(-1), "git-raw");
});

test("browse detail mouse wheel scrolls only over document rows", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Long document",
    items: [
      {
        id: "long",
        label: "Long",
        detailDocument: { content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") },
      },
    ],
    enableDetailSearch: true,
  };
  const harness = componentHarness(screen, { rows: 9 });
  harness.component.render(32);
  harness.component.handleInput("y");
  let frame = plainRender(harness.component, 32);
  const documentRow = frame.findIndex((line) => line.includes("line 1"));
  assert.notEqual(documentRow, -1);
  mouse(harness.component, frame, { type: "move", x: 2, y: documentRow }, 32);
  assert.match(plainRender(harness.component, 32).join("\n"), /line 1/u);
  mouse(harness.component, frame, { type: "wheel", x: 2, y: documentRow, wheelDelta: 1 }, 32);
  frame = plainRender(harness.component, 32);
  assert.doesNotMatch(frame.join("\n"), /line 1/u);
});

test("browse searches exact detail documents and resets on exit", () => {
  const screen: MenuScreen<ScreenId, ActionId> = {
    kind: "browse",
    title: "Documents",
    enableDetailSearch: true,
    items: [
      {
        id: "exact",
        label: "Exact",
        detailDocument: {
          content: "# Heading\n\nexact needle",
          format: { kind: "markdown" },
        },
      },
    ],
  };
  const harness = componentHarness(screen, { rows: 12 });
  harness.component.render(40);
  harness.component.handleInput("y");
  harness.component.render(40);
  harness.component.handleInput(" ");
  harness.component.handleInput("missing");
  assert.match(plainRender(harness.component, 40).join("\n"), /0\/0/u);
  harness.component.handleInput("q");
  assert.match(plainRender(harness.component, 40).join("\n"), /missingq/u);
  harness.component.handleInput("x");
  harness.component.handleInput("q");
  harness.component.handleInput("y");
  assert.doesNotMatch(plainRender(harness.component, 40).join("\n"), /Find:/u);
  harness.component.handleInput("\u0003");
  assert.deepEqual(harness.events, [{ kind: "close" }]);
});

function plainRender(component: MenuScreenComponent, width: number) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function mouse(
  component: MenuScreenComponent,
  frame: readonly string[],
  event: { type: "move" | "press" | "click" | "wheel"; x: number; y: number; wheelDelta?: number },
  width: number,
) {
  return component.handleMouse?.({
    type: event.type,
    button: event.type === "move" || event.type === "wheel" ? "none" : "left",
    x: event.x,
    y: event.y,
    screenX: event.x,
    screenY: event.y,
    width,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
    ...(event.wheelDelta === undefined ? {} : { wheelDelta: event.wheelDelta }),
  });
}

function componentHarness(
  screen: MenuScreen<ScreenId, ActionId>,
  options: {
    rows?: number;
    selectedItemId?: string;
    themed?: boolean;
    onColor?: (color: string) => void;
    keybindings?: typeof keybindings;
  } = {},
) {
  const events: MenuScreenEvent[] = [];
  const selectionChanges: string[] = [];
  const host = { terminal: { rows: options.rows ?? 24 }, requestRender() {} };
  const component = createMenuScreenComponent({
    screen,
    selectedItemId: options.selectedItemId,
    tui: host,
    theme: {
      fg: (color: string, text: string) => {
        options.onColor?.(color);
        return options.themed ? `${color}:${text}` : text;
      },
      bold: (text: string) => text,
    },
    keybindings: options.keybindings ?? keybindings,
    onEvent: (event) => events.push(event),
    onSelectionChange: (itemId) => selectionChanges.push(itemId),
  });
  return { component, events, selectionChanges, host };
}
