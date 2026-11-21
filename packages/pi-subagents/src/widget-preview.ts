import type { Theme } from "@earendil-works/pi-coding-agent";
import { HorizontalRule } from "@narumitw/pi-tui-kit";
import type { EditorStatusMode } from "@narumitw/pi-tui-kit/editor-status-view";
import type { ActiveJobDisplay } from "./runtime.js";
import type { SubagentSettings } from "./settings.js";
import { renderSubagentWidgetSnapshot, type SubagentWidgetSnapshot, subagentWidgetSummary } from "./widget-renderer.js";

const SAMPLE_JOBS: ActiveJobDisplay[] = [
  {
    jobId: "job_example_1",
    task: "Review release notes",
    state: "running",
    thinkingLevel: "medium",
    defaultThinkingLevel: "medium",
    elapsedMs: 12_000,
    timeout: 60,
    tools: ["read", "grep"],
  },
  {
    jobId: "job_example_2",
    task: "Check documentation links",
    state: "queued",
    thinkingLevel: "low",
    defaultThinkingLevel: "medium",
    elapsedMs: 0,
    tools: ["read"],
  },
];

export function renderSubagentWidgetPreview(
  settings: SubagentSettings,
  mode: EditorStatusMode,
  theme: Theme,
  width: number,
): string[] {
  if (!settings.showWidget) return [theme.fg("muted", "Hidden by Show widget.")];
  if (mode === "hidden") return [theme.fg("muted", "Status hidden for this session.")];
  const snapshot: SubagentWidgetSnapshot = {
    jobs: SAMPLE_JOBS,
    items: SAMPLE_JOBS.map((value) => ({ value, id: value.jobId, mode: "expanded" })),
    mode,
    settings,
  };
  const rows = SAMPLE_JOBS.length + 1;
  const divider = new HorizontalRule({
    label: `Subagents · ${subagentWidgetSummary(snapshot, rows)}`,
    labelAlignment: "left",
    ruleStyle: (text) => theme.fg("borderMuted", text),
    labelStyle: (text) => theme.fg("muted", text),
  });
  return [...divider.render(width), ...renderSubagentWidgetSnapshot(snapshot, theme, width, rows, false).slice(1)];
}
