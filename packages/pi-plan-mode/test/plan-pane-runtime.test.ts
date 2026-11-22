import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { PlanModeState } from "../src/state.js";
import { createPlanPaneHost, PANE_KEY } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

const stateEntry = (data: PlanModeState) => ({ type: "custom", customType: "plan-mode-state", data });

test("Plan pane reflects only accepted plans on the active branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-pane-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  initTheme("dark");
  const terminal = createPlanPaneHost();
  const mock = createMockPi({ activeTools: ["read"] });
  let branch: unknown[] = [];
  const context = createMockContext({
    mode: "tui",
    cwd: directory,
    sessionManager: { getSessionId: () => "pane", getBranch: () => branch, getEntries: () => branch },
  });
  const ctx: ExtensionContext = context.ctx;
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
  try {
    const { default: planMode } = await import("../src/plan-mode.js");
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" }) });
    await emit("session_start", { reason: "startup" });
    const command = mock.commands.get("plan");
    assert.ok(command);
    const invoke = (args: string) => command.handler(args, ctx as Parameters<typeof command.handler>[1]);
    await invoke("start");
    assert.match(await frame(), /No completed plan yet/u);

    const completed = mock.tools.find(({ name }) => name === "plan_mode_complete");
    assert.ok(completed);
    const complete = completed.execute as (...args: unknown[]) => Promise<unknown>;
    const rawPlan = "# Accepted plan\n\n\u202eChecklist";
    await complete("plan-pane-test", { plan: rawPlan }, undefined, undefined, ctx);
    assert.match(await frame(), /Accepted plan/u);
    assert.doesNotMatch(await frame(), /\u202e/u);
    assert.ok(mock.entries.some(({ data }) => (data as PlanModeState).latestPlan === rawPlan));

    await emit("before_agent_start", { messageType: "user" });
    assert.match(await frame(), /No completed plan yet/u);
    assert.doesNotMatch(await frame(), /Accepted plan/u);
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
    branch = [restored];
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
    assert.match(await frame(), /No completed plan yet/u);
    await invoke("exit");
    assert.doesNotMatch(await frame(), /No completed plan yet|│/u);
    await emit("session_tree");
    assert.match(await frame(), /Restored plan/u);
    await emit("session_shutdown", { reason: "reload" });
    assert.doesNotMatch(await frame(), /Restored plan|│/u);
    assert.equal(context.widgets.get(PANE_KEY), undefined);
  } finally {
    await emit("session_shutdown", { reason: "quit" });
    terminal.stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});
