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
import type { CodeBlockCopyButtonPosition, CodeBlockCopyMode } from "../src/settings.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: The renderer uses OSC 8 and SGR.
const meta = /\x1b\]8;id=pi-inline-code-(?:end;\x07|[a-f0-9]{64}-\d+-[cbr]-\d+-\d+;\x07\x1b\[39m)/g;
const removeMeta = (text: string) => text.replace(meta, "");
const buttonBackground = "\x1b[44m";
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (role: string, text: string) => (role === "selectedBg" ? `${buttonBackground}${text}\x1b[49m` : text),
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

test.each([
  { position: "left", width: 40, label: " Copy code ", start: 0 },
  { position: "left", width: 11, label: " Copy code ", start: 0 },
  { position: "left", width: 10, label: " Copy ", start: 0 },
  { position: "left", width: 6, label: " Copy ", start: 0 },
  { position: "left", width: 5, label: undefined, start: undefined },
  { position: "right", width: 40, label: " Copy code ", start: 28 },
  { position: "right", width: 12, label: " Copy code ", start: 0 },
  { position: "right", width: 11, label: " Copy ", start: 4 },
  { position: "right", width: 6, label: " Copy ", start: 0 },
  { position: "right", width: 5, label: undefined, start: undefined },
] as const)("aligns the solid button $position at $width columns", ({ position, width, label, start }) => {
  const copy = createCodeBlockCopy(alt, theme, undefined, vi.fn(), vi.fn(), true);
  copy.setButtonPosition(position);
  copy.setMode("button");
  const rows = new Markdown(code, 0, 0, getMarkdownTheme(), undefined, {
    transform: (source, availableWidth) => copy.transform(source, context(availableWidth)),
  }).render(width);
  expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
  const row = rows.find((line) => line.includes(buttonBackground));
  if (label === undefined) {
    expect(row).toBeUndefined();
    return;
  }
  expect(row).toContain(`${buttonBackground}${label}\x1b[49m`);
  expect(visibleWidth(row?.split(buttonBackground)[0] ?? "")).toBe(start);
});

function fullscreen(
  onTestFinished: (cleanup: () => void) => void,
  mode: CodeBlockCopyMode = "click",
  position: CodeBlockCopyButtonPosition = "left",
) {
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
  gestures.setButtonPosition(position);
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
  expect(fixture.notify).not.toHaveBeenCalled();
  fixture.tui.renderNow(true);
  expect(stripTerminalSequences(fixture.tui.getScreenLines()[0]).trimEnd()).toMatch(/Copied!$/u);
});

test.for([0, 1])(
  "copies after a released click followed by pointer motion (%i cells)",
  async (offset, { onTestFinished }) => {
    const fixture = fullscreen(onTestFinished);
    const { x, y } = fixture.point();
    fixture.click(x, y);
    await vi.advanceTimersByTimeAsync(10);
    fixture.mouse(35, x + offset, y);
    await vi.advanceTimersByTimeAsync(490);
    expect(fixture.copyCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.copyCode.mock.calls).toEqual([[fixture.longBody]]);
    expect(fixture.nativeCopy).not.toHaveBeenCalled();
  },
);

test.for([
  ["left", -1],
  ["left", "Copy code".length],
  ["right", -1],
  ["right", "Copy code".length],
] as const)(
  "copies immediately from painted button padding (%s, offset %i)",
  async ([position, offset], { onTestFinished }) => {
    const fixture = fullscreen(onTestFinished, "button", position);
    const bodyPoint = fixture.point();
    fixture.click(bodyPoint.x, bodyPoint.y);
    await vi.advanceTimersByTimeAsync(501);
    expect(fixture.copyCode).not.toHaveBeenCalled();
    fixture.scroll(200);
    const button = fixture.point("Copy code");
    fixture.click(button.x - 2, button.y);
    await Promise.resolve();
    expect(fixture.copyCode).not.toHaveBeenCalled();
    fixture.click(button.x + offset, button.y);
    await Promise.resolve();
    expect(fixture.copyCode.mock.calls).toEqual([[fixture.longBody]]);
    await Promise.resolve();
    expect(fixture.notify).not.toHaveBeenCalled();
    fixture.tui.renderNow(true);
    expect(stripTerminalSequences(fixture.tui.getScreenLines()[0]).trimEnd()).toMatch(/Copied!$/u);
  },
);

test.each(["click", "button"] as const)(
  "preserves the copy target and custom indentation in a user message (%s)",
  (mode) => {
    const user = {
      fg: (role: string, text: string) => (role === "userMessageText" ? `\x1b[35m${text}\x1b[39m` : text),
      bg: (role: string, text: string) => `${role === "selectedBg" ? buttonBackground : "\x1b[46m"}${text}\x1b[49m`,
    } as unknown as Theme;
    const probe = createCodeBlockCopy(alt, user, "    ", vi.fn(), vi.fn(), true);
    probe.setMode(mode);
    const source = `Before\n${code}\nAfter`;
    const result = probe.transform(source, { ...context(60), messageType: "user" });
    expect(result).toContain("pi-inline-code-");
    if (mode === "button") expect(result).toContain(`${buttonBackground} Copy code \x1b[49m`);
  },
);

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
  fixture.tui.renderNow(true);
  expect(fixture.tui.getScreenLines().map(stripTerminalSequences).join("\n")).not.toContain("Copied!");
});

test("reports a clipboard failure without retrying", async ({ onTestFinished }) => {
  const fixture = fullscreen(onTestFinished);
  fixture.copyCode.mockRejectedValueOnce(new Error("host detail"));
  const { x, y } = fixture.point();
  fixture.click(x, y);
  await vi.advanceTimersByTimeAsync(501);
  expect(fixture.copyCode).toHaveBeenCalledOnce();
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(false);
  fixture.tui.renderNow(true);
  expect(fixture.tui.getScreenLines().map(stripTerminalSequences).join("\n")).not.toContain("Copied!");
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

test.for(["scroll", "wheel", "resize", "dispose", "overlay"] as const)(
  "cancels a pending click on %s",
  async (event, { onTestFinished }) => {
    const fixture = fullscreen(onTestFinished);
    const { x, y } = fixture.point();
    fixture.click(x, y);
    if (event === "scroll") fixture.scroll(2);
    if (event === "wheel") fixture.mouse(65, x, y);
    if (event === "resize") fixture.resize(33);
    if (event === "dispose") fixture.gestures.dispose();
    if (event === "overlay") fixture.tui.showOverlay({ render: () => ["Overlay"], invalidate() {} });
    await vi.advanceTimersByTimeAsync(501);
    expect(fixture.copyCode).not.toHaveBeenCalled();
  },
);
