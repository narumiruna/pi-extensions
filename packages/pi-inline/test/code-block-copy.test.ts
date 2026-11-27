import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  getOsc8LinkAtColumn,
  Markdown,
  ScrollView,
  stripTerminalSequences,
  type Terminal,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createCodeBlockCopy, supportsCodeBlockCopy } from "../src/code-block-copy.js";
import type { CodeBlockCopyMode } from "../src/settings.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: The renderer uses OSC 8 and SGR.
const meta = /\x1b\]8;id=pi-inline-code-(?:end;\x07|[a-f0-9]{64}-\d+-[cbr]-\d+-\d+;\x07\x1b\[39m)/g;
const removeMeta = (text: string) => text.replace(meta, "");
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
} as unknown as Theme;
const alt = {
  mode: "fullscreen",
  getScreenLines: () => [],
  hasActiveSelection: () => false,
  viewportTop: 0,
  invalidate() {},
  requestRender() {},
} as unknown as TuiAltScreen;
const context = (availableWidth: number) => ({ messageType: "assistant" as const, isStreaming: false, availableWidth });

beforeAll(() => initTheme("dark", false));
afterEach(() => vi.useRealTimers());

const body = [
  "const example = '12345 很長的文字 67890';",
  "\t// <!-- literal comment -->",
  "",
  "console.log(example);  ",
].join("\n");
const code = `\`\`\`js\n${body}\n\`\`\``;

test.each([12, 23, 80])("renders the same styled rows and cell widths at width %i", (width) => {
  const markdownTheme = getMarkdownTheme();
  const probe = createCodeBlockCopy(alt, theme, undefined, vi.fn(), vi.fn(), true);
  probe.setMode("click");
  const source = `Before\n${code}\nAfter\n\n~~~txt\nmore\n~~~`;
  const original = new Markdown(source, 1, 0, markdownTheme).render(width);
  const rows = new Markdown(source, 1, 0, markdownTheme, undefined, {
    transform: (text, availableWidth) => probe.transform(text, context(availableWidth)),
  }).render(width);
  expect(rows.some((line) => line.includes("pi-inline-code-"))).toBe(true);
  expect(rows.map(removeMeta)).toEqual(original);
  expect(rows.map(visibleWidth)).toEqual(original.map(visibleWidth));

  expect(
    rows.every((line) =>
      Array.from({ length: width }, (_, x) => getOsc8LinkAtColumn(line, x)).every((url) => url === undefined),
    ),
  ).toBe(true);
});

test.each([
  "```txt\nunclosed",
  "`inline code`",
  "> ```\n> quoted\n> ```",
  "```\n```",
  `$$\n${code}\n$$`,
  "```js\nx\n```\u00a0",
  "```js\nx\n```\t\nUnrelated prose\n```",
])("does not tag unsupported code: %j", (source) => {
  const probe = createCodeBlockCopy(alt, theme, undefined, vi.fn(), vi.fn(), true);
  probe.setMode("click");
  expect(probe.transform(source, context(80))).toBe(source);
});

test("does not decorate while off, streaming, unavailable, or outside supported message types", () => {
  const supported = createCodeBlockCopy(alt, theme, undefined, vi.fn(), vi.fn(), true);
  expect(supported.transform(code, context(80))).toBe(code);
  supported.setMode("click");
  expect(supported.transform(code, { ...context(80), isStreaming: true })).toBe(code);
  expect(supported.transform(code, { ...context(80), messageType: "assistant-thinking" })).toBe(code);
  expect(supportsCodeBlockCopy("1.6.2")).toBe(false);
  const unavailable = createCodeBlockCopy(alt, theme, undefined, vi.fn(), vi.fn(), false);
  unavailable.setMode("button");
  expect(unavailable.transform(code, context(80))).toBe(code);
});

function fullscreen(onTestFinished: (cleanup: () => void) => void, mode: CodeBlockCopyMode = "click") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const longBody = [
    ...Array.from({ length: 24 }, (_, index) => `const row${index} = "long-line-${index}-visible-target";`),
    "\t// trailing blanks  ",
  ].join("\n");
  const source = `Before\n\n\`\`\`js\n${longBody}\n\`\`\`\n\nAfter`;
  let onInput: ((data: string) => void) | undefined;
  let columns = 28;
  const noop = () => {};
  const terminal: Terminal = {
    rows: 10,
    get columns() {
      return columns;
    },
    kittyProtocolActive: false,
    start(input) {
      onInput = input;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const nativeCopy = vi.fn(async (_text: string): Promise<true> => true);
  const openUrl = vi.fn();
  const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: nativeCopy, openUrl });
  const markdownTheme = getMarkdownTheme();
  const copyCode = vi.fn(async (_text: string): Promise<void> => {});
  const notify = vi.fn();
  const gestures = createCodeBlockCopy(tui, theme, undefined, copyCode, notify, true);
  gestures.setMode(mode);
  const markdown = new Markdown(source, 1, 0, markdownTheme, undefined, {
    transform: (text, availableWidth) => gestures.transform(text, context(availableWidth)),
  });
  tui.setLayoutRoot(new ScrollView(markdown, { primary: true }));
  tui.start();
  onTestFinished(() => {
    gestures.dispose();
    tui.stop();
  });
  function scroll(lines: number) {
    tui.scrollBy(lines);
    tui.renderNow(true);
  }
  tui.renderNow(true);
  scroll(18);
  function mouse(button: number, x: number, y: number, release = false) {
    const input = `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
    onInput?.(input);
    gestures.observe(input);
  }
  function click(x: number, y: number) {
    mouse(0, x, y);
    mouse(0, x, y, true);
  }
  return {
    tui,
    nativeCopy,
    copyCode,
    notify,
    openUrl,
    longBody,
    gestures,
    mouse,
    click,
    scroll,
    resize(width: number) {
      columns = width;
      tui.invalidate();
      tui.renderNow(true);
    },
    point(match = "visible") {
      for (const [y, line] of tui.getScreenLines().entries()) {
        const start = stripTerminalSequences(line).indexOf(match);
        if (start >= 0 && line.includes("pi-inline-code-")) return { x: start, y };
      }
      throw new Error("No wrapped target in the visible viewport");
    },
  };
}

test("copies the unwrapped source from the middle of a scrolled block without opening a URL", async ({
  onTestFinished,
}) => {
  const fixture = fullscreen(onTestFinished);
  expect(fixture.tui.getScreenLines().map(stripTerminalSequences).join("\n")).not.toContain("```");
  const { x, y } = fixture.point();
  fixture.click(x, y);
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.copyCode).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.copyCode.mock.calls).toEqual([[fixture.longBody]]);
  expect(fixture.nativeCopy).not.toHaveBeenCalled();
  expect(fixture.openUrl).not.toHaveBeenCalled();
});

test("copies only from the explicit button, without waiting for the double-click window", async ({
  onTestFinished,
}) => {
  const fixture = fullscreen(onTestFinished, "button");
  const bodyPoint = fixture.point();
  fixture.click(bodyPoint.x, bodyPoint.y);
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).not.toHaveBeenCalled();
  fixture.scroll(200);
  const button = fixture.point("[Copy]");
  fixture.click(button.x, button.y);
  await Promise.resolve();
  expect(fixture.copyCode.mock.calls).toEqual([[fixture.longBody]]);
  await Promise.resolve();
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(true);
});

test("normalizes user message foreground without losing the copy target or custom indentation", () => {
  const user = {
    fg: (role: string, text: string) => (role === "userMessageText" ? `\x1b[35m${text}\x1b[39m` : text),
    bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  } as unknown as Theme;
  const probe = createCodeBlockCopy(alt, user, "    ", vi.fn(), vi.fn(), true);
  probe.setMode("click");
  const source = `Before\n${code}\nAfter`;
  const result = probe.transform(source, { ...context(60), messageType: "user" });
  expect(result).toContain("pi-inline-code-");
});

test.for([2, 3])("preserves Pi's native selection after %i clicks", async (clicks, { onTestFinished }) => {
  const fixture = fullscreen(onTestFinished);
  const { x, y } = fixture.point();
  for (let index = 0; index < clicks; index++) {
    fixture.click(x, y);
    await vi.advanceTimersByTimeAsync(30);
  }
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).not.toHaveBeenCalled();
  const last = fixture.nativeCopy.mock.lastCall?.[0];
  expect(last).toContain("visible");
  expect(last).not.toBe(fixture.longBody);
  expect(last).not.toContain("pi-inline-probe");
});

test("suppresses concurrent copies and ignores an old result after the mode changes", async ({ onTestFinished }) => {
  const fixture = fullscreen(onTestFinished);
  const publication = Promise.withResolvers<void>();
  fixture.copyCode.mockReturnValueOnce(publication.promise);
  const { x, y } = fixture.point();
  fixture.click(x, y);
  await vi.advanceTimersByTimeAsync(501);
  fixture.click(x, y);
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).toHaveBeenCalledOnce();
  fixture.gestures.setMode("off");
  publication.resolve();
  await Promise.resolve();
  expect(fixture.notify).not.toHaveBeenCalled();
});

test("reports a clipboard failure without retrying", async ({ onTestFinished }) => {
  const fixture = fullscreen(onTestFinished);
  fixture.copyCode.mockRejectedValueOnce(new Error("host detail"));
  const { x, y } = fixture.point();
  fixture.click(x, y);
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).toHaveBeenCalledOnce();
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(false);
});

test("a drag copies only Pi's native selection", async ({ onTestFinished }) => {
  const fixture = fullscreen(onTestFinished);
  const { x, y } = fixture.point();
  fixture.mouse(0, x, y);
  fixture.mouse(32, x + 4, y);
  fixture.mouse(0, x + 4, y, true);
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).not.toHaveBeenCalled();
  expect(fixture.nativeCopy.mock.calls).toEqual([["visib"]]);
});

test.for(["scroll", "resize", "dispose", "overlay"] as const)(
  "cancels a pending click on %s",
  async (event, { onTestFinished }) => {
    const fixture = fullscreen(onTestFinished);
    const { x, y } = fixture.point();
    fixture.click(x, y);
    if (event === "scroll") fixture.scroll(2);
    if (event === "resize") fixture.resize(33);
    if (event === "dispose") fixture.gestures.dispose();
    if (event === "overlay") fixture.tui.showOverlay({ render: () => ["Overlay"], invalidate() {} });
    await vi.advanceTimersByTimeAsync(501);
    expect(fixture.copyCode).not.toHaveBeenCalled();
  },
);
