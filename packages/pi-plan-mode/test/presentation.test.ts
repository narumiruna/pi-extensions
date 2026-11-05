import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  clearPlanModeUi,
  planModeStatusText,
  renderPlanModeWidget,
  sanitizePlanModeWidgetLine,
  updatePlanModeUi,
} from "../src/presentation.js";
import type { PlanModeState } from "../src/state.js";

test("renders an editor-style divider above bounded Plan mode content", () => {
  const roles: string[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as unknown as Theme;

  const lines = renderPlanModeWidget(["Plan mode: planning", "A longer status line"], theme, 12);

  assert.deepEqual(lines.map(stripTerminalSequences), ["─".repeat(12), "Plan mode: p", "A longer sta"]);
  assert.deepEqual(roles, ["muted", "borderMuted"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test.each([0, 1, 2, 12, 80, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 12.9])(
  "keeps sanitized body rows bounded at width %s",
  (width) => {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const body = ["Plan mode: planning", "\u001b[31m界界\u001b[0m\ne\u0301\u202e"];
    const theme = { fg: (_role: string, text: string) => text } as Theme;
    const lines = renderPlanModeWidget(body, theme, width);
    assert.deepEqual(lines, [
      "─".repeat(normalized),
      ...body.map((line) => truncateToWidth(sanitizePlanModeWidgetLine(line), normalized, "")),
    ]);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    assert.equal(body[1], "\u001b[31m界界\u001b[0m\ne\u0301\u202e");
    if (normalized === 0) assert.deepEqual(lines, ["", "", ""]);
  },
);

const widgetStates: Array<{ state: PlanModeState; status: string; body: string[] }> = [
  {
    state: { enabled: true, awaitingAction: false },
    status: "plan active",
    body: [
      "Plan mode: planning",
      "Read tools only",
      "Finish with plan_mode_complete when decision-ready.",
      "Use /plan to switch to free discussion.",
    ],
  },
  {
    state: { enabled: true, awaitingAction: true, latestPlan: "A proposed plan" },
    status: "plan ready",
    body: [
      "Proposed plan ready",
      "Use /plan to implement, save, revise, or exit Plan mode.",
      "Use /plan to switch to free discussion.",
    ],
  },
  {
    state: { enabled: true, awaitingAction: false, interactionMode: "discussion" },
    status: "plan discussion",
    body: [
      "Plan mode: free discussion",
      "Read tools only",
      "Plain-text questions are allowed; questionnaires are paused.",
      "Use /plan to enable questionnaires.",
    ],
  },
  {
    state: { enabled: true, awaitingAction: false, interactionMode: "discussion", latestPlan: "Ready" },
    status: "plan ready",
    body: [
      "Proposed plan ready",
      "Plan mode: free discussion",
      "Use /plan to implement, save, revise, or exit Plan mode.",
      "Use /plan to enable questionnaires.",
    ],
  },
  {
    state: { enabled: false, awaitingAction: false, savedPlan: { plan: "Saved", source: "plan_mode_complete" } },
    status: "plan saved",
    body: ["Plan saved for later", "Use /plan to show, implement, or clear it."],
  },
  {
    state: {
      enabled: false,
      awaitingAction: false,
      activeImplementation: { id: "plan", plan: "Active", source: "plan_mode_complete", startedAt: 0 },
    },
    status: "plan implementing",
    body: ["Implementation plan active", "Use /plan to show, replace, or clear it."],
  },
];

test.each(widgetStates)("preserves widget publication and exact-key cleanup for $status", ({ state, status, body }) => {
  for (const mode of ["tui", "rpc"] as const) {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = { mode, hasUI: true, ui: { setWidget, setStatus } } as unknown as ExtensionContext;
    updatePlanModeUi(ctx, state, () => "Read tools only");
    assert.deepEqual(setStatus.mock.calls, [["plan-mode", status]]);
    assert.equal(setWidget.mock.calls.length, 1);
    const [key, content, options] = setWidget.mock.calls[0] ?? [];
    assert.equal(key, "plan-mode-plan");
    assert.equal(options, undefined, "retain default above-editor placement");
    if (mode === "tui") {
      const factory = content as (_tui: unknown, theme: Theme) => Component;
      let color = "\u001b[31m";
      const fg = vi.fn((_role: string, text: string) => `${color}${text}\u001b[0m`);
      const component = factory({}, { fg } as unknown as Theme);
      for (const width of [80, 0, 1, 12, 80]) {
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width === 0) assert.deepEqual(lines, ["", ...body.map(() => "")]);
        else assert.ok(fg.mock.calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(width)));
      }
      assert.deepEqual(component.render(80).slice(1).map(stripTerminalSequences), body);
      assert.ok(fg.mock.calls.some(([role, text]) => role === "muted" && text === body.at(-1)));
      color = "\u001b[32m";
      component.invalidate();
      const recolored = component.render(80);
      assert.equal(recolored[0], `${color}${"─".repeat(80)}\u001b[0m`);
      assert.equal(recolored.at(-1), `${color}${body.at(-1)}\u001b[0m`);
      assert.equal(setWidget.mock.calls.length, 1);
    } else {
      assert.deepEqual(content, body, "non-TUI publication stays plain and unframed");
    }
    clearPlanModeUi(ctx);
    clearPlanModeUi(ctx);
    assert.deepEqual(setWidget.mock.calls.slice(1), [
      ["plan-mode-plan", undefined],
      ["plan-mode-plan", undefined],
    ]);
    assert.deepEqual(setStatus.mock.calls.slice(1), [
      ["plan-mode", undefined],
      ["plan-mode", undefined],
    ]);
    updatePlanModeUi(ctx, { enabled: false, awaitingAction: false }, () => "unused");
    assert.deepEqual(setWidget.mock.calls.at(-1), ["plan-mode-plan", undefined]);
  }
});

test.each(["print", "json"] as const)("keeps existing no-op status adapters without custom UI in %s mode", (mode) => {
  const setWidget = vi.fn();
  const setStatus = vi.fn();
  const ctx = { mode, hasUI: false, ui: { setWidget, setStatus } } as unknown as ExtensionContext;
  updatePlanModeUi(
    ctx,
    { enabled: true, awaitingAction: false, interactionMode: "discussion" },
    () => "read only",
    "F2",
  );
  clearPlanModeUi(ctx);
  assert.equal(setWidget.mock.calls.length, 2);
  assert.ok(Array.isArray(setWidget.mock.calls[0]?.[1]));
  assert.doesNotMatch(JSON.stringify(setWidget.mock.calls[0]), /F2/);
  assert.deepEqual(setWidget.mock.calls[1], ["plan-mode-plan", undefined]);
  assert.deepEqual(setStatus.mock.calls, [
    ["plan-mode", "plan discussion"],
    ["plan-mode", undefined],
  ]);
});

test.each([undefined, "questions", "discussion"] as const)(
  "shows only available interaction hints for %s mode",
  (interactionMode) => {
    for (const mode of ["tui", "rpc"] as const) {
      for (const shortcut of [undefined, "F2"]) {
        const setWidget = vi.fn();
        const ctx = { mode, hasUI: true, ui: { setWidget, setStatus: vi.fn() } } as unknown as ExtensionContext;
        updatePlanModeUi(ctx, { enabled: true, awaitingAction: false, interactionMode }, () => "read only", shortcut);
        const content = setWidget.mock.calls[0]?.[1];
        const body =
          typeof content === "function"
            ? content({}, { fg: (_role: string, text: string) => text }).render(100)
            : content;
        const action = interactionMode === "discussion" ? "enable questionnaires" : "switch to free discussion";
        assert.equal(body.at(-1), mode === "tui" && shortcut ? `F2: ${action}.` : `Use /plan to ${action}.`);
      }
    }
  },
);

test("status text describes discussion, readiness, and restrictions without an inactive key hint", () => {
  for (const latestPlan of [undefined, "Ready plan"]) {
    const state: PlanModeState = { enabled: true, awaitingAction: false, interactionMode: "discussion", latestPlan };
    const text = planModeStatusText(state, () => "Read tools only");
    assert.match(text, /Free discussion is active; questionnaires are paused and plain-text questions are allowed/);
    assert.match(text, /File edits remain blocked\. Read tools only/);
    assert.equal(text.includes("F2"), false);
    assert.equal(text.includes("Use /plan"), false);
    assert.equal(text.includes("A proposed plan is ready"), latestPlan !== undefined);
  }
  const state = { enabled: true, awaitingAction: false };
  assert.equal(
    planModeStatusText(state, () => "read only"),
    planModeStatusText({ ...state, interactionMode: "questions" }, () => "read only"),
  );
});

test("sanitizes terminal and bidi controls before truncating Plan mode content", () => {
  const hostile = "safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n界界\u202e";
  assert.equal(sanitizePlanModeWidgetLine(hostile), "safelink 界界");
});
