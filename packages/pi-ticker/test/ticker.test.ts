import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import type { SettingsWriter } from "../src/settings.js";
import stockTicker, {
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  SETTINGS_FILE_NAME,
  type StockTickerDependencies,
  settingsPath,
  WIDGET_KEY,
} from "../src/ticker.js";

interface Command {
  handler: (argumentsText: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type WidgetFactory = (_tui: never, theme: Theme) => Component;
type WidgetRecord = [string, string[] | WidgetFactory | undefined, unknown?];

const temporaryDirectories: string[] = [];

const identityTheme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function createHarness(dependencies: Partial<StockTickerDependencies> = {}) {
  const handlers = new Map<string, Handler[]>();
  let command: Command | undefined;
  let commandName: string | undefined;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, registered: Command) {
      commandName = name;
      command = registered;
    },
  } as unknown as ExtensionAPI;
  stockTicker(pi, dependencies);
  return {
    get command(): Command {
      assert.ok(command);
      return command;
    },
    get commandName(): string | undefined {
      return commandName;
    },
    async emit(event: string, ctx: ExtensionContext) {
      for (const handler of handlers.get(event) ?? []) await handler({} as never, ctx);
    },
  };
}

async function createContext(mode: ExtensionContext["mode"] = "tui") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-stock-ticker-context-"));
  temporaryDirectories.push(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  const widgets: WidgetRecord[] = [];
  const notifications: [string, string | undefined][] = [];
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const ctx = {
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager,
    ui: {
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: unknown) {
        widgets.push([key, content, options]);
      },
      notify(message: string, type?: string) {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, cwd, widgets, notifications };
}

function successfulResponse(input: string | URL | Request): Promise<Response> {
  const symbol = decodeURIComponent(String(input).split("/").at(-1)?.split("?")[0] ?? "UNKNOWN");
  return Promise.resolve(
    new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                regularMarketPrice: 110,
                previousClose: 100,
                currency: "USD",
                symbol,
              },
            },
          ],
        },
      }),
    ),
  );
}

function render(record: WidgetRecord | undefined, width = 80): string[] | undefined {
  if (!record) return undefined;
  const content = record[1];
  return typeof content === "function" ? content(undefined as never, identityTheme).render(width) : content;
}

test("registers the ticker command and uses user-scoped settings", () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-ticker-agent");
  const harness = createHarness();
  assert.equal(harness.commandName, "ticker");
  assert.equal(POLL_INTERVAL_MS, 30_000);
  assert.equal(SETTINGS_FILE_NAME, "pi-ticker.json");
  assert.equal(settingsPath(), join("/tmp/pi-ticker-agent", SETTINGS_FILE_NAME));
  assert.deepEqual(
    harness.command.getArgumentCompletions("res")?.map((item) => item.value),
    ["reset"],
  );
});

test("starts empty without polling or showing a widget", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();

  await harness.emit("session_start", current.ctx);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);

  await harness.emit("session_shutdown", current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
});

test("mounts the Kit widget with callback themes and keeps publication snapshots after polling", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"]}\n');

  await harness.emit("session_start", current.ctx);
  const loadingFactory = current.widgets.find((record) => typeof record[1] === "function")?.[1];
  assert.equal(typeof loadingFactory, "function");
  if (typeof loadingFactory !== "function") throw new Error("Missing loading widget");
  const loadingWidget = loadingFactory(undefined as never, identityTheme);
  const loadingFrame = loadingWidget.render(80);
  assert.match(loadingFrame.join("\n"), /updating…/);

  await vi.advanceTimersByTimeAsync(0);
  const publication = current.widgets.at(-1);
  assert.equal(publication?.[0], WIDGET_KEY);
  assert.deepEqual(publication?.[2], { placement: "aboveEditor" });
  const factory = publication?.[1];
  if (typeof factory !== "function") throw new Error("Missing quote widget");
  const calls: [string, string][] = [];
  let color = "\u001b[31m";
  const callbackTheme = {
    fg: (role: string, text: string) => {
      calls.push([role, text]);
      return `${color}${text}\u001b[39m`;
    },
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as unknown as Theme;
  const widget = factory(undefined as never, callbackTheme);
  assert.ok(widget instanceof EditorStatusWidget);
  const frame = widget.render(80);
  const plainFrame = frame.map(stripTerminalSequences);
  assert.equal(frame[0], `\u001b[31m${"─".repeat(80)}\u001b[39m`);
  assert.ok(calls.some(([role]) => role === "muted"));
  assert.ok(calls.some(([role]) => role === "accent"));
  assert.ok(calls.some(([role]) => role === "text"));
  assert.ok(calls.some(([role]) => role === "success"));
  assert.ok(calls.some(([role]) => role === "dim"));
  assert.ok(calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(80)));
  assert.match(plainFrame.join("\n"), /NVDA \$110\.00/);

  color = "\u001b[36m";
  widget.invalidate();
  const recolored = widget.render(80);
  assert.ok(recolored.every((line) => line.includes(color) && !line.includes("\u001b[31m")));
  assert.deepEqual(recolored.map(stripTerminalSequences), plainFrame);
  const narrow = widget.render(7);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 7));
  assert.deepEqual(widget.render(0), [""]);
  assert.deepEqual(widget.render(80).map(stripTerminalSequences), plainFrame);

  fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.match(render(current.widgets.at(-1))?.join("\n") ?? "", /stale/);
  assert.deepEqual(widget.render(80).map(stripTerminalSequences), plainFrame);
  assert.deepEqual(loadingWidget.render(80), loadingFrame);
  await harness.emit("session_shutdown", current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  assert.equal(vi.getTimerCount(), 0);
});

test("aborts replaced requests and leaves no timers or late publications after shutdown", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn<typeof fetch>((_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  assert.equal(vi.getTimerCount(), 0);
  const current = await createContext();
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"]}\n');
  await harness.emit("session_start", current.ctx);
  assert.equal(signals.length, 1);
  const replacement = {
    ...current.ctx,
    sessionManager: {} as ExtensionContext["sessionManager"],
  } as ExtensionContext;
  const replacing = harness.emit("session_start", replacement);
  assert.equal(signals[0]?.aborted, true);
  await replacing;
  assert.equal(signals.length, 2);
  assert.equal(signals[1]?.aborted, false);
  await harness.emit("session_shutdown", current.ctx);
  assert.equal(signals[1]?.aborted, false);
  await harness.emit("session_shutdown", replacement);
  await harness.emit("session_shutdown", replacement);
  assert.equal(signals[1]?.aborted, true);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  const publications = current.widgets.length;
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + REQUEST_TIMEOUT_MS);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(current.widgets.length, publications);
  assert.equal(vi.getTimerCount(), 0);
});

test("ignores project-local ticker settings", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();
  const projectSettingsPath = join(current.cwd, ".pi", SETTINGS_FILE_NAME);
  await mkdir(join(current.cwd, ".pi"), { recursive: true });
  await writeFile(projectSettingsPath, '{"symbols":["NVDA"]}\n');

  await harness.emit("session_start", current.ctx);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(await readFile(projectSettingsPath, "utf8"), '{"symbols":["NVDA"]}\n');
  await harness.emit("session_shutdown", current.ctx);
});

test("sanitizes settings paths before displaying load and save errors", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();
  const unsafeAgentDirectory = join(current.cwd, "\u001b]0;owned\u0007agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", unsafeAgentDirectory);
  await mkdir(unsafeAgentDirectory, { recursive: true });
  await writeFile(join(unsafeAgentDirectory, SETTINGS_FILE_NAME), "{not json\n");

  await harness.emit("session_start", current.ctx);
  await harness.command.handler("MSFT", current.ctx);

  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(current.notifications.length, 2);
  for (const [message] of current.notifications) {
    const hasTerminalControl = [...message].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
    assert.equal(hasTerminalControl, false);
    assert.equal(message.includes("owned"), false);
  }
  await harness.emit("session_shutdown", current.ctx);
});

test("keeps a persisted disabled widget hidden and blocks manual refresh", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"],"widgetEnabled":false}\n');

  await harness.emit("session_start", current.ctx);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  await harness.command.handler("refresh", current.ctx);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.match(current.notifications.at(-1)?.[0] ?? "", /disabled/);
  await harness.emit("session_shutdown", current.ctx);
});

test("enables a persisted widget immediately through the RPC menu", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext("rpc");
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"],"widgetEnabled":false}\n');
  const rpc = createRpcHarness([
    { kind: "select", response: "Widget: Off" },
    { kind: "select", response: "Close" },
  ]);
  Object.assign(current.ctx.ui, rpc.ui);

  await harness.emit("session_start", current.ctx);
  await harness.command.handler("", current.ctx);
  await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  const settings = JSON.parse(await readFile(join(current.cwd, SETTINGS_FILE_NAME), "utf8")) as {
    widgetEnabled: boolean;
  };
  assert.equal(settings.widgetEnabled, true);
  await vi.waitFor(() => assert.match(render(current.widgets.at(-1))?.join("\n") ?? "", /NVDA \$110\.00/));
  rpc.assertConsumed();
  await harness.emit("session_shutdown", current.ctx);
});

test("disables and hides an active widget immediately through the RPC menu", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext("rpc");
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"],"widgetEnabled":true}\n');
  const rpc = createRpcHarness([
    { kind: "select", response: "Widget: On" },
    { kind: "select", response: "Close" },
  ]);
  Object.assign(current.ctx.ui, rpc.ui);

  await harness.emit("session_start", current.ctx);
  await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  await harness.command.handler("", current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  const settings = JSON.parse(await readFile(join(current.cwd, SETTINGS_FILE_NAME), "utf8")) as {
    widgetEnabled: boolean;
  };
  assert.equal(settings.widgetEnabled, false);
  rpc.assertConsumed();
  await harness.emit("session_shutdown", current.ctx);
});

test("keeps completed quotes when another symbol reaches the shared timeout", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    if (String(input).includes("NVDA")) return successfulResponse(input);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext();
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA","AAPL"]}\n');

  await harness.emit("session_start", current.ctx);
  assert.equal(fetchMock.mock.calls.length, 2);
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

  const frame = render(current.widgets.at(-1))?.join("\n") ?? "";
  assert.match(frame, /NVDA \$110\.00/);
  assert.match(frame, /AAPL unavailable/);
  assert.match(frame, /updated/);
  await harness.emit("session_shutdown", current.ctx);
});

test("keeps the last successful update time when every refresh request fails", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const harness = createHarness();
  const current = await createContext();
  await writeFile(join(current.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"]}\n');

  await harness.emit("session_start", current.ctx);
  await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  await vi.waitFor(() => assert.match(render(current.widgets.at(-1))?.join("\n") ?? "", /NVDA \$110\.00/));
  const successfulHeading = render(current.widgets.at(-1))?.find((line) => line.includes("updated"));
  assert.ok(successfulHeading);

  now.mockReturnValue(1_700_000_060_000);
  fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await harness.command.handler("refresh", current.ctx);
  await vi.waitFor(() => assert.match(render(current.widgets.at(-1))?.join("\n") ?? "", /NVDA .* stale/));
  const failedHeading = render(current.widgets.at(-1))?.find((line) => line.includes("updated"));
  assert.equal(failedHeading, successfulHeading);
  await harness.emit("session_shutdown", current.ctx);
});

test("uses plain RPC widgets and rejects commands without a UI", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const rpc = await createContext("rpc");
  await writeFile(join(rpc.cwd, SETTINGS_FILE_NAME), '{"symbols":["NVDA"]}\n');

  await harness.emit("session_start", rpc.ctx);
  await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  await vi.waitFor(() => assert.match(render(rpc.widgets.at(-1))?.join("\n") ?? "", /NVDA \$110\.00/));
  const quoteLines = rpc.widgets.at(-1)?.[1];
  assert.ok(Array.isArray(quoteLines));
  assert.deepEqual(quoteLines, [
    `Stocks · updated ${new Date(Date.now()).toLocaleTimeString()}`,
    "NVDA $110.00 +10.00 (+10.00%)",
  ]);
  const savedLines = [...quoteLines];
  fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await harness.command.handler("refresh", rpc.ctx);
  await vi.waitFor(() => assert.match(render(rpc.widgets.at(-1))?.join("\n") ?? "", /stale/));
  assert.deepEqual(quoteLines, savedLines);
  for (const [key, content, options] of rpc.widgets) {
    assert.equal(key, WIDGET_KEY);
    if (content === undefined) continue;
    assert.ok(Array.isArray(content));
    assert.deepEqual(options, { placement: "aboveEditor" });
    assert.ok(content.every((line) => line === stripTerminalSequences(line) && !line.includes("─")));
  }
  assert.ok(rpc.widgets.some((record) => Array.isArray(record[1]) && record[1][0] === "Stocks · updating"));
  await harness.command.handler("help", rpc.ctx);
  assert.match(rpc.notifications.at(-1)?.[0] ?? "", /Usage: \/ticker.*reset/);
  await harness.emit("session_shutdown", rpc.ctx);

  fetchMock.mockClear();
  const json = await createContext("json");
  await harness.emit("session_start", json.ctx);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(json.widgets.length, 0);
  await assert.rejects(harness.command.handler("help", json.ctx), /requires TUI or RPC mode/);
  await assert.rejects(harness.command.handler("NVDA", json.ctx), /requires TUI or RPC mode/);
  assert.equal(json.notifications.length, 0);
  await assert.rejects(readFile(join(json.cwd, SETTINGS_FILE_NAME)), { code: "ENOENT" });
  await harness.emit("session_shutdown", json.ctx);
});

test("waits for queued saves before a replacement session loads settings", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  let savedSymbols: string[] = [];
  let pendingSave = Promise.resolve();
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const writer: SettingsWriter = {
    save(_path, nextSymbols) {
      saveStarted();
      pendingSave = saveGate.then(() => {
        savedSymbols = [...nextSymbols];
      });
      return pendingSave;
    },
    async saveWidgetEnabled() {},
    flush: () => pendingSave,
  };
  const readSettings = vi.fn(async () => ({
    settings: { symbols: [...savedSymbols], widgetEnabled: true },
  }));
  const harness = createHarness({ createSettingsWriter: () => writer, loadSettings: readSettings });
  const current = await createContext();
  await harness.emit("session_start", current.ctx);

  const saving = harness.command.handler("MSFT", current.ctx);
  await started;
  const replacement = {
    ...current.ctx,
    sessionManager: {} as ExtensionContext["sessionManager"],
  } as ExtensionContext;
  const startingReplacement = harness.emit("session_start", replacement);
  let replacementSettled = false;
  void startingReplacement.then(() => {
    replacementSettled = true;
  });
  await Promise.resolve();

  assert.equal(readSettings.mock.calls.length, 1);
  assert.equal(replacementSettled, false);
  releaseSave();
  await saving;
  await startingReplacement;
  assert.equal(readSettings.mock.calls.length, 2);
  assert.deepEqual(savedSymbols, ["MSFT"]);
  await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  await harness.emit("session_shutdown", replacement);
});

test("opens the Kit menu for bare commands and drains it during shutdown", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const current = await createContext("rpc");
  const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
  Object.assign(current.ctx.ui, rpc.ui);

  await harness.emit("session_start", current.ctx);
  const running = harness.command.handler("", current.ctx);
  await rpc.waitForCall();
  await harness.emit("session_shutdown", current.ctx);
  await running;

  rpc.assertConsumed();
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
});

test("ignores stale session shutdown and persists command symbol changes", async () => {
  const fetchMock = vi.fn(successfulResponse);
  vi.stubGlobal("fetch", fetchMock);
  const harness = createHarness();
  const previous = await createContext();
  const current = await createContext();

  await harness.emit("session_start", previous.ctx);
  await harness.emit("session_start", current.ctx);
  const currentWidgetCount = current.widgets.length;
  await harness.emit("session_shutdown", previous.ctx);
  assert.equal(current.widgets.length, currentWidgetCount);

  await harness.command.handler("msft spy", current.ctx);
  const settings = JSON.parse(await readFile(join(current.cwd, SETTINGS_FILE_NAME), "utf8")) as {
    symbols: string[];
  };
  assert.deepEqual(settings.symbols, ["MSFT", "SPY"]);
  assert.match(current.notifications.at(-1)?.[0] ?? "", /MSFT SPY/);
  assert.equal(harness.command.getArgumentCompletions("ref") !== null, true);

  await harness.command.handler("reset", current.ctx);
  assert.match(current.notifications.at(-1)?.[0] ?? "", /No default ticker list/);
  await harness.command.handler("reset now", current.ctx);
  assert.match(current.notifications.at(-1)?.[0] ?? "", /trailing arguments/);
  await harness.command.handler("refresh now", current.ctx);
  assert.match(current.notifications.at(-1)?.[0] ?? "", /trailing arguments/);
  await harness.emit("session_shutdown", current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
});
