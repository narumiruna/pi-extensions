import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen, runConfirmation, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type AnalyticsMenuDataSource,
  type AnalyticsMenuState,
  createAnalyticsMenu,
  showAnalyticsMenu,
} from "../src/menu.js";
import type { AnalyticsSnapshot } from "../src/storage/queries.js";

initTheme("dark", false);

const confirmationOptions = { runConfirmation, isCurrent: () => true };

const snapshot: AnalyticsSnapshot = {
  overview: {
    responseCycles: 83,
    llmCalls: 192,
    callsPerResponse: 2.31,
    p95CallsPerResponse: 6,
    toolCalls: 414,
    toolErrors: 7,
    skillActivations: 31,
    providerErrors: 4,
    recoveredErrors: 3,
  },
  skills: [
    {
      name: "reviewing-code",
      count: 18,
      modelInitiated: 13,
      userInitiated: 5,
      lastOccurredAtMs: 1_786_000_000_000,
      models: [{ provider: "openai", model: "gpt-test", count: 18 }],
    },
  ],
  tools: [
    {
      name: "read",
      count: 182,
      errors: 2,
      averageDurationMs: 12.5,
      lastOccurredAtMs: 1_786_000_000_000,
      models: [{ provider: "openai", model: "gpt-test", count: 182 }],
    },
  ],
  reliability: {
    http429: 3,
    http5xx: 1,
    recovered: 3,
    terminal: 1,
    categories: {
      dns: 0,
      timeout: 2,
      connection_refused: 0,
      connection_reset: 1,
      tls: 0,
      network_other: 0,
      provider_other: 0,
    },
  },
  responses: {
    count: 83,
    llmCalls: 192,
    average: 2.31,
    median: 2,
    p95: 6,
    maximum: 9,
    distribution: { one: 31, twoToThree: 34, fourToSix: 15, sevenPlus: 3 },
    models: [
      { provider: "router", model: "auto", responseModel: "concrete-a", count: 100 },
      { provider: "router", model: "auto", responseModel: "concrete-b", count: 50 },
      { provider: "router", model: "auto", responseModel: "auto", count: 20 },
      { provider: "router", model: "auto", count: 22 },
    ],
  },
};

function source(overrides: Partial<AnalyticsMenuDataSource> = {}): AnalyticsMenuDataSource {
  return {
    path: "/home/test/.pi/agent/pi-analytics",
    async load() {
      return { kind: "ready", snapshot };
    },
    async clearAll() {
      return { cleanupIncomplete: false };
    },
    ...overrides,
  };
}

async function state(controller: ReturnType<typeof createAnalyticsMenu>): Promise<AnalyticsMenuState> {
  return controller.getState({ signal: new AbortController().signal });
}

function withRpcUi(context: ReturnType<typeof createMockContext>, rpc: ReturnType<typeof createRpcHarness>) {
  const base = context.ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  return { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
}

test("dashboard exposes seven primary rows and concise settled metrics", async () => {
  const controller = createAnalyticsMenu(source());
  const screen = resolveMenuScreen(controller.menu, "main", await state(controller));
  assert.equal(screen.kind, "actions");
  if (screen.kind !== "actions") return;
  assert.equal(screen.items.length, 7);
  assert.deepEqual(
    screen.items.map(({ label }) => label),
    ["Change time range", "Skills", "Tools", "Provider reliability", "Response cycles", "Data & privacy", "Close"],
  );
  assert.match(screen.title, /Last 7 days/);
  assert.match(screen.lines?.join("\n") ?? "", /Response cycles\s+83/);
  assert.match(screen.lines?.join("\n") ?? "", /Includes settled response cycles only/);
});

test("skill and tool browse details preserve attribution and model breakdowns", async () => {
  const controller = createAnalyticsMenu(source());
  const current = await state(controller);
  const skills = resolveMenuScreen(controller.menu, "skills", current);
  const tools = resolveMenuScreen(controller.menu, "tools", current);
  assert.equal(skills.kind, "browse");
  assert.equal(tools.kind, "browse");
  if (skills.kind !== "browse" || tools.kind !== "browse") return;
  assert.equal(skills.items[0]?.statusText, "18 · 13 model / 5 user");
  assert.match(skills.items[0]?.details?.join("\n") ?? "", /openai\/gpt-test: 18/);
  assert.equal(tools.items[0]?.statusText, "182 · 2 errors");
  assert.match(tools.items[0]?.details?.join("\n") ?? "", /Average duration: 12.5 ms/);
});

test("response details distinguish requested, identical, routed, and unreported model IDs", async () => {
  const controller = createAnalyticsMenu(source());
  const screen = resolveMenuScreen(controller.menu, "responses", await state(controller));
  assert.equal(screen.kind, "review");
  if (screen.kind !== "review") return;
  const lines = screen.content;
  assert.ok(lines.includes("Requested: router/auto · Calls: 100\n  Reported: concrete-a"));
  assert.ok(lines.includes("Requested: router/auto · Calls: 50\n  Reported: concrete-b"));
  assert.ok(lines.includes("Requested: router/auto · Calls: 20\n  Reported: auto"));
  assert.ok(lines.includes("Requested: router/auto · Calls: 22\n  Reported: not reported"));
});

test("dashboard strips terminal controls from stored labels, models, and paths", async () => {
  const baseSkill = snapshot.skills[0];
  assert.ok(baseSkill);
  const unsafe = {
    ...snapshot,
    responses: {
      ...snapshot.responses,
      models: [
        {
          provider: "provider\u001b[31m",
          model: "requested\u009b31m\nmodel",
          responseModel: "reported\u001b]8;;https://evil.example\u0007model\u000d\u009f",
          count: 1,
        },
      ],
    },
    skills: [
      {
        ...baseSkill,
        name: "skill\u001b]8;;https://evil.example\u0007name",
        models: [{ provider: "provider\u001b[31m", model: "model\u009b31m", count: 1 }],
      },
    ],
  };
  const controller = createAnalyticsMenu(
    source({
      path: "/tmp/path\u001b]0;owned\u0007",
      async load() {
        return { kind: "ready", snapshot: unsafe };
      },
    }),
  );
  const current = await state(controller);
  const skills = resolveMenuScreen(controller.menu, "skills", current);
  const privacy = resolveMenuScreen(controller.menu, "privacy", current);
  const responses = resolveMenuScreen(controller.menu, "responses", current);
  assert.equal(responses.kind, "review");
  assert.equal(skills.kind, "browse");
  assert.equal(privacy.kind, "actions");
  if (skills.kind !== "browse" || privacy.kind !== "actions" || responses.kind !== "review") return;
  assert.equal((skills.items[0]?.id ?? "").includes("\u001b"), true);
  assert.doesNotMatch(
    JSON.stringify({
      item: {
        label: skills.items[0]?.label,
        searchText: skills.items[0]?.searchText,
        details: skills.items[0]?.details,
      },
      lines: privacy.lines,
      responses: responses.content,
    }),
    /\\u00(?:1b|07|9b|9f|0d)|\\nmodel/iu,
  );
  assert.equal(unsafe.responses.models[0]?.responseModel.includes("\u001b"), true);
  assert.match(responses.content, /Requested: provider\/requested model · Calls: 1/);
  assert.match(responses.content, /Reported: reportedmodel/);
});

test("range selection updates the next state load without creating settings", async () => {
  const loaded: string[] = [];
  const controller = createAnalyticsMenu(
    source({
      async load(range) {
        loaded.push(range.id ?? "custom");
        return { kind: "ready", snapshot };
      },
    }),
  );
  await state(controller);
  const action = controller.menu.actions.setRange;
  await action({
    ctx: createMockContext({ hasUI: true, mode: "rpc" }).ctx,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "30d",
  });
  await state(controller);
  assert.deepEqual(loaded, ["7d", "30d"]);
});

test("clear cancellation is side-effect free and confirmation clears committed rows", async () => {
  let clears = 0;
  const controller = createAnalyticsMenu(
    source({
      async clearAll() {
        clears += 1;
        return { cleanupIncomplete: false };
      },
    }),
    Date.now,
    confirmationOptions,
  );
  const current = await state(controller);
  const cancelledRpc = createRpcHarness([{ kind: "select", response: undefined }]);
  const cancelled = createMockContext({ hasUI: true, mode: "rpc" });
  await controller.menu.actions.clearData({
    ctx: withRpcUi(cancelled, cancelledRpc),
    state: current,
    signal: new AbortController().signal,
    itemId: "clear",
  });
  cancelledRpc.assertConsumed();
  assert.equal(clears, 0);
  assert.match(cancelledRpc.dialogs[0]?.title ?? "", /clear all local analytics history/i);
  assert.match(cancelledRpc.dialogs[0]?.title ?? "", /selected range currently shows 83 response cycles/i);

  const confirmedRpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
  const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
  await controller.menu.actions.clearData({
    ctx: withRpcUi(confirmed, confirmedRpc),
    state: current,
    signal: new AbortController().signal,
    itemId: "clear",
  });
  confirmedRpc.assertConsumed();
  assert.equal(clears, 1);
  assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
});

test("TUI Ctrl+C closes the dashboard from clear confirmation without deleting data", async () => {
  let clears = 0;
  const controller = createAnalyticsMenu(
    source({
      async clearAll() {
        clears += 1;
        return { cleanupIncomplete: false };
      },
    }),
    Date.now,
    confirmationOptions,
  );
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const context = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
  const clearing = controller.menu.actions.clearData({
    ctx: context.ctx,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "clear",
  });
  await tui.waitForOpen();
  tui.press("ctrl+c");
  assert.deepEqual(await clearing, { kind: "close" });
  assert.equal(clears, 0);
});

test("stale and failed clear confirmations never delete analytics", async () => {
  let clears = 0;
  const analyticsSource = source({
    async clearAll() {
      clears += 1;
      return { cleanupIncomplete: false };
    },
  });
  const stale = createAnalyticsMenu(analyticsSource, Date.now, {
    runConfirmation,
    isCurrent: () => false,
  });
  const staleContext = createMockContext({ hasUI: true, mode: "rpc" });
  assert.deepEqual(
    await stale.menu.actions.clearData({
      ctx: staleContext.ctx,
      state: await state(stale),
      signal: new AbortController().signal,
      itemId: "clear",
    }),
    { kind: "close" },
  );

  const failed = createAnalyticsMenu(analyticsSource, Date.now, confirmationOptions);
  const failedContext = createMockContext({
    hasUI: true,
    mode: "rpc",
    select: async () => {
      throw new Error("confirmation transport failed");
    },
  });
  await assert.rejects(
    Promise.resolve(
      failed.menu.actions.clearData({
        ctx: failedContext.ctx,
        state: await state(failed),
        signal: new AbortController().signal,
        itemId: "clear",
      }),
    ),
    /confirmation transport failed/u,
  );
  assert.equal(clears, 0);
});

test("clear reports obsolete files that could not be removed", async () => {
  const controller = createAnalyticsMenu(
    source({
      async clearAll() {
        return { cleanupIncomplete: true };
      },
    }),
    Date.now,
    confirmationOptions,
  );
  const current = await state(controller);
  const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
  const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
  await controller.menu.actions.clearData({
    ctx: withRpcUi(confirmed, rpc),
    state: current,
    signal: new AbortController().signal,
    itemId: "clear",
  });
  rpc.assertConsumed();
  assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
  assert.match(confirmed.notifications[1]?.message ?? "", /still in use/);
});

test("clear completion remains visible when cancellation races after confirmation", async () => {
  let startedClear!: () => void;
  const started = new Promise<void>((resolve) => {
    startedClear = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = createAnalyticsMenu(
    source({
      async clearAll() {
        startedClear();
        await blocked;
        return { cleanupIncomplete: false };
      },
    }),
    Date.now,
    confirmationOptions,
  );
  const current = await state(controller);
  const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
  const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
  const owner = new AbortController();
  const clearing = controller.menu.actions.clearData({
    ctx: withRpcUi(confirmed, rpc),
    state: current,
    signal: owner.signal,
    itemId: "clear",
  });
  await started;
  owner.abort();
  release();
  assert.deepEqual(await clearing, { kind: "close" });
  rpc.assertConsumed();
  assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
});

test("session replacement after committed clear suppresses stale UI publication", async () => {
  let startedClear!: () => void;
  const started = new Promise<void>((resolve) => {
    startedClear = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = true;
  const controller = createAnalyticsMenu(
    source({
      async clearAll() {
        startedClear();
        await blocked;
        return { cleanupIncomplete: false };
      },
    }),
    Date.now,
    { runConfirmation, isCurrent: () => current },
  );
  const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
  const context = createMockContext({ hasUI: true, mode: "rpc" });
  const clearing = controller.menu.actions.clearData({
    ctx: withRpcUi(context, rpc),
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "clear",
  });
  await started;
  current = false;
  release();
  assert.deepEqual(await clearing, { kind: "close" });
  rpc.assertConsumed();
  assert.equal(context.notifications.length, 0);
});

test("empty and unavailable states remain actionable", async () => {
  const emptySnapshot: AnalyticsSnapshot = {
    ...snapshot,
    overview: { ...snapshot.overview, responseCycles: 0 },
    skills: [],
    tools: [],
  };
  const empty = createAnalyticsMenu(
    source({
      async load() {
        return { kind: "ready", snapshot: emptySnapshot };
      },
    }),
  );
  const emptyMain = resolveMenuScreen(empty.menu, "main", await state(empty));
  assert.match(emptyMain.lines?.join("\n") ?? "", /No analytics yet/);
  const unavailable = createAnalyticsMenu(
    source({
      async load() {
        return { kind: "unavailable", message: "Native binding unavailable on linux-arm64-musl" };
      },
    }),
  );
  const unavailableMain = resolveMenuScreen(unavailable.menu, "main", await state(unavailable));
  assert.match(unavailableMain.lines?.join("\n") ?? "", /No analytics are being collected/);
  assert.match(unavailableMain.lines?.join("\n") ?? "", /linux-arm64-musl/);
});

test("RPC adapts the same dashboard without opening custom TUI", async () => {
  const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
  const base = createMockContext({ hasUI: true, mode: "rpc" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const ctx = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  const owner = new AbortController();
  await showAnalyticsMenu(ctx, source(), {
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
  });
  rpc.assertConsumed();
});

test("RPC response details expose requested and reported models without custom TUI", async () => {
  const rpc = createRpcHarness([
    { kind: "select", response: "Response cycles" },
    { kind: "select", response: "Next" },
    { kind: "select", response: "Next" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Close" },
  ]);
  const context = createMockContext({ hasUI: true, mode: "rpc" });
  await showAnalyticsMenu(withRpcUi(context, rpc), source(), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  rpc.assertConsumed();
  const pages = rpc.dialogs
    .slice(1, -1)
    .map(({ title }) => title)
    .join("\n");
  assert.match(pages, /Requested: router\/auto · Calls: 100/);
  for (const reported of ["concrete-a", "concrete-b", "auto", "not reported"]) {
    assert.ok(pages.includes(`Reported: ${reported}`));
  }
});

test("TUI response details scroll to every model at normal and constrained heights", async () => {
  const longModel = `concrete-long-${"x".repeat(180)}-tail`;
  const controller = createAnalyticsMenu(
    source({
      async load() {
        return {
          kind: "ready",
          snapshot: {
            ...snapshot,
            responses: {
              ...snapshot.responses,
              models: [
                ...snapshot.responses.models,
                {
                  provider: "router",
                  model: "auto",
                  responseModel: longModel,
                  count: 1,
                },
              ],
            },
          },
        };
      },
    }),
  );
  const bindings: Record<string, KeyId> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.cancel": "q",
  };
  const tui = createTuiHarness({
    width: 80,
    rows: 24,
    keybindings: {
      matches: (data, binding) => Boolean(bindings[binding] && matchesKey(data, bindings[binding])),
      getKeys: (binding) => (bindings[binding] ? [bindings[binding]] : []),
    },
  });
  const context = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
  const running = runMenu(
    context.ctx,
    { ...controller.menu, start: "responses" },
    {
      getState: controller.getState,
    },
  );
  await tui.waitForOpen();
  for (const rows of [24, 12, 5]) {
    tui.resize({ width: 80, rows });
    tui.press("home");
    const frames: string[] = [];
    for (let offset = 0; offset < 50; offset += 1) {
      const lines = tui.render();
      assert.ok(lines.length <= rows - 3);
      frames.push(stripVTControlCharacters(lines.join("\n")));
      tui.send("j");
    }
    const visible = frames.join("\n");
    for (const reported of ["concrete-a", "concrete-b", "auto", "not reported", "concrete-long-"]) {
      assert.ok(visible.includes(`Reported: ${reported}`), `${reported} at ${rows} rows`);
    }
    assert.ok(visible.includes("-tail"), `long ID tail at ${rows} rows`);
    tui.press("end");
    assert.match(stripVTControlCharacters(tui.render().join("\n")), /-tail/);
  }
  for (const width of [1, 8, 40, 100]) {
    tui.resize({ width, rows: 24 });
    tui.invalidate();
    const lines = tui.render();
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.equal(stripVTControlCharacters(lines[0] ?? ""), "─".repeat(width));
    assert.equal(stripVTControlCharacters(lines.at(-1) ?? ""), "─".repeat(width));
  }
  tui.send("q");
  assert.equal((await running).kind, "closed");
});

test("TUI shows a cancellable loader before opening the dashboard", async () => {
  let customCalls = 0;
  const { ctx } = createMockContext({
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) =>
      new Promise<unknown>((resolve) => {
        if (typeof factory !== "function") return resolve(undefined);
        customCalls += 1;
        let component: { dispose?(): void; handleInput(data: string): void };
        const done = (value: unknown) => {
          component.dispose?.();
          resolve(value);
        };
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: { fg(_color: string, text: string): string },
            keybindings: object,
            done: (value: unknown) => void,
          ) => typeof component
        )({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
        setImmediate(() => component.handleInput("\u001b"));
      }),
  });
  const owner = new AbortController();
  await showAnalyticsMenu(
    ctx,
    source({
      async load(_range, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        });
        return { kind: "ready", snapshot };
      },
    }),
    { signal: owner.signal, isCurrent: () => !owner.signal.aborted },
  );
  assert.equal(customCalls, 1);
});

test("dashboard rendering is width-safe and owner cancellation settles the menu", async () => {
  const controller = createAnalyticsMenu(source());
  const tui = createTuiHarness({ width: 40, rows: 20 });
  const owner = new AbortController();
  const base = createMockContext({ hasUI: true, mode: "tui" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const ctx = { ...base, ui: { ...base.ui, custom: tui.custom } } as never;
  const running = runMenu(ctx, controller.menu, {
    getState: controller.getState,
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
  });
  await tui.waitForOpen();
  for (const width of [40, 80, 120]) {
    tui.resize({ width, rows: 20 });
    const frame = tui.render();
    for (const line of frame) assert.ok(visibleWidth(line) <= width);
    assert.equal(stripVTControlCharacters(frame[0] ?? ""), "─".repeat(width));
    assert.equal(stripVTControlCharacters(frame.at(-1) ?? ""), "─".repeat(width));
  }
  owner.abort();
  assert.equal((await running).kind, "stale");
});
