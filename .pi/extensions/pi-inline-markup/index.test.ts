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
import { readExcerpt, resolveLinkPath } from "./filelinks.ts";
import { createFileIndex, renderWikiPreview } from "./wikilinks.ts";

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

async function startSession(tui: TUI = new TuiMainScreen(new ProcessTerminal())) {
  const on = vi.fn<(event: string, handler: unknown) => void>();
  const registerMarkdownTransformer = vi.fn<(transform: MarkdownTransformer) => void>();
  extension({ on, registerMarkdownTransformer } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([event]) => event === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([event]) => event === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const theme = {
    colors: new Proxy({}, { get: () => rgbColor(88, 60, 137) }),
    getBgAnsi: () => "",
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  } as unknown as ExtensionUIContext["theme"];
  const invalidate = vi.spyOn(tui, "invalidate");
  const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let disposeWidget: (() => void) | undefined;
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    disposeWidget?.();
    disposeWidget = typeof content === "function" ? content(tui, theme).dispose : undefined;
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
  expect(session.render("[[README.md]]")).not.toContain("file://");
  await frame.promise;
  expect(session.invalidate).toHaveBeenCalledTimes(2);
  const [line] = new Markdown(session.render("[[README.md]]"), 0, 0, getMarkdownTheme()).render(80);
  const chip = stripTerminalSequences(line).trimEnd();
  expect(chip).toBe("\uE0B6\u00a0README\u00a0\uE0B4");
  const href = new URL("../../../README.md", import.meta.url).href;
  expect(getOsc8LinkAtColumn(line, 0)).toBe(href);
  expect(getOsc8LinkAtColumn(line, visibleWidth(chip) - 1)).toBe(href);
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

test.for(["leave", "dispose", "show and leave"] as const)(
  "handles hover preview action: %s",
  async (action, { onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const raw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
    Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
    onTestFinished(() => {
      if (raw) Object.defineProperty(process.stdin, "isRaw", raw);
      else Reflect.deleteProperty(process.stdin, "isRaw");
    });
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
  expect(index.find("existing")).toBe("existing.md");

  async function refresh() {
    change = Promise.withResolvers<void>();
    await vi.advanceTimersToNextTimerAsync();
    await change.promise;
  }

  await writeFile(join(root, "folder", "new.md"), "");
  await refresh();
  expect(index.find("new")).toBe("folder/new.md");
  expect(index.find("./folder/new")).toBe("folder/new.md");

  await rename(join(root, "folder", "new.md"), join(root, "folder", "renamed.md"));
  await refresh();
  expect(index.find("new")).toBeUndefined();
  expect(index.find("renamed")).toBe("folder/renamed.md");

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
