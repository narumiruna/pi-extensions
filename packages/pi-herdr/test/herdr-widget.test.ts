import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  type HerdrPane,
  herdrWidgetSubscriptions,
  parseAgentListResult,
  parseHerdrPaneEvent,
  parsePaneCurrentResult,
  parsePaneListResult,
  parseWorkspaceGetResult,
} from "../src/herdr-protocol.js";
import {
  createHerdrWidget,
  HerdrWidgetModel,
  herdrWidgetFingerprint,
  MAX_HERDR_WIDGET_AGENTS,
} from "../src/herdr-widget.js";

function pane(
  paneId: string,
  agentStatus: HerdrPane["agentStatus"] = "idle",
  overrides: Partial<HerdrPane> = {},
): HerdrPane {
  return {
    paneId,
    workspaceId: "w1",
    tabId: `${paneId}:tab`,
    terminalId: `${paneId}:term`,
    focused: false,
    revision: 1,
    agent: "pi",
    agentStatus,
    stateLabels: {},
    ...overrides,
  };
}

function wirePane(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    terminal_id: "term-1",
    focused: false,
    revision: 1,
    agent: "pi",
    agent_status: "idle",
    future_field: true,
    ...overrides,
  };
}

test("validates current panes, pane lists, and supported subscription events", () => {
  assert.equal(parsePaneCurrentResult({ type: "pane_current", pane: wirePane() }).paneId, "w1:p1");
  assert.equal(
    parsePaneListResult({ type: "pane_list", panes: [wirePane(), wirePane({ pane_id: "w1:p2" })] }).length,
    2,
  );
  assert.throws(
    () => parsePaneCurrentResult({ type: "pane_current", pane: wirePane({ pane_id: "" }) }),
    /invalid current pane/u,
  );
  assert.throws(
    () => parsePaneListResult({ type: "pane_list", panes: [wirePane({ agent_status: "new" })] }),
    /invalid pane/u,
  );
  assert.equal(
    parseAgentListResult({ type: "agent_list", agents: [wirePane({ name: "reviewer" })] })[0]?.agentName,
    "reviewer",
  );
  assert.deepEqual(
    parseWorkspaceGetResult({
      type: "workspace_info",
      workspace: { workspace_id: "w1", label: "space" },
    }),
    { workspaceId: "w1", label: "space" },
  );

  assert.deepEqual(
    parseHerdrPaneEvent({
      event: "pane.agent_status_changed",
      data: {
        pane_id: "w1:p2",
        workspace_id: "w1",
        agent: "pi",
        agent_status: "blocked",
        state_labels: { blocked: "waiting" },
      },
    }),
    {
      type: "agent_status_changed",
      paneId: "w1:p2",
      workspaceId: "w1",
      agent: "pi",
      agentStatus: "blocked",
      displayAgent: undefined,
      stateLabels: { blocked: "waiting" },
      title: undefined,
    },
  );
  assert.deepEqual(
    parseHerdrPaneEvent({
      event: "pane_agent_detected",
      data: {
        pane_id: "w1:p2",
        workspace_id: "w1",
        agent: "codex",
        final_status: "done",
        released: false,
      },
    }),
    {
      type: "agent_detected",
      paneId: "w1:p2",
      workspaceId: "w1",
      agent: "codex",
      finalStatus: "done",
      released: false,
    },
  );
  assert.equal(
    parseHerdrPaneEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "invalid" },
    }),
    undefined,
  );
  assert.deepEqual(
    herdrWidgetSubscriptions([pane("w1:p1"), pane("w1:shell", "unknown", { agent: undefined })]).filter(
      (entry) => entry.type === "pane.agent_status_changed",
    ),
    [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
  );
});

test("filters siblings, orders every state, distinguishes panes, and caps rows", () => {
  const model = new HerdrWidgetModel();
  const current = pane("w1:p1", "working", { title: "current" });
  model.reset(current, [
    current,
    pane("w1:p2", "idle", { label: "same" }),
    pane("w1:p3", "blocked", { label: "blocked" }),
    pane("w1:p4", "done", { label: "done" }),
    pane("w1:p5", "working", { label: "working" }),
    pane("w1:p6", "unknown", { label: "unknown" }),
    pane("w1:p7", "idle", { label: "same" }),
    pane("w1:p8", "idle", { label: "overflow" }),
    pane("w2:p1", "blocked", { workspaceId: "w2", label: "other workspace" }),
    pane("w1:shell", "blocked", { agent: undefined, label: "shell" }),
  ]);
  const snapshot = model.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.totalAgents, 7);
  assert.equal(snapshot.rows.length, MAX_HERDR_WIDGET_AGENTS);
  assert.equal(snapshot.hiddenAgents, 2);
  assert.deepEqual(
    snapshot.rows.map(({ state }) => state),
    ["blocked", "done", "working", "idle", "idle"],
  );
  assert.ok(snapshot.rows.some(({ pane }) => pane === "same/p2"));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.rows), true);
});

test("tracks moved current panes plus agent detection, release, and exit", () => {
  const model = new HerdrWidgetModel();
  model.reset(pane("w1:p1"), [pane("w1:p1"), pane("w1:p2", "working", { label: "worker" })]);
  model.apply({
    type: "moved",
    previousPaneId: "w1:p1",
    previousWorkspaceId: "w1",
    pane: pane("w2:p9", "working", { workspaceId: "w2" }),
  });
  model.apply({
    type: "agent_detected",
    paneId: "w2:p2",
    workspaceId: "w2",
    agent: "codex",
    finalStatus: "done",
    released: false,
  });
  assert.equal(model.snapshot()?.rows[0]?.paneId, "w2:p2");
  model.apply({
    type: "agent_detected",
    paneId: "w2:p2",
    workspaceId: "w2",
    released: true,
  });
  assert.equal(model.snapshot(), undefined);
  model.apply({
    type: "agent_status_changed",
    paneId: "w2:p3",
    workspaceId: "w2",
    agent: "pi",
    agentStatus: "blocked",
  });
  assert.equal(model.snapshot()?.rows[0]?.paneId, "w2:p3");
  model.apply({ type: "exited", paneId: "w2:p3", workspaceId: "w2" });
  assert.equal(model.snapshot(), undefined);
});

test("renders Herdr's distinct static symbol and semantic theme role for every agent state", () => {
  const roles = new Map<string, string>();
  const theme = {
    bold: (text: string) => text,
    fg: (role: string, text: string) => {
      if (/^[×◐✓○·] /u.test(text)) roles.set(text, role);
      return text;
    },
  } as Theme;
  const widget = createHerdrWidget(
    {
      totalAgents: 5,
      hiddenAgents: 0,
      rows: [
        {
          agent: "a",
          pane: "p1",
          paneId: "w1:p1",
          space: "w1",
          state: "blocked",
          stateLabel: "blocked",
        },
        {
          agent: "b",
          pane: "p2",
          paneId: "w1:p2",
          space: "w1",
          state: "working",
          stateLabel: "working",
        },
        { agent: "c", pane: "p3", paneId: "w1:p3", space: "w1", state: "done", stateLabel: "done" },
        { agent: "d", pane: "p4", paneId: "w1:p4", space: "w1", state: "idle", stateLabel: "idle" },
        {
          agent: "e",
          pane: "p5",
          paneId: "w1:p5",
          space: "w1",
          state: "unknown",
          stateLabel: "unknown",
        },
      ],
    },
    theme,
  );

  const rendered = widget.render(80).join("\n");
  for (const state of ["× blocked", "◐ working", "✓ done", "○ idle", "· unknown"]) {
    assert.ok(rendered.includes(state), `missing ${state}`);
  }
  assert.deepEqual(Object.fromEntries(roles), {
    "× blocked": "error",
    "◐ working": "warning",
    "✓ done": "accent",
    "○ idle": "success",
    "· unknown": "dim",
  });
});

test("sanitizes before sorting and renders terminal-width-safe themed rows", () => {
  const model = new HerdrWidgetModel();
  model.reset(
    pane("w1:p1"),
    [
      pane("w1:p1"),
      pane("w1:p2\u001b]8;;spoof", "blocked", {
        agentName: "reviewer\nname\u202e",
        label: "測試\nagent\u202e\u001b]8;;https://spoof\u0007",
        stateLabels: { blocked: "wait\rnow" },
      }),
    ],
    { workspaceId: "w1", label: "space\u001b]8;;spoof" },
  );
  const snapshot = model.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.rows[0]?.agent, "reviewer name");
  assert.equal(snapshot.rows[0]?.pane, "測試 agent/p2");
  assert.equal(snapshot.rows[0]?.space, "space/w1");
  assert.equal(snapshot.rows[0]?.stateLabel, "wait now");
  assert.equal(snapshot.rows[0]?.paneId.includes("\u001b"), false);
  assert.equal(herdrWidgetFingerprint(snapshot), herdrWidgetFingerprint(model.snapshot()));

  let color = 31;
  const theme = {
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    fg: (_role: string, text: string) => `\u001b[${color}m${text}\u001b[0m`,
  } as Theme;
  const widget = createHerdrWidget(snapshot, theme);
  for (const width of [0, 1, 12, 32, 80]) {
    assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
  }
  const first = widget.render(80).join("\n");
  assert.equal(first.includes("\u001b]8"), false);
  assert.equal(first.includes("\u202e"), false);
  assert.equal(first.includes("> "), false);
  color = 32;
  widget.invalidate();
  assert.notEqual(widget.render(80).join("\n"), first);
});
