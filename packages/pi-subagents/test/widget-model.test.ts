import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import * as resources from "../src/resource-attachments.js";
import type { ActiveJobDisplay, SubagentModelOverrides } from "../src/runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.js";
import { registerSubagentTools } from "../src/tools.js";
import type { ChildRequest, ChildResult } from "../src/types.js";
import { createSubagentWidgetController, renderSubagentWidget, SUBAGENT_WIDGET_KEY } from "../src/widget.js";
import { renderSubagentWidgetSnapshot } from "../src/widget-renderer.js";

interface Pair {
  provider: string;
  id: string;
}

interface SpawnTool {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ): Promise<{ details: { jobId: string; state: string } }>;
}

const parent: Pair = { provider: "main-provider", id: "main-model" };
const theme = { fg: (_role: string, value: string) => value } as Theme;
const job: ActiveJobDisplay = {
  jobId: "job_model",
  task: "Check selection",
  state: "running",
  thinkingLevel: "high",
  defaultThinkingLevel: "high",
  elapsedMs: 0,
  tools: [],
};
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const selections: SubagentModelOverrides[] = [
  {},
  { provider: "other-provider" },
  { model: "vendor/model:high" },
  { provider: "other-provider", model: "vendor/model:high" },
];

test.each(selections.flatMap((selection) => (["queued", "running"] as const).map((state) => ({ selection, state }))))(
  "renders independent $state model overrides $selection",
  ({ selection, state }) => {
    const value = { ...job, ...selection, state };
    const fields = [
      ...(selection.provider !== undefined ? [`provider: ${selection.provider}`] : []),
      ...(selection.model !== undefined ? [`model: ${selection.model}`] : []),
      state === "running" ? "0s" : "queued",
    ];
    for (const mode of ["default", "expanded"] as const) {
      assert.equal(
        renderSubagentWidget([value], theme, 300, DEFAULT_SUBAGENT_SETTINGS, 10, mode)[2],
        `${state === "running" ? "▶" : "○"} Check selection · ${fields.join(" · ")}`,
      );
    }
    const compact = renderSubagentWidgetSnapshot(
      {
        jobs: [value],
        items: [{ id: value.jobId, value, mode: "compact" }],
        settings: DEFAULT_SUBAGENT_SETTINGS,
        mode: "expanded",
      },
      theme,
      300,
      10,
    );
    assert.equal(
      compact[2],
      `${state === "running" ? "▶" : "○"} Check selection${state === "queued" ? " · queued" : ""}`,
    );
    assert.doesNotMatch(
      renderSubagentWidget([value], theme, 300, DEFAULT_SUBAGENT_SETTINGS, 10, "compact").join("\n"),
      /provider:|model:/u,
    );
  },
);

test.each([
  "\u001b[31mvendor/id\u001b[0m",
  "\u001b]0;hidden title\u0007vendor/id",
  "\u001b]8;;https://example.com\u001b\\vendor/id\u001b]8;;\u001b\\",
  "\u009b31mvendor/id\u009b0m",
  "\u202evendor/id\u2069",
  "vendor/\n\t id",
])("sanitizes model display text without changing raw IDs: %j", (raw) => {
  const value = { ...job, provider: raw, model: raw };
  const fg = vi.fn((_role: string, text: string) => text);
  const callbackTheme = { fg } as unknown as Theme;
  const lines = renderSubagentWidget([value], callbackTheme, 300);
  const expected = raw === "vendor/\n\t id" ? "vendor/ id" : "vendor/id";
  assert.equal(lines[2], `▶ Check selection · provider: ${expected} · model: ${expected} · 0s`);
  assert.doesNotMatch(lines.join(""), /[\p{Cc}\p{Bidi_Control}]/u);
  assert.ok(fg.mock.calls.some(([role, text]) => role === "muted" && text.includes(`model: ${expected}`)));
  for (const width of [0, 1, 8, 32, 80, 300]) {
    for (const line of renderSubagentWidget([value], callbackTheme, width)) {
      assert.ok(visibleWidth(line) <= width);
      // Pi's width truncation can append its own ANSI reset.
      assert.doesNotMatch(stripTerminalSequences(line), /[\p{Cc}\p{Bidi_Control}]/u);
    }
  }
  assert.equal(value.provider, raw);
  assert.equal(value.model, raw);
});

test.each(
  [undefined, parent.provider, "other-provider"].flatMap((provider) =>
    [undefined, parent.id, "other-model"].map((model) => ({ provider, model })),
  ),
)("hides inherited and explicit-equal spawn IDs for %j", async (overrides) => {
  const f = await fixture();
  const spawned = await f.spawn(overrides);
  const selected = { provider: overrides.provider ?? parent.provider, model: overrides.model ?? parent.id };
  const provider = selected.provider === parent.provider ? undefined : selected.provider;
  const model = selected.model === parent.id ? undefined : selected.model;
  const display = f.session.runtime.activeJobsForDisplay()[0];
  assert.ok(display);
  assert.equal(display.provider, provider);
  assert.equal(display.model, model);
  const fields = [
    ...(provider !== undefined ? [`provider: ${provider}`] : []),
    ...(model !== undefined ? [`model: ${model}`] : []),
    "0s",
  ];
  assert.equal(f.render()[2], `▶ Check selection · ${fields.join(" · ")}`);
  assert.equal(f.requests[0]?.provider, selected.provider);
  assert.equal(f.requests[0]?.model, selected.model);
  assert.equal(Object.hasOwn(f.requests[0] ?? {}, "modelOverrides"), false);
  assert.doesNotMatch(JSON.stringify([spawned, f.session.runtime.inspectJobs()]), /provider|model|Overrides/u);
});

test("shows both explicit IDs when no parent model is selected", async () => {
  const f = await fixture({ parent: undefined });
  await f.spawn({ provider: "other-provider", model: "other-model" });
  assert.equal(f.render()[2], "▶ Check selection · provider: other-provider · model: other-model · 0s");
});

test("keeps spawn-time comparisons fixed after parent changes without exposing model metadata", async () => {
  const f = await fixture();
  let current = parent;
  const readModel = vi.fn(() => current);
  Object.defineProperty(f.context.ctx, "model", { configurable: true, get: readModel });
  const first = await f.spawn({ provider: "other-provider", model: "other-model" });
  const component = f.component();
  const before = f.render()[2];
  assert.equal(before, "▶ Check selection · provider: other-provider · model: other-model · 0s");
  current = { provider: "other-provider", id: "other-model" };
  const second = await f.spawn({}, "Inherit new pair");
  assert.equal(f.component(), component, "ordinary updates retain the mounted widget");
  assert.equal(f.render()[2], before);
  assert.equal(f.render()[3], "▶ Inherit new pair · 0s");
  assert.equal(readModel.mock.calls.length, 2, "each admission captures the parent pair once");
  assert.deepEqual(
    f.requests.map(({ provider, model }) => ({ provider, model })),
    [
      { provider: "other-provider", model: "other-model" },
      { provider: "other-provider", model: "other-model" },
    ],
  );
  for (const { details } of [first, second]) await f.session.runtime.cancel(details.jobId);
  assert.equal(f.context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.doesNotMatch(
    JSON.stringify([first, second, f.session.runtime.inspectJobs(), f.mock.sentMessages]),
    /provider|model|Overrides/u,
  );
  assert.ok(f.requests.every((request) => request.signal.aborted));
});

test("compares against the effective pair after asynchronous attachment preflight", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const resolve = resources.resolveResourceAttachments;
  vi.spyOn(resources, "resolveResourceAttachments").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return resolve(...args);
  });
  const admission = f.spawn({ provider: "other-provider" });
  await entered.promise;
  Object.assign(f.context.ctx, { model: { provider: "other-provider", id: "other-model" } });
  release.resolve();
  await admission;
  assert.equal(f.requests[0]?.provider, "other-provider");
  assert.equal(f.requests[0]?.model, "other-model");
  assert.equal(f.render()[2], "▶ Check selection · 0s");
});

test("copies local model overrides for queued and running snapshots without changing child payloads", async () => {
  const f = await fixture();
  const modelOverrides = { provider: "other-provider", model: "other-model" };
  const selected = { ...modelOverrides };
  f.session.runtime.start({
    task: "Check selection",
    tools: [],
    skills: [],
    extensions: [],
    toolSources: {},
    ...selected,
    modelOverrides,
    thinkingLevel: "high",
    defaultThinkingLevel: "high",
    cwd: process.cwd(),
    projectTrusted: false,
  });
  modelOverrides.provider = "mutated input";
  modelOverrides.model = "mutated input";
  const snapshot = f.session.runtime.activeJobsForDisplay()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.state, "queued");
  assert.equal(snapshot.provider, selected.provider);
  assert.equal(snapshot.model, selected.model);
  assert.equal(f.render()[2], "○ Check selection · provider: other-provider · model: other-model · queued");
  snapshot.provider = "mutated snapshot";
  snapshot.model = "mutated snapshot";
  await Promise.resolve();
  const running = f.session.runtime.activeJobsForDisplay()[0];
  assert.equal(running?.state, "running");
  assert.equal(running?.provider, selected.provider);
  assert.equal(running?.model, selected.model);
  assert.equal(f.render()[2], "▶ Check selection · provider: other-provider · model: other-model · 0s");
  assert.equal(f.requests[0]?.provider, selected.provider);
  assert.equal(f.requests[0]?.model, selected.model);
  assert.equal(Object.hasOwn(f.requests[0] ?? {}, "modelOverrides"), false);
});

async function fixture(options: { parent?: Pair } = {}) {
  const mock = createMockPi({ thinkingLevel: "high" });
  const context = createMockContext({
    mode: "tui",
    model: Object.hasOwn(options, "parent") ? options.parent : parent,
    thinkingLevel: "high",
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    },
  });
  const requests: ChildRequest[] = [];
  const session = registerSubagentTools(mock.pi, {
    now: () => 0,
    runChild: (request) =>
      new Promise<ChildResult>((resolve) => {
        requests.push(request);
        const onAbort = () => resolve({ state: "cancelled", limitations: [], truncated: false });
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      }),
  });
  const controller = createSubagentWidgetController(session.runtime);
  cleanups.push(async () => {
    controller.shutdown(context.ctx);
    await session.shutdown();
  });
  await session.startSession();
  controller.start(context.ctx);
  const spawn = mock.tools.find((tool) => tool.name === "subagent_spawn") as unknown as SpawnTool;
  assert.ok(spawn);
  const mounted = new WeakMap<object, Component>();
  const component = (): Component => {
    const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as
      | ((_tui: unknown, callbackTheme: Theme) => Component)
      | undefined;
    assert.ok(factory);
    let value = mounted.get(factory);
    if (!value) {
      value = factory({ terminal: { rows: 36 }, requestRender() {} }, theme);
      mounted.set(factory, value);
    }
    return value;
  };
  return {
    mock,
    context,
    session,
    requests,
    component,
    render: () => component().render(300),
    spawn: (overrides: Record<string, unknown> = {}, task = "Check selection") =>
      spawn.execute("spawn", { task, ...overrides }, undefined, undefined, context.ctx),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
