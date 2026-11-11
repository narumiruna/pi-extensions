import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, ModelCostRates } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import cacheHitMonitor, { COMMAND_NAME, renderCacheMonitor, WIDGET_KEY } from "../src/index.js";
import { createCacheMonitorView, createCacheSample, formatMonitorLines, sanitizeDisplayLabel } from "../src/metrics.js";

const RATES: ModelCostRates = { input: 10, output: 20, cacheRead: 1, cacheWrite: 20 };
const MODEL: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: RATES,
  contextWindow: 200_000,
  maxTokens: 10_000,
};
const THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;
type WidgetFactory = (_tui: never, theme: Theme) => Component & { dispose?(): void };
type WidgetRecord = [string, string[] | WidgetFactory | undefined, { placement: "aboveEditor" } | undefined];

function assistant(
  input: number,
  cacheRead: number,
  cacheWrite = 0,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    content: [],
    stopReason: "stop",
    timestamp: 1_000,
    usage: {
      input,
      output: 10,
      cacheRead,
      cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + 10,
      cost: {
        input: (input * RATES.input) / 1_000_000,
        output: (10 * RATES.output) / 1_000_000,
        cacheRead: (cacheRead * RATES.cacheRead) / 1_000_000,
        cacheWrite: (cacheWrite * RATES.cacheWrite) / 1_000_000,
        total: 0,
      },
    },
    ...overrides,
  };
}

function messageEntry(message: AssistantMessage): SessionEntry {
  return { type: "message", id: crypto.randomUUID(), parentId: null, message } as SessionEntry;
}

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  cacheHitMonitor(pi);
  return {
    async emit(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
      for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx);
    },
    async command(args: string, ctx: ExtensionContext) {
      const handler = commands.get(COMMAND_NAME);
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

function createContext(mode: ExtensionContext["mode"] = "tui", initialEntries: SessionEntry[] = []) {
  let entries = initialEntries;
  const widgets: WidgetRecord[] = [];
  const notifications: [string, "info" | "warning" | "error" | undefined][] = [];
  const sessionManager = {
    getBranch: () => entries,
  } as unknown as ExtensionContext["sessionManager"];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager,
    modelRegistry: {
      find: () => MODEL,
    },
    ui: {
      notify(message: string, level?: "info" | "warning" | "error") {
        notifications.push([message, level]);
      },
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement: "aboveEditor" }) {
        widgets.push([key, content, options]);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    notifications,
    widgets,
    setEntries(next: SessionEntry[]) {
      entries = next;
    },
  };
}

function renderWidget(record: WidgetRecord | undefined, width = 100): string[] | undefined {
  if (!record) return undefined;
  const content = record[1];
  return typeof content === "function" ? content(undefined as never, THEME).render(width) : content;
}

test("stays hidden by default, then previews and finalizes detailed metrics when shown", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", {}, current.ctx);
  assert.equal(current.widgets.length, 0);

  await harness.command("", current.ctx);
  assert.deepEqual(current.notifications, [["Cache hit monitor shown.", "info"]]);
  const waiting = renderWidget(current.widgets.at(-1), 160);
  assert.match(waiting?.[0] ?? "", /Cache hit monitor · waiting for provider cache usage/u);
  assert.deepEqual(waiting?.slice(1), ["Cache usage is unknown until this provider reports cache activity."]);

  const first = assistant(200, 800);
  await harness.emit("message_update", { message: first, assistantMessageEvent: {} }, current.ctx);
  const live = renderWidget(current.widgets.at(-1));
  assert.match(live?.[0] ?? "", /Cache hit monitor · LIVE · request #1/u);
  assert.equal(live?.[1], "test-provider/test-model");
  assert.match(live?.join("\n") ?? "", /LIVE.*hit 80\.0%/s);
  assert.doesNotMatch(live?.slice(1).join("\n") ?? "", /Prompt cache|LIVE|request #1|Formula|hit=read\/prompt/u);
  const updateCount = current.widgets.length;
  const outputDelta = assistant(200, 800, 0, {
    content: [{ type: "text", text: "more generated text" }],
  });
  outputDelta.usage.output = 20;
  outputDelta.usage.totalTokens += 10;
  outputDelta.usage.cost.output = (20 * RATES.output) / 1_000_000;
  await harness.emit("message_update", { message: outputDelta, assistantMessageEvent: {} }, current.ctx);
  assert.equal(current.widgets.length, updateCount);

  await harness.emit("message_end", { message: first }, current.ctx);
  assert.doesNotMatch(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);

  const second = assistant(400, 600, 100, { timestamp: 3_000 });
  await harness.emit("message_update", { message: second, assistantMessageEvent: {} }, current.ctx);
  const compared = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(compared, /loss 25\.5 pp/);
  assert.match(compared, /re-billed 400 \(40\.0%\)/);
  assert.match(compared, /miss premium ~\$0\.0044/);
});

test("does not display all-zero cache fields until the provider reports cache activity", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  const waitingCount = current.widgets.length;

  await harness.emit("message_update", { message: assistant(1_000, 0) }, current.ctx);
  assert.equal(current.widgets.length, waitingCount);
  assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /waiting/);

  const cached = assistant(200, 800);
  await harness.emit("message_update", { message: cached }, current.ctx);
  await harness.emit("message_end", { message: cached }, current.ctx);
  await harness.emit("message_update", { message: assistant(1_000, 0, 0, { timestamp: 2_000 }) }, current.ctx);
  const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /hit 0\.0%/);
  assert.match(rendered, /re-billed 1k \(100\.0%\)/);
  assert.match(rendered, /miss premium ~\$0\.0090/);
});

test("the command toggles the widget closed and rejects arguments", async () => {
  const harness = createHarness();
  const current = createContext("tui", [messageEntry(assistant(200, 800))]);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /hit 80\.0%/);

  await harness.command("", current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  assert.deepEqual(current.notifications, [
    ["Cache hit monitor shown.", "info"],
    ["Cache hit monitor hidden.", "info"],
  ]);
  await assert.rejects(() => harness.command("unexpected", current.ctx), {
    message: `Usage: /${COMMAND_NAME}`,
  });
});

test("clears a partial live preview if an agent run ends without a final message", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  await harness.emit("message_update", { message: assistant(200, 800) }, current.ctx);
  assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);

  await harness.emit("agent_end", { messages: [] }, current.ctx);
  assert.doesNotMatch(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);
  assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /waiting for provider cache usage/);
});

test("restores active-branch history and resets comparison at the compaction boundary", async () => {
  const first = assistant(200, 800);
  const second = assistant(400, 600, 0, { timestamp: 2_000 });
  const harness = createHarness();
  const current = createContext("tui", [messageEntry(first), messageEntry(second)]);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /Reuse vs #1/);

  current.setEntries([
    messageEntry(first),
    messageEntry(second),
    { type: "compaction", id: "compact", parentId: null } as SessionEntry,
  ]);
  await harness.emit("session_compact", {}, current.ctx);
  let rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /request #2.*hit 60\.0%/s);
  assert.match(rendered, /no comparable request in the current cache epoch/);

  const afterCompaction = assistant(900, 100, 0, { timestamp: 4_000 });
  current.setEntries([
    messageEntry(first),
    messageEntry(second),
    { type: "compaction", id: "compact", parentId: null } as SessionEntry,
    messageEntry(afterCompaction),
  ]);
  await harness.emit("session_compact", {}, current.ctx);
  rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /request #3.*hit 10\.0%/s);
  assert.match(rendered, /no comparable request in the current cache epoch/);
  assert.match(rendered, /Session {2}3 req/);
  assert.match(rendered, /re-billed\s+400/);
});

test("reconciles confirmed idle cache-warm usage at a settled boundary", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);

  const warm = assistant(100, 900);
  current.setEntries([
    {
      type: "usage",
      id: "warm-1",
      parentId: null,
      kind: "cache_warm",
      provider: "test-provider",
      model: "test-model",
      usage: warm.usage,
    } as SessionEntry,
  ]);
  await harness.emit("agent_settled", {}, current.ctx);

  const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /aggregate usage only/);
  assert.match(rendered, /Session {2}1 req.*hit 90\.0%/);
});

test("renders restored totals for a summary-only branch", async () => {
  const summary = assistant(100, 900);
  const harness = createHarness();
  const current = createContext("tui", [
    {
      type: "branch_summary",
      id: "branch-summary",
      parentId: null,
      usage: summary.usage,
    } as SessionEntry,
  ]);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);

  const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /aggregate usage only/);
  assert.match(rendered, /Session {2}1 req.*hit 90\.0%/);
});

test("renders restored summary totals when cache accounting is unavailable", async () => {
  const summary = assistant(1_000, 0);
  const harness = createHarness();
  const current = createContext("tui", [
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      usage: summary.usage,
    } as SessionEntry,
  ]);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);

  const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
  assert.match(rendered, /aggregate usage only/);
  assert.match(rendered, /Session {2}1 req.*hit n\/a.*uncached 1k.*cost \$0\.010.*saved ~n\/a/);
});

test("clears replacement UI and ignores stale replacement-session events", async () => {
  const harness = createHarness();
  const previous = createContext();
  const current = createContext();
  await harness.emit("session_start", {}, previous.ctx);
  await harness.command("", previous.ctx);
  await harness.emit("session_start", {}, current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  await harness.command("", current.ctx);
  const currentCount = current.widgets.length;

  await harness.emit("message_update", { message: assistant(100, 900) }, previous.ctx);
  await harness.emit("session_shutdown", {}, previous.ctx);
  assert.equal(current.widgets.length, currentCount);

  await harness.emit("session_shutdown", {}, current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
  const shutdownWrites = current.widgets.length;
  await harness.emit("session_shutdown", {}, current.ctx);
  await harness.emit("message_update", { message: assistant(100, 900) }, current.ctx);
  assert.equal(current.widgets.length, shutdownWrites);
});

test("uses plain string widgets in RPC mode and remains silent without UI", async () => {
  const harness = createHarness();
  const rpc = createContext("rpc", [messageEntry(assistant(200, 800))]);
  await harness.emit("session_start", {}, rpc.ctx);
  assert.equal(rpc.widgets.length, 0);
  await harness.command("", rpc.ctx);
  const rpcContent = rpc.widgets.at(-1)?.[1];
  assert.ok(Array.isArray(rpcContent));
  const sample = createCacheSample(assistant(200, 800), 0, MODEL);
  assert.ok(sample);
  assert.deepEqual(
    rpcContent,
    formatMonitorLines(createCacheMonitorView([sample])).map(({ text }) => text),
  );
  assert.match(rpcContent.join("\n"), /Prompt cache.*request #1/);
  assert.match(rpcContent.join("\n"), /Formula {2}hit=read\/prompt/);
  await harness.emit("session_shutdown", {}, rpc.ctx);

  for (const mode of ["print", "json"] as const) {
    const context = createContext(mode, [messageEntry(assistant(200, 800))]);
    await harness.emit("session_start", {}, context.ctx);
    assert.equal(context.widgets.length, 0);
    await assert.rejects(() => harness.command("", context.ctx), {
      message: `/${COMMAND_NAME} requires TUI or RPC mode.`,
    });
    await harness.emit("session_shutdown", {}, context.ctx);
  }
});

test.each([0, 1, 2, 12, 80, 200, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 12.9])(
  "preserves styled body wrapping and bounds at width %s",
  (width) => {
    const sample = createCacheSample(assistant(200, 800, 0, { model: "界界e\u0301_model" }), 0, MODEL);
    assert.ok(sample);
    const view = createCacheMonitorView([sample]);
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const roles = {
      title: "accent",
      good: "success",
      warning: "warning",
      bad: "error",
      muted: "muted",
      dim: "dim",
    } as const;
    const theme = {
      fg: (role: string, text: string) => `\u001b[${role === "borderMuted" ? "90" : "32"}m${text}\u001b[0m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    } as unknown as Theme;
    const lines = renderCacheMonitor(view, theme, width);
    const report = formatMonitorLines(view);
    const body = [
      {
        role: "title" as const,
        text: `${sanitizeDisplayLabel(sample.provider)}/${sanitizeDisplayLabel(sample.model)}`,
      },
      ...report.slice(1, -1),
    ].flatMap((line) =>
      normalized === 0
        ? [""]
        : wrapTextWithAnsi(
            theme.fg(roles[line.role], line.role === "title" ? theme.bold(line.text) : line.text),
            normalized,
          ),
    );
    assert.deepEqual(
      lines.slice(1),
      body.map((line) => truncateToWidth(line, normalized, "")),
    );
    assert.equal(visibleWidth(lines[0] ?? ""), normalized);
    if (normalized >= 40) assert.match(stripTerminalSequences(lines[0] ?? ""), /^─ ▾ Cache hit monitor · request #1/u);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 0) assert.ok(lines.every((line) => line === ""));
  },
);

test.each(["waiting", "aggregate", "unknown aggregate", "latest", "live"] as const)(
  "keeps %s state in the divider without repeating the title or formula",
  (state) => {
    const sample = createCacheSample(assistant(200, 800), 0, MODEL);
    assert.ok(sample);
    const view =
      state === "live"
        ? createCacheMonitorView([], sample)
        : state === "latest"
          ? createCacheMonitorView([sample])
          : createCacheMonitorView([], undefined, {
              summaryRecords:
                state === "waiting"
                  ? []
                  : state === "aggregate"
                    ? [sample]
                    : [
                        {
                          input: 1_000,
                          cacheRead: 0,
                          cacheWrite: 0,
                          promptTokens: 1_000,
                          hitRatePercent: null,
                          uncachedRatePercent: null,
                          promptCost: 0.01,
                          estimatedSavings: null,
                        },
                      ],
            });
    const summary =
      state === "live"
        ? "LIVE · request #1"
        : state === "latest"
          ? "request #1"
          : state === "waiting"
            ? "waiting for provider cache usage"
            : "aggregate usage only";
    const lines = renderCacheMonitor(view, THEME, 200);
    assert.ok(lines[0]?.includes(`Cache hit monitor · ${summary}`));
    const body = lines.slice(1).join("\n");
    assert.doesNotMatch(body, /Prompt cache|Formula|hit=read\/prompt|Hit = cacheRead/u);
    if (state === "waiting") {
      assert.match(body, /Cache usage is unknown/u);
      assert.doesNotMatch(body, /hit 0\.0%|read 0|write 0/u);
    } else if (state === "unknown aggregate") {
      assert.match(body, /Session {2}1 req.*hit n\/a.*saved ~n\/a/u);
      assert.doesNotMatch(body, /hit 0\.0%/u);
    } else if (state === "aggregate") {
      assert.match(body, /Session {2}1 req.*hit 80\.0%/u);
      assert.match(body, /Latest request metrics are unavailable/u);
    } else {
      assert.equal(lines[1], "test-provider/test-model");
      assert.match(body, /Latest {2}hit 80\.0%/u);
    }
    for (const width of [40, 12, 2, 1, 0]) {
      const narrow = renderCacheMonitor(view, THEME, width);
      assert.ok(narrow.every((line) => visibleWidth(line) <= width));
      assert.equal(visibleWidth(narrow[0] ?? ""), width);
      if (width === 0) assert.ok(narrow.every((line) => line === ""));
    }
  },
);

test("uses the callback theme after resize and invalidation without changing publication caching", async () => {
  const harness = createHarness();
  const current = createContext("tui", [messageEntry(assistant(200, 800))]);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  const record = current.widgets.at(-1);
  assert.equal(record?.[0], WIDGET_KEY);
  assert.deepEqual(record?.[2], { placement: "aboveEditor" });
  const factory = record?.[1];
  assert.equal(typeof factory, "function");
  if (typeof factory !== "function") return;
  let color = "\u001b[31m";
  const fg = vi.fn((_role: string, text: string) => `${color}${text}\u001b[0m`);
  const component = factory(undefined as never, { fg, bold: (text: string) => text } as unknown as Theme);
  for (const width of [0, 1, 2, 40, 160, 12, 160]) {
    fg.mockClear();
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width === 0) {
      assert.ok(lines.every((line) => line === ""));
      assert.equal(fg.mock.calls.length, 0);
    } else {
      if (width > 2) assert.ok(fg.mock.calls.some(([role]) => role === "borderMuted"));
      if (width >= 40) assert.match(stripTerminalSequences(lines[0] ?? ""), /^─ ▾ Cache hit monitor · request #1/u);
      assert.ok(fg.mock.calls.some(([role]) => role === "accent"));
      assert.ok(fg.mock.calls.some(([role]) => role === "success"));
    }
  }
  color = "\u001b[32m";
  component.invalidate();
  const lines = component.render(160);
  assert.ok(lines.every((line) => line.startsWith(color)));
  assert.equal(current.widgets.length, 1);
  await harness.emit("session_tree", {}, current.ctx);
  assert.equal(current.widgets.length, 1);
  assert.equal(current.widgets.at(-1)?.[1], factory);
  await harness.emit("session_shutdown", {}, current.ctx);
});

function clickWidget(component: Component, event: TuiMouseEvent) {
  component.handleMouse?.({ ...event, type: "press" });
  component.render(event.width);
  component.handleMouse?.({ ...event, type: "release" });
  return component.handleMouse?.({ ...event, type: "click" });
}

test("body and blank-column clicks retain collapse across usage remounts and restore the latest data", async () => {
  const harness = createHarness();
  const current = createContext("tui", [messageEntry(assistant(200, 800))]);
  const mount = () => {
    const factory = current.widgets.at(-1)?.[1];
    assert.equal(typeof factory, "function");
    if (typeof factory !== "function") throw new Error("Missing monitor widget");
    return factory(undefined as never, THEME);
  };
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  const first = mount();
  const lines = first.render(160);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 159,
    y: lines.length - 1,
    screenX: 159,
    screenY: lines.length - 1,
    width: 160,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.deepEqual(clickWidget(first, event), { handled: true, render: true });
  assert.equal(first.render(160).length, 1);
  first.dispose?.();
  await harness.emit("message_update", { message: assistant(100, 900) }, current.ctx);
  const updated = mount();
  assert.equal(updated.render(160).length, 1);
  assert.match(updated.render(160)[0] ?? "", /▸ Cache hit monitor · LIVE · request #2/u);
  assert.doesNotMatch(updated.render(160)[0] ?? "", /test-provider|Formula/u);
  const collapsed = { ...event, y: 0, screenY: 0, height: updated.render(160).length };
  assert.deepEqual(clickWidget(updated, collapsed), { handled: true, render: true });
  assert.match(updated.render(160).join("\n"), /LIVE.*hit 90\.0%/s);
  const narrow = updated.render(32);
  assert.ok(narrow.length > lines.length, "wrapped metrics change the click height");
  assert.deepEqual(
    clickWidget(updated, {
      ...event,
      x: 31,
      screenX: 31,
      width: 32,
      y: narrow.length - 1,
      screenY: narrow.length - 1,
      height: narrow.length,
    }),
    { handled: true, render: true },
  );
  assert.equal(updated.render(160).length, 1);
  updated.dispose?.();
  updated.dispose?.();
  assert.equal(clickWidget(updated, collapsed), undefined);
  await harness.emit("message_end", { message: assistant(100, 900) }, current.ctx);
  const finalized = mount();
  assert.equal(finalized.render(160).length, 1);
  assert.match(finalized.render(160)[0] ?? "", /▸ Cache hit monitor · request #2/u);
  assert.doesNotMatch(finalized.render(160)[0] ?? "", /LIVE/u);
  finalized.dispose?.();
  await harness.command("", current.ctx);
  await harness.command("", current.ctx);
  assert.ok(mount().render(160).length > 1, "show command restores the body");
  await harness.emit("session_shutdown", {}, current.ctx);
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  assert.ok(mount().render(160).length > 1, "new session starts expanded");
  await harness.emit("session_shutdown", {}, current.ctx);
});

test("waiting becomes aggregate-only in the collapsed divider without implying a zero hit rate", async () => {
  const harness = createHarness();
  const current = createContext();
  const mount = () => {
    const factory = current.widgets.at(-1)?.[1];
    if (typeof factory !== "function") throw new Error("Missing monitor widget");
    return factory(undefined as never, THEME);
  };
  await harness.emit("session_start", {}, current.ctx);
  await harness.command("", current.ctx);
  const waiting = mount();
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 159,
    y: 1,
    screenX: 159,
    screenY: 1,
    width: 160,
    height: waiting.render(160).length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.deepEqual(clickWidget(waiting, event), { handled: true, render: true });
  assert.equal(waiting.render(160).length, 1);
  assert.match(waiting.render(160)[0] ?? "", /▸ Cache hit monitor · waiting for provider cache usage/u);
  waiting.dispose?.();
  current.setEntries([
    {
      type: "usage",
      id: "unknown-warm",
      parentId: null,
      kind: "cache_warm",
      provider: "test-provider",
      model: "test-model",
      usage: assistant(1_000, 0).usage,
    } as SessionEntry,
  ]);
  await harness.emit("agent_settled", {}, current.ctx);
  const aggregate = mount();
  assert.equal(aggregate.render(160).length, 1);
  assert.match(aggregate.render(160)[0] ?? "", /▸ Cache hit monitor · aggregate usage only/u);
  assert.doesNotMatch(aggregate.render(160)[0] ?? "", /waiting|0\.0%/u);
  assert.deepEqual(clickWidget(aggregate, { ...event, y: 0, screenY: 0, height: 1 }), { handled: true, render: true });
  assert.match(aggregate.render(200).join("\n"), /Session {2}1 req.*hit n\/a/u);
  aggregate.dispose?.();
  await harness.emit("session_shutdown", {}, current.ctx);
  assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
});

test("renders every line within narrow widths and strips unsafe model text", () => {
  const sample = createCacheSample(
    assistant(200, 800, 0, {
      provider: "\u001b]8;;bad\u0007provider",
      model: "model\n\u202eunsafe",
    }),
    0,
    MODEL,
  );
  assert.ok(sample);
  const view = createCacheMonitorView([sample]);
  const lines = renderCacheMonitor(view, THEME, 32);
  const plain = lines.map(stripTerminalSequences);
  const zeroWidthLines = renderCacheMonitor(view, THEME, 0);

  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
  assert.equal(zeroWidthLines.length, formatMonitorLines(view).length);
  assert.ok(zeroWidthLines.every((line) => line === ""));
  assert.match(plain.join("\n"), /provider\/model unsafe/);
  assert.ok(
    plain.every((line) =>
      [...line].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (codePoint >= 32 || character === "\n") && codePoint !== 127 && codePoint !== 0x202e;
      }),
    ),
  );
});
