import assert from "node:assert/strict";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { PLAN_DRAFT_PREVIEW_MESSAGE_TYPE } from "../src/message-transform.js";
import { createPlanPaneController } from "../src/plan-pane.js";
import { showStoredPlan, updatePlanModeUi } from "../src/presentation.js";
import type { PlanModeState } from "../src/state.js";
import { createPlanPaneHost } from "./plan-pane-support.js";
import { createMockContext, createMockPi } from "./support.js";

const plan = "# Fresh direction\n\n- First step";
const draft: PlanModeState = { enabled: true, awaitingAction: false, draftPlan: plan };

test.each(["tui", "rpc"] as const)("shows a draft without a new turn or ready status in %s", (mode) => {
  const mock = createMockPi();
  const { ctx, statuses } = createMockContext({ mode });
  const tainted = { ...draft, draftPlan: `${plan}\u001b]0;NO TITLE\u0007\u202e` };
  updatePlanModeUi(ctx, tainted, () => "Read only");
  showStoredPlan(mock.pi, ctx, tainted);
  assert.equal(statuses.get("plan-mode"), "plan active");
  assert.deepEqual(mock.sentMessages, [
    {
      message: { customType: PLAN_DRAFT_PREVIEW_MESSAGE_TYPE, content: `**Draft Plan**\n\n${plan}`, display: true },
      options: { triggerTurn: false },
    },
  ]);
  assert.ok(tainted.draftPlan.endsWith("\u202e"));
  const ready: PlanModeState = { enabled: true, awaitingAction: true, latestPlan: plan };
  updatePlanModeUi(ctx, ready, () => "Read only");
  showStoredPlan(mock.pi, ctx, ready);
  assert.equal(statuses.get("plan-mode"), "plan ready");
  assert.deepEqual(mock.sentMessages.at(-1)?.message, {
    customType: "proposed-plan",
    content: `**Proposed Plan**\n\n${plan}`,
    display: true,
  });
});

test.each(["print", "json"] as const)("rejects draft display in %s without changing history", (mode) => {
  const mock = createMockPi();
  const { ctx } = createMockContext({ mode, hasUI: false });
  assert.throws(() => showStoredPlan(mock.pi, ctx, draft), /Draft plan display is unavailable in print\/JSON/u);
  assert.deepEqual(mock.sentMessages, []);
});

test.each(["left", "right"] as const)(
  "the %s pane updates draft Markdown and shows when it becomes ready",
  async (placement) => {
    initTheme("dark");
    const terminal = createPlanPaneHost();
    const ctx = createMockContext({ mode: "tui" }).ctx as ExtensionContext;
    ctx.ui.setWidget = terminal.setWidget;
    const pane = createPlanPaneController();
    const rows = () => terminal.render().map(stripTerminalSequences);
    try {
      pane.update(ctx, placement, "# Earlier draft", true);
      await Promise.resolve();
      assert.match(rows()[0] ?? "", /Draft/u);
      assert.match(rows().join("\n"), /Earlier draft/u);
      pane.update(ctx, placement, plan, true);
      assert.match(rows()[0] ?? "", /Draft/u);
      assert.match(rows().join("\n"), /Fresh direction/u);
      assert.doesNotMatch(rows().join("\n"), /Earlier draft/u);
      pane.update(ctx, placement, plan);
      assert.match(rows()[0] ?? "", /Plan/u);
      assert.match(rows().join("\n"), /Fresh direction/u);
      terminal.resize(80, 12);
      assert.ok(rows().every((row) => visibleWidth(row) <= 80));
    } finally {
      pane.clear();
      terminal.stop();
    }
  },
);
