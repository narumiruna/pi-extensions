import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  Markdown,
  Marked,
  ProcessTerminal,
  rgbColor,
  setCapabilityOverrides,
  stripTerminalSequences,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createFileIndex } from "./wikilinks.ts";

vi.mock("node:fs/promises", { spy: true });

let fixtureRoot: string;
let extension: typeof import("./index.ts").default;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-inline-markup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", fixtureRoot);
  vi.stubEnv("TERM_PROGRAM", "");
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

async function startSession() {
  const on = vi.fn<(event: string, handler: unknown) => void>();
  const registerMarkdownTransformer = vi.fn<(transform: MarkdownTransformer) => void>();
  extension({ on, registerMarkdownTransformer } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([event]) => event === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([event]) => event === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const tui = new TuiMainScreen(new ProcessTerminal());
  const theme = {
    colors: new Proxy({}, { get: () => rgbColor(88, 60, 137) }),
    getBgAnsi: () => "",
    fg: (_color: string, text: string) => text,
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
  expect(visible).toBe("📄\u00a0Manifest\u00a0Wiki");
  expect(output).toContain("./package.json");
  expect(session.render(`\`${source}\``)).toBe(`\`${source}\``);
  expect(session.render("[[README.md|Wiki]][Manifest](./package.json)")).toContain("📄");
  expect(session.render(source, "assistant-thinking")).toBe(source);

  await session.stop();
  expect(process.stdin.listenerCount("data")).toBe(listeners);
  expect(session.render(source)).toBe(source);
});

test.for([
  ["[[README.md|Note]]`after`", ["\u00a0Note\u00a0", "after"]],
  ["`before`[[README.md|Note]]", ["before", "\u00a0Note\u00a0"]],
  ["`before`[[README.md|Note`v2]]``after``", ["before", "\u00a0Note`v2\u00a0", "after"]],
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
  const rendered = session.render("[[README.md]]");
  expect(rendered).toContain("file://");
  expect(rendered).toContain("/README.md");
  expect(vi.getTimerCount()).toBe(1);
  await session.stop();
  expect(session.setWidget).toHaveBeenLastCalledWith("pi-inline-markup.preview", undefined);
  expect(vi.getTimerCount()).toBe(0);
  expect(session.render("[[README.md]]")).toBe("[[README.md]]");
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
