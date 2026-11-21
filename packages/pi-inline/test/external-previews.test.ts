import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type ExtensionUIContext,
  getMarkdownTheme,
  initTheme,
  type MarkdownTransformer,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  hyperlink,
  Markdown,
  type OverlayHandle,
  ProcessTerminal,
  rgbColor,
  setCapabilityOverrides,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readExcerpt } from "../src/filelinks.js";
import { prepareImagePreview } from "../src/image-preview.js";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../src/filelinks.js", { spy: true });
vi.mock("../src/image-preview.js", { spy: true });

let base: string;
let plans: string;
let cwd: string;
let home: string;
let agentDir: string;
let settingsFile: string;
let plan: string;
let extension: typeof import("../src/index.js").default;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pi-inline-external-")));
  cwd = join(base, "workspace");
  plans = join(base, "plans");
  home = join(base, "home");
  agentDir = join(home, "agent");
  settingsFile = join(agentDir, "pi-inline.json");
  plan = join(plans, "rename plan.md");
  await Promise.all([mkdir(cwd), mkdir(plans), mkdir(home)]);
  await writeFile(plan, "# Preview title\n**Second line**\nThird line\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.resetModules();
  ({ default: extension } = await import("../src/index.js"));
  initTheme("dark");
  setCapabilityOverrides({ hyperlinks: true, images: "kitty" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setCapabilityOverrides({});
  await rm(base, { recursive: true, force: true });
});

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(value));
}

function fixture(onTestFinished: (cleanup: () => void) => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: true });
  const terminal = new ProcessTerminal();
  const columns = vi.spyOn(terminal, "columns", "get").mockReturnValue(120);
  vi.spyOn(terminal, "rows", "get").mockReturnValue(24);
  const tui = new TuiAltScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const hide = vi.fn();
  const show = vi.spyOn(tui, "showOverlay").mockReturnValue({ hide } as unknown as OverlayHandle);
  const screen = vi.spyOn(tui, "getScreenLines").mockReturnValue([]);
  const on = vi.fn<(name: string, handler: unknown) => void>();
  const registerMarkdownTransformer = vi.fn<(transform: MarkdownTransformer) => void>();
  extension({ on, registerMarkdownTransformer, registerCommand: vi.fn() } as unknown as ExtensionAPI);
  const start = on.mock.calls.find(([name]) => name === "session_start")?.[1] as ExtensionHandler<SessionStartEvent>;
  const shutdown = on.mock.calls.find(
    ([name]) => name === "session_shutdown",
  )?.[1] as ExtensionHandler<SessionShutdownEvent>;
  const [[transform]] = registerMarkdownTransformer.mock.calls;
  let widget: (Component & { dispose?(): void }) | undefined;
  const setWidget = vi.fn<ExtensionUIContext["setWidget"]>((_key, content) => {
    widget?.dispose?.();
    widget = typeof content === "function" ? content(tui, getTheme()) : undefined;
  });
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: {},
    ui: { setWidget, notify },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  onTestFinished(() => {
    widget?.dispose?.();
    if (raw) Object.defineProperty(process.stdin, "isRaw", raw);
    else Reflect.deleteProperty(process.stdin, "isRaw");
  });
  const render = (source: string) =>
    transform(source, { messageType: "assistant", isStreaming: false, availableWidth: 120 });
  return {
    columns,
    hide,
    show,
    screen,
    notify,
    setWidget,
    render,
    start: (mode: ExtensionContext["mode"] = "tui") =>
      start({ type: "session_start", reason: "startup" }, { ...ctx, mode }),
    stop: (reason: SessionShutdownEvent["reason"] = "quit") => shutdown({ type: "session_shutdown", reason }, ctx),
    renderWidget: () => widget?.render(120),
    dispose: () => widget?.dispose?.(),
    link(source: string) {
      const lines = new Markdown(render(source), 0, 0, getMarkdownTheme()).render(120);
      screen.mockImplementation(() => [...lines]);
      return lines[0];
    },
    async hover() {
      process.stdin.emit("data", "\x1b[<35;1;1M");
      await vi.advanceTimersByTimeAsync(250);
    },
  };
}

function getTheme(): ExtensionUIContext["theme"] {
  return {
    colors: new Proxy({}, { get: () => rgbColor(88, 60, 137) }),
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    getBgAnsi: () => "",
  } as unknown as ExtensionUIContext["theme"];
}

const io = [open, lstat, readFile, realpath, readdir];

function clearIo(): void {
  for (const fn of io) vi.mocked(fn).mockClear();
}

test.for([true, false])(
  "styles external links with OSC 8 support set to %s without filesystem access",
  async (hyperlinks, { onTestFinished }) => {
    const session = fixture(onTestFinished);
    await session.start();
    setCapabilityOverrides({ hyperlinks });
    clearIo();
    const href = `${plans}/rename%20plan.md#L2-L3`;
    const relative = "../plans/rename%20plan.md#L2-L3";
    for (const [source, link, label] of [
      [`[rename plan](${href})`, href, "📄\u00a0rename plan"],
      [`[rename plan](${relative})`, relative, "📄\u00a0rename plan"],
      ["[rename plan](<../plans/rename plan.md#L2-L3>)", "../plans/rename plan.md#L2-L3", "📄\u00a0rename plan"],
      [`[[[rename plan](${relative})]]`, relative, "\uE0B6\u00a0rename\u00a0plan\u00a0\uE0B4"],
      [`[[[rename plan]]](${href})`, href, "\uE0B6\u00a0rename\u00a0plan\u00a0\uE0B4"],
      ["[Workspace](./README.md)", "./README.md", "📄\u00a0Workspace"],
      ["[Photo](../plans/image.png)", "../plans/image.png", "🖼️\u00a0Photo"],
    ]) {
      const line = session.link(source);
      expect(stripTerminalSequences(line).trimEnd()).toBe(label);
      expect(getOsc8LinkAtColumn(line, 0)).toBe(hyperlinks ? link : undefined);
    }
    for (const source of [
      "[Note](https://example.test/a.md)",
      "[Note](//example.test/a.md)",
      "[Note](file:///tmp/a.md)",
      "[Note](../plans/%zz.md)",
      "[Note](../plans/%1b.md)",
      "[Note](../plans/unsafe\x07.md)",
      "[Note](../node_modules/a.md)",
      "[Note](./node_modules/a.md)",
      "[Note](../plans/file \u202e.md)",
      "[**Note**](../plans/a.md)",
      "![Note](../plans/a.md)",
      "`[Note](../plans/a.md)`",
      "[Note][ref]\n\n[ref]: ../plans/a.md",
    ]) {
      expect(session.render(source), source).toBe(source);
      expect(session.link(source)).not.toContain("📄");
    }
    for (const fn of io) expect(fn).not.toHaveBeenCalled();
  },
);

test("only loads the user settings file, without writing missing defaults or loading in RPC mode", async ({
  onTestFinished,
}) => {
  const session = fixture(onTestFinished);
  const projectDir = join(cwd, CONFIG_DIR_NAME);
  await mkdir(projectDir);
  await writeFile(join(projectDir, "pi-inline.json"), JSON.stringify({ promptHintEnabled: "invalid" }));
  clearIo();
  await session.start("rpc");
  for (const fn of io) expect(fn).not.toHaveBeenCalled();
  expect(session.setWidget).not.toHaveBeenCalled();
  await session.start();
  expect(lstat).toHaveBeenCalledExactlyOnceWith(settingsFile, { bigint: true });
  expect(readFile).not.toHaveBeenCalled();
  await expect(lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(session.notify).not.toHaveBeenCalled();
});

test("warns without echoing malformed settings or read errors", async ({ onTestFinished }) => {
  const session = fixture(onTestFinished);
  await writeSettings({});
  await writeFile(settingsFile, "{ invalid \x1b[31msecret");
  await session.start();
  vi.mocked(readFile).mockRejectedValueOnce(new Error("secret settings path"));
  await session.start();
  expect(session.notify.mock.calls).toEqual(
    Array(2).fill(["pi-inline: Invalid or unreadable settings were ignored.", "warning"]),
  );
});

test.for(["replacement", "shutdown"] as const)(
  "discards delayed settings on %s",
  async (action, { onTestFinished }) => {
    const session = fixture(onTestFinished);
    await writeSettings({ promptHintText: "Old prompt" });
    const pending = Promise.withResolvers<Buffer<ArrayBuffer>>();
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    vi.mocked(readFile).mockImplementationOnce((_file, options) => {
      entered.resolve(typeof options === "object" ? options?.signal : undefined);
      return pending.promise;
    });
    const old = session.start();
    const signal = await entered.promise;
    if (action === "replacement") await writeSettings({ promptHintText: "New prompt" });
    const next = action === "replacement" ? session.start() : session.stop();
    expect(signal?.aborted).toBe(true);
    pending.resolve(Buffer.from("invalid JSON"));
    await Promise.all([old, next]);
    expect(session.notify).not.toHaveBeenCalled();
  },
);

test.for([
  { absolute: true, anchor: "", legacy: undefined },
  { absolute: false, anchor: "#L2-L3", legacy: { externalPreviewRoots: [] } },
  { absolute: true, anchor: "#L2-L3", legacy: { externalPreviewRoots: "invalid" } },
])(
  "shows a bounded external Markdown excerpt without approval (%j)",
  async ({ absolute, anchor, legacy }, { onTestFinished }) => {
    const session = fixture(onTestFinished);
    if (legacy) await writeSettings(legacy);
    await session.start();
    const directory = absolute ? plans : "../plans";
    const source = `[rename plan](${directory}/rename%20plan.md${anchor})`;
    const shown = Promise.withResolvers<void>();
    session.show.mockImplementationOnce(() => {
      shown.resolve();
      return { hide: session.hide } as unknown as OverlayHandle;
    });
    const rendered = session.link(source);
    expect(readExcerpt).not.toHaveBeenCalled();
    await session.hover();
    await shown.promise;
    const [[overlay, options]] = session.show.mock.calls;
    const lines = overlay.render(60);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(options?.nonCapturing).toBe(true);
    const text = stripTerminalSequences(lines.join("\n"));
    expect(text).toContain(`rename plan.md${anchor}`);
    if (anchor) {
      expect(text).toContain("**Second line**");
      expect(text).not.toContain("Preview title");
    } else {
      expect(text).toContain("Preview title");
      expect(text).not.toContain("**Second line**");
    }
    expect(session.render(source)).not.toMatch(/Preview title|Second line/);
    expect(session.notify).not.toHaveBeenCalled();
    await session.stop("reload");
    expect(session.hide).toHaveBeenCalledOnce();
    await session.start();
    session.screen.mockReturnValue([rendered]);
    vi.mocked(readExcerpt).mockClear();
    await session.hover();
    expect(readExcerpt).not.toHaveBeenCalled();
  },
);

test("does not read external targets from unsigned or changed links, images, or excluded paths", async ({
  onTestFinished,
}) => {
  const session = fixture(onTestFinished);
  await writeFile(join(plans, "image.png"), "Not a preview");
  await session.start();
  clearIo();
  const unsigned = hyperlink("Note", "../plans/rename%20plan.md");
  session.screen.mockReturnValue([unsigned]);
  await session.hover();
  const signed = session.link("[Note](../plans/rename%20plan.md)");
  session.screen.mockReturnValue([signed.replace("rename%20plan.md", "other.txt")]);
  await session.hover();
  for (const href of ["../plans/image.png", "../node_modules/dependency.md", "https://example.test/a.md"]) {
    session.link(`[Note](${href})`);
    await session.hover();
  }
  for (const fn of io) expect(fn).not.toHaveBeenCalled();
  expect(readExcerpt).not.toHaveBeenCalled();
  expect(prepareImagePreview).not.toHaveBeenCalled();
  expect(session.show).not.toHaveBeenCalled();
});

test("rejects missing and nonregular external paths and symlinks before opening a file", async () => {
  await symlink(plans, join(base, "alias"), "dir");
  await symlink(plan, join(plans, "link.md"), "file");
  await mkdir(join(plans, "directory"));
  if (process.platform !== "win32") execFileSync("mkfifo", [join(plans, "pipe")]);
  clearIo();
  const root = parse(base).root;
  const signal = new AbortController().signal;
  for (const path of [
    join(base, "alias", "rename plan.md"),
    ...["link.md", "missing.md", "directory", "pipe", "node_modules/ignored.md"].map((name) => join(plans, name)),
  ]) {
    await expect(readExcerpt(root, path, signal)).resolves.toBeUndefined();
  }
  expect(open).not.toHaveBeenCalled();
});

test("closes the wrong handle without reading if the target changes during open", async () => {
  const signal = new AbortController().signal;
  const root = parse(base).root;
  const replacement = join(plans, "different.md");
  await writeFile(replacement, "Unexpected content");
  const other = await open(replacement, "r");
  const read = vi.spyOn(other, "read");
  const close = vi.spyOn(other, "close");
  vi.mocked(open).mockImplementationOnce(async () => {
    await rename(replacement, plan);
    return other;
  });
  try {
    await expect(readExcerpt(root, plan, signal)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await other.close();
  }
});

test.for(["leave", "resize", "dispose", "replacement", "shutdown", "reload"] as const)(
  "cancels a delayed external read on %s",
  async (action, { onTestFinished }) => {
    const session = fixture(onTestFinished);
    await session.start();
    session.link("[Note](../plans/rename%20plan.md)");
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readExcerpt>>>();
    vi.mocked(readExcerpt).mockReturnValueOnce(pending.promise);
    onTestFinished(() => pending.resolve(undefined));
    await session.hover();
    const [[, , signal]] = vi.mocked(readExcerpt).mock.calls;
    expect(signal.aborted).toBe(false);
    if (action === "reload") {
      await session.stop("reload");
      await session.start();
    } else if (action === "replacement") await session.start();
    else if (action === "shutdown") await session.stop();
    else if (action === "dispose") session.dispose();
    else if (action === "leave") process.stdin.emit("data", "\x1b[<35;120;1M");
    else {
      session.columns.mockReturnValue(90);
      session.renderWidget();
      await Promise.resolve();
    }
    expect(signal.aborted).toBe(true);
    pending.resolve({ filename: "rename plan.md", text: "Stale content", clipped: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.show).not.toHaveBeenCalled();
  },
);
