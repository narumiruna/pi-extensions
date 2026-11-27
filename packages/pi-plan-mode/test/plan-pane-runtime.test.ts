import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionContext,
  initTheme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { PlanModeState } from "../src/state.js";
import { createPlanPaneHost, PANE_KEY } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

const stateEntry = (data: PlanModeState) => ({ type: "custom", customType: "plan-mode-state", data });

type RuntimeOptions = NonNullable<Parameters<typeof import("../src/plan-mode.js").default>[1]>;

async function fixture(
  mode: ExtensionContext["mode"] = "tui",
  planPane?: "left" | "right" | "off",
  options: RuntimeOptions & { agentDirectory?: string } = {},
) {
  const directory = options.agentDirectory ?? (await mkdtemp(join(tmpdir(), "pi-plan-pane-runtime-")));
  const settingsPath = join(directory, "pi-plan-mode.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  initTheme("dark");
  const terminal = createPlanPaneHost();
  const mock = createMockPi({ activeTools: ["read"] });
  let branch: unknown[] = [];
  const context = createMockContext({
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: directory,
    onTerminalInput: (listener: Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]) =>
      terminal.host.addInputListener(listener),
    sessionManager: { getSessionId: () => "pane", getBranch: () => branch, getEntries: () => branch },
  });
  let ctx: ExtensionContext = context.ctx;
  const setWidget = ctx.ui.setWidget;
  ctx.ui.setWidget = ((...args: Parameters<ExtensionContext["ui"]["setWidget"]>) => {
    setWidget(...args);
    terminal.setWidget(...args);
  }) as ExtensionContext["ui"]["setWidget"];
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  const frame = async () => {
    await Promise.resolve();
    return terminal.render().map(stripTerminalSequences).join("\n");
  };
  async function close() {
    await emit("session_shutdown", { reason: "quit" });
    terminal.stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (!options.agentDirectory) await rm(directory, { recursive: true, force: true });
  }
  try {
    const { default: planMode } = await import("../src/plan-mode.js");
    planMode(mock.pi, {
      settingsPath,
      ...(planPane
        ? { readSettings: async () => ({ kind: "loaded", settings: { thinkingLevel: "inherit", planPane } }) }
        : {}),
      ...options,
    });
    await emit("session_start", { reason: "startup" });
    const command = mock.commands.get("plan");
    assert.ok(command);
    const invoke = (args: string) => command.handler(args, ctx as Parameters<typeof command.handler>[1]);
    await invoke("start");
    const tool = mock.tools.find(({ name }) => name === "plan_mode_complete") as unknown as ToolDefinition;
    assert.ok(tool);
    return {
      close,
      context,
      ctx,
      emit,
      frame,
      invoke,
      directory,
      settingsPath,
      mock,
      terminal,
      async divider() {
        const first = (await frame()).split("\n")[0] ?? "";
        return first.indexOf("│") + 1;
      },
      mouse(button: number, column: number, suffix = "M") {
        terminal.send(`\u001b[<${button};${column};4${suffix}`);
      },
      togglePane() {
        terminal.send("\u001bOS");
        mock.shortcuts.get("f4")?.handler(ctx);
      },
      setBranch(entries: unknown[]) {
        branch = entries;
      },
      replaceSession() {
        ctx = { ...ctx, sessionManager: { ...ctx.sessionManager } };
        return emit("session_start", { reason: "resume" });
      },
      complete: (id: string, plan: string) =>
        tool.execute(id, { plan }, undefined, undefined, ctx as Parameters<typeof tool.execute>[4]),
      row(id: string, started = true) {
        const row = new ToolExecutionComponent(tool.name, id, {}, {}, tool, terminal.host, directory);
        if (started) row.markExecutionStarted();
        return row;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("a completed divider drag persists across workflows, renderers, and a fresh runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-persist-pane-"));
  try {
    const f = await fixture("tui", undefined, { agentDirectory: directory });
    const { readPlanModeSettings } = await import("../src/settings.js");
    try {
      await f.complete("resize", "# Resize me");
      assert.equal(await f.divider(), 50);
      await assert.rejects(access(f.settingsPath), { code: "ENOENT" });

      f.mouse(0, 50);
      f.mouse(32, 60);
      assert.equal(await f.divider(), 60);
      await assert.rejects(access(f.settingsPath), { code: "ENOENT" });
      f.mouse(0, 60, "m");
      assert.deepEqual(await readPlanModeSettings(f.settingsPath), {
        kind: "loaded",
        settings: { thinkingLevel: "inherit", planPaneWidthRatio: 40 / 99 },
      });
      f.togglePane();
      assert.equal(await f.divider(), 0);
      f.togglePane();
      assert.equal(await f.divider(), 60);

      f.terminal.switchMode("regular");
      assert.equal(await f.divider(), 0);
      f.terminal.switchMode("fullscreen");
      await f.frame();
      assert.equal(await f.divider(), 60);
      await f.invoke("exit");
      await f.invoke("start");
      await f.complete("next", "# New Plan");
      assert.equal(await f.divider(), 60);
    } finally {
      await f.close();
    }

    vi.resetModules();
    const fresh = await fixture("tui", undefined, { agentDirectory: directory });
    try {
      await fresh.complete("fresh", "# Fresh Plan");
      assert.equal(await fresh.divider(), 60);
    } finally {
      await fresh.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued drag saves preserve concurrent settings and roll back to the last successful width", async () => {
  const { readPlanModeSettings, updatePlanModeSettings } = await import("../src/settings.js");
  const ui = await import("../src/interactive-ui.js");
  const firstSave = Promise.withResolvers<void>();
  const releaseFirstSave = Promise.withResolvers<void>();
  const menuSaveQueued = Promise.withResolvers<void>();
  let attempts = 0;
  const f = await fixture("tui", undefined, {
    loadInteractiveUi: async () => ({
      ...ui,
      showPlanModeSettings: async (_ctx, options) => {
        const update = options.updateSettings ?? updatePlanModeSettings;
        const save = update({ planPane: "left" }, { settingsPath: options.settingsPath });
        menuSaveQueued.resolve();
        options.onSaved(await save);
        return { kind: "closed", reason: "close" };
      },
    }),
    updateSettings: (patch, options) => {
      if (patch.planPaneWidthRatio === undefined) return updatePlanModeSettings(patch, options);
      const attempt = ++attempts;
      return updatePlanModeSettings(patch, {
        ...options,
        beforeRename: async () => {
          if (attempt === 1) {
            firstSave.resolve();
            await releaseFirstSave.promise;
          } else if (attempt === 2) {
            throw new Error("resize publication failed");
          }
        },
      });
    },
  });
  const notify = vi.spyOn(f.ctx.ui, "notify");
  let menu: Promise<unknown> | undefined;
  try {
    await writeFile(f.settingsPath, '{"future":{"keep":true}}');
    await f.complete("race", "# Resize");
    assert.equal(await f.divider(), 50);
    f.mouse(0, 50);
    f.mouse(32, 60);
    f.mouse(0, 60, "m");
    await firstSave.promise;

    menu = Promise.resolve(f.invoke("settings"));
    await menuSaveQueued.promise;
    f.mouse(0, 60);
    f.mouse(32, 65);
    f.mouse(0, 65, "m");
    f.togglePane();
    f.togglePane();
    assert.equal(await f.divider(), 65);
    releaseFirstSave.resolve();
    await menu;
    await vi.waitFor(async () => assert.equal(await f.divider(), 41), { timeout: 2_000 });
    assert.ok(notify.mock.calls.some(([message]) => message.includes("resize publication failed")));
    assert.deepEqual(await readPlanModeSettings(f.settingsPath), {
      kind: "loaded",
      settings: { thinkingLevel: "inherit", planPane: "left", planPaneWidthRatio: 40 / 99 },
    });

    f.mouse(0, 41);
    f.mouse(32, 45);
    f.mouse(0, 45, "m");
    await vi.waitFor(async () => {
      const loaded = await readPlanModeSettings(f.settingsPath);
      assert.equal(loaded.kind === "loaded" && loaded.settings.planPaneWidthRatio, 44 / 99);
    });
    assert.equal(await f.divider(), 45);
    assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")), {
      future: { keep: true },
      planPane: "left",
      planPaneWidthRatio: 44 / 99,
    });
  } finally {
    releaseFirstSave.resolve();
    try {
      await menu;
    } finally {
      await f.close();
    }
  }
});

test.each(["replacement", "reload"] as const)("session %s reads the completed width save", async (boundary) => {
  const { updatePlanModeSettings } = await import("../src/settings.js");
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture("tui", undefined, {
    updateSettings: (patch, options) =>
      updatePlanModeSettings(patch, {
        ...options,
        beforeRename: async () => {
          reached.resolve();
          await release.promise;
        },
      }),
  });
  let transition: Promise<void> | undefined;
  try {
    await f.complete("before-boundary", "# Plan before boundary");
    assert.equal(await f.divider(), 50);
    f.mouse(0, 50);
    f.mouse(32, 60);
    f.mouse(0, 60, "m");
    await reached.promise;
    f.setBranch([stateEntry({ enabled: true, awaitingAction: true, latestPlan: "# Restored Plan" })]);

    let settled = false;
    transition = (async () => {
      if (boundary === "reload") {
        await f.emit("session_shutdown", { reason: "reload" });
        await f.emit("session_start", { reason: "reload" });
      } else {
        await f.replaceSession();
      }
      settled = true;
    })();
    assert.equal(await f.divider(), 0);
    assert.equal(settled, false);
    release.resolve();
    await transition;
    assert.equal(await f.divider(), 60);
    assert.match(await f.frame(), /Restored Plan/u);
  } finally {
    release.resolve();
    try {
      await transition;
    } finally {
      await f.close();
    }
  }
});

test("Plan pane reflects only accepted plans on the active branch", async () => {
  const f = await fixture();
  const { context, emit, frame, invoke, mock } = f;
  try {
    assert.doesNotMatch(await frame(), /│|No completed plan yet/u);
    f.togglePane();
    const rawPlan = "# Accepted plan\n\n\u202eChecklist";
    await f.complete("plan-pane-test", rawPlan);
    assert.match(await frame(), /Accepted plan/u);
    assert.doesNotMatch(await frame(), /\u202e/u);
    assert.ok(mock.entries.some(({ data }) => (data as PlanModeState).latestPlan === rawPlan));

    await emit("before_agent_start", { messageType: "user" });
    assert.doesNotMatch(await frame(), /│|Accepted plan/u);
    await emit("agent_end", { messages: [{ role: "assistant", content: "# Draft only" }] });
    assert.doesNotMatch(await frame(), /Draft only/u);
    await emit("agent_end", {
      messages: [{ role: "assistant", content: "<proposed_plan>\n# Revised plan\n</proposed_plan>" }],
    });
    assert.match(await frame(), /Revised plan/u);

    const restored = stateEntry({
      enabled: true,
      awaitingAction: true,
      latestPlan: "# Restored plan",
      latestPlanSource: "plan_mode_complete",
    });
    f.setBranch([restored]);
    await emit("session_tree");
    assert.match(await frame(), /Restored plan/u);
    assert.doesNotMatch(await frame(), /Revised plan/u);
    await invoke("save");
    assert.doesNotMatch(await frame(), /Restored plan|│/u);
    assert.equal(context.statuses.get("plan-mode"), "plan saved");

    await emit("session_tree");
    assert.match(await frame(), /Restored plan/u);
    await invoke("implement");
    assert.doesNotMatch(await frame(), /Restored plan|│/u);

    await invoke("start");
    assert.doesNotMatch(await frame(), /│|No completed plan yet/u);
    await invoke("exit");
    assert.doesNotMatch(await frame(), /No completed plan yet|│/u);
    await emit("session_tree");
    assert.match(await frame(), /Restored plan/u);
    await emit("session_shutdown", { reason: "reload" });
    assert.doesNotMatch(await frame(), /Restored plan|│/u);
    assert.equal(context.widgets.get(PANE_KEY), undefined);
  } finally {
    await f.close();
  }
});

const PLAN = "# Delivery plan\n\n\u202eDecisionMarker";
const CONFIRMATION = /Plan complete\. See the Plan pane\./u;
const snapshot = {
  content: [{ type: "text", text: `**Proposed Plan**\n\n${PLAN}` }],
  details: { version: 1, source: "plan_mode_complete", plan: PLAN },
  terminate: true,
};

function rendered(row: ToolExecutionComponent) {
  return row.render(80).map(stripTerminalSequences).join("\n");
}

const sides = ["left", "right"] as const;

test.each(sides)("a live completion is compact only while its %s pane is visible", async (side) => {
  const f = await fixture("tui", side);
  try {
    const row = f.row("live");
    f.terminal.appendToTranscript(row);
    const result = await f.complete("live", PLAN);
    assert.deepEqual(result, snapshot);
    row.updateResult({ ...result, isError: false, durationMs: 0 });
    const assertFrame = async (visible: boolean) => {
      const frame = await f.frame();
      assert.equal(CONFIRMATION.test(frame), visible, frame);
      assert.equal(frame.match(/DecisionMarker/gu)?.length, 1, frame);
      assert.equal(frame.includes("Plan · Ready"), visible, frame);
      assert.doesNotMatch(frame, /\u202e/u);
    };
    await assertFrame(true);
    row.setExpanded(true);
    await assertFrame(true);
    f.togglePane();
    await assertFrame(false);
    f.togglePane();
    await assertFrame(true);
    for (const [width, height, visible] of [
      [79, 18, false],
      [80, 18, true],
      [80, 11, false],
      [80, 12, true],
    ] as const) {
      f.terminal.resize(width, height);
      await assertFrame(visible);
    }
    await f.invoke("show");
    assert.ok(
      f.mock.sentMessages.some(({ message }) => (message as { content: unknown }).content === snapshot.content[0].text),
    );
    const destination = join(f.directory, "completed.md");
    await f.invoke(`export ${destination}`);
    assert.equal(await readFile(destination, "utf8"), `${PLAN}\n`);
    await assertFrame(false);
  } finally {
    await f.close();
  }
});

test("completion respects a manually hidden pane, but a restored branch starts in automatic mode", async () => {
  const f = await fixture();
  try {
    const original = "# Original plan";
    await f.complete("original", original);
    assert.match(await f.frame(), /│.*Original plan/u);
    f.togglePane();
    assert.doesNotMatch(await f.frame(), /│/u);
    await f.emit("before_agent_start", { messageType: "user" });
    const row = f.row("replacement");
    f.terminal.appendToTranscript(row);
    const replacement = await f.complete("replacement", PLAN);
    row.updateResult({ ...replacement, isError: false, durationMs: 0 });
    assert.doesNotMatch(await f.frame(), CONFIRMATION);
    assert.match(await f.frame(), /DecisionMarker/u);
    f.setBranch([stateEntry({ enabled: true, awaitingAction: true, latestPlan: original })]);
    await f.emit("session_tree");
    assert.match(await f.frame(), /│.*Original plan/u);
  } finally {
    await f.close();
  }
});

test("partial, error, stale, and replayed results never use a visible pane in place of their own output", async () => {
  const f = await fixture();
  try {
    const result = await f.complete("previous", PLAN);
    await f.complete("live", PLAN);
    assert.match(await f.frame(), /Plan · Ready/u);
    for (const { id, started, durationMs, isError, isPartial, original } of [
      { id: "previous", started: true, durationMs: 0 },
      { id: "live", started: false, durationMs: 0 },
      { id: "live", started: true },
      { id: "live", started: true, durationMs: 0, isError: true },
      { id: "live", started: true, durationMs: 0, isPartial: true },
      { id: "live", started: true, durationMs: 0, original: "Different content" },
    ]) {
      const row = f.row(id, started);
      const content = original ? [{ type: "text", text: original }] : result.content;
      row.updateResult(
        { ...result, content, isError: isError ?? false, ...(durationMs !== undefined && { durationMs }) },
        isPartial,
      );
      assert.ok(rendered(row).includes(original ?? "DecisionMarker"));
      assert.doesNotMatch(rendered(row), CONFIRMATION);
    }
    const liveRow = f.row("live");
    liveRow.updateResult({ ...result, isError: false, durationMs: 0 });
    assert.match(rendered(liveRow), CONFIRMATION);
    const different = await f.complete("revised", "# A different plan");
    assert.match(rendered(liveRow), /DecisionMarker/u);
    const revisedRow = f.row("revised");
    revisedRow.updateResult({ ...different, isError: false, durationMs: 0 });
    assert.match(rendered(revisedRow), CONFIRMATION);
    const restored = stateEntry({
      enabled: true,
      awaitingAction: true,
      latestPlan: "# A different plan",
      latestPlanSource: "plan_mode_complete",
    });
    f.setBranch([restored]);
    await f.emit("session_tree");
    assert.match(await f.frame(), /A different plan/u);
    assert.match(rendered(revisedRow), /A different plan/u);
    assert.doesNotMatch(rendered(revisedRow), CONFIRMATION);
    await f.complete("revised", "# A different plan");
    assert.match(rendered(revisedRow), CONFIRMATION);
    await f.emit("session_start", { reason: "resume" });
    assert.match(await f.frame(), /A different plan/u);
    assert.doesNotMatch(rendered(revisedRow), CONFIRMATION);
  } finally {
    await f.close();
  }
});

test("a replaced fullscreen root or regular renderer keeps the full result", async () => {
  const f = await fixture();
  try {
    const result = await f.complete("live", PLAN);
    const row = f.row("live");
    row.updateResult({ ...result, isError: false, durationMs: 0 });
    assert.match(await f.frame(), /Plan · Ready/u);
    assert.match(rendered(row), CONFIRMATION);
    f.terminal.fullscreen.setLayoutRoot(new VStack([new Text("Incompatible root")]));
    assert.match(rendered(row), /DecisionMarker/u);
    f.terminal.switchMode("regular");
    assert.match(rendered(row), /DecisionMarker/u);
  } finally {
    await f.close();
  }
});

test.each(["tui", "rpc", "print", "json"] as const)("%s keeps the raw result when no pane is mounted", async (mode) => {
  const f = await fixture(mode, mode === "tui" ? "off" : "right");
  try {
    const result = await f.complete("live", PLAN);
    assert.deepEqual(result, snapshot);
    const row = f.row("live");
    row.updateResult({ ...result, isError: false, durationMs: 0 });
    assert.match(rendered(row), /DecisionMarker/u);
    assert.doesNotMatch(rendered(row), CONFIRMATION);
  } finally {
    await f.close();
  }
});
