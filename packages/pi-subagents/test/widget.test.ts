import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { MessageBroker } from "../src/message-broker.js";
import { type ActiveJobDisplay, SubagentRuntime } from "../src/runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.js";
import {
  type ChildRequest,
  type ChildResult,
  SUBAGENT_THINKING_LEVELS,
  type SubagentThinkingLevel,
} from "../src/types.js";
import { createSubagentWidgetController, renderSubagentWidget, SUBAGENT_WIDGET_KEY } from "../src/widget.js";

const theme = { fg: (_role: string, text: string) => text } as Theme;
const displayJob: ActiveJobDisplay = {
  jobId: "job_preview",
  task: "Review authentication tests",
  state: "running",
  thinkingLevel: "medium",
  defaultThinkingLevel: "high",
  elapsedMs: 123_000,
  tools: ["read", "bash"],
};
const cleanups: Array<() => Promise<void>> = [];

test.each(
  SUBAGENT_THINKING_LEVELS.flatMap((defaultThinkingLevel) =>
    SUBAGENT_THINKING_LEVELS.flatMap((thinkingLevel) =>
      (["queued", "running"] as const).map((state) => ({ defaultThinkingLevel, thinkingLevel, state })),
    ),
  ),
)("renders $state thinking $thinkingLevel relative to default $defaultThinkingLevel", (job) => {
  const lines = renderSubagentWidget([{ ...displayJob, ...job }], theme, 200);
  const thinking = job.thinkingLevel === job.defaultThinkingLevel ? "" : ` · thinking: ${job.thinkingLevel}`;
  assert.equal(lines.length, 3);
  assert.equal(
    lines[2],
    `${job.state === "running" ? "▶" : "○"} Review authentication tests${thinking} · ${job.state === "running" ? "2m 3s" : "queued"}`,
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([
  ["short task", "Review authentication tests", "Review authentication tests"],
  ["multiline whitespace", "  Review\n\t authentication   tests  ", "Review authentication tests"],
  ["exact width", "a".repeat(40), "a".repeat(40)],
  ["long task", "a".repeat(41), `${"a".repeat(39)}…`],
  ["wide characters", "界".repeat(21), `${"界".repeat(19)}…`],
  ["exact wide width", "界".repeat(20), "界".repeat(20)],
  ["combining characters", "e\u0301".repeat(41), `${"e\u0301".repeat(39)}…`],
  ["emoji", "👩‍💻".repeat(21), `${"👩‍💻".repeat(19)}…`],
  ["CSI styling", "\u001b[31mReview tests\u001b[0m", "Review tests"],
  ["OSC title", "\u001b]0;hidden title\u0007Review tests", "Review tests"],
  ["OSC hyperlink", "\u001b]8;;https://example.com\u001b\\Review tests\u001b]8;;\u001b\\", "Review tests"],
  ["APC marker", "\u001b_hidden marker\u001b\\Review tests", "Review tests"],
  ["DCS string", "\u001bPhidden data\u001b\\Review tests", "Review tests"],
  ["SOS string", "\u001bXhidden data\u001b\\Review tests", "Review tests"],
  ["PM string", "\u001b^hidden data\u001b\\Review tests", "Review tests"],
  ["C1 CSI", "\u009b31mReview tests\u009b0m", "Review tests"],
  ["C1 OSC", "\u009d0;hidden title\u009cReview tests", "Review tests"],
  ["C1 strings", "\u0090data\u009c\u0098data\u009c\u009edata\u009c\u009fdata\u009cReview tests", "Review tests"],
  ["simple escape", "\u001b7Review tests\u001b8", "Review tests"],
  ["malformed escape", "\u001b[\u001b]Review tests", "Review tests"],
  ["control characters", "Review\r\u0007\u0080 tests\u007f", "Review tests"],
  [
    "bidirectional controls",
    "\u061c\u200e\u200f\u202a\u202b\u202dReview\u202e tests\u202c\u2066\u2067\u2068\u2069",
    "Review tests",
  ],
  ["empty sanitized text", "\u0007\u001b\u202e\u2066\n\t", ""],
  ["only terminal sequences", "\u001b[31m\u001b[0m\u001b]0;title\u0007", ""],
  ["only invisible text", "\u200b\u0301", ""],
])("renders a safe task preview: %s", (_name, task, expected) => {
  const job = { ...displayJob, task };
  const lines = renderSubagentWidget([job], theme, 200);
  assert.equal(lines[2], `▶ ${expected || "running"} · thinking: medium · 2m 3s`);
  assert.ok(visibleWidth(expected) <= 40);
  for (const line of lines) assert.doesNotMatch(line, /[\p{Cc}\p{Bidi_Control}]/u);
  assert.equal(job.task, task);
});

test.each(["\u001b[", "\u001b]", "\u001b_", "\u001bP", "\u001bX", "\u001b^", "\u009b", "\u009d", "\u009f"])(
  "renders maximum-size tasks containing repeated unterminated sequences: %j",
  (prefix) => {
    const task = prefix.repeat(Math.floor((50 * 1024) / Buffer.byteLength(prefix, "utf8")));
    assert.ok(Buffer.byteLength(task, "utf8") <= 50 * 1024);
    const jobs = Array.from({ length: 8 }, (_, index) => ({ ...displayJob, jobId: `job_${index}`, task }));
    const lines = renderSubagentWidget(jobs, theme, 200);
    assert.equal(lines.length, 10);
    for (const line of lines) assert.doesNotMatch(line, /[\p{Cc}\p{Bidi_Control}]/u);
    assert.ok(lines.slice(2).every((line) => line.startsWith("▶ ") && line.includes("thinking: medium")));
  },
);

test("keeps rows bounded across resize and uses the callback theme on every render", async () => {
  const { context, runtime } = await setupWidget();
  runtime.start(jobInput(`${"界e\u0301👩‍💻".repeat(20)}\nconstraints`));
  const component = widgetComponent(context);
  const fg = vi.fn((_role: string, text: string) => text);
  const callbackTheme = { fg } as unknown as Theme;
  const themedComponent = widgetComponent(context, callbackTheme);
  for (const width of [0, 1, 2, 24, 80, 200, 24, 200]) {
    const lines = component.render(width);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "─".repeat(width));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    themedComponent.invalidate();
    themedComponent.render(width);
    if (width > 0) {
      assert.ok(fg.mock.calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(width)));
    }
  }
  assert.ok(fg.mock.calls.some(([role, text]) => role === "text" && text.includes("…")));
  assert.ok(fg.mock.calls.some(([role, text]) => role === "muted" && text.includes("thinking: medium")));
  fg.mockClear();
  themedComponent.invalidate();
  themedComponent.render(200);
  assert.ok(fg.mock.calls.length > 0, "theme content must not stay cached across invalidation");
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 1.9, 12.9])(
  "normalizes widget width %s without changing the body row count",
  (width) => {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const lines = renderSubagentWidget([displayJob], theme, width);
    assert.deepEqual(lines, renderSubagentWidget([displayJob], theme, normalized));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 0) assert.deepEqual(lines, ["", "", ""]);
  },
);

test.each(["rpc", "print", "json"] as const)("does not subscribe, schedule, or publish in %s mode", (mode) => {
  const activeJobsForDisplay = vi.fn(() => [displayJob]);
  const subscribeJobs = vi.fn();
  const runtime = { activeJobsForDisplay, subscribeJobs } as unknown as SubagentRuntime;
  const context = createMockContext({ mode });
  const setWidget = vi.spyOn((context.ctx as ExtensionContext).ui, "setWidget");
  const timer = vi.spyOn(globalThis, "setInterval");
  const controller = createSubagentWidgetController(runtime);
  controller.start(context.ctx);
  controller.update(context.ctx, DEFAULT_SUBAGENT_SETTINGS);
  controller.shutdown(context.ctx);
  controller.shutdown(context.ctx);
  assert.equal(timer.mock.calls.length, 0);
  assert.equal(subscribeJobs.mock.calls.length, 0);
  assert.equal(activeJobsForDisplay.mock.calls.length, 0);
  assert.equal(setWidget.mock.calls.length, 0);
});

test("carries separate queued and running tasks and levels without changing child requests or public metadata", async () => {
  const { context, runtime, mock, children } = await setupWidget();
  const tasks = ["Review authentication\nwith full constraints", `Implement ${"long task ".repeat(100)}`] as const;
  const levels = ["off", "max"] as const;
  const spawned = tasks.map((task, index) => runtime.start(jobInput(task, levels[index])));
  const [first, second] = spawned;
  assert.ok(first && second);
  const queued = runtime.activeJobsForDisplay();
  assert.deepEqual(
    queued.map(({ task, state, thinkingLevel }) => ({ task, state, thinkingLevel })),
    tasks.map((task, index) => ({ task, state: "queued", thinkingLevel: levels[index] })),
  );
  const queuedRows = widgetComponent(context).render(200);
  assert.match(queuedRows[2] ?? "", /Review authentication with full constra… · thinking: off · queued/u);
  assert.match(queuedRows[3] ?? "", /Implement .*… · thinking: max · queued/u);
  const firstSnapshot = queued[0];
  assert.ok(firstSnapshot);
  firstSnapshot.task = "mutated snapshot";
  firstSnapshot.thinkingLevel = "low";
  firstSnapshot.defaultThinkingLevel = "low";
  assert.equal(runtime.activeJobsForDisplay()[0]?.task, tasks[0]);
  assert.equal(runtime.activeJobsForDisplay()[0]?.thinkingLevel, "off");
  assert.equal(runtime.activeJobsForDisplay()[0]?.defaultThinkingLevel, "high");

  await Promise.resolve();
  assert.deepEqual(
    runtime.activeJobsForDisplay().map(({ state }) => state),
    ["running", "running"],
  );
  assert.deepEqual(
    [...children.values()].map(({ request }) => request.task),
    tasks,
  );
  const runningRows = widgetComponent(context).render(200);
  assert.deepEqual(
    [...children.values()].map(({ request }) => request.thinkingLevel),
    levels,
  );
  assert.match(runningRows[2] ?? "", / · thinking: off/u);
  assert.match(runningRows[3] ?? "", / · thinking: max/u);
  assert.deepEqual(Object.keys(spawned[0] ?? {}).sort(), ["jobId", "state"]);
  const activeMetadata = JSON.stringify(runtime.inspectJobs());
  assert.doesNotMatch(activeMetadata, /task|preview|thinkingLevel|Review authentication|Implement/u);

  const firstChild = children.get(tasks[0]);
  assert.ok(firstChild);
  firstChild.finish({ state: "completed", result: "done", limitations: [], truncated: false });
  const result = await runtime.wait(first.jobId, undefined);
  assert.equal(result.state, "completed");
  assert.equal(widgetComponent(context).render(200).length, 3);
  assert.doesNotMatch(widgetComponent(context).render(200).join("\n"), /Review authentication/u);
  await runtime.cancel(second.jobId);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.deepEqual(runtime.activeJobsForDisplay(), []);
  assert.doesNotMatch(
    JSON.stringify([result, runtime.inspectJobs(), mock.sentMessages]),
    /taskText|"task"|preview|thinkingLevel|Review authentication|Implement/u,
  );
});

test("refreshes a changed task even when the remaining display data is unchanged", async () => {
  let refresh: (() => void) | undefined;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    refresh = callback as () => void;
    return { unref() {} } as NodeJS.Timeout;
  });
  const { context, runtime } = await setupWidget();
  const jobs = vi.spyOn(runtime, "activeJobsForDisplay").mockReturnValue([{ ...displayJob, task: "First task" }]);
  assert.ok(refresh);
  refresh();
  const firstFactory = context.widgets.get(SUBAGENT_WIDGET_KEY);
  const first = widgetComponent(context);
  assert.match(first.render(200)[2] ?? "", /First task/u);
  refresh();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), firstFactory);
  jobs.mockReturnValue([{ ...displayJob, task: "Second task" }]);
  refresh();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), firstFactory, "visible changes retain the mount");
  assert.equal(widgetComponent(context), first);
  assert.match(first.render(200)[2] ?? "", /Second task/u);
});

test("refreshes a changed thinking level in the retained component without republishing unchanged data", async () => {
  let refresh: (() => void) | undefined;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    refresh = callback as () => void;
    return { unref() {} } as NodeJS.Timeout;
  });
  const { context, runtime } = await setupWidget();
  const jobs = vi.spyOn(runtime, "activeJobsForDisplay").mockReturnValue([{ ...displayJob, thinkingLevel: "off" }]);
  assert.ok(refresh);
  refresh();
  const firstFactory = context.widgets.get(SUBAGENT_WIDGET_KEY);
  const first = widgetComponent(context);
  assert.match(first.render(200)[2] ?? "", /thinking: off/u);
  refresh();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), firstFactory);
  jobs.mockReturnValue([{ ...displayJob, thinkingLevel: "max" }]);
  refresh();
  const changedFactory = context.widgets.get(SUBAGENT_WIDGET_KEY);
  assert.equal(changedFactory, firstFactory);
  assert.equal(widgetComponent(context), first);
  assert.match(first.render(200)[2] ?? "", /thinking: max/u);
  refresh();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), changedFactory);
});

test("clears task rows and levels and releases refresh ownership across session replacement and repeated shutdown", async () => {
  const { context, runtime, controller, children } = await setupWidget();
  const timers = vi.spyOn(globalThis, "clearInterval");
  runtime.start(jobInput("Old session task", "off"));
  await Promise.resolve();
  assert.match(widgetComponent(context).render(200)[2] ?? "", /Old session task/u);
  await runtime.shutdown();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(children.get("Old session task")?.request.signal.aborted, true);
  runtime.beginSession();
  const replacement = createMockContext({ mode: "tui" });
  controller.start(replacement.ctx);
  cleanups.push(async () => controller.shutdown(replacement.ctx));
  assert.ok(timers.mock.calls.length > 0);
  runtime.start(jobInput("New session task", "max"));
  assert.match(widgetComponent(replacement).render(200)[2] ?? "", /New session task · thinking: max · queued/u);
  assert.doesNotMatch(widgetComponent(replacement).render(200).join("\n"), /Old session task|thinking: off/u);
  controller.shutdown(context.ctx);
  assert.match(widgetComponent(replacement).render(200)[2] ?? "", /New session task/u);
  controller.shutdown(replacement.ctx);
  controller.shutdown(replacement.ctx);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(replacement.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  const writes = vi.spyOn((replacement.ctx as ExtensionContext).ui, "setWidget");
  await runtime.shutdown();
  assert.equal(writes.mock.calls.length, 0, "shutdown must unsubscribe the widget from later job changes");
});

test.each(
  [true, false].flatMap((showJobId) =>
    [true, false].flatMap((showTools) => [true, false].map((showTiming) => ({ showJobId, showTools, showTiming }))),
  ),
)("renders independent optional fields: %j", (preferences) => {
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS, ...preferences };
  const job = { ...displayJob, timeout: 300 };
  const text = renderSubagentWidget([job], theme, 200, settings)[2] ?? "";
  assert.equal(text.includes("job_preview"), preferences.showJobId);
  assert.equal(text.includes("tools: read, bash"), preferences.showTools);
  assert.equal(text.includes("2m 3s / 5m"), preferences.showTiming);
  assert.match(text, /Review authentication tests · thinking: medium/u);
  assert.equal(text.includes(" ·  · "), false);
  assert.equal(text.endsWith(" · "), false);
  for (const width of [0, 1, 10, 80, 200]) {
    const lines = renderSubagentWidget([job], theme, width, settings);
    assert.equal(lines[0], "─".repeat(width));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test.each([
  { state: "running" as const, timeout: undefined, showTiming: true, suffix: "2m 3s" },
  { state: "running" as const, timeout: 120, showTiming: true, suffix: "2m 3s / 2m" },
  { state: "running" as const, timeout: 120, showTiming: false, suffix: "" },
  { state: "queued" as const, timeout: undefined, showTiming: true, suffix: "queued" },
  { state: "queued" as const, timeout: 120, showTiming: true, suffix: "queued · timeout: 2m" },
  { state: "queued" as const, timeout: 120, showTiming: false, suffix: "queued" },
])(
  "renders timing for $state with timeout $timeout and timing $showTiming",
  ({ state, timeout, showTiming, suffix }) => {
    const job = { ...displayJob, state, timeout, defaultThinkingLevel: displayJob.thinkingLevel };
    const settings = { ...DEFAULT_SUBAGENT_SETTINGS, showTiming };
    const text = renderSubagentWidget([job], theme, 200, settings)[2];
    assert.equal(text, `${state === "running" ? "▶" : "○"} Review authentication tests${suffix ? ` · ${suffix}` : ""}`);
  },
);

test("keeps state readable when all optional fields and the task preview are absent", () => {
  const settings = { showWidget: true, showJobId: false, showTools: false, showTiming: false };
  for (const state of ["queued", "running"] as const) {
    const lines = renderSubagentWidget([{ ...displayJob, task: "\u0007\n", state }], theme, 80, settings);
    const label = `${state === "running" ? "▶" : "○"} ${state}`;
    assert.equal(lines[2], `${label} · thinking: medium`);
    const defaultJob = { ...displayJob, task: "\u0007\n", state, defaultThinkingLevel: displayJob.thinkingLevel };
    assert.equal(renderSubagentWidget([defaultJob], theme, 80, settings)[2], label);
    const emptyId = { ...defaultJob, jobId: "\u0007\u001b[31m\u001b[0m" };
    assert.equal(renderSubagentWidget([emptyId], theme, 80, { ...settings, showJobId: true })[2], label);
  }
  assert.deepEqual(renderSubagentWidget([displayJob], theme, 80, { ...settings, showWidget: false }), []);
});

test("applies display settings immediately and preserves active jobs, payloads, and completions", async () => {
  const { context, runtime, controller, children, mock } = await setupWidget();
  const first = runtime.start(jobInput("Keep running when hidden", "off"));
  const second = runtime.start(jobInput("Finish while hidden", "max"));
  await Promise.resolve();
  const preferences = { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: false, showTools: false, showTiming: false };
  const original = widgetComponent(context);
  const metadata = runtime.inspectJobs();
  controller.update(context.ctx, preferences);
  const rows = widgetComponent(context).render(200);
  assert.doesNotMatch(rows.join("\n"), /job_|tools:|no timeout/u);
  assert.match(rows[2] ?? "", /▶ Keep running when hidden · thinking: off/u);
  assert.match(rows[3] ?? "", /Finish while hidden · thinking: max/u);
  assert.equal(widgetComponent(context), original);
  assert.doesNotMatch(original.render(200).join("\n"), /job_|tools:|no timeout/u);
  controller.update(context.ctx, { ...preferences, showWidget: false });
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.deepEqual(runtime.inspectJobs(), metadata);
  assert.equal(children.get("Keep running when hidden")?.request.signal.aborted, false);
  children
    .get("Finish while hidden")
    ?.finish({ state: "completed", result: "done", limitations: [], truncated: false });
  assert.equal((await runtime.wait(second.jobId, undefined)).state, "completed");
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.ok(mock.sentMessages.some(({ message }) => JSON.stringify(message).includes(second.jobId)));
  controller.update(context.ctx, preferences);
  const restored = widgetComponent(context).render(200);
  assert.equal(restored.length, 3);
  assert.match(restored[2] ?? "", /Keep running when hidden · thinking: off/u);
  assert.doesNotMatch(restored.join("\n"), /job_|tools:|no timeout|thinking: max/u);
  assert.doesNotMatch(JSON.stringify(mock.sentMessages), /thinkingLevel/u);
  assert.equal(children.get("Keep running when hidden")?.request.task, "Keep running when hidden");
  await runtime.cancel(first.jobId);
});

test("clears the previous widget on replacement and ignores stale settings updates", async () => {
  const { context, runtime, controller } = await setupWidget();
  runtime.start(jobInput("Old owner"));
  const replacement = createMockContext({ mode: "tui" });
  controller.start(replacement.ctx);
  cleanups.push(async () => controller.shutdown(replacement.ctx));
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  controller.update(context.ctx, { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  assert.match(widgetComponent(replacement).render(200)[2] ?? "", /Old owner/u);
});

async function setupWidget() {
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui" });
  const children = new Map<string, { request: ChildRequest; finish: (result: ChildResult) => void }>();
  const broker = new MessageBroker({ onMessage() {} });
  const runtime = new SubagentRuntime(mock.pi, broker, {
    now: () => 0,
    runChild: (request) =>
      new Promise((resolve) => {
        const onAbort = () => finish({ state: "cancelled", limitations: [], truncated: false });
        const finish = (result: ChildResult) => {
          request.signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        children.set(request.task, { request, finish });
        request.signal.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const controller = createSubagentWidgetController(runtime);
  cleanups.push(async () => {
    controller.shutdown(context.ctx);
    await runtime.shutdown();
    await broker.shutdown();
  });
  await broker.start();
  runtime.beginSession();
  controller.start(context.ctx);
  return { mock, context, runtime, controller, children };
}

const widgetComponents = new WeakMap<object, Component>();
function widgetComponent(context: ReturnType<typeof createMockContext>, callbackTheme = theme): Component {
  const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as ((_tui: unknown, theme: Theme) => Component) | undefined;
  assert.ok(factory);
  Object.assign((context.ctx as ExtensionContext).ui, { theme: callbackTheme });
  let component = widgetComponents.get(factory);
  if (!component) {
    component = factory({ terminal: { rows: 36 }, requestRender() {} }, callbackTheme);
    widgetComponents.set(factory, component);
  }
  return component;
}

function jobInput(task: string, thinkingLevel: SubagentThinkingLevel = "medium") {
  return {
    task,
    tools: ["read"],
    skills: [],
    extensions: [],
    toolSources: {},
    provider: "test-provider",
    model: "test-model",
    thinkingLevel,
    defaultThinkingLevel: "high" as const,
    cwd: process.cwd(),
    projectTrusted: false,
  };
}
