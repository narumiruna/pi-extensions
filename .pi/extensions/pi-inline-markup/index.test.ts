import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { type PreviewExcerpt, parseLineRange, readExcerpt, renderFilePreview, resolveLinkPath } from "./filelinks.ts";
import { createHoverPreview } from "./hover-preview.ts";
import { createFileIndex } from "./wikilink-index.ts";
import { createWikilinks, renderWikiPreview } from "./wikilinks.ts";

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
    stop: () => shutdown({ type: "session_shutdown", reason: "quit" }, ctx),
  };
}

test("only rewrites wikilinks in user and assistant prose", async ({ onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const source = "See [[README.md]].";
  expect(session.render(source, "user")).not.toBe(source);
  expect(session.render(source, "assistant")).not.toBe(source);
  expect(session.render(source, "assistant-thinking")).toBe(source);
  for (const literal of ["`[[README.md]]`", "```md\n[[README.md]]\n```", "[See [[README.md]]](https://example.com)"]) {
    expect(session.render(literal)).toBe(literal);
  }
});

test.for(["herdr", undefined])("renders rounded chips with TERM_PROGRAM=%s", async (terminal, { onTestFinished }) => {
  const previous = process.env.TERM_PROGRAM;
  vi.stubEnv("TERM_PROGRAM", terminal);
  onTestFinished(() => {
    vi.stubEnv("TERM_PROGRAM", previous);
  });
  const session = await startSession();
  onTestFinished(session.stop);
  const [line] = new Markdown(session.render("[[README.md|Wiki]]"), 0, 0, getMarkdownTheme()).render(80);
  expect(stripTerminalSequences(line).trimEnd()).toBe("\uE0B6\u00a0Wiki\u00a0\uE0B4");
});

test("renders both link syntaxes in the same message and releases the shared input listener", async ({
  onTestFinished,
}) => {
  const listeners = process.stdin.listenerCount("data");
  const session = await startSession();
  onTestFinished(session.stop);
  expect(process.stdin.listenerCount("data")).toBe(listeners + 1);

  const source = "[Manifest](./package.json)[[README.md|Wiki]]";
  const output = session.render(source, "assistant");
  const lines = new Markdown(output, 0, 0, getMarkdownTheme()).render(80);
  const visible = stripTerminalSequences(lines.join("\n")).replaceAll("\u2060", "").trimEnd();
  expect(visible).toBe("📄\u00a0Manifest\uE0B6\u00a0Wiki\u00a0\uE0B4");
  expect(output).toContain("./package.json");
  expect(session.render(`\`${source}\``)).toBe(`\`${source}\``);
  expect(session.render("[[README.md|Wiki]][Manifest](./package.json)")).toContain("📄");
  expect(session.render(source, "assistant-thinking")).toBe(source);

  await session.stop();
  expect(process.stdin.listenerCount("data")).toBe(listeners);
  expect(session.render(source)).toBe(source);
});

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
  ["[[README.md|Note]]`after`", ["\uE0B6\u00a0Note\u00a0\uE0B4", "after"]],
  ["`before`[[README.md|Note]]", ["before", "\uE0B6\u00a0Note\u00a0\uE0B4"]],
  ["`before`[[README.md|Note`v2]]``after``", ["before", "\uE0B6\u00a0Note`v2\u00a0\uE0B4", "after"]],
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

test("repaints after the first snapshot and clears the widget and timer on shutdown", async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = await startSession();
  onTestFinished(session.stop);
  const frame = Promise.withResolvers<void>();
  session.requestRender.mockImplementation(() => frame.resolve());
  expect(session.invalidate).toHaveBeenCalledOnce();
  expect(session.render("[[README]]")).not.toContain("file://");
  await frame.promise;
  expect(session.invalidate).toHaveBeenCalledTimes(2);
  const href = new URL("../../../README.md", import.meta.url).href;
  for (const source of ["[[README]]", "[[README.md]]"]) {
    const [line] = new Markdown(session.render(source), 0, 0, getMarkdownTheme()).render(80);
    const chip = stripTerminalSequences(line).trimEnd();
    expect(chip).toBe("\uE0B6\u00a0README\u00a0\uE0B4");
    expect(getOsc8LinkAtColumn(line, 0)).toBe(href);
    expect(getOsc8LinkAtColumn(line, visibleWidth(chip) - 1)).toBe(href);
  }
  expect(vi.getTimerCount()).toBe(1);
  await session.stop();
  expect(session.setWidget).toHaveBeenLastCalledWith("pi-inline-markup.preview", undefined);
  expect(vi.getTimerCount()).toBe(0);
  expect(session.render("[[README.md]]")).toBe("[[README.md]]");
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

test("does not show a note whose front matter extends past the read limit", async () => {
  const path = join(fixtureRoot, "long-front-matter.md");
  await writeFile(path, `---\nkey: ${"a".repeat(16 * 1024)}\n---\n# Visible body\n`);
  const excerpt = await readExcerpt(fixtureRoot, path, new AbortController().signal);
  expect(excerpt?.clipped).toBe(true);
  if (!excerpt) throw new Error("Expected a clipped excerpt");
  expect(
    renderWikiPreview({ path, color: "accent" }, excerpt, {} as ExtensionUIContext["theme"], 50, 12),
  ).toBeUndefined();
});

function stubRawInput(): () => void {
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
  return () => {
    if (raw) Object.defineProperty(process.stdin, "isRaw", raw);
    else Reflect.deleteProperty(process.stdin, "isRaw");
  };
}

test.for(["leave", "dispose", "show and leave"] as const)(
  "handles hover preview action: %s",
  async (action, { onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(stubRawInput());
    const terminal = new ProcessTerminal();
    vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
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

    if (action === "dispose") await session.stop();
    else process.stdin.emit("data", "\x1b[<35;80;1M");
    expect(signal.aborted).toBe(true);
    pending.resolve({ filename: "local.txt", text: "Preview text", clipped: false });
    await pending.promise;
    expect(show).toHaveBeenCalledTimes(action === "show and leave" ? 1 : 0);
    expect(hide).toHaveBeenCalledTimes(action === "show and leave" ? 1 : 0);
  },
);

test("hovers a line-range link with an inline code label", async ({ onTestFinished }) => {
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
  const link = "[`readExcerpt()`](./example.ts#L2-L3)";
  expect(session.render("[**bold**](./example.ts#L2-L3)")).toBe("[**bold**](./example.ts#L2-L3)");
  const screen = new Markdown(session.render(link), 0, 0, getMarkdownTheme()).render(80);
  expect(stripTerminalSequences(screen[0]).trimEnd()).toBe("📄\u00a0readExcerpt()");
  expect(getOsc8LinkAtColumn(screen[0], 0)).toBe("./example.ts#L2-L3");
  vi.spyOn(tui, "getScreenLines").mockReturnValue(screen);

  process.stdin.emit("data", "\x1b[<35;6;1M");
  await vi.advanceTimersByTimeAsync(250);
  await displayed.promise;
  const [[overlay]] = show.mock.calls;
  const card = overlay.render(60).map(stripTerminalSequences).join("\n");
  expect(card).toContain("example.ts#L2-L3");
  expect(card).toContain("second");
  expect(card).toContain("third");
  expect(card).not.toMatch(/first|fourth/);
});

async function setupWikiHover(columns: number, rows: number, paths: string[]) {
  const root = await mkdtemp(join(fixtureRoot, "wiki-hover-"));
  for (const path of paths) {
    const directory = path.split("/").slice(0, -1).join("/");
    if (directory) await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, path),
      `---\nsecret: hidden\n---\n# ${directory || "Root"} overview\n\nSee [docs](https://example.com).\n\nMore text.\n`,
    );
  }

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const restoreRaw = stubRawInput();
  const terminal = new ProcessTerminal();
  vi.spyOn(terminal, "columns", "get").mockReturnValue(columns);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(rows);
  const tui = new TuiAltScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const displayed = Promise.withResolvers<void>();
  const hide = vi.fn();
  const show = vi.spyOn(tui, "showOverlay").mockImplementation(() => {
    displayed.resolve();
    return { hide } as unknown as OverlayHandle;
  });
  const ready = Promise.withResolvers<void>();
  const wiki = createWikilinks(root, () => ready.resolve());
  const preview = createHoverPreview(tui, previewTheme, root, root, wiki.findPreview);
  const screen = vi.spyOn(tui, "getScreenLines");
  function render(markdown: string): string[] {
    return new Markdown(wiki.render(markdown, previewTheme, true), 0, 0, getMarkdownTheme()).render(columns);
  }
  return {
    root,
    show,
    hide,
    screen,
    render,
    ready: ready.promise,
    displayed: displayed.promise,
    dispose() {
      preview.dispose();
      wiki.dispose();
      restoreRaw();
    },
  };
}

const readmePaths = ["Z/README.md", "C/README.md", "B/README.md", "A/README.md"];

test.for([
  { columns: 80, rows: 24, primary: true, visible: ["README.md", "A/README.md", "B/README.md"] },
  { columns: 80, rows: 24, primary: false, visible: ["A/README.md", "B/README.md", "C/README.md"] },
  { columns: 24, rows: 8, primary: true, visible: ["README.md"] },
  { columns: 24, rows: 5, primary: true, visible: [] },
])(
  "bounds the stacked preview and preserves click behavior: %j",
  async ({ columns, rows, primary, visible }, { onTestFinished }) => {
    const paths = primary ? [...readmePaths, "README.md"] : readmePaths;
    const hover = await setupWikiHover(columns, rows, paths);
    onTestFinished(hover.dispose);
    hover.render("[[README]]");
    await hover.ready;
    const screen = hover.render("[[README]]");
    const clickHref = primary ? new URL("README.md", `file://${hover.root}/`).href : undefined;
    expect(getOsc8LinkAtColumn(screen[0], 0)).toBe(clickHref);
    expect(getOsc8LinkAtColumn(hover.render("[[README.md|Guide]]")[0], 0)).toBe(clickHref);
    hover.screen.mockReturnValue(screen);

    const read = vi.mocked(readExcerpt).mockClear();
    process.stdin.emit("data", "\x1b[<35;2;1M");
    await vi.advanceTimersByTimeAsync(250);
    await hover.displayed;

    expect(read.mock.calls.map(([, path]) => path)).toEqual(visible.map((path) => join(hover.root, path)));
    expect(hover.show).toHaveBeenCalledOnce();
    const [[overlay, options]] = hover.show.mock.calls;
    expect(options?.nonCapturing).toBe(true);
    const lines = overlay.render(columns);
    expect(lines.length).toBeLessThanOrEqual(Math.min(rows - 1, 12));
    expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    expect(lines.every((line) => !line.includes("\x1b]8;") && !line.includes("hidden"))).toBe(true);
    const plain = lines.map(stripTerminalSequences).join("\n");
    let offset = 0;
    for (const path of visible) {
      const caption = path.includes("/") ? path : `./${path}`;
      const index = plain.indexOf(caption, offset);
      expect(index).toBeGreaterThanOrEqual(offset);
      const text = `${path.split("/").length === 1 ? "Root" : path.split("/")[0]} overview`;
      expect(plain.slice(index).split("\n")[1]).toContain(text);
      offset = index + caption.length;
    }
    const remaining = paths.length - visible.length;
    expect(plain).toContain(visible.length ? `… ${remaining} more file` : `${remaining} matching files`);
    overlay.invalidate();
    expect(overlay.render(columns)).toEqual(lines);
    process.stdin.emit("data", `\x1b[<35;${columns};1M`);
    expect(hover.hide).toHaveBeenCalledOnce();
  },
);

test("switching to an explicit link for the same file aborts every grouped read", async ({ onTestFinished }) => {
  const hover = await setupWikiHover(80, 24, [...readmePaths, "README.md"]);
  onTestFinished(hover.dispose);
  hover.render("[[README.md]]");
  await hover.ready;
  hover.screen.mockReturnValue(hover.render("[[README.md]]"));
  const pending = Promise.withResolvers<PreviewExcerpt>();
  onTestFinished(() => pending.resolve({ filename: "README.md", text: "Grouped excerpt", clipped: false }));
  const read = vi.mocked(readExcerpt).mockClear();
  for (let i = 0; i < 3; i++) read.mockReturnValueOnce(pending.promise);

  process.stdin.emit("data", "\x1b[<35;1;1M");
  await vi.advanceTimersByTimeAsync(250);
  expect(read).toHaveBeenCalledTimes(3);
  const signals = read.mock.calls.map(([, , signal]) => signal);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);

  hover.screen.mockReturnValue(hover.render("[[./README.md]]"));
  process.stdin.emit("data", "\x1b[<35;1;1M");
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  pending.resolve({ filename: "README.md", text: "Grouped excerpt", clipped: false });
  await pending.promise;
  expect(hover.show).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(250);
  await hover.displayed;
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls[3][1]).toBe(join(hover.root, "README.md"));
  const [[overlay]] = hover.show.mock.calls;
  const lines = overlay.render(80).join("\n");
  expect(lines).toContain("Root overview");
  expect(lines).not.toContain("A/README.md");
  expect(lines).not.toContain("Grouped excerpt");
});

test("refreshes cached paths after a file is created, renamed, or deleted", async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = join(fixtureRoot, "notes");
  await mkdir(root);
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "existing.md"), "");
  let change = Promise.withResolvers<void>();
  const index = createFileIndex(root, () => change.resolve());
  onTestFinished(() => index.dispose());

  expect(index.find("existing")).toBeUndefined();
  await change.promise;
  expect(index.find("existing")).toEqual({ path: "existing.md" });

  async function refresh() {
    change = Promise.withResolvers<void>();
    await vi.advanceTimersToNextTimerAsync();
    await change.promise;
  }

  await writeFile(join(root, "folder", "new.md"), "");
  await refresh();
  expect(index.find("new")).toEqual({ path: "folder/new.md" });
  expect(index.find("./folder/new")).toEqual({ path: "folder/new.md" });
  expect(index.find("./new")).toBeUndefined();

  await writeFile(join(root, "new.md"), "");
  await refresh();
  expect(index.find("new")).toEqual({ path: "new.md", sources: ["new.md", "folder/new.md"] });
  expect(index.find("./new")).toEqual({ path: "new.md" });

  await rm(join(root, "new.md"));
  await rename(join(root, "folder", "new.md"), join(root, "folder", "renamed.md"));
  await refresh();
  expect(index.find("new")).toBeUndefined();
  expect(index.find("renamed")).toEqual({ path: "folder/renamed.md" });

  await rm(join(root, "folder", "renamed.md"));
  await refresh();
  expect(index.find("renamed")).toBeUndefined();
});

test("does not publish or reschedule a scan disposed while it was pending", async () => {
  const onChange = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = Promise.withResolvers<never[]>();
  vi.mocked(readdir).mockReturnValueOnce(pending.promise);
  const index = createFileIndex(fixtureRoot, onChange);
  index.find("note");
  index.dispose();
  index.dispose();
  pending.resolve([]);
  await pending.promise;
  await Promise.resolve();
  expect(index.find("note")).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
