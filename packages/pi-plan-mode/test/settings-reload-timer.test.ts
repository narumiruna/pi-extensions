import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { PlanModeSettingsLoadResult } from "../src/settings.js";
import { createPlanPaneHost } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

const watches = vi.hoisted(
  () =>
    [] as Array<{
      listener(event: string, filename: string): void;
      close: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn((_path: string, _options: unknown, listener: (event: string, filename: string) => void) => {
      const close = vi.fn();
      watches.push({ listener, close });
      return { on: vi.fn().mockReturnThis(), close };
    }),
  };
});

test("settings reload Node timers are unreferenced and cancel on debounce, replacement, and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-timer-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  const { default: planMode } = await import("../src/plan-mode.js");
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { settingsPath: join(directory, "pi-plan-mode.json") });
  const context = createMockContext();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    const firstWatch = watches.at(-1);
    assert.ok(firstWatch);
    firstWatch.listener("change", "pi-plan-mode.json");
    const first = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(first);
    assert.equal(first.hasRef(), false);

    firstWatch.listener("rename", "pi-plan-mode.json");
    const second = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.hasRef(), false);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === first).length, 1);

    const replacement = createMockContext();
    await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
    assert.equal(firstWatch.close.mock.calls.length, 1);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === second).length, 1);
    const nextWatch = watches.at(-1);
    assert.ok(nextWatch);
    assert.notEqual(nextWatch, firstWatch);
    nextWatch.listener("change", "pi-plan-mode.json");
    const third = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(third);
    assert.equal(third.hasRef(), false);
    await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
    await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === third).length, 1);
    assert.equal(nextWatch.close.mock.calls.length, 1);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
    timeout.mockRestore();
    clear.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("pane settings apply on save and reject obsolete or invalid watcher reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-pane-watch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  initTheme("dark");
  const terminal = createPlanPaneHost();
  const settings = await import("../src/settings.js");
  const ui = await import("../src/interactive-ui.js");
  let finishRead: (result: PlanModeSettingsLoadResult) => void = () => {};
  const stale = new Promise<PlanModeSettingsLoadResult>((resolve) => {
    finishRead = resolve;
  });
  const reads = vi.spyOn(settings, "readPlanModeSettings").mockResolvedValueOnce({ kind: "missing" });
  reads.mockReturnValueOnce(stale);
  const mock = createMockPi({ activeTools: ["read"] });
  const ctx: ExtensionContext = createMockContext({ mode: "tui", cwd: directory }).ctx;
  ctx.ui.setWidget = terminal.setWidget;
  const frame = () => stripTerminalSequences(terminal.render()[0] ?? "");
  const { default: planMode } = await import("../src/plan-mode.js");
  planMode(mock.pi, {
    settingsPath: join(directory, "pi-plan-mode.json"),
    loadInteractiveUi: async () => ({
      ...ui,
      showPlanModeSettings: async (_ctx, options) => {
        options.onSaved({ thinkingLevel: "inherit", planPane: "left" });
        return { kind: "closed", reason: "close" };
      },
    }),
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    const command = mock.commands.get("plan");
    assert.ok(command);
    const invoke = (args: string) => command.handler(args, ctx as Parameters<typeof command.handler>[1]);
    await invoke("start");
    assert.doesNotMatch(frame(), /│/u);
    const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete");
    assert.ok(complete);
    await (complete.execute as (...args: unknown[]) => Promise<unknown>)(
      "pane-settings",
      { plan: "# Plan content" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(frame(), /^history .*│Plan/u);
    const watcher = watches.at(-1);
    assert.ok(watcher);
    watcher.listener("change", "pi-plan-mode.json");
    await vi.advanceTimersByTimeAsync(75);
    assert.equal(reads.mock.calls.length, 2);
    await invoke("settings");
    assert.match(frame(), /^Plan .*│history/u);
    finishRead({ kind: "loaded", settings: { thinkingLevel: "inherit", planPane: "right" } });
    await Promise.resolve();
    assert.match(frame(), /^Plan .*│history/u);
    reads.mockResolvedValueOnce({ kind: "invalid", reason: "invalid settings shape" });
    await vi.advanceTimersByTimeAsync(75);
    assert.match(frame(), /^Plan .*│history/u);
    reads.mockResolvedValueOnce({ kind: "loaded", settings: { thinkingLevel: "inherit", planPane: "off" } });
    watcher.listener("rename", "pi-plan-mode.json");
    await vi.advanceTimersByTimeAsync(75);
    assert.doesNotMatch(frame(), /│/u);
    reads.mockResolvedValueOnce({ kind: "loaded", settings: { thinkingLevel: "inherit", planPane: "right" } });
    watcher.listener("rename", "pi-plan-mode.json");
    await vi.advanceTimersByTimeAsync(75);
    assert.match(frame(), /^history .*│Plan/u);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    vi.useRealTimers();
    reads.mockRestore();
    terminal.stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});
