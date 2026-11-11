import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createProgressPresentation } from "../src/progress-presentation.js";
import { type RenderProgressWidgetOptions, renderProgressWidget } from "../src/progress-renderer.js";
import type { ProgressStep } from "../src/progress-state.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettings } from "../src/settings.js";
import { createContext } from "./progress-harness.js";

import {
  backgroundRoles as backgrounds,
  foregroundRoles as foregrounds,
  createProgressTheme as rendererTheme,
} from "./progress-theme.js";

function settings(color = "error", icon = "!", patch: Partial<ProgressSettings> = {}) {
  return { ...DEFAULT_PROGRESS_SETTINGS, ...patch, blockedStyle: { icon, color } };
}

const blocked: ProgressStep[] = [{ text: "approval", status: "blocked" }];
const mixed: ProgressStep[] = [
  { text: "finished", status: "completed" },
  { text: "current", status: "in_progress" },
  { text: "approval", status: "blocked" },
  { text: "next", status: "pending" },
];
const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);

function rowWith(lines: readonly string[], text: string) {
  const row = lines.find((line) => stripVTControlCharacters(line) === text);
  assert.notEqual(row, undefined, `Missing row: ${text}\n${plain(lines).join("\n")}`);
  return row;
}

for (const displayMode of ["expanded", "collapsed", "adaptive"] as const) {
  test(`${displayMode}: custom blocked detail uses its icon and color without changing other statuses`, () => {
    const theme = rendererTheme();
    const options = { settings: settings("error", "!", { displayMode }), terminalRows: 36 };
    const lines = renderProgressWidget(mixed, theme, 100, options);
    assert.equal(rowWith(lines, "! approval"), theme.fg("error", "! ") + theme.fg("error", "approval"));
    assert.equal(rowWith(lines, "▶ current"), theme.fg("accent", "▶ ") + theme.fg("accent", theme.bold("current")));
    assert.equal(rowWith(lines, "○ next"), theme.fg("dim", "○ ") + theme.fg("text", "next"));
    assert.equal(lines[0], theme.fg("borderMuted", "─".repeat(100)));
    assert.equal(lines[1], theme.fg("muted", "Progress · 1/4 complete"));
    if (displayMode !== "collapsed") {
      assert.equal(
        rowWith(lines, "✓ finished"),
        theme.fg("success", "✓ ") + theme.fg("muted", theme.strikethrough("finished")),
      );
    }
    assert.doesNotMatch(plain(lines).join("\n"), /⚠/u);
  });
}

test("default blocked detail and compact summary retain their exact bytes", () => {
  const theme = rendererTheme();
  assert.deepEqual(DEFAULT_PROGRESS_SETTINGS.blockedStyle, { icon: "⚠", color: "warning" });
  assert.deepEqual(renderProgressWidget(blocked, theme, 80), [
    theme.fg("borderMuted", "─".repeat(80)),
    theme.fg("muted", "Progress · 0/1 complete"),
    theme.fg("warning", "⚠ ") + theme.fg("warning", "approval"),
  ]);
  assert.deepEqual(renderProgressWidget(blocked, theme, 80, { viewMode: "compact" }), [
    theme.fg("borderMuted", "─".repeat(80)),
    theme.fg("warning", "⚠ 1 blocked · 0/1 complete"),
  ]);
  assert.deepEqual(renderProgressWidget(blocked, theme, 80, { maxRows: 2 }), [
    theme.fg("borderMuted", "─".repeat(80)),
    theme.fg("warning", "⚠ 1 blocked · 0/1 complete · 1 hidden"),
  ]);
});

const summarySteps: ProgressStep[] = [
  { text: "current", status: "in_progress" },
  { text: "approval", status: "blocked" },
  { text: "next", status: "pending" },
  { text: "later", status: "pending" },
];

const summaryCases: Array<{
  name: string;
  options: RenderProgressWidgetOptions;
  patch?: Partial<ProgressSettings>;
  role: ThemeColor;
  summary: string;
}> = [
  {
    name: "compact view",
    options: { viewMode: "compact" },
    role: "error",
    summary: "! 1 blocked · 0/4 complete · 1 active",
  },
  {
    name: "two-row cap",
    options: { maxRows: 2, viewMode: "expanded" },
    role: "error",
    summary: "! 1 blocked · 0/4 complete · 1 active · 4 hidden",
  },
  {
    name: "expanded item cap omits blocked detail",
    options: { viewMode: "expanded" },
    patch: { maxVisibleItems: 1 },
    role: "error",
    summary: "! 1 blocked · 0/4 complete · 1 active",
  },
  {
    name: "collapsed row budget omits blocked detail",
    options: { terminalRows: 12 },
    patch: { displayMode: "collapsed" },
    role: "error",
    summary: "! 1 blocked · 0/4 complete · 1 active",
  },
  {
    name: "adaptive item cap omits blocked detail",
    options: { terminalRows: 36 },
    patch: { displayMode: "adaptive", maxVisibleItems: 1 },
    role: "error",
    summary: "! 1 blocked · 0/4 complete · 1 active",
  },
  {
    name: "compact item retains muted aggregate header",
    options: {
      items: summarySteps.map((value) => ({ value, mode: value.status === "blocked" ? "compact" : "expanded" })),
      viewMode: "expanded",
    },
    role: "muted",
    summary: "! 1 blocked · 0/4 complete · 1 active",
  },
  {
    name: "removed blocked item retains muted aggregate header",
    options: {
      items: summarySteps.filter((value) => value.status !== "blocked").map((value) => ({ value, mode: "expanded" })),
      viewMode: "expanded",
    },
    role: "muted",
    summary: "! 1 blocked · 0/4 complete · 1 active · 1 hidden",
  },
  {
    name: "capped overflow retains muted aggregate header",
    options: { maxRows: 4, viewMode: "expanded" },
    role: "muted",
    summary: "! 1 blocked · 0/4 complete · 1 active · 3 hidden",
  },
];

for (const { name, options, patch, role, summary } of summaryCases) {
  test(`${name}: custom icon reaches the summary and preserves the branch's color policy`, () => {
    const theme = rendererTheme();
    const lines = renderProgressWidget(summarySteps, theme, 100, {
      ...options,
      settings: settings("error", "!", patch),
    });
    assert.equal(lines[1], theme.fg(role, summary));
    assert.equal(
      renderProgressWidget(summarySteps, theme, 100, {
        ...options,
        settings: { ...DEFAULT_PROGRESS_SETTINGS, ...patch },
      })[1],
      theme.fg(role === "error" ? "warning" : role, summary.replace("!", "⚠")),
      "the default summary must retain its previous bytes",
    );
    assert.doesNotMatch(plain(lines).join("\n"), /⚠/u);
    if (name === "compact item retains muted aggregate header") {
      assert.equal(rowWith(lines, "! approval"), theme.fg("error", "! ") + theme.fg("error", "approval"));
    }
  });
}

for (const role of foregrounds) {
  test(`public foreground role ${role} is accepted through the supplied Theme`, () => {
    const theme = rendererTheme(0, { text: "" }, ["muted"]);
    const lookup = vi.spyOn(theme, "getFgAnsi");
    try {
      const options = { settings: settings(role) };
      const lines = renderProgressWidget(blocked, theme, 100, options);
      assert.equal(lines[2], theme.fg(role, "! ") + theme.fg(role, "approval"));
      assert.equal(
        renderProgressWidget(blocked, theme, 100, { ...options, viewMode: "compact" })[1],
        theme.fg(role, "! 1 blocked · 0/1 complete"),
      );
      if (role !== "warning") {
        assert.ok(
          lookup.mock.calls.some(([value]) => value === role),
          "validate non-default roles with the current getFgAnsi",
        );
      }
    } finally {
      lookup.mockRestore();
    }
  });
}

for (const role of [
  ...Object.keys(backgrounds),
  "unknown-role",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "warning ",
  "Warning",
  "",
  "#ff0000",
]) {
  test(`invalid foreground role ${JSON.stringify(role)} falls back to warning without losing the custom icon`, () => {
    const theme = rendererTheme();
    const options = { settings: settings(role) };
    assert.deepEqual(renderProgressWidget(blocked, theme, 100, options), [
      theme.fg("borderMuted", "─".repeat(100)),
      theme.fg("muted", "Progress · 0/1 complete"),
      theme.fg("warning", "! ") + theme.fg("warning", "approval"),
    ]);
    assert.equal(
      renderProgressWidget(blocked, theme, 100, { ...options, viewMode: "compact" })[1],
      theme.fg("warning", "! 1 blocked · 0/1 complete"),
    );
    assert.equal(
      renderProgressWidget(blocked, theme, 100, { ...options, maxRows: 2 })[1],
      theme.fg("warning", "! 1 blocked · 0/1 complete · 1 hidden"),
    );
    assert.equal(
      renderProgressWidget(summarySteps, theme, 100, {
        settings: settings(role, "!", { displayMode: "expanded", maxVisibleItems: 1 }),
      })[1],
      theme.fg("warning", "! 1 blocked · 0/4 complete · 1 active"),
    );
  });
}

test("a compact blocked item uses one bounded detail row with its custom icon and color", () => {
  const theme = rendererTheme();
  const steps: ProgressStep[] = [{ text: "alpha beta gamma delta", status: "blocked" }];
  const lines = renderProgressWidget(steps, theme, 10, {
    settings: settings(),
    items: steps.map((value) => ({ value, mode: "compact" })),
    viewMode: "expanded",
  });
  assert.equal(lines.length, 3);
  assert.match(stripVTControlCharacters(lines[2] ?? ""), /^! .*…$/u);
  assert.ok(lines[2]?.includes(theme.getFgAnsi("error")));
  for (const line of lines) assert.ok(visibleWidth(line) <= 10);
});

for (const icon of ["!", "e\u0301", "⚠\uFE0E"]) {
  test(`wrapped blocked text with ${JSON.stringify(icon)} keeps a two-cell continuation indent and configured color`, () => {
    const theme = rendererTheme();
    const lines = renderProgressWidget([{ text: "alpha beta gamma", status: "blocked" }], theme, 7, {
      settings: settings("error", icon, { displayMode: "expanded" }),
    });
    assert.deepEqual(plain(lines.slice(2)), [`${icon} alpha`, "  beta", "  gamma"]);
    for (const line of lines.slice(2)) assert.ok(line.includes(theme.getFgAnsi("error")));
    for (const line of lines) assert.ok(visibleWidth(line) <= 7);
  });
}

for (const displayMode of ["expanded", "collapsed", "adaptive"] as const) {
  for (const viewMode of ["default", "expanded", "compact", "hidden"] as const) {
    test(`${displayMode}/${viewMode}: custom blocked rendering respects narrow widths and every row cap`, () => {
      const theme = rendererTheme();
      const steps: ProgressStep[] = [
        { text: "current work continues across several rows", status: "in_progress" },
        { text: "approval is needed before this task can continue", status: "blocked" },
        { text: "another blocked task", status: "blocked" },
        { text: "next task", status: "pending" },
        { text: "finished task", status: "completed" },
      ];
      for (const width of [0, 1, 2, 3, 7, 20, 80]) {
        for (const maxRows of [0, 1, 2, 2.9, 3, 4, 5, 8, Number.NaN, Number.POSITIVE_INFINITY]) {
          for (const items of [
            undefined,
            steps.slice(0, 4).map((value) => ({ value, mode: "compact" as const })),
            steps.filter((value) => value.status !== "blocked").map((value) => ({ value, mode: "expanded" as const })),
            [],
          ]) {
            const lines = renderProgressWidget(steps, theme, width, {
              settings: settings("error", "!", { displayMode, showCompleted: false, maxVisibleItems: 3 }),
              terminalRows: 12,
              viewMode,
              maxRows,
              items,
            });
            const cap = Number.isFinite(maxRows) ? Math.floor(maxRows) : 4;
            assert.ok(lines.length <= cap, `row cap ${maxRows}, width ${width}`);
            for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
            if (viewMode === "hidden" || cap < 2 || items?.length === 0) assert.deepEqual(lines, []);
          }
        }
      }
    });
  }
}

test("direct rendering rejects unsafe or wide icons before layout while retaining a valid custom color", () => {
  const theme = rendererTheme();
  for (const icon of ["", " ", "界", "⚠️", "!\n", "\u001b[31m!\u001b[0m", "!\u200d"]) {
    const lines = renderProgressWidget(blocked, theme, 80, { settings: settings("error", icon) });
    assert.equal(lines[2], theme.fg("error", "⚠ ") + theme.fg("error", "approval"));
  }
});

test("presentation snapshots own their nested style after caller mutation", () => {
  const current = createContext();
  const theme = rendererTheme();
  current.setTheme(theme);
  const configured = settings("thinkingHigh");
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: configured,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  try {
    presentation.update(blocked, configured);
    configured.blockedStyle.icon = "?";
    configured.blockedStyle.color = "error";
    presentation.refresh();
    assert.deepEqual(current.renderWidget(), [
      theme.fg("borderMuted", "─") +
        " " +
        theme.fg("muted", "▾ Progress · ! 1 blocked · 0/1 complete") +
        " " +
        theme.fg("borderMuted", "─".repeat(38)),
      theme.fg("thinkingHigh", "! ") + theme.fg("thinkingHigh", "approval"),
    ]);
    assert.deepEqual(DEFAULT_PROGRESS_SETTINGS.blockedStyle, { icon: "⚠", color: "warning" });
  } finally {
    presentation.dispose();
  }
});

test("changing blockedStyle leaves nonblocked rows and summaries byte-identical", () => {
  const theme = rendererTheme();
  const steps = mixed.filter((step) => step.status !== "blocked");
  for (const displayMode of ["expanded", "collapsed", "adaptive"] as const) {
    for (const viewMode of ["default", "expanded", "compact"] as const) {
      for (const width of [0, 1, 2, 12, 80]) {
        for (const maxRows of [2, 4, 12]) {
          const options = { viewMode, maxRows, terminalRows: 12 };
          assert.deepEqual(
            renderProgressWidget(steps, theme, width, {
              ...options,
              settings: settings("error", "!", { displayMode }),
            }),
            renderProgressWidget(steps, theme, width, {
              ...options,
              settings: { ...DEFAULT_PROGRESS_SETTINGS, displayMode },
            }),
          );
        }
      }
    }
  }
});

test("the mounted presentation uses the replacement Theme and revalidates its configured foreground", () => {
  const current = createContext();
  const first = rendererTheme();
  const next = rendererTheme(0x101010);
  current.setTheme(first);
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: settings("syntaxKeyword"),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  const lookup = vi.spyOn(next, "getFgAnsi");
  try {
    presentation.update(blocked, settings("syntaxKeyword"));
    const mounted = current.component;
    assert.equal(current.renderWidget()[1], first.fg("syntaxKeyword", "! ") + first.fg("syntaxKeyword", "approval"));
    current.setTheme(next);
    mounted?.invalidate();
    assert.deepEqual(current.renderWidget(), [
      next.fg("borderMuted", "─") +
        " " +
        next.fg("muted", "▾ Progress · ! 1 blocked · 0/1 complete") +
        " " +
        next.fg("borderMuted", "─".repeat(38)),
      next.fg("syntaxKeyword", "! ") + next.fg("syntaxKeyword", "approval"),
    ]);
    assert.ok(lookup.mock.calls.some(([role]) => role === "syntaxKeyword"));
    assert.equal(current.component, mounted, "theme changes must not remount the widget");
    assert.notEqual(first.getFgAnsi("syntaxKeyword"), next.getFgAnsi("syntaxKeyword"));
  } finally {
    lookup.mockRestore();
    presentation.dispose();
  }
});

test("presentation item compact/remove and hide/show keep the custom blocked aggregate truthful", () => {
  const current = createContext();
  const theme = rendererTheme();
  current.setTheme(theme);
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: settings(),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  try {
    const steps: ProgressStep[] = [
      ...blocked,
      { text: "next", status: "pending" },
      { text: "gate", status: "blocked" },
    ];
    presentation.update(steps, settings());
    const [approval, , gate] = presentation.items();
    assert.ok(approval && gate);
    assert.equal(presentation.item(approval.id)?.compact(), true);
    assert.equal(presentation.item(gate.id)?.remove(), true);
    presentation.refresh();
    let lines = current.renderWidget();
    assert.equal(
      lines[0],
      theme.fg("borderMuted", "─") +
        " " +
        theme.fg("muted", "▾ Progress · ! 2 blocked · 0/3 complete · 1 removed") +
        " " +
        theme.fg("borderMuted", "─".repeat(26)),
    );
    assert.equal(rowWith(lines, "! approval"), theme.fg("error", "! ") + theme.fg("error", "approval"));
    assert.doesNotMatch(plain(lines).join("\n"), /gate|⚠/u);
    assert.equal(presentation.item(approval.id)?.remove(), true);
    presentation.refresh();
    lines = current.renderWidget();
    const divider =
      theme.fg("borderMuted", "─") +
      " " +
      theme.fg("muted", "▾ Progress · ! 2 blocked · 0/3 complete · 2 removed") +
      " " +
      theme.fg("borderMuted", "─".repeat(26));
    assert.equal(lines[0], divider);
    assert.doesNotMatch(plain(lines).join("\n"), /approval|gate|⚠/u);
    presentation.show("hidden");
    assert.deepEqual(current.renderWidget(), []);
    presentation.show("expanded");
    assert.equal(current.renderWidget()[0], divider);
  } finally {
    presentation.dispose();
  }
});
