import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type ExtensionUIContext,
  getMarkdownTheme,
  initTheme,
  type MarkdownTransformContext,
  type MarkdownTransformer,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getOsc8LinkAtColumn,
  Markdown,
  Marked,
  type OverlayHandle,
  ProcessTerminal,
  rgbColor,
  setCapabilityOverrides,
  stripTerminalSequences,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { parseLineRange, readExcerpt, renderFilePreview, resolveLinkPath } from "./filelinks.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("./filelinks.ts", { spy: true });

let fixtureRoot: string;
let extension: typeof import("./index.ts").default;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-inline-markup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", fixtureRoot);
  ({ default: extension } = await import("./index.ts"));
  initTheme("dark");
  setCapabilityOverrides({ hyperlinks: true });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  setCapabilityOverrides({});
  vi.unstubAllEnvs();
  await rm(fixtureRoot, { recursive: true, force: true });
});

const previewTheme = {
  colors: new Proxy({}, { get: () => rgbColor(88, 60, 137) }),
  getBgAnsi: () => "",
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  style: (text: string) => text,
} as unknown as ExtensionUIContext["theme"];

async function startSession(tui: TUI = new TuiMainScreen(new ProcessTerminal())) {
  const on = vi.fn<(event: string, handler: unknown) => void>();
  const registerMarkdownTransformer = vi.fn<(transform: MarkdownTransformer) => void>();
  extension({ on, registerMarkdownTransformer } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([event]) => event === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([event]) => event === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const beforeAgentStart = on.mock.calls.find(
    ([event]) => event === "before_agent_start",
  )?.[1] as ExtensionHandler<BeforeAgentStartEvent>;
  const invalidate = vi.spyOn(tui, "invalidate");
  const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let disposeWidget: (() => void) | undefined;
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    disposeWidget?.();
    disposeWidget = typeof content === "function" ? content(tui, previewTheme).dispose : undefined;
  });
  const ctx = { cwd: fixtureRoot, mode: "tui", ui: { setWidget } } as unknown as ExtensionContext;
  await start({ type: "session_start", reason: "startup" }, ctx);
  expect(registerMarkdownTransformer).toHaveBeenCalledOnce();
  expect(setWidget).toHaveBeenCalledOnce();
  const [[transform]] = registerMarkdownTransformer.mock.calls;

  return {
    invalidate,
    requestRender,
    setWidget,
    render(markdown: string, messageType: MarkdownTransformContext["messageType"] = "user") {
      return transform(markdown, { messageType, isStreaming: false, availableWidth: 80 });
    },
    async promptSections(mode: ExtensionContext["mode"] = "tui") {
      const systemPromptOptions = {
        sections: { other: "Keep this section." },
      } as BeforeAgentStartEvent["systemPromptOptions"];
      await beforeAgentStart(
        { type: "before_agent_start", messageType: "user", prompt: "test", systemPrompt: "", systemPromptOptions },
        { ...ctx, mode },
      );
      return systemPromptOptions.sections;
    },
    stop: () => shutdown({ type: "session_shutdown", reason: "quit" }, ctx),
  };
}

test("adds a stable badge hint only while the TUI widget is active", async ({ onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const first = await session.promptSections();
  expect(first).toEqual({
    other: "Keep this section.",
    pi_inline_markup: expect.stringContaining("[[label]] is decorative"),
  });
  expect(first.pi_inline_markup).toContain("[[[label](./path)]]");
  expect(first.pi_inline_markup).toContain("#L12-L20");
  expect(await session.promptSections()).toEqual(first);
  expect(await session.promptSections("rpc")).toEqual({ other: "Keep this section." });
  await session.stop();
  expect(await session.promptSections()).toEqual({ other: "Keep this section." });
});

test.for(["[[README.md]]", "[[[README](./README.md)]]", "[[[README]]](./README.md)"])(
  "only rewrites %s in user and assistant prose",
  async (markup, { onTestFinished }) => {
    const session = await startSession();
    onTestFinished(session.stop);
    const source = `See ${markup}.`;
    expect(session.render(source, "user")).not.toBe(source);
    expect(session.render(source, "assistant")).not.toBe(source);
    expect(session.render(source, "assistant-thinking")).toBe(source);
    for (const literal of [`\`${markup}\``, `\`\`\`md\n${markup}\n\`\`\``, `    ${markup}`]) {
      expect(session.render(literal)).toBe(literal);
    }
  },
);

test.for([
  "[See [[README.md]]](https://example.com)",
  "![See [[README.md]]](./photo.png)",
  "![See [[[README]]](./README.md)](./photo.png)",
  "[[[README](https://example.com)]]",
  "[[[README]]](../README.md)",
  "\\[[README.md]]",
])("leaves unsupported or literal markup unchanged: %s", async (source, { onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  expect(session.render(source)).toBe(source);
});

test.for(["herdr", undefined])("renders rounded chips with TERM_PROGRAM=%s", async (terminal, { onTestFinished }) => {
  const previous = process.env.TERM_PROGRAM;
  vi.stubEnv("TERM_PROGRAM", terminal);
  onTestFinished(() => {
    vi.stubEnv("TERM_PROGRAM", previous);
  });
  const session = await startSession();
  onTestFinished(session.stop);
  const [line] = new Markdown(session.render("[[README.md|Guide]]"), 0, 0, getMarkdownTheme()).render(80);
  expect(stripTerminalSequences(line).trimEnd()).toBe("\uE0B6\u00a0README.md|Guide\u00a0\uE0B4");
  expect(getOsc8LinkAtColumn(line, 0)).toBeUndefined();
});

test("renders badges next to file links and releases the shared input listener", async ({ onTestFinished }) => {
  const listeners = process.stdin.listenerCount("data");
  const session = await startSession();
  onTestFinished(session.stop);
  expect(process.stdin.listenerCount("data")).toBe(listeners + 1);

  const source = "[Manifest](./package.json)[[Guide]][[[README]]](./README.md)";
  const output = session.render(source, "assistant");
  const lines = new Markdown(output, 0, 0, getMarkdownTheme()).render(80);
  const visible = stripTerminalSequences(lines.join("\n")).replaceAll("\u2060", "").trimEnd();
  expect(visible).toBe("📄\u00a0Manifest\uE0B6\u00a0Guide\u00a0\uE0B4\uE0B6\u00a0README\u00a0\uE0B4");
  expect(output).toContain("./package.json");
  expect(session.render(`\`${source}\``)).toBe(`\`${source}\``);
  expect(session.render("[[Guide]][Manifest](./package.json)")).toContain("📄");
  expect(session.render(source, "assistant-thinking")).toBe(source);

  await session.stop();
  expect(process.stdin.listenerCount("data")).toBe(listeners);
  expect(session.render(source)).toBe(source);
});

test.for([
  ['[[[Read me](./note%20one.md "[[title]]")]]', "./note%20one.md"],
  ['[[[Read me]]](./note%20one.md "[[title]]")', "./note%20one.md"],
] as const)(
  "keeps the badge and its destination intact before trailing text: %s",
  async ([link, href], { onTestFinished }) => {
    const session = await startSession();
    onTestFinished(session.stop);
    const [line] = new Markdown(session.render(`${link} tail`), 0, 0, getMarkdownTheme()).render(80);
    expect(stripTerminalSequences(line).trimEnd()).toBe("\uE0B6\u00a0Read\u00a0me\u00a0\uE0B4 tail");
    expect(getOsc8LinkAtColumn(line, 0)).toBe(href);
    expect(getOsc8LinkAtColumn(line, visibleWidth(stripTerminalSequences(line).trimEnd()) - 1)).toBeUndefined();
  },
);

test.for([
  { source: '[Note](./notes.md "see [x](y) and [a](b)") tail', href: "./notes.md" },
  { source: "[Note](<./[draft](1).md>) tail", href: "./[draft](1).md" },
  { source: "[Note](./notes.md) tail", href: "./notes.md" },
])("preserves text and link destinations for $source", async ({ source, href }, { onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const output = session.render(`${source} [Next](./next.md)`);
  const [line] = new Markdown(output, 0, 0, getMarkdownTheme()).render(80);
  expect(stripTerminalSequences(line).trimEnd()).toBe("📄\u00a0Note tail 📄\u00a0Next");
  expect(getOsc8LinkAtColumn(line, 0)).toBe(href);
});

test.for([
  ["[[Note]]`after`", ["\uE0B6\u00a0Note\u00a0\uE0B4", "after"]],
  ["`before`[[[Note](./notes.md)]]", ["before", "\uE0B6\u00a0Note\u00a0\uE0B4"]],
  ["`before`[[[Note`v2]]](./notes.md)``after``", ["before", "\uE0B6\u00a0Note`v2\u00a0\uE0B4", "after"]],
] as const)("keeps inline code separate from the chip in %s", async ([source, expected], { onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const transformed = session.render(source);
  const parser = new Marked();
  const spans: string[] = [];
  parser.walkTokens(parser.lexer(transformed), (token) => {
    if (token.type === "codespan") spans.push(stripTerminalSequences(token.text));
  });
  expect(spans).toEqual(expected);
  const rendered = new Markdown(transformed, 0, 0, getMarkdownTheme()).render(80);
  const visible = stripTerminalSequences(rendered.join("\n")).replaceAll("\u2060", "").replace(/ +$/, "");
  expect(visible).toBe(expected.join(""));
});

test("plain badges do not index, link, or preview an existing file", async ({ onTestFinished }) => {
  await writeFile(join(fixtureRoot, "README.md"), "A real file");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(stubRawInput());
  const terminal = new ProcessTerminal();
  vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
  const tui = new TuiAltScreen(terminal);
  const session = await startSession(tui);
  onTestFinished(session.stop);
  const read = vi.mocked(readExcerpt).mockClear();
  const scan = vi.mocked(readdir).mockClear();
  const show = vi.spyOn(tui, "showOverlay");
  const screen = vi.spyOn(tui, "getScreenLines");
  for (const source of ["[[README]]", "[[README.md]]", "[[./README.md]]"]) {
    const lines = new Markdown(session.render(source), 0, 0, getMarkdownTheme()).render(80);
    expect(getOsc8LinkAtColumn(lines[0], 1)).toBeUndefined();
    screen.mockReturnValue(lines);
    process.stdin.emit("data", "\x1b[<35;2;1M");
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(scan).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await session.stop();
  expect(session.setWidget).toHaveBeenLastCalledWith("pi-inline-markup.preview", undefined);
});

test("only resolves eligible workspace paths", () => {
  expect(resolveLinkPath(fixtureRoot, "./notes/a%20b.md#part")).toBe(join(fixtureRoot, "notes", "a b.md"));
  for (const href of [
    "https://example.test/a.md",
    `file://${join(fixtureRoot, "a.md")}`,
    "//example.test/a.md",
    "../outside.md",
    "./%2e%2e/outside.md",
    "./notes/.hidden.md",
    "./node_modules/pkg/README.md",
  ]) {
    expect(resolveLinkPath(fixtureRoot, href), href).toBeUndefined();
  }
});

test.for([
  ["./notes.md#L12", { start: 12, end: 12 }],
  ["./notes.md#L12-L20", { start: 12, end: 20 }],
  ["./notes.md#L12-20", { start: 12, end: 20 }],
  ["./notes.md#heading", undefined],
  ["./notes.md#heading#L12", undefined],
  ["./notes.md#L0", undefined],
  ["./notes.md#L20-L12", undefined],
  ["./notes.md#L9007199254740992", undefined],
] as const)("parses the source-line selection in %s", ([href, expected]) => {
  expect(parseLineRange(href)).toEqual(expected);
});

test("reads literal source lines using file line endings, not Markdown or terminal wrapping", async () => {
  const path = join(fixtureRoot, "source-lines.md");
  await writeFile(path, "Skipped\r\n# Heading\r\n  **bold**\n\x1b[31mLast\x1b[0m");
  const signal = new AbortController().signal;
  expect(await readExcerpt(fixtureRoot, path, signal, { start: 4, end: 4 })).toMatchObject({
    text: "Last",
    clipped: false,
  });
  expect(await readExcerpt(fixtureRoot, path, signal, { start: 5, end: 5 })).toBeUndefined();
  const excerpt = await readExcerpt(fixtureRoot, path, signal, { start: 2, end: 3 });
  expect(excerpt).toMatchObject({ text: "# Heading\n  **bold**\n", clipped: false });
  if (!excerpt) throw new Error("Expected a source excerpt");
  const lines = renderFilePreview(previewTheme, excerpt, 30, 5);
  expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  expect(lines).toHaveLength(5);
  expect(lines[1]).toContain("source-lines.md#L2-L3");
  expect(lines[2]).toContain("# Heading");
  expect(lines[3]).toContain("│   **bold**");
});

test("scans beyond the first excerpt while bounding the source search and output", async () => {
  const path = join(fixtureRoot, "long-source.txt");
  const wide = "x".repeat(16 * 1024 - 1);
  await writeFile(path, `${wide}\n${wide}界\n${"x".repeat(256 * 1024)}\nOutside the scan\n`);
  const signal = new AbortController().signal;
  const later = await readExcerpt(fixtureRoot, path, signal, { start: 2, end: 2 });
  expect(later).toMatchObject({ text: wide, clipped: true });
  expect(await readExcerpt(fixtureRoot, path, signal, { start: 4, end: 4 })).toBeUndefined();
});

test("does not read directories or symlinks", async () => {
  const project = await mkdtemp(join(fixtureRoot, "project-"));
  const outside = join(fixtureRoot, "outside.md");
  const plain = join(project, "plain.md");
  await writeFile(outside, "Outside the project");
  await writeFile(plain, "Inside the project");
  await symlink(outside, join(project, "outside-link.md"));
  await symlink(plain, join(project, "inside-link.md"));
  await mkdir(join(project, "folder"));
  const { signal } = new AbortController();
  await expect(readExcerpt(project, plain, signal)).resolves.toMatchObject({ text: "Inside the project" });
  for (const path of [outside, ...["outside-link.md", "inside-link.md", "folder"].map((name) => join(project, name))]) {
    await expect(readExcerpt(project, path, signal)).resolves.toBeUndefined();
  }
});

test("stops resolving a preview path after abort", async ({ onTestFinished }) => {
  const pending = Promise.withResolvers<string>();
  const controller = new AbortController();
  const resolvePath = vi.mocked(realpath);
  resolvePath.mockClear();
  resolvePath.mockReturnValueOnce(pending.promise);
  const stat = vi.mocked(lstat);
  stat.mockClear();
  const resolving = readExcerpt(fixtureRoot, join(fixtureRoot, "no-read.md"), controller.signal);
  onTestFinished(() => pending.resolve(fixtureRoot));
  controller.abort();
  pending.resolve(fixtureRoot);
  await expect(resolving).resolves.toBeUndefined();
  expect(resolvePath).toHaveBeenCalledExactlyOnceWith(fixtureRoot);
  expect(stat).not.toHaveBeenCalled();
});

function stubRawInput(): () => void {
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
  return () => {
    if (raw) Object.defineProperty(process.stdin, "isRaw", raw);
    else Reflect.deleteProperty(process.stdin, "isRaw");
  };
}

test.for(["leave", "dispose", "resize", "show and leave"] as const)(
  "handles hover preview action: %s",
  async (action, { onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(stubRawInput());
    const terminal = new ProcessTerminal();
    const columns = vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
    vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
    const tui = new TuiAltScreen(terminal);
    const hide = vi.fn();
    const show = vi.spyOn(tui, "showOverlay").mockReturnValue({ hide } as unknown as OverlayHandle);
    const session = await startSession(tui);
    onTestFinished(session.stop);
    const screen = new Markdown(session.render("[Local](./local.txt)"), 0, 0, getMarkdownTheme()).render(80);
    vi.spyOn(tui, "getScreenLines").mockReturnValue(screen);

    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readExcerpt>>>();
    const read = vi.mocked(readExcerpt);
    read.mockClear();
    read.mockReturnValueOnce(pending.promise);
    onTestFinished(() => pending.resolve(undefined));
    process.stdin.emit("data", "\x1b[<35;1;1M");
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledOnce();
    const signal = read.mock.calls[0][2];
    expect(signal.aborted).toBe(false);

    if (action === "show and leave") {
      pending.resolve({ filename: "local.txt", text: "Preview text", clipped: false });
      await pending.promise;
      expect(show).toHaveBeenCalledOnce();
      const [overlay, options] = show.mock.calls[0];
      expect(options?.nonCapturing).toBe(true);
      expect(overlay.render(60).join("\n")).toContain("Preview text");
    }

    if (action === "resize") columns.mockReturnValue(70);
    else if (action === "dispose") await session.stop();
    else process.stdin.emit("data", "\x1b[<35;80;1M");
    pending.resolve({ filename: "local.txt", text: "Preview text", clipped: false });
    await pending.promise;
    expect(signal.aborted).toBe(true);
    expect(show).toHaveBeenCalledTimes(action === "show and leave" ? 1 : 0);
    expect(hide).toHaveBeenCalledTimes(action === "show and leave" ? 1 : 0);
  },
);

test.for([
  ["[`readExcerpt()`](./example.ts#L2-L3)", "📄\u00a0readExcerpt()"],
  ["[[[`readExcerpt()`](./example.ts#L2-L3)]]", "\uE0B6\u00a0readExcerpt()\u00a0\uE0B4"],
  ["[[[readExcerpt()]]](./example.ts#L2-L3)", "\uE0B6\u00a0readExcerpt()\u00a0\uE0B4"],
] as const)("hovers the line-range link %s", async ([link, label], { onTestFinished }) => {
  await writeFile(join(fixtureRoot, "example.ts"), "first\nsecond\nthird\nfourth\n");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(stubRawInput());
  const terminal = new ProcessTerminal();
  vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
  const tui = new TuiAltScreen(terminal);
  const session = await startSession(tui);
  onTestFinished(session.stop);
  const displayed = Promise.withResolvers<void>();
  const show = vi.spyOn(tui, "showOverlay").mockImplementation(() => {
    displayed.resolve();
    return { hide: vi.fn() } as unknown as OverlayHandle;
  });
  expect(session.render("[**bold**](./example.ts#L2-L3)")).toBe("[**bold**](./example.ts#L2-L3)");
  const screen = new Markdown(session.render(link), 0, 0, getMarkdownTheme()).render(80);
  expect(stripTerminalSequences(screen[0]).trimEnd()).toBe(label);
  for (const col of [0, visibleWidth(label) - 1]) {
    expect(getOsc8LinkAtColumn(screen[0], col)).toBe("./example.ts#L2-L3");
  }
  vi.spyOn(tui, "getScreenLines").mockReturnValue(screen);

  process.stdin.emit("data", "\x1b[<35;6;1M");
  await vi.advanceTimersByTimeAsync(250);
  await displayed.promise;
  const [[overlay]] = show.mock.calls;
  const lines = overlay.render(60);
  expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  overlay.invalidate();
  expect(overlay.render(60)).toEqual(lines);
  const card = lines.map(stripTerminalSequences).join("\n");
  expect(card).toContain("example.ts#L2-L3");
  expect(card).toContain("second");
  expect(card).toContain("third");
  expect(card).not.toMatch(/first|fourth/);
});
