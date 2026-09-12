import type { Theme } from "@earendil-works/pi-coding-agent";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { HerdrAgentStatus, HerdrPane, HerdrPaneEvent, HerdrWorkspace } from "./herdr-protocol.js";

export const HERDR_WIDGET_KEY = "herdr:agents";
export const MAX_HERDR_WIDGET_AGENTS = 5;

interface ObservedPane {
  paneId: string;
  workspaceId: string;
  agent?: string;
  agentName?: string;
  agentStatus: HerdrAgentStatus;
  displayAgent?: string;
  label?: string;
  stateLabels: Record<string, string>;
  title?: string;
}

export interface HerdrWidgetRow {
  agent: string;
  pane: string;
  paneId: string;
  space: string;
  state: HerdrAgentStatus;
  stateLabel: string;
}

export interface HerdrWidgetSnapshot {
  totalAgents: number;
  hiddenAgents: number;
  rows: readonly HerdrWidgetRow[];
}

const STATE_ORDER: Record<HerdrAgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

function observedPane(pane: HerdrPane): ObservedPane {
  return {
    paneId: pane.paneId,
    workspaceId: pane.workspaceId,
    agent: pane.agent,
    agentName: pane.agentName,
    agentStatus: pane.agentStatus,
    displayAgent: pane.displayAgent,
    label: pane.label,
    stateLabels: { ...pane.stateLabels },
    title: pane.title,
  };
}

function safeDisplay(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = sanitizeTerminalText(value).trim();
  return safe.length > 0 ? safe : undefined;
}

function shortIdentity(value: string, fallback: string): string {
  const safe = safeDisplay(value);
  if (!safe) return fallback;
  return safe.split(":").at(-1) || fallback;
}

function agentDisplay(pane: ObservedPane): string {
  return safeDisplay(pane.agentName) ?? safeDisplay(pane.displayAgent) ?? safeDisplay(pane.agent) ?? "agent";
}

function paneDisplay(pane: ObservedPane): string {
  const id = shortIdentity(pane.paneId, "pane");
  const label = safeDisplay(pane.label) ?? safeDisplay(pane.title);
  return label ? `${label}/${id}` : id;
}

function spaceDisplay(workspace: HerdrWorkspace): string {
  const id = shortIdentity(workspace.workspaceId, "space");
  const label = safeDisplay(workspace.label);
  return label ? `${label}/${id}` : id;
}

function rowForPane(pane: ObservedPane, workspace: HerdrWorkspace): HerdrWidgetRow {
  return {
    agent: agentDisplay(pane),
    pane: paneDisplay(pane),
    paneId: safeDisplay(pane.paneId) ?? "pane",
    space: spaceDisplay(workspace),
    state: pane.agentStatus,
    stateLabel: safeDisplay(pane.stateLabels[pane.agentStatus]) ?? safeDisplay(pane.agentStatus) ?? "unknown",
  };
}

function immutableSnapshot(rows: HerdrWidgetRow[]): HerdrWidgetSnapshot | undefined {
  if (rows.length === 0) return undefined;
  const visible = rows.slice(0, MAX_HERDR_WIDGET_AGENTS).map((row) => Object.freeze({ ...row }));
  return Object.freeze({
    totalAgents: rows.length,
    hiddenAgents: Math.max(0, rows.length - visible.length),
    rows: Object.freeze(visible),
  });
}

export class HerdrWidgetModel {
  private currentPaneId: string | undefined;
  private currentWorkspaceId: string | undefined;
  private workspace: HerdrWorkspace | undefined;
  private panes = new Map<string, ObservedPane>();

  reset(
    currentPane: HerdrPane,
    panes: readonly HerdrPane[],
    workspace: HerdrWorkspace = { workspaceId: currentPane.workspaceId },
  ): void {
    this.currentPaneId = currentPane.paneId;
    this.currentWorkspaceId = currentPane.workspaceId;
    this.workspace = { ...workspace };
    this.panes = new Map(panes.map((pane) => [pane.paneId, observedPane(pane)]));
  }

  clear(): void {
    this.currentPaneId = undefined;
    this.currentWorkspaceId = undefined;
    this.workspace = undefined;
    this.panes.clear();
  }

  isCurrentPane(paneId: string): boolean {
    return this.currentPaneId === paneId;
  }

  isCurrentWorkspace(workspaceId: string): boolean {
    return this.currentWorkspaceId === workspaceId;
  }

  apply(event: HerdrPaneEvent): void {
    if (event.type === "created") {
      this.panes.set(event.pane.paneId, observedPane(event.pane));
      return;
    }
    if (event.type === "closed" || event.type === "exited") {
      this.panes.delete(event.paneId);
      return;
    }
    if (event.type === "moved") {
      this.panes.delete(event.previousPaneId);
      this.panes.set(event.pane.paneId, observedPane(event.pane));
      if (this.currentPaneId === event.previousPaneId) {
        this.currentPaneId = event.pane.paneId;
        this.currentWorkspaceId = event.pane.workspaceId;
        this.workspace = { workspaceId: event.pane.workspaceId };
      }
      return;
    }

    const existing = this.panes.get(event.paneId);
    if (event.type === "agent_detected") {
      if (event.released || !event.agent) {
        if (existing) this.panes.set(event.paneId, { ...existing, agent: undefined });
        return;
      }
      this.panes.set(event.paneId, {
        ...(existing ?? {
          paneId: event.paneId,
          workspaceId: event.workspaceId,
          agentStatus: event.finalStatus ?? "unknown",
          stateLabels: {},
        }),
        agent: event.agent,
        agentStatus: event.finalStatus ?? existing?.agentStatus ?? "unknown",
      });
      return;
    }
    if (event.type !== "agent_status_changed") return;

    this.panes.set(event.paneId, {
      ...(existing ?? {
        paneId: event.paneId,
        workspaceId: event.workspaceId,
        stateLabels: {},
      }),
      agent: event.agent ?? existing?.agent,
      agentStatus: event.agentStatus,
      displayAgent: event.displayAgent ?? existing?.displayAgent,
      stateLabels: event.stateLabels ?? existing?.stateLabels ?? {},
      title: event.title ?? existing?.title,
    });
  }

  snapshot(): HerdrWidgetSnapshot | undefined {
    if (!this.currentPaneId || !this.currentWorkspaceId || !this.workspace) return undefined;
    const rows = [...this.panes.values()]
      .filter(
        (pane) =>
          pane.workspaceId === this.currentWorkspaceId &&
          pane.paneId !== this.currentPaneId &&
          pane.agent !== undefined,
      )
      .map((pane) => rowForPane(pane, this.workspace as HerdrWorkspace));
    rows.sort(
      (left, right) =>
        STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
        left.agent.localeCompare(right.agent) ||
        left.pane.localeCompare(right.pane) ||
        left.paneId.localeCompare(right.paneId),
    );
    return immutableSnapshot(rows);
  }
}

function stateStyle(theme: Theme, state: HerdrAgentStatus, text: string): string {
  switch (state) {
    case "blocked":
      return theme.fg("error", text);
    case "done":
      return theme.fg("accent", text);
    case "working":
      return theme.fg("warning", text);
    case "idle":
      return theme.fg("success", text);
    case "unknown":
      return theme.fg("dim", text);
  }
}

function stateSymbol(state: HerdrAgentStatus): string {
  switch (state) {
    case "blocked":
      return "×";
    case "done":
      return "✓";
    case "working":
      return "◐";
    case "idle":
      return "○";
    case "unknown":
      return "·";
  }
}

export function createHerdrWidget(snapshot: HerdrWidgetSnapshot, theme: Theme): EditorStatusWidget {
  return new EditorStatusWidget({
    theme,
    renderBody() {
      const noun = snapshot.totalAgents === 1 ? "agent" : "agents";
      const lines = [theme.fg("muted", `Herdr · ${snapshot.totalAgents} sibling ${noun}`)];
      const separator = theme.fg("dim", " · ");
      for (const row of snapshot.rows) {
        const state = stateStyle(theme, row.state, `${stateSymbol(row.state)} ${row.stateLabel}`);
        const agent = theme.bold(theme.fg("text", row.agent));
        const pane = theme.fg("muted", row.pane);
        const space = theme.fg("dim", row.space);
        lines.push(`${state}  ${agent}${separator}${pane}${separator}${space}`);
      }
      if (snapshot.hiddenAgents > 0) {
        lines.push(theme.fg("dim", `+${snapshot.hiddenAgents} more`));
      }
      return lines;
    },
  });
}

export function herdrWidgetFingerprint(snapshot: HerdrWidgetSnapshot | undefined): string | undefined {
  return snapshot ? JSON.stringify(snapshot) : undefined;
}
