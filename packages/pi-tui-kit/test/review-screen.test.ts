import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createMenuScreenComponent } from "../src/components/index.js";
import { defineMenu, type ReviewScreen, runMenu } from "../src/index.js";
import { createTuiHarness } from "../src/testing/index.js";

initTheme("dark", false);

type ScreenId = "review";
type ActionId = "apply";

const reviewScreen: ReviewScreen<ActionId> = {
  kind: "review",
  title: "Review changes",
  content: "line 1\nline 2\nline 3\nline 4\nline 5",
  format: { kind: "text" },
  viewportSize: 3,
  confirm: { id: "raw-apply", label: "Apply", action: "apply" },
  hint: "back",
};

type ReviewKeybindings = {
  matches(data: string, binding: string): boolean;
  getKeys(binding: string): readonly string[];
};

const reviewTestKeybindings: ReviewKeybindings = {
  matches(data, binding) {
    const values: Record<string, string> = {
      "tui.select.up": "k",
      "tui.select.down": "j",
      "tui.select.pageUp": "u",
      "tui.select.pageDown": "d",
      "tui.select.confirm": "l",
      "tui.select.cancel": "q",
      "tui.altScreen.search": "s",
      "tui.altScreen.searchNext": "n",
      "tui.altScreen.searchPrevious": "p",
      "tui.altScreen.searchClose": "x",
    };
    return data === values[binding];
  },
  getKeys(binding) {
    const values: Record<string, readonly string[]> = {
      "tui.select.up": ["k"],
      "tui.select.down": ["j"],
      "tui.select.pageUp": ["u"],
      "tui.select.pageDown": ["d"],
      "tui.select.confirm": ["l"],
      "tui.select.cancel": ["q", "ctrl+c"],
      "tui.altScreen.search": ["s"],
      "tui.altScreen.searchNext": ["n"],
      "tui.altScreen.searchPrevious": ["p"],
      "tui.altScreen.searchClose": ["x"],
    };
    return values[binding] ?? [];
  },
};

const defaultReviewKeybindings: ReviewKeybindings = {
  matches() {
    return false;
  },
  getKeys(binding) {
    const values: Record<string, readonly string[]> = {
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.select.pageUp": ["pageup"],
      "tui.select.pageDown": ["pagedown"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
    };
    return values[binding] ?? [];
  },
};

const longCancelReviewKeybindings: ReviewKeybindings = {
  ...defaultReviewKeybindings,
  getKeys(binding) {
    if (binding === "tui.select.cancel") return ["shift+escape", "ctrl+c"];
    return defaultReviewKeybindings.getKeys(binding);
  },
};

test("review preserves whitespace, sanitizes controls, and bounds exact text at every width", () => {
  const harness = reviewComponentHarness({
    ...reviewScreen,
    content: "  indented\tvalue\n你🙂very-long-token\nunsafe\u001b]8;;https://unsafe.example\u0007text",
    viewportSize: 20,
  });
  for (const width of [1, 2, 8, 20, 40, 80, 120]) {
    const lines = harness.component.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
    assert.equal(lines.join("\n").includes("\u001b]8;;https://unsafe.example"), false);
  }
  const rendered = stripVTControlCharacters(harness.component.render(80).join("\n"));
  assert.match(rendered, / {2}indented {2,}value/);
  assert.match(rendered, /你🙂very-long-token/);
});

test("fixed and default review frames use consistent rules and preserve content", () => {
  const content = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n");
  const fixed = reviewComponentHarness({ ...reviewScreen, content });
  assert.deepEqual(plainLines(fixed.component, 80), [
    "─".repeat(80),
    "Review changes",
    "",
    "row 1",
    "row 2",
    "row 3",
    "1-3/20",
    "k/j navigate • l Apply • q back • ctrl+c close",
    "─".repeat(80),
  ]);

  const defaultViewport = reviewComponentHarness({
    ...reviewScreen,
    content,
    viewportSize: undefined,
  });
  assert.deepEqual(plainLines(defaultViewport.component, 80), [
    "─".repeat(80),
    "Review changes",
    "",
    ...Array.from({ length: 14 }, (_, index) => `row ${index + 1}`),
    "1-14/20",
    "k/j navigate • l Apply • q back • ctrl+c close",
    "─".repeat(80),
  ]);
});

test("rendered-empty fixed and default reviews preserve controls at minimum heights", () => {
  for (const content of ["", " ", "\n", " \n\t"]) {
    for (const viewportSize of [3, undefined]) {
      for (const terminalRows of [4, 5]) {
        const harness = reviewComponentHarness({ ...reviewScreen, content, viewportSize }, false, terminalRows);
        const lines = plainLines(harness.component, 80);
        assert.ok(lines.length > 0);
        assert.match(lines.join("\n"), /l Apply|q back|ctrl\+c close/u);
        assert.ok(lines.every((line) => line.trim().length > 0));
      }
    }
  }
});

test("two-row fixed and default reviews preserve content and cancellation", () => {
  for (const viewportSize of [3, undefined]) {
    const harness = reviewComponentHarness({ ...reviewScreen, content: "Important change", viewportSize }, false, 5);
    const rendered = plainLines(harness.component, 80);
    assert.equal(rendered.length, 2);
    assert.match(rendered[0] ?? "", /Important change/u);
    assert.match(rendered[1] ?? "", /q back/u);
    assert.doesNotMatch(rendered.join("\n"), /Review changes/u);
  }
});

test("narrow compact review hints advertise cancellation before confirmation", () => {
  const custom = reviewComponentHarness(reviewScreen, false, 6);
  assert.match(plainRender(custom.component, 10), /q back/u);
  assert.doesNotMatch(plainRender(custom.component, 10), /l Apply/u);

  const defaults = reviewComponentHarness(reviewScreen, false, 6, undefined, defaultReviewKeybindings);
  assert.match(plainRender(defaults.component, 12), /esc back/u);
  assert.doesNotMatch(plainRender(defaults.component, 12), /enter Apply/u);
});

test("compact review hints skip oversized controls and retain later controls", () => {
  const harness = reviewComponentHarness(reviewScreen, false, 6, undefined, longCancelReviewKeybindings);
  const rendered = plainRender(harness.component, 12);
  assert.match(rendered, /ctrl\+c close/u);
  assert.doesNotMatch(rendered, /shift\+escap/u);
});

test("fixed and default review pagination reaches the end after height compaction", () => {
  const content = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n");
  for (const viewportSize of [14, undefined]) {
    const harness = reviewComponentHarness({ ...reviewScreen, content, viewportSize }, false, 10);
    let rendered = plainRender(harness.component, 80);
    assert.ok(harness.component.render(80).length <= 7);
    assert.match(rendered, /row 1/u);
    assert.match(rendered, /1-2\/20/u);

    harness.component.handleInput("\u001b[F");
    rendered = plainRender(harness.component, 80);
    assert.match(rendered, /row 20/u);
    assert.match(rendered, /19-20\/20/u);
    harness.component.handleInput("u");
    assert.match(plainRender(harness.component, 80), /row 17/u);
  }
});

test("fixed and default reviews reserve their requested viewport before extra header rows", () => {
  const content = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n");
  const lines = Array.from({ length: 20 }, (_, index) => `Context ${index + 1}`);
  for (const viewportSize of [14, undefined]) {
    const harness = reviewComponentHarness({ ...reviewScreen, content, lines, viewportSize }, false, 24);
    const rendered = plainRender(harness.component, 80);
    assert.match(rendered, /row 1[\s\S]*row 14/u);
    assert.match(rendered, /1-14\/20/u);
    assert.ok(harness.component.render(80).length <= 21);
  }
});

test("fixed and default reviews cap reserved viewport rows at formatted content length", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `Context ${index + 1}`);
  for (const viewportSize of [14, undefined]) {
    const harness = reviewComponentHarness({ ...reviewScreen, content: "only row", lines, viewportSize }, false, 24);
    const rendered = plainRender(harness.component, 80);
    assert.match(rendered, /Context 1[\s\S]*Context 10/u);
    assert.match(rendered, /only row/u);
    assert.ok(harness.component.render(80).length <= 21);
  }
});

test("adaptive review degrades explicitly at constrained terminal heights", () => {
  const content = Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n");
  const harness = reviewComponentHarness({ ...reviewScreen, content, viewportSize: "adaptive" }, false, 4);
  assert.deepEqual(plainLines(harness.component, 80), ["row 1"]);

  harness.setTerminalRows(5);
  assert.deepEqual(plainLines(harness.component, 80), ["row 1", "q back • ctrl+c close • l Apply • k/j navigate"]);

  harness.setTerminalRows(6);
  assert.deepEqual(plainLines(harness.component, 80), [
    "Review changes",
    "row 1",
    "q back • ctrl+c close • l Apply • k/j navigate",
  ]);

  harness.setTerminalRows(7);
  assert.deepEqual(plainLines(harness.component, 80), [
    "Review changes",
    "row 1",
    "1-1/10",
    "q back • ctrl+c close • l Apply • k/j navigate",
  ]);

  harness.setTerminalRows(8);
  assert.deepEqual(plainLines(harness.component, 80), [
    "─".repeat(80),
    "Review changes",
    "row 1",
    "q back • ctrl+c close • l Apply • k/j navigate",
    "─".repeat(80),
  ]);
});

test("adaptive review restores wrapped context and exceeds the numeric viewport ceiling safely", () => {
  const content = Array.from({ length: 100 }, (_, index) => `row ${index + 1}`).join("\n");
  const typical = reviewComponentHarness(
    {
      ...reviewScreen,
      title: "Review configuration changes",
      lines: ["Supporting context that wraps at narrow widths"],
      content,
      viewportSize: "adaptive",
    },
    false,
    30,
  );
  const typicalLines = plainLines(typical.component, 18);
  assert.equal(typicalLines.length, 27);
  assert.ok(typicalLines.some((line) => line.includes("Supporting")));
  assert.ok(typicalLines.some((line) => /\d+-\d+\/100/u.test(line)));
  assert.ok(typicalLines.every((line) => visibleWidth(line) <= 18));

  const large = reviewComponentHarness({ ...reviewScreen, content, viewportSize: "adaptive" }, false, 80);
  const largeLines = plainLines(large.component, 80);
  assert.equal(largeLines.length, 77);
  assert.ok(largeLines.includes("row 71"));
  assert.ok(largeLines.every((line) => visibleWidth(line) <= 80));
});

test("adaptive review resizes, reflows, clamps, and pages by the latest rendered viewport", () => {
  const content = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n");
  const harness = reviewComponentHarness({ ...reviewScreen, content, viewportSize: "adaptive" }, false, 12);
  let rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 1[\s\S]*row 3/);
  assert.match(rendered, /1-3\/20/);

  harness.component.handleInput("\u001b[F");
  rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 18[\s\S]*row 20/);
  assert.match(rendered, /18-20\/20/);

  harness.setTerminalRows(7);
  rendered = plainRender(harness.component, 30);
  assert.match(rendered, /row 18/);
  assert.match(rendered, /18-18\/20/);

  harness.setTerminalRows(14);
  rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 16[\s\S]*row 20/);
  assert.match(rendered, /16-20\/20/);
  harness.component.handleInput("u");
  rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 11[\s\S]*row 15/);

  harness.setTerminalRows(9);
  rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 11/);
  harness.component.handleInput("d");
  rendered = plainRender(harness.component, 80);
  assert.match(rendered, /row 12/);
  assert.ok(harness.component.render(20).every((line) => visibleWidth(line) <= 20));
});

test("review scrolls by injected keys, pages, and clamps after resize", () => {
  const harness = reviewComponentHarness({
    ...reviewScreen,
    content: Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n"),
  });
  let rendered = plainRender(harness.component, 40);
  assert.match(rendered, /row 1[\s\S]*row 3/);
  assert.doesNotMatch(rendered, /row 4/);

  harness.component.handleInput("j");
  rendered = plainRender(harness.component, 40);
  assert.match(rendered, /row 2[\s\S]*row 4/);
  harness.component.handleInput("d");
  rendered = plainRender(harness.component, 40);
  assert.match(rendered, /row 5[\s\S]*row 7/);
  harness.component.handleInput("\u001b[F");
  rendered = plainRender(harness.component, 40);
  assert.match(rendered, /row 8[\s\S]*row 10/);
  assert.match(rendered, /8-10\/10/);
  assert.ok(harness.component.render(8).every((line) => visibleWidth(line) <= 8));
});

test("review reuses exact formatting across scroll renders and clears it on invalidation", () => {
  const colorCalls: string[] = [];
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      content: Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n"),
    },
    false,
    24,
    (color) => colorCalls.push(color),
  );
  harness.component.render(40);
  const initialTextCalls = colorCalls.filter((color) => color === "text").length;
  assert.equal(initialTextCalls, 10);

  harness.component.handleInput("j");
  harness.component.render(40);
  assert.equal(colorCalls.filter((color) => color === "text").length, initialTextCalls);

  harness.component.invalidate();
  harness.component.render(40);
  assert.equal(colorCalls.filter((color) => color === "text").length, initialTextCalls * 2);
});

test("review confirmation dispatches raw identity and exits remain Back versus Close", () => {
  const confirm = reviewComponentHarness(reviewScreen);
  confirm.component.handleInput("l");
  assert.deepEqual(confirm.events, [{ kind: "activate", itemId: "raw-apply" }]);

  const readOnly = reviewComponentHarness({ ...reviewScreen, confirm: undefined });
  readOnly.component.handleInput("l");
  assert.deepEqual(readOnly.events, []);
  readOnly.component.handleInput("q");
  assert.deepEqual(readOnly.events, [{ kind: "back" }]);

  const close = reviewComponentHarness(reviewScreen);
  close.component.handleInput("\u0003");
  assert.deepEqual(close.events, [{ kind: "close" }]);
});

test("review renders semantic Markdown, LaTeX, code, controls, and cache invalidation", () => {
  const colorCalls: string[] = [];
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      content:
        "# Formula\n\nInline $x^2 + y^2$.\n\n$$\\frac{a}{b}$$\n\n```ts\nconst answer = 42;\n```\nunsafe\u001b]8;;https://unsafe.example\u0007text\u202ereversed",
      format: { kind: "markdown", renderMermaid: false },
      viewportSize: 30,
      confirm: undefined,
    },
    false,
    40,
    (color) => colorCalls.push(color),
  );

  for (const width of [8, 20, 40, 80]) {
    const lines = harness.component.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
    assert.equal(lines.join("\n").includes("https://unsafe.example"), false);
    assert.equal(lines.join("\n").includes("\u202e"), false);
  }
  const rendered = plainRender(harness.component, 80);
  assert.match(rendered, /^Formula\s*$/mu);
  assert.doesNotMatch(rendered, /^# Formula/mu);
  assert.match(rendered, /Inline x² \+ y²\./u);
  assert.match(rendered, /^a\s*\n─\s*\nb\s*$/mu);
  assert.match(rendered, /const answer = 42;/u);
  assert.match(rendered, /```ts/u);
  assert.match(rendered, /unsafetextreversed/u);

  const initialHeadingCalls = colorCalls.filter((color) => color === "mdHeading").length;
  assert.ok(initialHeadingCalls > 0);
  harness.component.handleInput("j");
  harness.component.render(80);
  assert.equal(colorCalls.filter((color) => color === "mdHeading").length, initialHeadingCalls);
  const beforeInvalidation = colorCalls.filter((color) => color === "mdHeading").length;
  harness.component.invalidate();
  harness.component.render(80);
  assert.ok(colorCalls.filter((color) => color === "mdHeading").length > beforeInvalidation);
});

test("review preserves disabled and malformed rich source", () => {
  const disabled = reviewComponentHarness({
    ...reviewScreen,
    content: "Disabled $x^2$\n\n```mermaid\nflowchart LR\n A --> B\n```",
    format: { kind: "markdown", renderLatex: false, renderMermaid: false },
    confirm: undefined,
    viewportSize: 20,
  });
  const disabledRender = plainRender(disabled.component, 80);
  assert.match(disabledRender, /Disabled \$x\^2\$/u);
  assert.match(disabledRender, /flowchart LR/u);

  const malformed = reviewComponentHarness({
    ...reviewScreen,
    content: "Malformed $\\frac{a}{$",
    format: { kind: "markdown", renderMermaid: false },
    confirm: undefined,
  });
  assert.match(plainRender(malformed.component, 40), /Malformed \$\\frac\{a\}\{\$/u);
});

test("review renders fitting Mermaid art lazily and preserves mixed Markdown", async () => {
  const colors: string[] = [];
  const tui = createTuiHarness({
    width: 120,
    rows: 30,
    theme: {
      fg: (color, text) => {
        colors.push(color);
        return text;
      },
      bold: (text) => text,
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Mermaid review",
        content:
          "Before diagram.\n\n~~~MerMaid\nflowchart LR\n A[plain ` tick] --> B[two `` ticks]\n C[unsafe\u001b]8;;https://unsafe.example\u0007text 你🙂wide]\n~~~\n\nAfter diagram.",
        format: { kind: "markdown" },
        viewportSize: "adaptive",
      }),
    },
    actions: { apply: async () => ({ kind: "close" }) },
  });

  const running = runMenu(context.ctx, menu, { getState: () => undefined });
  await tui.waitForOpen();
  const narrow = stripVTControlCharacters(tui.resize({ width: 18 }).join("\n"));
  assert.match(narrow, /flowchart/u);
  assert.doesNotMatch(narrow, /https:\/\/unsafe\.example/u);
  const wide = stripVTControlCharacters(tui.resize({ width: 120 }).join("\n"));
  assert.match(wide, /Before diagram\./u);
  assert.match(wide, /After diagram\./u);
  assert.match(wide, /plain ` tick/u);
  assert.match(wide, /two `` ticks/u);
  assert.match(wide, /unsafetext/u);
  assert.match(wide, /你🙂wide/u);
  assert.match(wide, /[┌╭].*[┐╮]/u);
  assert.doesNotMatch(wide, /flowchart LR/u);
  assert.ok(colors.includes("borderMuted"));
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("review preserves Mermaid source and warns when a partial parse is not authoritative", async () => {
  const tui = createTuiHarness({ width: 100, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Mermaid fallbacks",
        content: "```mermaid\nflowchart LR\n A[Start --> B\n```\n\n```mermaid\npie\n title Unsupported\n```",
        format: { kind: "markdown" },
        viewportSize: "adaptive",
      }),
    },
    actions: { apply: async () => ({ kind: "close" }) },
  });

  const running = runMenu(context.ctx, menu, { getState: () => undefined });
  await tui.waitForOpen();
  const rendered = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(rendered, /flowchart LR/u);
  assert.match(rendered, /Mermaid diagram not rendered:/u);
  assert.match(rendered, /pie/u);
  tui.press("tui.select.cancel");
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
});

test("review Markdown reflows and clamps scrolling after width changes", () => {
  const harness = reviewComponentHarness({
    ...reviewScreen,
    content: [
      "# Long document",
      "",
      "This paragraph contains enough words to wrap across several narrow terminal rows.",
      "",
      "Inline $x^2$ remains readable after resize.",
    ].join("\n"),
    format: { kind: "markdown", renderMermaid: false },
    viewportSize: 3,
    confirm: undefined,
  });
  const wide = plainLines(harness.component, 80);
  harness.component.handleInput("\u001b[F");
  assert.match(plainRender(harness.component, 80), /x² remains readable/u);
  const narrow = plainLines(harness.component, 18);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 18));
  assert.notDeepEqual(narrow, wide);
  harness.component.handleInput("\u001b[H");
  assert.match(plainRender(harness.component, 18), /Long document/u);
});

test("review formats code and diffs through theme-aware display paths", () => {
  const code = reviewComponentHarness({
    ...reviewScreen,
    content: "const answer = 42;",
    format: { kind: "code", language: "typescript" },
    confirm: undefined,
  });
  assert.match(stripVTControlCharacters(code.component.render(80).join("\n")), /const answer = 42/);

  const diff = reviewComponentHarness(
    {
      ...reviewScreen,
      content: "@@ header\n-old\n+new\n same",
      format: { kind: "diff", filePath: "settings.json" },
      confirm: undefined,
    },
    true,
  );
  const rendered = diff.component.render(80).join("\n");
  assert.match(rendered, /toolDiffRemoved:-old/);
  assert.match(rendered, /toolDiffAdded:\+new/);
  assert.match(rendered, /accent:@@ header/);
});

test("code review uses the injected theme for inferred syntax tokens and safe fallback", () => {
  const inferred = reviewComponentHarness(
    {
      ...reviewScreen,
      content: "const answer: number = 42;",
      format: { kind: "code", filePath: "answer.ts" },
      confirm: undefined,
    },
    true,
  );
  const highlighted = inferred.component.render(200).join("\n");
  assert.match(highlighted, /syntaxKeyword:const/u);
  assert.match(highlighted, /syntaxType:number/u);
  assert.match(highlighted, /syntaxNumber:42/u);

  const explicit = reviewComponentHarness(
    {
      ...reviewScreen,
      content: "++>---",
      format: { kind: "code", language: "brainfuck" },
      confirm: undefined,
    },
    true,
  );
  const explicitlyHighlighted = explicit.component.render(80).join("\n");
  assert.match(explicitlyHighlighted, /\+\+>/u);
  assert.match(explicitlyHighlighted, /syntaxNumber:-/u);

  const unknown = reviewComponentHarness(
    {
      ...reviewScreen,
      content: "plain value",
      format: { kind: "code", language: "not-a-language" },
      confirm: undefined,
    },
    true,
  );
  const fallback = unknown.component.render(80).join("\n");
  assert.match(fallback, /mdCodeBlock:mdCodeBlock:plain value/u);
  assert.doesNotMatch(fallback, /syntax(?:Keyword|Type|Number):/u);
});

test("TUI adaptive review reads live host rows and invokes its raw confirmation action", async () => {
  const invoked: string[] = [];
  const frameHeights: number[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 80, undefined, 7);
      frameHeights.push(harness.render().length);
      harness.setTerminalRows(12);
      frameHeights.push(harness.render().length);
      harness.handleInput("tui.select.confirm");
      return harness.result;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "review",
    screens: {
      review: () => ({
        ...reviewScreen,
        content: Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n"),
        viewportSize: "adaptive",
      }),
    },
    actions: {
      apply: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "close" };
      },
    },
  });
  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["raw-apply"]);
  assert.deepEqual(frameHeights, [4, 9]);
});

test("RPC adaptive review matches default bounded pagination without custom TUI", async () => {
  async function collect(viewportSize: ReviewScreen<ActionId>["viewportSize"]) {
    const titles: string[] = [];
    const context = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        return choices.find((choice) => choice.startsWith("Next")) ?? "Back";
      },
      custom: async () => {
        throw new Error("RPC review must not open custom TUI");
      },
    });
    const menu = defineMenu<undefined, ScreenId, ActionId>({
      start: "review",
      screens: {
        review: () => ({
          ...reviewScreen,
          content: Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n"),
          viewportSize,
          enableSearch: true,
          confirm: undefined,
        }),
      },
      actions: { apply: async () => ({ kind: "close" }) },
    });
    assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
      kind: "closed",
      reason: "back",
    });
    return titles;
  }

  const omitted = await collect(undefined);
  const adaptive = await collect("adaptive");
  assert.deepEqual(adaptive, omitted);
  assert.equal(adaptive.length, 3);
  assert.match(adaptive[0] ?? "", /row 1[\s\S]*row 8/);
  assert.match(adaptive[2] ?? "", /row 17[\s\S]*row 20/);
});

test("RPC review paginates bounded content and preserves colliding confirmation identity", async () => {
  const titles: string[] = [];
  const choicesSeen: string[][] = [];
  let call = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[], options?: { signal?: AbortSignal }) => {
      call += 1;
      titles.push(title);
      choicesSeen.push(choices);
      assert.equal(options?.signal?.aborted, false);
      assert.ok(title.length < 2000);
      if (call === 1) return choices.find((choice) => choice.startsWith("Next"));
      return choices.find((choice) => choice.startsWith("Next") && choice !== "Next");
    },
    custom: async () => {
      throw new Error("RPC review must not open custom TUI");
    },
  });
  const content = Array.from({ length: 30 }, (_, index) => `row ${index + 1}`).join("\n");
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "review",
    screens: {
      review: () => ({
        ...reviewScreen,
        content,
        enableSearch: true,
        confirm: { id: "confirm-next", label: "Next", action: "apply" },
      }),
    },
    actions: {
      apply: async ({ itemId }) => {
        assert.equal(itemId, "confirm-next");
        return { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(call, 2);
  assert.match(titles[0] ?? "", /row 1/);
  assert.doesNotMatch(titles[0] ?? "", /row 30/);
  assert.match(titles[1] ?? "", /row 4/);
  assert.equal(new Set(choicesSeen[1]).size, choicesSeen[1]?.length);
});

test("owner abort dismisses an unanswered adaptive RPC review without invoking confirmation", async () => {
  const owner = new AbortController();
  let reportOpened: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    reportOpened = resolve;
  });
  let invoked = false;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
      reportOpened?.();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return undefined;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "review",
    screens: {
      review: () => ({ ...reviewScreen, viewportSize: "adaptive" }),
    },
    actions: {
      apply: async () => {
        invoked = true;
        return { kind: "close" };
      },
    },
  });
  const running = runMenu(context.ctx, menu, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await opened;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(invoked, false);
});

test("review search is opt-in, focus-aware, navigable, and separately dismissible", () => {
  const colors: string[] = [];
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      content: "first needle\nsecond\nthird needle",
      enableSearch: true,
    },
    false,
    10,
    (color) => colors.push(color),
  );
  const focusable = harness.component as typeof harness.component & Focusable;
  focusable.focused = true;
  harness.component.render(40);
  harness.component.handleInput("s");
  assert.doesNotMatch(plainRender(harness.component, 40), /Find:/u);
  harness.component.handleInput("\u001b[32u");
  harness.component.handleInput("\u001b[20");
  harness.component.handleInput("0~");
  harness.component.handleInput("n");
  harness.component.handleInput("eedle\u001b[201~");
  assert.match(plainRender(harness.component, 40), /Find:/u);
  assert.ok(colors.includes("searchMatchText"));
  harness.component.handleInput("n");
  assert.match(plainRender(harness.component, 40), /third needle/u);
  harness.component.handleInput("x");
  assert.doesNotMatch(plainRender(harness.component, 40), /Find:/u);
  assert.deepEqual(harness.events, []);
  harness.component.handleInput(" ");
  harness.component.handleInput("\u001b[200~");
  harness.component.handleInput("\u0003");
  harness.component.handleInput("\u001b[201~");
  assert.deepEqual(harness.events, []);
  harness.component.handleInput("x");
  harness.component.handleInput("q");
  assert.deepEqual(harness.events, [{ kind: "back" }]);
  harness.component.handleInput(" ");
  harness.component.handleInput("\u001b[200~needle");
  harness.component.handleInput("\u001b[201~\u0003");
  assert.deepEqual(harness.events.at(-1), { kind: "close" });
});

test("review keeps the current search match visible after rewrapping", () => {
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      content: `${"prefix ".repeat(12)}\nneedle`,
      enableSearch: true,
    },
    false,
    8,
  );
  harness.component.render(80);
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.equal(plainLines(harness.component, 80).includes("needle"), true);
  assert.equal(plainLines(harness.component, 12).includes("needle"), true);
  harness.setTerminalRows(6);
  assert.equal(plainLines(harness.component, 12).includes("needle"), true);
});

test("review keeps the current match visible when width only changes chrome layout", () => {
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      title: "Very long review title ".repeat(6),
      content: [
        ...Array.from({ length: 5 }, (_, index) => `row ${index + 1}`),
        "needle",
        ...Array.from({ length: 5 }, (_, index) => `tail ${index + 1}`),
      ].join("\n"),
      enableSearch: true,
    },
    false,
    16,
  );
  harness.component.render(100);
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.equal(plainLines(harness.component, 100).includes("needle"), true);
  assert.equal(plainLines(harness.component, 20).includes("needle"), true);
});

test("review forwards Home and End to the active search input", () => {
  const harness = reviewComponentHarness({ ...reviewScreen, content: "zabcd", enableSearch: true }, false, 8);
  harness.component.render(30);
  harness.component.handleInput(" ");
  harness.component.handleInput("abcd");
  harness.component.handleInput("\u001b[H");
  harness.component.handleInput("z");
  assert.match(plainRender(harness.component, 30), /Find:.*zabcd.*1\/1/u);
  harness.component.handleInput("\u001b[F");
  harness.component.handleInput("y");
  assert.match(plainRender(harness.component, 30), /Find:.*zabcdy.*0\/0/u);
});

test("review preserves manual scrolling while search is active", () => {
  const harness = reviewComponentHarness(
    {
      ...reviewScreen,
      content: ["needle", ...Array.from({ length: 12 }, (_, index) => `row ${index + 1}`)].join("\n"),
      enableSearch: true,
    },
    false,
    8,
  );
  harness.component.render(30);
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.match(plainRender(harness.component, 30), /needle/u);
  harness.component.handleInput("d");
  const scrolled = plainRender(harness.component, 30);
  assert.equal(scrolled.split("\n").includes("needle"), false);
  assert.match(scrolled, /row 1/u);
});

test("review keeps local activation and omits unavailable active-search hints", () => {
  const hiddenSearchKeybindings: ReviewKeybindings = {
    matches: () => false,
    getKeys: () => [],
  };
  const harness = reviewComponentHarness(
    { ...reviewScreen, enableSearch: true },
    false,
    8,
    undefined,
    hiddenSearchKeybindings,
  );
  assert.match(plainRender(harness.component, 100), /space search/u);
  harness.component.handleInput(" ");
  const active = plainRender(harness.component, 40);
  assert.doesNotMatch(active, /close search|\bnext\b/u);
  assert.match(active, /ctrl\+c close/u);
});

test("review gives a configured Space action priority over search", () => {
  const remappedKeybindings: ReviewKeybindings = {
    matches(data, binding) {
      if (binding === "tui.select.confirm") return data === " ";
      if (binding === "tui.altScreen.searchClose") return data === "\u001b";
      return reviewTestKeybindings.matches(data, binding);
    },
    getKeys(binding) {
      if (binding === "tui.select.confirm") return ["space"];
      if (binding === "tui.altScreen.searchClose") return ["escape"];
      return reviewTestKeybindings.getKeys(binding);
    },
  };
  const harness = reviewComponentHarness(
    { ...reviewScreen, enableSearch: true },
    false,
    8,
    undefined,
    remappedKeybindings,
  );
  const inactive = plainRender(harness.component, 80);
  assert.doesNotMatch(inactive, /space search/u);
  harness.component.handleInput(" ");
  assert.deepEqual(harness.events, [{ kind: "activate", itemId: "raw-apply" }]);
  assert.doesNotMatch(plainRender(harness.component, 40), /Find:/u);
});

test("review closes Space-activated search immediately on Escape", () => {
  const escapeKeybindings: ReviewKeybindings = {
    ...reviewTestKeybindings,
    matches(data, binding) {
      if (binding === "tui.altScreen.searchClose") return data === "\u001b";
      return reviewTestKeybindings.matches(data, binding);
    },
    getKeys(binding) {
      if (binding === "tui.altScreen.searchClose") return ["escape"];
      return reviewTestKeybindings.getKeys(binding);
    },
  };
  const harness = reviewComponentHarness(
    { ...reviewScreen, enableSearch: true },
    false,
    8,
    undefined,
    escapeKeybindings,
  );
  assert.match(plainRender(harness.component, 80), /space search/u);
  harness.component.handleInput(" ");
  assert.match(plainRender(harness.component, 40), /Find:/u);
  harness.component.handleInput("\u001b");
  assert.doesNotMatch(plainRender(harness.component, 40), /Find:/u);
  harness.component.handleInput("a");
  assert.doesNotMatch(plainRender(harness.component, 40), /Find:/u);
});

test("review dispatches Escape when it is remapped to next search match", () => {
  const escapeNextKeybindings: ReviewKeybindings = {
    ...reviewTestKeybindings,
    matches(data, binding) {
      if (binding === "tui.altScreen.searchNext") return data === "\u001b";
      return reviewTestKeybindings.matches(data, binding);
    },
    getKeys(binding) {
      if (binding === "tui.altScreen.searchNext") return ["escape"];
      return reviewTestKeybindings.getKeys(binding);
    },
  };
  const harness = reviewComponentHarness(
    { ...reviewScreen, content: "needle\nother\nneedle", enableSearch: true },
    false,
    8,
    undefined,
    escapeNextKeybindings,
  );
  harness.component.handleInput(" ");
  harness.component.handleInput("needle");
  assert.match(plainRender(harness.component, 40), /1\/2/u);
  harness.component.handleInput("\u001b");
  assert.match(plainRender(harness.component, 40), /2\/2/u);
});

test("search-disabled review keeps its prior component and disposal behavior", () => {
  const harness = reviewComponentHarness(reviewScreen);
  assert.equal("focused" in harness.component, false);
  harness.component.render(30);
  harness.component.handleInput(" ");
  assert.doesNotMatch(plainRender(harness.component, 30), /Find:/u);
  harness.component.dispose?.();
  harness.component.handleInput("q");
  assert.deepEqual(harness.events, []);
});

function reviewComponentHarness(
  screen: ReviewScreen<ActionId>,
  themed = false,
  terminalRows = 24,
  onColor?: (color: string) => void,
  keybindings = reviewTestKeybindings,
) {
  const events: Array<{ kind: "back" | "close" } | { kind: "activate"; itemId: string }> = [];
  const terminal = { rows: terminalRows };
  const component = createMenuScreenComponent<ScreenId, ActionId>({
    screen,
    tui: { terminal, requestRender() {} },
    theme: {
      fg: (color: string, text: string) => {
        onColor?.(color);
        return themed ? `${color}:${text}` : text;
      },
      bold: (text: string) => text,
    },
    keybindings,
    onEvent: (event) => events.push(event),
  });
  return {
    component,
    events,
    setTerminalRows(rows: number) {
      terminal.rows = rows;
    },
  };
}

function plainLines(component: { render(width: number): string[] }, width: number) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function plainRender(component: { render(width: number): string[] }, width: number) {
  return plainLines(component, width).join("\n");
}
