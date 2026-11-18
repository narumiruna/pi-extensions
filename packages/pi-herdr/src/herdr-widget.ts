import type { Theme } from "@earendil-works/pi-coding-agent";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { HerdrAgentStatus, HerdrPane, HerdrWorkspace } from "./herdr-protocol.js";
import type { HerdrSpawnProvenance } from "./herdr-spawn-provenance.js";

export const HERDR_WIDGET_KEY = "herdr:agents";
export const MAX_HERDR_WIDGET_AGENTS = 5;

interface ObservedPane {
  paneId: string;
  workspaceId: string;
  terminalId: string;
  sessionFingerprint?: string;
  spawn?: HerdrSpawnProvenance;
  agent?: string;
  agentName?: string;
  agentStatus: HerdrAgentStatus;
  displayAgent?: string;
  label?: string;
  stateLabels: Record<string, string>;
  title?: string;
}

export type HerdrWidgetState = HerdrAgentStatus | "error";

export interface HerdrWidgetRow {
  agent: string;
  pane: string;
  paneId: string;
  space: string;
  state: HerdrWidgetState;
  stateLabel: string;
  relation?: string;
}

export interface HerdrWidgetSnapshot {
  totalAgents: number;
  hiddenAgents: number;
  rows: readonly HerdrWidgetRow[];
}

const STATE_ORDER: Record<HerdrWidgetState, number> = {
  error: -1,
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
    terminalId: pane.terminalId,
    sessionFingerprint: pane.sessionFingerprint,
    spawn: pane.spawn ? { ...pane.spawn } : undefined,
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

function spawnRelations(panes: readonly ObservedPane[], currentPaneId: string): Map<string, string> {
  const identities = new Map<string, ObservedPane | undefined>();
  const key = (terminal: string, session: string) => JSON.stringify([terminal, session]);
  for (const pane of panes) {
    if (pane.agent !== "pi" || !pane.sessionFingerprint) continue;
    const identity = key(pane.terminalId, pane.sessionFingerprint);
    // Ambiguous identities must not resolve to an arbitrary live origin.
    identities.set(identity, identities.has(identity) ? undefined : pane);
  }
  const origins = new Map<string, ObservedPane>();
  const records = new Map<string, HerdrSpawnProvenance>();
  for (const pane of panes) {
    const spawn = pane.spawn;
    if (
      pane.agent !== "pi" ||
      !pane.sessionFingerprint ||
      !spawn ||
      spawn.targetSession !== pane.sessionFingerprint ||
      spawn.originTerminalId === pane.terminalId
    )
      continue;
    records.set(pane.paneId, spawn);
    const origin = identities.get(key(spawn.originTerminalId, spawn.originSession));
    if (origin) origins.set(pane.paneId, origin);
  }
  const cyclic = (id: string): boolean => {
    const visited = new Set<string>();
    let next: string | undefined = id;
    while (next !== undefined) {
      if (visited.has(next)) return true;
      visited.add(next);
      next = origins.get(next)?.paneId;
    }
    return false;
  };
  const currentOrigin = cyclic(currentPaneId) ? undefined : origins.get(currentPaneId);
  const relations = new Map<string, string>();
  for (const pane of panes) {
    const labels: string[] = [];
    const spawn = records.get(pane.paneId);
    if (spawn && !cyclic(pane.paneId)) {
      const origin = origins.get(pane.paneId);
      const label = origin
        ? origin.paneId === currentPaneId
          ? "you"
          : `${agentDisplay(origin)}/${paneDisplay(origin)}`
        : `${safeDisplay(spawn.originLabel) ?? "previous agent"} (unavailable)`;
      labels.push(`spawned by ${label}`);
    }
    if (currentOrigin?.paneId === pane.paneId) labels.push("spawned you");
    if (labels.length > 0) relations.set(pane.paneId, labels.join("; "));
  }
  return relations;
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
  private workspaces = new Map<string, HerdrWorkspace>();
  private panes = new Map<string, ObservedPane>();

  reset(currentPane: HerdrPane, panes: readonly HerdrPane[], workspaces: readonly HerdrWorkspace[] = []): void {
    this.currentPaneId = currentPane.paneId;
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.workspaceId, { ...workspace }]));
    this.panes = new Map(panes.map((pane) => [pane.paneId, observedPane(pane)]));
    this.panes.set(currentPane.paneId, observedPane(currentPane));
  }

  clear(): void {
    this.currentPaneId = undefined;
    this.workspaces.clear();
    this.panes.clear();
  }

  snapshot(): HerdrWidgetSnapshot | undefined {
    if (!this.currentPaneId) return undefined;
    const panes = [...this.panes.values()];
    const relations = spawnRelations(panes, this.currentPaneId);
    const rows = panes
      .filter((pane) => pane.paneId !== this.currentPaneId && pane.agent !== undefined)
      .map((pane) => {
        const row = rowForPane(pane, this.workspaces.get(pane.workspaceId) ?? { workspaceId: pane.workspaceId });
        const relation = relations.get(pane.paneId);
        return relation ? { ...row, relation } : row;
      });
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

function stateStyle(theme: Theme, state: HerdrWidgetState, text: string): string {
  switch (state) {
    case "error":
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

function stateSymbol(state: HerdrWidgetState): string {
  switch (state) {
    case "error":
      return "!";
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

export function herdrWidgetSummary(snapshot: HerdrWidgetSnapshot): string {
  return `${snapshot.totalAgents} sibling ${snapshot.totalAgents === 1 ? "agent" : "agents"}`;
}

export function createHerdrWidget(
  snapshot: HerdrWidgetSnapshot,
  theme: Theme,
  includeHeader = true,
): EditorStatusWidget {
  return new EditorStatusWidget({
    theme,
    renderBody() {
      const lines = includeHeader ? [theme.fg("muted", `Herdr · ${herdrWidgetSummary(snapshot)}`)] : [];
      const separator = theme.fg("dim", " · ");
      for (const row of snapshot.rows) {
        const state = stateStyle(theme, row.state, `${stateSymbol(row.state)} ${row.stateLabel}`);
        const agent = theme.bold(theme.fg("text", row.agent));
        const pane = theme.fg("muted", row.pane);
        const space = theme.fg("dim", row.space);
        const relation = row.relation ? `${separator}${theme.fg("muted", row.relation)}` : "";
        lines.push(`${state}  ${agent}${separator}${pane}${separator}${space}${relation}`);
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
