import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  Markdown,
  type OverlayHandle,
  ProcessTerminal,
  setCapabilityOverrides,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { readExcerpt } from "../src/filelinks.js";
import { startInlineSession, stubRawInput } from "./inline-session-fixture.js";

vi.mock("../src/filelinks.js", { spy: true });
vi.mock("../src/settings-menu.js", () => ({ showInlineSettings: vi.fn() }));

let fixtureRoot: string;
let extension: typeof import("../src/index.js").default;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-inline-fragments-"));
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

async function fragmentFixture(onTestFinished: (cleanup: () => void) => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(stubRawInput());
  const terminal = new ProcessTerminal();
  const columns = vi.spyOn(terminal, "columns", "get").mockReturnValue(80);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
  const tui = new TuiAltScreen(terminal);
  const session = await startInlineSession(extension, fixtureRoot, tui);
  onTestFinished(session.stop);
  const screen = vi.spyOn(tui, "getScreenLines");
  const hide = vi.fn();
  const show = vi.spyOn(tui, "showOverlay").mockReturnValue({ hide } as unknown as OverlayHandle);
  return {
    ...session,
    columns,
    screen,
    show,
    hide,
    draw(source: string) {
      const width = terminal.columns;
      const rows = [...new Markdown(session.render(source), 0, 0, getMarkdownTheme()).render(width)];
      Object.freeze(rows);
      screen.mockReturnValue(rows);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      return rows;
    },
    async hover(col: number, row = 0) {
      process.stdin.emit("data", `\x1b[<35;${col + 1};${row + 1}M`);
      await vi.advanceTimersByTimeAsync(250);
    },
    nextCard() {
      const card = Promise.withResolvers<Component>();
      show.mockImplementationOnce((component) => {
        card.resolve(component);
        return { hide } as unknown as OverlayHandle;
      });
      return card.promise.then((component) => {
        const width = terminal.columns;
        const lines = component.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        return stripTerminalSequences(lines.join("\n"));
      });
    },
  };
}

const osc8Params = (line: string) =>
  line
    .split("\x1b]8;")
    .slice(1)
    .map((part) => part.split(";", 1)[0])
    .filter((params) => params.startsWith("id="));

test("decorates code blocks alongside native file links and applies a saved copy mode without reload", async ({
  onTestFinished,
}) => {
  const session = await fragmentFixture(onTestFinished);
  const source = "[[Note]] [README](./README.md)\n\n```js\nconst example = 3;\n```";
  const click = session.draw(source);
  expect(click.join("\n")).toContain("pi-inline-code-");
  expect(click.map(stripTerminalSequences).join("\n")).not.toContain("[Copy]");
  const saveMode = async (mode: "click" | "button" | "off") => {
    session.settings.mockImplementationOnce(async (_ctx, options) => {
      expect(await options.saveCodeBlockCopyMode(mode, options.signal)).toBe(true);
      return false;
    });
    await session.runCommand();
  };
  try {
    await saveMode("button");
    const button = session.draw(source);
    expect(button.map(stripTerminalSequences).join("\n")).toContain("[Copy]");
    expect(button.join("\n")).toContain("./README.md");
    await saveMode("off");
    expect(session.draw(source).join("\n")).not.toContain("pi-inline-code-");
  } finally {
    await saveMode("click");
  }
});

test("opens one README while hovering adjacent, wrapped, and restored links to different excerpts", async ({
  onTestFinished,
}) => {
  const path = join(fixtureRoot, "README.md");
  await writeFile(
    path,
    ["# Fixture heading", ...Array.from({ length: 19 }, (_, i) => `Source line ${i + 2}`)].join("\n"),
  );
  const session = await fragmentFixture(onTestFinished);
  const fifth = "[Fifth](./README.md#L5)";
  const twentieth = "[Twentieth](./README.md#L20)";
  const heading = "[Heading](./README.md#快速開始)";
  const history = Object.freeze({ role: "assistant", content: `${fifth}${twentieth}${heading}` });
  const prompt = await session.promptSections();
  await session.setWikilinks(true);
  const indexed = Promise.withResolvers<void>();
  session.requestRender.mockImplementationOnce(() => indexed.resolve());
  session.draw("[[./README.md]]");
  await indexed.promise;
  const [wikiLink] = session.draw("[[./README.md]]");
  expect(getOsc8LinkAtColumn(wikiLink, 0)).toBe(pathToFileURL(path).href);

  const renderHistory = () => session.draw(history.content);
  const [row] = renderHistory();
  const params = osc8Params(row);
  expect(params).toHaveLength(3);
  expect(new Set(params).size).toBe(3);
  expect(osc8Params(renderHistory()[0])).toEqual(params);
  for (const [col, included, excluded] of [
    [0, "Source line 5", "Source line 20"],
    [visibleWidth("📄\u00a0Fifth"), "Source line 20", "Source line 5"],
    [visibleWidth("📄\u00a0Fifth📄\u00a0Twentieth"), "Fixture heading", "README.md#L"],
  ] as const) {
    expect(getOsc8LinkAtColumn(row, col)).toBe(pathToFileURL(path).href);
    const card = session.nextCard();
    await session.hover(col);
    expect(await card).toContain(included);
    expect(await card).not.toContain(excluded);
  }
  session.columns.mockReturnValue(24);
  const wrapped = session.draw(`[${"Long ".repeat(8)}label](./README.md#L5)`);
  expect(wrapped.length).toBeGreaterThan(1);
  expect(osc8Params(wrapped[1])).toEqual([params[0]]);
  expect(getOsc8LinkAtColumn(wrapped[1], 0)).toBe(pathToFileURL(path).href);
  session.renderWidget(24);
  await Promise.resolve();
  expect(session.hide).toHaveBeenCalledTimes(3);
  const wrappedCard = session.nextCard();
  await session.hover(0, 1);
  expect(await wrappedCard).toContain("Source line 5");

  await session.startWidget();
  expect(session.hide).toHaveBeenCalledTimes(4);
  expect(osc8Params(renderHistory()[0])[0]).not.toBe(params[0]);
  const restoredCard = session.nextCard();
  await session.hover(0);
  expect(await restoredCard).toContain("Source line 5");
  expect(history.content).toBe(`${fifth}${twentieth}${heading}`);
  expect(await session.promptSections()).toEqual(prompt);
});

test.for(["pointer move", "screen change", "shutdown", "replacement", "invalidate failure", "mount failure"] as const)(
  "does not publish a delayed anchored preview after %s",
  async (action, { onTestFinished }) => {
    const session = await fragmentFixture(onTestFinished);
    const fifth = "[Fifth](./README.md#L5)";
    const twentieth = "[Twentieth](./README.md#L20)";
    const [row] = session.draw(fifth + twentieth);
    const read = vi.mocked(readExcerpt).mockClear();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readExcerpt>>>();
    read.mockReturnValueOnce(pending.promise);
    onTestFinished(() => pending.resolve(undefined));
    await session.hover(0);
    const [[, , signal]] = read.mock.calls;
    expect(signal.aborted).toBe(false);

    if (action === "pointer move") {
      process.stdin.emit("data", `\x1b[<35;${visibleWidth("📄\u00a0Fifth") + 1};1M`);
    } else if (action === "screen change") {
      session.draw(twentieth);
    } else if (action === "shutdown") {
      await session.stop();
    } else if (action === "replacement") {
      await session.startWidget();
      session.screen.mockReturnValue([row]);
      await session.hover(0);
      expect(read).toHaveBeenCalledOnce();
    } else {
      const listeners = process.stdin.listenerCount("data");
      const fail = () => {
        session.draw(twentieth);
        throw new Error("Cannot initialize the screen");
      };
      if (action === "invalidate failure") {
        session.invalidate.mockImplementationOnce(fail);
      } else {
        const mount = session.setWidget.getMockImplementation();
        session.setWidget.mockImplementation((...args) => {
          mount?.(...args);
          if (args[1]) fail();
        });
      }
      await expect(session.startWidget()).rejects.toThrow("Cannot initialize the screen");
      expect(session.setWidget).toHaveBeenLastCalledWith("pi-inline-markup.preview", undefined);
      expect(process.stdin.listenerCount("data")).toBe(listeners - 1);
      expect(session.render(twentieth)).toBe(twentieth);
      await session.hover(0);
      expect(read).toHaveBeenCalledOnce();
    }
    if (action !== "screen change") expect(signal.aborted).toBe(true);
    pending.resolve({ filename: "README.md", text: "Stale content", clipped: false });
    await pending.promise;
    expect(signal.aborted).toBe(true);
    expect(session.show).not.toHaveBeenCalled();
  },
);

test("rejects unmarked or mismatched file URLs and leaves non-TUI Markdown alone", async ({ onTestFinished }) => {
  const session = await fragmentFixture(onTestFinished);
  const source = "[Fifth](./README.md#L5)";
  const [row] = session.draw(source);
  const [params] = osc8Params(row);
  const url = pathToFileURL(join(fixtureRoot, "README.md")).href;
  expect(params).toBeDefined();
  const read = vi.mocked(readExcerpt).mockClear();
  for (const invalid of [
    row.replace(params, ""),
    row.replace(params, `${params}fake`),
    row.replace(url, `${url}?changed`),
    row.replace(url, "./README.md#L5"),
  ]) {
    session.screen.mockReturnValue([invalid]);
    await session.hover(0);
  }
  setCapabilityOverrides({ hyperlinks: false });
  onTestFinished(() => setCapabilityOverrides({ hyperlinks: true }));
  const [plain] = session.draw(source);
  expect(getOsc8LinkAtColumn(plain, 0)).toBeUndefined();
  expect(osc8Params(plain)).toEqual([]);
  await session.hover(0);
  expect(read).not.toHaveBeenCalled();
  for (const mode of ["rpc", "print", "json"] as const) {
    await session.startWidget(mode);
    expect(session.render(source)).toBe(source);
    expect(await session.promptSections(mode)).toEqual({ other: "Keep this section." });
  }
});
