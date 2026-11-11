import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createProgressPresentation } from "../src/progress-presentation.js";
import { progressDividerSummary, renderProgressWidget } from "../src/progress-renderer.js";
import type { ProgressStep } from "../src/progress-state.js";
import { DEFAULT_PROGRESS_SETTINGS } from "../src/settings.js";
import { createContext, identityTheme } from "./progress-harness.js";

const steps: ProgressStep[] = [
  { text: "Completed step", status: "completed" },
  { text: "Current step", status: "in_progress" },
  { text: "Pending step", status: "pending" },
  { text: "External approval needed", status: "blocked" },
];

test("Progress puts counts and critical state in the divider, not in a second body header", () => {
  const current = createContext();
  current.setTheme(identityTheme().theme);
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: DEFAULT_PROGRESS_SETTINGS,
    setTimeout,
    clearTimeout,
  });
  try {
    presentation.reset(steps);
    const lines = current.renderWidget();
    assert.match(lines[0] ?? "", /^─ ▾ Progress · ⚠ 1 blocked · 1\/4 complete ─+$/u);
    assert.deepEqual(lines.slice(1), [
      "✓ Completed step",
      "▶ Current step",
      "○ Pending step",
      "⚠ External approval needed",
    ]);
    assert.equal(lines.filter((line) => line.includes("Progress")).length, 1);
    presentation.show("compact");
    assert.equal(current.renderWidget().length, 1);
    assert.match(current.renderWidget()[0] ?? "", /1 blocked · 1\/4 complete · 1 active/u);
  } finally {
    presentation.dispose();
  }
});

test("collapsed Progress retains current warning and completion counts", () => {
  const current = createContext();
  current.setTheme(identityTheme().theme);
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: DEFAULT_PROGRESS_SETTINGS,
    setTimeout,
    clearTimeout,
  });
  try {
    presentation.reset(steps);
    const component = current.component;
    assert.ok(component);
    const event = {
      button: "left" as const,
      x: 79,
      y: 1,
      screenX: 79,
      screenY: 1,
      width: 80,
      height: current.renderWidget().length,
      shift: false,
      alt: false,
      ctrl: false,
    };
    for (const type of ["press", "release", "click"] as const) component.handleMouse?.({ ...event, type });
    assert.equal(current.renderWidget().length, 1);
    presentation.update([{ text: "Current blocker", status: "blocked" }], DEFAULT_PROGRESS_SETTINGS);
    assert.match(current.renderWidget()[0] ?? "", /▸ Progress · ⚠ 1 blocked · 0\/1 complete/u);
    presentation.show("default");
    assert.equal(current.renderWidget()[1], "⚠ Current blocker");
  } finally {
    presentation.dispose();
  }
});

test("Progress keeps custom blocker and removed counts without forcing a disabled progress counter", () => {
  const settings = {
    ...DEFAULT_PROGRESS_SETTINGS,
    showProgress: false,
    blockedStyle: { icon: "◆", color: "error" as const },
  };
  assert.equal(progressDividerSummary(steps, settings, 1), "◆ 1 blocked · 1 removed");
  assert.equal(progressDividerSummary(steps, settings, 0, true), "◆ 1 blocked · 1/4 complete · 1 active");
});

for (const width of [0, 1, 2, 10, 40, 80]) {
  test(`named Progress stays bounded at width ${width} without changing standalone output`, () => {
    const theme = identityTheme().theme;
    const named = renderProgressWidget(steps, theme, width, { showHeader: false });
    const standalone = renderProgressWidget(steps, theme, width);
    assert.ok(named.every((line) => visibleWidth(line) <= width));
    assert.ok(standalone.every((line) => visibleWidth(line) <= width));
    assert.equal(named[0], "─".repeat(width));
    if (width >= 40) {
      assert.match(standalone[1] ?? "", /^Progress · 1\/4 complete/u);
      assert.equal(named[1], "✓ Completed step");
    }
    assert.deepEqual(renderProgressWidget(steps, theme, width, { maxRows: 1 }), []);
    assert.deepEqual(renderProgressWidget(steps, theme, width, { maxRows: 1, showHeader: false }), ["─".repeat(width)]);
  });
}
