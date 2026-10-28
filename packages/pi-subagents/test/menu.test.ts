import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import { showSubagentsMenu } from "../src/menu.js";
import type { ActiveJobDisplay, SubagentRuntime } from "../src/runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.js";
import { JOB_STATES, type JobSummary } from "../src/types.js";
import { createSubagentWidgetController, SUBAGENT_WIDGET_KEY } from "../src/widget.js";

initTheme("dark");

function fixture(jobs: JobSummary[] = [{ jobId: "job_one", state: "running", createdAt: 0 }]) {
  const tui = createTuiHarness();
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tui.custom, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const state = {
    settings: { ...DEFAULT_SUBAGENT_SETTINGS },
    settingsPath: "/user/pi-subagents.json",
    jobs,
    omitted: 2,
  };
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    isCurrent: () => true,
    getState: () => state,
    cancelJob: vi.fn(async (_jobId: string, _signal: AbortSignal): Promise<void> => {}),
    showSettings: vi.fn(async (_signal: AbortSignal): Promise<"back" | "close" | "stale"> => "back"),
  };
  return { tui, ctx, state, controller, options, notifications };
}

const text = (lines: readonly string[]) => lines.map(stripVTControlCharacters).join("\n");

async function openConfirmation(current: ReturnType<typeof fixture>) {
  const command = showSubagentsMenu(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  return { command };
}

test("RPC uses privacy-filtered summaries, keeps raw IDs, and cancels only after confirmation", async () => {
  const rawId = "job_\u001b[31mone\u001b[0m\u202e";
  const current = fixture([
    {
      jobId: rawId,
      state: "queued",
      createdAt: 0,
      timeout: 2,
      resultSummary: "PRIVATE OUTPUT",
      errorSummary: "PRIVATE ERROR",
    },
  ]);
  const rpc = createRpcHarness([
    { kind: "select", response: "Jobs" },
    { kind: "select", options: ["job_one", "Back"], response: "job_one" },
    { kind: "select", response: "Cancel job…" },
    { kind: "select", options: ["Cancel job", "Keep job"], response: "Cancel job" },
    { kind: "select", options: [], response: undefined },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Close" },
  ]);
  current.options.cancelJob.mockImplementation(async (id, signal) => {
    if (!signal.aborted)
      current.state.jobs = current.state.jobs.map((job) => (job.jobId === id ? { ...job, state: "cancelled" } : job));
  });
  await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
  rpc.assertConsumed();
  assert.equal(current.options.cancelJob.mock.calls.length, 1);
  assert.equal(current.options.cancelJob.mock.calls[0]?.[0], rawId);
  assert.equal(current.state.jobs[0]?.jobId, rawId);
  const display = rpc.dialogs.map((dialog) => dialog.title).join("\n");
  assert.match(display, /Timeout: 2 seconds/u);
  assert.doesNotMatch(display, /PRIVATE|\p{Bidi_Control}/u);
  assert.equal(display.includes("\u001b"), false);
  assert.deepEqual(current.notifications, []);
});

test.each(JOB_STATES.filter((state) => state !== "queued" && state !== "running"))(
  "terminal %s jobs have no cancellation action",
  async (state) => {
    const current = fixture([{ jobId: "job_one", state, createdAt: 0, finishedAt: 10 }]);
    const rpc = createRpcHarness([
      { kind: "select", response: "Jobs" },
      { kind: "select", response: "job_one" },
      { kind: "select", options: [], response: undefined },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Close" },
    ]);
    await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
    rpc.assertConsumed();
    assert.equal(current.options.cancelJob.mock.calls.length, 0);
    assert.match(rpc.dialogs[2]?.title ?? "", new RegExp(`State: ${state}`, "u"));
    assert.deepEqual(current.notifications, []);
  },
);

test("RPC Status, Help, empty Jobs and Settings use one manager with observable data", async () => {
  const current = fixture([]);
  current.state.settingsPath = "/user/\u001b]0;hidden\u0007pi-subagents.json\u202e";
  const rpc = createRpcHarness([
    { kind: "select", response: "Status" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Help" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Jobs" },
    { kind: "select", options: ["Back"], response: "Back" },
    { kind: "select", response: "Settings" },
    { kind: "select", response: "Close" },
  ]);
  await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
  rpc.assertConsumed();
  const status = rpc.dialogs[1]?.title ?? "";
  const help = rpc.dialogs[3]?.title ?? "";
  assert.match(status, /Runtime: active for this session/u);
  assert.match(status, /Retained jobs: 0/u);
  assert.match(status, /Active jobs: 0/u);
  assert.match(status, /Omitted jobs: 2/u);
  assert.match(status, /Show widget: true/u);
  assert.match(status, /Show job ID: false/u);
  assert.match(status, /Show tools: false/u);
  assert.match(status, /Show timing: true/u);
  assert.match(status, /User settings: \/user\/pi-subagents.json/u);
  assert.doesNotMatch(status, /hidden|\p{Bidi_Control}/u);
  assert.equal(status.includes("\u001b"), false);
  assert.match(help, /\/subagents opens/u);
  assert.match(help, /\/subagents settings opens/u);
  for (const tool of ["spawn", "inspect", "wait", "send", "cancel"]) assert.ok(help.includes(`subagent_${tool}`));
  assert.match(help, /32 terminal jobs.*24 hours/u);
  assert.match(rpc.dialogs[5]?.title ?? "", /No jobs in this session/u);
  assert.equal(current.options.showSettings.mock.calls.length, 1);
  assert.deepEqual(current.notifications, []);
});

test.each(["completed", "removed"] as const)("confirmation revalidates a job that becomes %s", async (change) => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  const before = text(current.tui.render());
  current.state.jobs = change === "removed" ? [] : [{ jobId: "job_one", state: "completed", createdAt: 0 }];
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  const after = text(current.tui.render());
  current.tui.press("ctrl+c");
  await command;
  assert.match(before, /Cancel subagent job/u);
  assert.doesNotMatch(after, /Cancel job…/u);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});

test("confirmation Back returns locally, but Ctrl+C closes the root manager", async () => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  const confirmation = text(current.tui.render());
  current.tui.press("tui.select.cancel");
  await current.tui.waitForOpen();
  const detail = text(current.tui.render());
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("ctrl+c");
  await command;
  assert.match(confirmation, /Cancel subagent job/u);
  assert.match(detail, /Job ID: job_one/u);
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.tui.openCount, 6);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
});

test.each(["owner", "dispose"] as const)("%s cancels an open confirmation without a side effect", async (kind) => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  if (kind === "owner") current.controller.abort();
  else current.tui.dispose();
  await command;
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});

test("cancelling pending job work aborts and drains its owned task", async () => {
  const current = fixture();
  let finish!: () => void;
  let taskSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    current.options.cancelJob.mockImplementation(async (_id, signal) => {
      taskSignal = signal;
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
    });
  });
  const { command } = await openConfirmation(current);
  current.tui.press("tui.select.confirm");
  await started;
  await current.tui.waitForOpen();
  let settled = false;
  void command.then(() => {
    settled = true;
  });
  current.tui.press("ctrl+c");
  const aborted = taskSignal?.aborted;
  const early = settled;
  finish();
  await command;
  assert.equal(aborted, true);
  assert.equal(early, false);
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.options.cancelJob.mock.calls.length, 1);
});

test.each(["back", "close", "stale"] as const)("Settings result %s controls the root flow", async (reason) => {
  const current = fixture();
  current.options.showSettings.mockResolvedValue(reason);
  const command = showSubagentsMenu(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.confirm");
  if (reason === "back") {
    await current.tui.waitForOpen();
    current.tui.press("ctrl+c");
  }
  await command;
  assert.equal(current.options.showSettings.mock.calls.length, 1);
  assert.equal(current.tui.isOpen, false);
  assert.deepEqual(current.notifications, []);
});

test("manager frame uses callback theme, bounds all heights and supports custom cancellation", async () => {
  const current = fixture();
  const roles: string[] = [];
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.cancel": "ctrl+x",
  });
  const tui = createTuiHarness({
    keybindings: bindings,
    theme: {
      fg: (role, value) => {
        roles.push(role);
        return value;
      },
      bold: (value) => value,
    },
  });
  // Zero-width handling belongs to Kit's screen tests; the published dependency
  // can differ from the workspace Kit during a release version bump.
  current.ctx.ui.custom = tui.custom;
  const command = showSubagentsMenu(current.ctx, current.options);
  await tui.waitForOpen();
  tui.send("\u000e");
  const frames: { width: number; rows: number; lines: readonly string[] }[] = [];
  for (const rows of [24, 8, 7, 4])
    for (const width of [1, 3, 20, 80]) {
      frames.push({ width, rows, lines: tui.resize({ width, rows }) });
    }
  tui.invalidate();
  tui.resize({ width: 80, rows: 24 });
  tui.send("\u0018");
  await command;
  for (const { width, rows, lines } of frames) {
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.ok(lines.length <= Math.max(1, rows - 3));
    if (rows >= 8 && width > 0) {
      assert.equal(stripVTControlCharacters(lines[0] ?? ""), "─".repeat(width));
      assert.equal(stripVTControlCharacters(lines.at(-1) ?? ""), "─".repeat(width));
    }
    if (width === 80) assert.match(text(lines), /Settings/u);
  }
  assert.ok(roles.includes("border"));
  assert.ok(roles.includes("muted"));
  assert.equal(tui.isOpen, false);
});

const widgetCleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of widgetCleanups.splice(0)) dispose();
});

function presentationFixture() {
  const current = fixture();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+x",
  });
  const tui = createTuiHarness({ keybindings: bindings, width: 160 });
  current.ctx.ui.custom = tui.custom;
  const rawId = "job_\u001b[31mone\u001b[0m";
  let jobs: ActiveJobDisplay[] = [
    {
      jobId: rawId,
      task: "First task",
      state: "running",
      thinkingLevel: "high",
      defaultThinkingLevel: "medium",
      elapsedMs: 0,
      tools: ["read"],
    },
    {
      jobId: "job_one",
      task: "Second task",
      state: "queued",
      thinkingLevel: "off",
      defaultThinkingLevel: "medium",
      elapsedMs: 0,
      tools: [],
    },
  ];
  current.state.jobs = jobs.map(({ jobId, state }) => ({ jobId, state, createdAt: 0 }));
  let change!: () => void;
  const runtime = {
    activeJobsForDisplay: () => jobs,
    subscribeJobs: (callback: () => void) => {
      change = callback;
      return () => {};
    },
  } as unknown as SubagentRuntime;
  const controller = createSubagentWidgetController(runtime);
  let component: Component | undefined;
  const theme = { fg: (_role: string, value: string) => value } as Theme;
  Object.assign(current.ctx.ui, {
    theme,
    setWidget: (key: string, value: ((tui: TUI, theme: Theme) => Component) | undefined) => {
      assert.equal(key, SUBAGENT_WIDGET_KEY);
      component = value?.({ terminal: { rows: 36 }, requestRender() {} } as TUI, theme);
    },
  });
  Object.assign(current.ctx, { isIdle: () => true, sessionManager: {} });
  controller.start(current.ctx);
  widgetCleanups.push(() => controller.shutdown(current.ctx));
  const controls = controller.controls(current.ctx);
  assert.ok(controls);
  return {
    ...current,
    tui,
    controller,
    controls,
    rawId,
    options: { ...current.options, widget: controls },
    render: () => text(component?.render(200) ?? []),
    changeTask() {
      jobs = jobs.map((job) => ({ ...job, task: "New assignment" }));
      change();
    },
  };
}

async function choosePresentation(tui: ReturnType<typeof createTuiHarness>, label: string) {
  for (let index = 0; index < 20; index++) {
    if (tui.render().some((line) => stripVTControlCharacters(line).includes(`→ ${label}`))) {
      tui.send("\u0019"); // Remapped confirm, not the default Enter.
      await tui.waitForOpen();
      return;
    }
    tui.send("\u000e");
  }
  throw new Error(`Menu item not found: ${label}`);
}

test("remapped widget menu controls actual presentation and disabled settings beat pin", async () => {
  const f = presentationFixture();
  const command = showSubagentsMenu(f.ctx, f.options);
  await f.tui.waitForOpen();
  await choosePresentation(f.tui, "Widget view");
  await choosePresentation(f.tui, "Show summary");
  const compact = f.render();
  await choosePresentation(f.tui, "Pin view");
  const pinned = text(f.tui.render());
  await choosePresentation(f.tui, "Hide widget");
  const hidden = f.render();
  await choosePresentation(f.tui, "Show widget");
  const shown = f.render();
  f.state.settings.showWidget = false;
  f.controller.update(f.ctx, f.state.settings);
  await choosePresentation(f.tui, "Show details");
  const disabled = f.render();
  const disabledMenu = text(f.tui.render());
  f.tui.send("\u0018"); // Remapped back returns to the root.
  await f.tui.waitForOpen();
  const root = text(f.tui.render());
  f.tui.press("ctrl+c");
  await command;
  assert.match(compact, /2 active · 1 running · 1 queued/u);
  assert.doesNotMatch(compact, /thinking:/u);
  assert.match(pinned, /pinned: true/u);
  assert.match(pinned, /Unpin view/u);
  assert.equal(hidden, "");
  assert.match(shown, /thinking: high/u);
  assert.equal(disabled, "");
  assert.match(disabledMenu, /Disabled by Settings/u);
  assert.match(root, /Widget view/u);
  assert.equal(f.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(f.notifications, []);
});

test("item menu uses raw IDs, rejects a stale selected revision, and resets removed presentation only", async () => {
  const f = presentationFixture();
  const command = showSubagentsMenu(f.ctx, f.options);
  await f.tui.waitForOpen();
  await choosePresentation(f.tui, "Jobs");
  await choosePresentation(f.tui, "job_one"); // Same sanitized label; first item has the raw escaped ID.
  const details = text(f.tui.render());
  f.changeTask(); // The selected handle is now stale.
  await choosePresentation(f.tui, "Widget: job summary");
  const staleResult = f.render();
  await choosePresentation(f.tui, "Widget: job summary");
  const compact = f.render();
  await choosePresentation(f.tui, "Remove from widget (keep job)");
  const removed = f.render();
  f.tui.send("\u0018");
  await f.tui.waitForOpen();
  f.tui.send("\u0018");
  await f.tui.waitForOpen();
  await choosePresentation(f.tui, "Widget view");
  await choosePresentation(f.tui, "Reset item views");
  const reset = f.render();
  f.tui.press("ctrl+c");
  await command;
  assert.match(details, /Job ID: job_one/u);
  assert.equal(details.includes("\u001b[31m"), false);
  assert.equal((staleResult.match(/thinking:/gu) ?? []).length, 2);
  assert.equal((compact.match(/thinking:/gu) ?? []).length, 1);
  assert.match(compact, /▶ New assignment\n/u);
  assert.match(removed, /1 not shown \(1 removed\)/u);
  assert.doesNotMatch(removed, /thinking: high/u);
  assert.match(reset, /thinking: high/u);
  assert.match(reset, /thinking: off/u);
  assert.equal(f.state.jobs[0]?.jobId, f.rawId);
  assert.equal(f.state.jobs.length, 2);
  assert.equal(f.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(f.notifications, []);
});

test.each(["print", "json"] as const)("%s does not open TUI or mutate jobs", async (mode) => {
  const current = fixture();
  const custom = vi.fn();
  await showSubagentsMenu({ ...current.ctx, mode, hasUI: false, ui: { ...current.ctx.ui, custom } }, current.options);
  assert.equal(custom.mock.calls.length, 0);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
});
