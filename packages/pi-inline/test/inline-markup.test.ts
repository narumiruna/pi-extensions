import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
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
  type Component,
  getCellDimensions,
  getOsc8LinkAtColumn,
  Markdown,
  Marked,
  type OverlayHandle,
  ProcessTerminal,
  rgbColor,
  setCapabilityOverrides,
  setCellDimensions,
  stripTerminalSequences,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { parseLineRange, readExcerpt, renderFilePreview, resolveLinkPath } from "../src/filelinks.js";
import { prepareImagePreview, previewImageMime } from "../src/image-preview.js";
import { showInlineSettings } from "../src/settings-menu.js";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../src/filelinks.js", { spy: true });
vi.mock("../src/settings-menu.js", () => ({ showInlineSettings: vi.fn() }));

let fixtureRoot: string;
let extension: typeof import("../src/index.js").default;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-inline-markup-"));
  for (const directory of [".", "docs", "examples"]) {
    await mkdir(join(fixtureRoot, directory), { recursive: true });
    await writeFile(join(fixtureRoot, directory, "README.md"), "# Preview fixture\n");
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", join(fixtureRoot, ".agent"));
  ({ default: extension } = await import("../src/index.js"));
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
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  extension({ on, registerCommand, registerMarkdownTransformer } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([event]) => event === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([event]) => event === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const beforeAgentStart = on.mock.calls.find(
    ([event]) => event === "before_agent_start",
  )?.[1] as ExtensionHandler<BeforeAgentStartEvent>;
  const invalidate = vi.spyOn(tui, "invalidate");
  const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let widget: (Component & { dispose?(): void }) | undefined;
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    widget?.dispose?.();
    widget = typeof content === "function" ? content(tui, previewTheme) : undefined;
  });
  const settings = vi.mocked(showInlineSettings).mockReset().mockResolvedValue(false);
  const ctx = { cwd: fixtureRoot, mode: "tui", ui: { setWidget } } as unknown as ExtensionCommandContext;
  const startWidget = () => start({ type: "session_start", reason: "startup" }, ctx);
  await startWidget();
  const commands = new Map(registerCommand.mock.calls);
  expect([...commands.keys()]).toEqual(["inline", "inline-markup"]);
  expect(registerMarkdownTransformer).toHaveBeenCalledOnce();
  expect(setWidget).toHaveBeenCalledOnce();
  const [[transform]] = registerMarkdownTransformer.mock.calls;

  return {
    invalidate,
    requestRender,
    settings,
    setWidget,
    startWidget,
    renderWidget: (width: number) => widget?.render(width) ?? [],
    runCommand: (args = "", mode: ExtensionContext["mode"] = "tui", route = "inline") =>
      commands.get(route)?.handler(args, { ...ctx, mode }),
    setWikilinks(enabled: boolean) {
      settings.mockImplementationOnce(async (_ctx, { setWikilinks }) => {
        setWikilinks(enabled);
        return false;
      });
      return commands.get("inline")?.handler("", ctx);
    },
    render(markdown: string, messageType: MarkdownTransformContext["messageType"] = "user") {
      return transform(markdown, { messageType, isStreaming: false, availableWidth: 80 });
    },
    async promptSections(mode: ExtensionContext["mode"] = "tui") {
      const systemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] = {
        cwd: ctx.cwd,
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: { other: "Keep this section." },
        contextFiles: [],
        skills: [],
      };
      await beforeAgentStart(
        { type: "before_agent_start", messageType: "user", prompt: "test", systemPrompt: "", systemPromptOptions },
        { ...ctx, mode },
      );
      return systemPromptOptions.sections;
    },
    stop: () => shutdown({ type: "session_shutdown", reason: "quit" }, ctx),
  };
}

test("adds generic formatting guidance only while the TUI widget is active", async ({ onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const first = await session.promptSections();
  expect(first).toEqual({
    other: "Keep this section.",
    inline_formatting: `Use [[label]] for badges.
Use Markdown links with workspace-relative paths for file citations, for example [file](./path/to/file#L12-L20).`,
  });
  expect(await session.promptSections()).toEqual(first);
  expect(await session.promptSections("rpc")).toEqual({ other: "Keep this section." });
  await session.stop();
  expect(await session.promptSections()).toEqual({ other: "Keep this section." });
});

test("resolves wikilinks in the session workspace and leaves the prompt unchanged", async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = await startSession();
  onTestFinished(session.stop);
  const scan = vi.mocked(readdir).mockClear();
  const normalBadge = "[[[README]]](./README.md)";
  const plain = "[[./README.md|Guide]]";
  const baseline = session.render(plain);
  const explicit = session.render(normalBadge);
  const prompt = await session.promptSections();
  expect(scan).not.toHaveBeenCalled();

  await session.runCommand();
  expect(session.settings).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ wikilinks: false }));
  expect(session.render(plain)).toBe(baseline);

  await session.setWikilinks(true);
  expect(scan).not.toHaveBeenCalled();
  const ready = Promise.withResolvers<void>();
  session.requestRender.mockImplementationOnce(() => ready.resolve());
  session.render(plain);
  await ready.promise;

  const [linked] = new Markdown(session.render(plain), 0, 0, getMarkdownTheme()).render(80);
  expect(scan).toHaveBeenNthCalledWith(1, fixtureRoot, { withFileTypes: true });
  expect(getOsc8LinkAtColumn(linked, 0)).toBe(pathToFileURL(join(fixtureRoot, "README.md")).href);
  expect(stripTerminalSequences(linked).trimEnd()).toBe("\uE0B6\u00a0Guide\u00a0\uE0B4");
  expect(session.render(normalBadge)).toBe(explicit);
  expect(await session.promptSections()).toEqual(prompt);
  expect(vi.getTimerCount()).toBe(1);

  await session.runCommand();
  expect(session.settings).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ wikilinks: true }));
  expect(session.render(plain)).not.toBe(baseline);
  await session.setWikilinks(false);
  expect(session.render(plain)).toBe(baseline);
  expect(session.render(normalBadge)).toBe(explicit);
  expect(vi.getTimerCount()).toBe(0);
  expect(await session.promptSections()).toEqual(prompt);
});

test.for(["show", "cancel"] as const)(
  "handles a grouped preview on toggle off: %s",
  async (action, { onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(stubRawInput());
    const terminal = new ProcessTerminal();
    vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
    vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
    const tui = new TuiAltScreen(terminal);
    const session = await startSession(tui);
    onTestFinished(session.stop);
    const hide = vi.fn();
    const show = vi.spyOn(tui, "showOverlay").mockReturnValue({ hide } as unknown as OverlayHandle);
    await session.setWikilinks(true);
    const ready = Promise.withResolvers<void>();
    session.requestRender.mockImplementationOnce(() => ready.resolve());
    session.render("[[README]]");
    await ready.promise;
    const screen = new Markdown(session.render("[[README]]"), 0, 0, getMarkdownTheme()).render(80);
    const rootReadme = join(fixtureRoot, "README.md");
    expect(getOsc8LinkAtColumn(screen[0], 0)).toBe(pathToFileURL(rootReadme).href);
    vi.spyOn(tui, "getScreenLines").mockImplementation(() => [...screen]);

    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readExcerpt>>>();
    onTestFinished(() => pending.resolve(undefined));
    const read = vi.mocked(readExcerpt).mockClear();
    for (let i = 0; i < 3; i++) read.mockReturnValueOnce(pending.promise);
    process.stdin.emit("data", "\x1b[<35;2;1M");
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(3);
    const [[, firstPath, signal]] = read.mock.calls;
    expect(firstPath).toBe(rootReadme);
    expect(read.mock.calls.every(([root, , other]) => root === fixtureRoot && other === signal)).toBe(true);
    const excerpt = { filename: "README.md", text: "---\nkey: hidden\n---\n# Preview body\n", clipped: false };

    if (action === "show") {
      pending.resolve(excerpt);
      await vi.advanceTimersByTimeAsync(0);
      expect(show).toHaveBeenCalledOnce();
      const [[overlay, options]] = show.mock.calls;
      const lines = overlay.render(56);
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lines.every((line) => visibleWidth(line) <= (options?.width as number))).toBe(true);
      const card = lines.map(stripTerminalSequences).join("\n");
      expect(card).toContain("./README.md");
      expect(card).toContain("Preview body");
      expect(card).not.toContain("hidden");
    }

    await session.setWikilinks(false);
    expect(signal.aborted).toBe(true);
    pending.resolve(excerpt);
    await vi.advanceTimersByTimeAsync(0);
    expect(show).toHaveBeenCalledTimes(action === "show" ? 1 : 0);
    expect(hide).toHaveBeenCalledTimes(action === "show" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.for(["inline", "inline-markup"])(
  "opens /%s only in the terminal UI without arguments",
  async (route, { onTestFinished }) => {
    const session = await startSession();
    onTestFinished(session.stop);
    await expect(session.runCommand("on", "tui", route)).rejects.toThrow("no arguments");
    for (const mode of ["rpc", "print", "json"] as const) {
      await expect(session.runCommand("", mode, route)).rejects.toThrow("terminal UI");
    }
    expect(session.settings).not.toHaveBeenCalled();
    await session.runCommand("", "tui", route);
    expect(session.settings).toHaveBeenCalledOnce();
  },
);

test("dismisses a pending menu on replacement and ignores its late answer", async ({ onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const entered = Promise.withResolvers<Parameters<typeof showInlineSettings>[1]>();
  const pending = Promise.withResolvers<void>();
  session.settings.mockImplementationOnce(async (_ctx, options) => {
    entered.resolve(options);
    await pending.promise;
    options.setWikilinks(true);
    return true;
  });
  const command = session.runCommand();
  const options = await entered.promise;
  expect(options.signal.aborted).toBe(false);
  await session.startWidget();
  expect(options.signal.aborted).toBe(true);
  pending.resolve();
  await command;
  await session.runCommand();
  expect(session.settings).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ wikilinks: false }));
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
  "[[[README]]](file:///README.md)",
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
  ["[[[Read me](./cat.png)]]", "./cat.png"],
  ["[[[Read me]]](./cat.png)", "./cat.png"],
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
  { href: "./cat.png", label: "Photo", icon: "🖼️" },
  { href: "./cat.jpg", label: "Photo", icon: "🖼️" },
  { href: "./cat%2EJPEG?size=full#L2", label: "`Photo`", icon: "🖼️" },
  { href: "./cat.gif", label: "Photo", icon: "🖼️" },
  { href: "./cat.webp", label: "Photo", icon: "🖼️" },
  { href: "./notes.md?name=cat.png", label: "Photo", icon: "📄" },
])("uses $icon for $href without changing the destination", async ({ href, label, icon }, { onTestFinished }) => {
  const session = await startSession();
  onTestFinished(session.stop);
  const rendered = session.render(`[${label}](${href})`);
  const [line] = new Markdown(rendered, 0, 0, getMarkdownTheme()).render(80);
  const visible = `${icon}\u00a0Photo`;
  expect(stripTerminalSequences(line).trimEnd()).toBe(visible);
  expect(getOsc8LinkAtColumn(line, 0)).toBe(href);
  expect(getOsc8LinkAtColumn(line, visibleWidth(visible) - 1)).toBe(href);
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
    screen.mockImplementation(() => [...lines]);
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
  expect(resolveLinkPath(fixtureRoot, "./notes/.hidden.md")).toBe(join(fixtureRoot, "notes", ".hidden.md"));
  const workflow = join(fixtureRoot, ".github", "workflows", "ci.yml");
  expect(resolveLinkPath(fixtureRoot, `${workflow}#L1`)).toBe(workflow);
  for (const href of [
    "https://example.test/a.md",
    `file://${join(fixtureRoot, "a.md")}`,
    "//example.test/a.md",
    "../outside.md",
    "./%2e%2e/.outside.md",
    join(dirname(fixtureRoot), ".outside.md"),
    "./.hidden/node_modules/pkg/README.md",
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

test("still excludes files outside the workspace, node_modules, directories, and symlinks", async () => {
  const project = await mkdtemp(join(fixtureRoot, "project-"));
  const outside = join(fixtureRoot, ".outside.md");
  const hidden = join(project, ".hidden.md");
  const dependency = join(project, "node_modules", "dependency.md");
  await writeFile(outside, "Outside the project");
  await writeFile(hidden, "Inside the project");
  await mkdir(dirname(dependency));
  await writeFile(dependency, "Inside node_modules");
  const outsideLink = join(project, ".outside-link.md");
  const insideLink = join(project, ".inside-link.md");
  await symlink(outside, outsideLink);
  await symlink(hidden, insideLink);
  const folder = join(project, ".folder");
  await mkdir(folder);
  const { signal } = new AbortController();
  await expect(readExcerpt(project, hidden, signal)).resolves.toMatchObject({ text: "Inside the project" });
  for (const path of [outside, dependency, folder, outsideLink, insideLink]) {
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
    vi.spyOn(tui, "getScreenLines").mockImplementation(() => [...screen]);

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
  ["[`readExcerpt()`](./example.ts#L2-L3)", "📄\u00a0readExcerpt()", "example.ts"],
  ["[[[`readExcerpt()`](./example.ts#L2-L3)]]", "\uE0B6\u00a0readExcerpt()\u00a0\uE0B4", "example.ts"],
  ["[[[readExcerpt()]]](./example.ts#L2-L3)", "\uE0B6\u00a0readExcerpt()\u00a0\uE0B4", "example.ts"],
  ["[CI workflow](./.github/workflows/ci.yml#L2-L3)", "📄\u00a0CI workflow", ".github/workflows/ci.yml"],
] as const)("hovers the line-range link %s", async ([link, label, file], { onTestFinished }) => {
  const path = join(fixtureRoot, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "first\nsecond\nthird\nfourth\n");
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
    expect(getOsc8LinkAtColumn(screen[0], col)).toBe(`./${file}#L2-L3`);
  }
  vi.spyOn(tui, "getScreenLines").mockImplementation(() => [...screen]);

  process.stdin.emit("data", "\x1b[<35;6;1M");
  await vi.advanceTimersByTimeAsync(250);
  await displayed.promise;
  const [[overlay]] = show.mock.calls;
  const lines = overlay.render(60);
  expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  overlay.invalidate();
  expect(overlay.render(60)).toEqual(lines);
  const card = lines.map(stripTerminalSequences).join("\n");
  expect(card).toContain(`${basename(file)}#L2-L3`);
  expect(card).toContain("second");
  expect(card).toContain("third");
  expect(card).not.toMatch(/first|fourth/);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEklEQVR4nGP8z4AdMOEQp4sEAJiFAQtsMIKbAAAAAElFTkSuQmCC";

function thumbnailPng(line: string): Buffer {
  const chunks = line.split("\x1b_G").slice(1);
  const data = chunks.map((chunk) => chunk.slice(chunk.indexOf(";") + 1).split("\x1b\\")[0]).join("");
  return Buffer.from(data, "base64");
}

function useKittyImages(onTestFinished: (cleanup: () => void) => void) {
  const cell = getCellDimensions();
  setCapabilityOverrides({ hyperlinks: true, images: "kitty" });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  onTestFinished(() => {
    setCapabilityOverrides({ hyperlinks: true });
    setCellDimensions(cell);
  });
}

test.for([
  ["png", PNG],
  [
    "JPEG",
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAGAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AO//Z",
  ],
  ["gif", "R0lGODdhCAAGAIEAAP8AAAAAAAAAAAAAACwAAAAACAAGAAAIDgABCBxIsKDBgwgTDgwIADs="],
  ["webp", "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoIAAYAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="],
] as const)("prepares a bounded static Kitty image for %s", async ([extension, data], { onTestFinished }) => {
  useKittyImages(onTestFinished);
  const path = join(fixtureRoot, `fixture.${extension}`);
  await writeFile(path, Buffer.from(data, "base64"));
  const mime = previewImageMime(path);
  if (!mime) throw new Error("Expected a supported extension");
  const { signal } = new AbortController();
  const image = await prepareImagePreview(fixtureRoot, path, mime, 16, 4, signal);
  if (!image) throw new Error("Expected an image preview");
  const lines = image.render(0);
  expect(image.width).toBe(2);
  expect(lines).toHaveLength(1);
  expect(lines.every((line) => visibleWidth(line) <= image.width)).toBe(true);
  expect(lines[0]).toContain("\x1b_Ga=T,f=100,q=2,C=1,i=");
  expect(lines[0]).not.toMatch(/,[cr]=\d+/);
  const output = sharp(thumbnailPng(lines[0]));
  await expect(output.metadata()).resolves.toMatchObject({ format: "png", width: 8, height: 6 });
  await expect(output.raw().toBuffer()).resolves.toEqual(await sharp(Buffer.from(data, "base64")).raw().toBuffer());
  await expect(prepareImagePreview(fixtureRoot, path, mime, 0, 4, signal)).resolves.toBeUndefined();
});

test("scales an image above the old byte and pixel limits to the terminal cell size", async ({ onTestFinished }) => {
  useKittyImages(onTestFinished);
  const currentCellSize = getCellDimensions();
  setCellDimensions({ widthPx: 10, heightPx: 20 });
  onTestFinished(() => setCellDimensions(currentCellSize));
  const path = join(fixtureRoot, "large.png");
  const input = await sharp({
    create: {
      width: 2400,
      height: 1800,
      channels: 3,
      background: "black",
      noise: { type: "gaussian", mean: 127, sigma: 30 },
    },
  })
    .ensureAlpha(0.5)
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(input.byteLength).toBeGreaterThan(4 * 1024 * 1024);
  await writeFile(path, input);
  const image = await prepareImagePreview(fixtureRoot, path, "image/png", 62, 12, new AbortController().signal);
  if (!image) throw new Error("Expected an image preview");
  const lines = image.render(0);
  expect(image.width).toBe(33);
  expect(lines).toHaveLength(12);
  expect(lines.every((line) => visibleWidth(line) <= image.width)).toBe(true);
  expect(lines[0]).toContain("\x1b_Gm=0;");
  await expect(sharp(thumbnailPng(lines[0])).metadata()).resolves.toMatchObject({
    format: "png",
    width: 320,
    height: 240,
    hasAlpha: true,
  });
});

test("skips invalid and disallowed image files", async ({ onTestFinished }) => {
  useKittyImages(onTestFinished);
  const root = await mkdtemp(join(fixtureRoot, "images-"));
  const outside = join(fixtureRoot, "outside.png");
  const link = join(root, "symlink.png");
  const invalid = join(root, "invalid.png");
  const truncated = join(root, "truncated.png");
  const png = Buffer.from(PNG, "base64");
  await writeFile(outside, png);
  await symlink(outside, link);
  await writeFile(invalid, "Not a PNG");
  await writeFile(truncated, png.subarray(0, 33));
  const { signal } = new AbortController();
  for (const path of [outside, link, invalid, truncated]) {
    await expect(prepareImagePreview(root, path, "image/png", 16, 4, signal), path).resolves.toBeUndefined();
  }
});

test("terminates the thumbnail worker when the preview is cancelled", async ({ onTestFinished }) => {
  useKittyImages(onTestFinished);
  const path = join(fixtureRoot, "cancel.png");
  await writeFile(path, Buffer.from(PNG, "base64"));
  const controller = new AbortController();
  const started = Promise.withResolvers<Worker>();
  const once = Worker.prototype.once;
  const listen = vi.spyOn(Worker.prototype, "once").mockImplementation(function (this: Worker, event, listener) {
    const result = once.call(this, event, listener);
    if (event === "message") started.resolve(this);
    return result;
  });
  const stop = vi.spyOn(Worker.prototype, "terminate");
  onTestFinished(() => {
    controller.abort();
    listen.mockRestore();
    stop.mockRestore();
  });

  const preview = prepareImagePreview(fixtureRoot, path, "image/png", 16, 4, controller.signal);
  const worker = await started.promise;
  controller.abort();
  await expect(preview).resolves.toBeUndefined();
  expect(stop.mock.contexts).toContain(worker);
});

test("does not read an image without Kitty graphics", async ({ onTestFinished }) => {
  setCapabilityOverrides({ hyperlinks: true, images: null });
  onTestFinished(() => setCapabilityOverrides({ hyperlinks: true }));
  const resolvePath = vi.mocked(realpath).mockClear();
  const path = join(fixtureRoot, "cat.png");
  await expect(
    prepareImagePreview(fixtureRoot, path, "image/png", 16, 4, new AbortController().signal),
  ).resolves.toBeUndefined();
  expect(resolvePath).not.toHaveBeenCalled();
});

test.for(["leave", "escape", "resize", "shutdown"] as const)(
  "composites and clears the image in a real fullscreen frame on %s",
  async (action, { onTestFinished }) => {
    useKittyImages(onTestFinished);
    await sharp({ create: { width: 251, height: 300, channels: 3, background: "red" } })
      .png()
      .toFile(join(fixtureRoot, "cat.png"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(stubRawInput());
    let columns = 80;
    const writes = vi.fn<(data: string) => void>();
    const terminal = new (class extends ProcessTerminal {
      override get columns() {
        return columns;
      }
      override get rows() {
        return 24;
      }
      override start() {}
      override stop() {}
      override hideCursor() {}
      override showCursor() {}
      override write = writes;
    })();
    const tui = new TuiAltScreen(terminal);
    const session = await startSession(tui);
    onTestFinished(session.stop);
    const row = action === "resize" ? 20 : 0;
    const indent = action === "escape" ? 64 : 4;
    const pointer = indent + 1;
    const imageWidth = 29;
    const expectedColumn = Math.min(pointer, columns - imageWidth);
    const rightColumn = expectedColumn + imageWidth;
    let backdropText = "Keep this text";
    const message = new Markdown(session.render("[Cat Photo](./cat.png)"), 0, 0, getMarkdownTheme());
    const root = {
      render: (width: number) => {
        const backdrop = rightColumn < width ? " ".repeat(rightColumn) + backdropText : "";
        const lines = Array<string>(terminal.rows).fill(backdrop);
        lines[row] = " ".repeat(indent) + message.render(width - indent)[0];
        return [...lines, ...session.renderWidget(width)];
      },
      invalidate: () => message.invalidate(),
    };
    tui.setLayoutRoot(root);
    tui.setFocus(root);
    tui.start();
    onTestFinished(() => tui.stop({ preserveScreen: true }));
    tui.renderNow();
    expect(getOsc8LinkAtColumn(tui.getScreenLines()[row], pointer)).toBe("./cat.png");

    const displayed = Promise.withResolvers<OverlayHandle>();
    const mount = tui.showOverlay.bind(tui);
    vi.spyOn(tui, "showOverlay").mockImplementation((component, options) => {
      const handle = mount(component, options);
      displayed.resolve(handle);
      return handle;
    });
    process.stdin.emit("data", `\x1b[<35;${pointer + 1};${row + 1}M`);
    await vi.advanceTimersByTimeAsync(250);
    const handle = await displayed.promise;
    const hide = vi.spyOn(handle, "hide");
    tui.renderNow();
    const imageRow = tui.getScreenLines().findIndex((line) => line.includes("\x1b_Ga=T"));
    expect(imageRow).toBeGreaterThanOrEqual(0);
    expect(imageRow).toBe(row === 0 ? 1 : row - 17);
    expect(handle.getBounds()).toEqual({ row: imageRow, col: expectedColumn, width: imageWidth, height: 17 });
    const screen = tui.getScreenLines();
    if (rightColumn < columns) {
      for (const line of screen.slice(imageRow, imageRow + 17)) {
        expect(stripTerminalSequences(line).slice(rightColumn)).toContain("Keep this text");
      }
    }
    expect(writes.mock.lastCall?.[0]).toContain(`\x1b[${expectedColumn + 1}G\x1b_Ga=T`);
    expect(writes.mock.lastCall?.[0]).toContain(`\x1b\\\x1b[${rightColumn}G`);
    await expect(sharp(thumbnailPng(screen[imageRow])).metadata()).resolves.toMatchObject({
      format: "png",
      width: 251,
      height: 300,
    });
    expect(tui.getFocusedComponent()).toBe(root);

    if (action === "leave") {
      backdropText = "Keep this edit";
      tui.renderNow();
      const redraw = writes.mock.lastCall?.[0];
      expect(redraw).toContain("Keep this edit");
      expect(redraw).toContain("\x1b_Ga=p,q=2,C=1,i=");
      expect(redraw).not.toMatch(/,[cr]=\d+/);
      process.stdin.emit("data", `\x1b[<35;80;${row + 1}M`);
    } else if (action === "escape") {
      process.stdin.emit("data", "\x1b");
      await vi.runOnlyPendingTimersAsync();
    } else if (action === "resize") columns = 70;
    else await session.stop();
    tui.renderNow();
    await Promise.resolve();
    expect(hide).toHaveBeenCalledOnce();
    expect(tui.hasOverlay()).toBe(false);
    expect(tui.getScreenLines().some((line) => line.includes("\x1b_G"))).toBe(false);
    expect(writes.mock.lastCall?.[0]).toContain("\x1b_Ga=d,d=a");
  },
);

test("cancels a pending image read when the session widget is replaced", async ({ onTestFinished }) => {
  useKittyImages(onTestFinished);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(stubRawInput());
  const terminal = new ProcessTerminal();
  vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
  const tui = new TuiAltScreen(terminal);
  const session = await startSession(tui);
  onTestFinished(session.stop);
  const screen = new Markdown(session.render("[Cat Photo](./cat.png)"), 0, 0, getMarkdownTheme()).render(80);
  vi.spyOn(tui, "getScreenLines").mockImplementation(() => [...screen]);
  const overlay = vi.spyOn(tui, "showOverlay");
  const pending = Promise.withResolvers<string>();
  onTestFinished(() => pending.resolve(fixtureRoot));
  const resolvePath = vi.mocked(realpath).mockClear().mockReturnValueOnce(pending.promise);

  process.stdin.emit("data", "\x1b[<35;6;1M");
  await vi.advanceTimersByTimeAsync(250);
  expect(resolvePath).toHaveBeenCalledExactlyOnceWith(fixtureRoot);
  await session.startWidget();
  pending.resolve(fixtureRoot);
  await pending.promise;
  expect(resolvePath).toHaveBeenCalledOnce();
  expect(overlay).not.toHaveBeenCalled();
});
