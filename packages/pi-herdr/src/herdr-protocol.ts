export const HERDR_AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

export type HerdrAgentStatus = (typeof HERDR_AGENT_STATUSES)[number];

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string;
  focused: boolean;
  revision: number;
  agent?: string;
  agentName?: string;
  agentStatus: HerdrAgentStatus;
  displayAgent?: string;
  label?: string;
  stateLabels: Record<string, string>;
  terminalTitle?: string;
  title?: string;
}

export interface HerdrWorkspace {
  workspaceId: string;
  label?: string;
}

export type HerdrPaneEvent =
  | { type: "created"; pane: HerdrPane }
  | { type: "closed" | "exited"; paneId: string; workspaceId: string }
  | {
      type: "moved";
      pane: HerdrPane;
      previousPaneId: string;
      previousWorkspaceId: string;
    }
  | {
      type: "agent_detected";
      paneId: string;
      workspaceId: string;
      agent?: string;
      finalStatus?: HerdrAgentStatus;
      released: boolean;
    }
  | {
      type: "agent_status_changed";
      paneId: string;
      workspaceId: string;
      agent?: string;
      agentStatus: HerdrAgentStatus;
      displayAgent?: string;
      stateLabels?: Record<string, string>;
      title?: string;
    };

const HERDR_WIDGET_TOPOLOGY_SUBSCRIPTIONS = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
] as const;

export function herdrWidgetSubscriptions(panes: readonly HerdrPane[]) {
  return [
    ...HERDR_WIDGET_TOPOLOGY_SUBSCRIPTIONS.map((entry) => ({ ...entry })),
    ...panes
      .filter((pane) => pane.agent !== undefined)
      .map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.paneId })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function agentStatus(value: unknown): HerdrAgentStatus | undefined {
  return typeof value === "string" && HERDR_AGENT_STATUSES.includes(value as HerdrAgentStatus)
    ? (value as HerdrAgentStatus)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseHerdrPane(value: unknown): HerdrPane | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = requiredString(value.pane_id);
  const workspaceId = requiredString(value.workspace_id);
  const tabId = requiredString(value.tab_id);
  const terminalId = requiredString(value.terminal_id);
  const status = agentStatus(value.agent_status);
  const revision = value.revision;
  if (
    !paneId ||
    !workspaceId ||
    !tabId ||
    !terminalId ||
    !status ||
    typeof value.focused !== "boolean" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return undefined;
  }
  return {
    paneId,
    workspaceId,
    tabId,
    terminalId,
    focused: value.focused,
    revision,
    agent: optionalString(value.agent),
    agentName: optionalString(value.name),
    agentStatus: status,
    displayAgent: optionalString(value.display_agent),
    label: optionalString(value.label),
    stateLabels: stringRecord(value.state_labels) ?? {},
    terminalTitle: optionalString(value.terminal_title_stripped) ?? optionalString(value.terminal_title),
    title: optionalString(value.title),
  };
}

export function parsePaneCurrentResult(value: unknown): HerdrPane {
  if (!isRecord(value) || value.type !== "pane_current") {
    throw new Error("Herdr returned an invalid current-pane response");
  }
  const pane = parseHerdrPane(value.pane);
  if (!pane) throw new Error("Herdr returned an invalid current pane");
  return pane;
}

export function parsePaneListResult(value: unknown): HerdrPane[] {
  if (!isRecord(value) || value.type !== "pane_list" || !Array.isArray(value.panes)) {
    throw new Error("Herdr returned an invalid pane-list response");
  }
  const panes = value.panes.map(parseHerdrPane);
  if (panes.some((pane) => pane === undefined)) {
    throw new Error("Herdr returned an invalid pane in the pane list");
  }
  return panes as HerdrPane[];
}

export function parseAgentListResult(value: unknown): HerdrPane[] {
  if (!isRecord(value) || value.type !== "agent_list" || !Array.isArray(value.agents)) {
    throw new Error("Herdr returned an invalid agent-list response");
  }
  return value.agents.flatMap((entry) => {
    const pane = parseHerdrPane(entry);
    return pane ? [pane] : [];
  });
}

export function parseWorkspaceGetResult(value: unknown): HerdrWorkspace {
  if (!isRecord(value) || value.type !== "workspace_info" || !isRecord(value.workspace)) {
    throw new Error("Herdr returned an invalid workspace response");
  }
  const workspaceId = requiredString(value.workspace.workspace_id);
  if (!workspaceId) throw new Error("Herdr returned an invalid workspace identity");
  return { workspaceId, label: optionalString(value.workspace.label) };
}

export function parseHerdrPaneEvent(value: unknown): HerdrPaneEvent | undefined {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) {
    return undefined;
  }
  const data = value.data;

  if (value.event === "pane.agent_status_changed") {
    const paneId = requiredString(data.pane_id);
    const workspaceId = requiredString(data.workspace_id);
    const status = agentStatus(data.agent_status);
    if (!paneId || !workspaceId || !status) return undefined;
    return {
      type: "agent_status_changed",
      paneId,
      workspaceId,
      agent: optionalString(data.agent),
      agentStatus: status,
      displayAgent: optionalString(data.display_agent),
      stateLabels: stringRecord(data.state_labels),
      title: optionalString(data.title),
    };
  }

  if (value.event === "pane_created") {
    const pane = parseHerdrPane(data.pane);
    return pane ? { type: "created", pane } : undefined;
  }
  if (value.event === "pane_closed" || value.event === "pane_exited") {
    const paneId = requiredString(data.pane_id);
    const workspaceId = requiredString(data.workspace_id);
    if (!paneId || !workspaceId) return undefined;
    return {
      type: value.event === "pane_closed" ? "closed" : "exited",
      paneId,
      workspaceId,
    };
  }
  if (value.event === "pane_moved") {
    const pane = parseHerdrPane(data.pane);
    const previousPaneId = requiredString(data.previous_pane_id);
    const previousWorkspaceId = requiredString(data.previous_workspace_id);
    if (!pane || !previousPaneId || !previousWorkspaceId) return undefined;
    return { type: "moved", pane, previousPaneId, previousWorkspaceId };
  }
  if (value.event === "pane_agent_detected") {
    const paneId = requiredString(data.pane_id);
    const workspaceId = requiredString(data.workspace_id);
    if (!paneId || !workspaceId || typeof data.released !== "boolean") return undefined;
    const finalStatus = data.final_status === null ? undefined : agentStatus(data.final_status);
    if (data.final_status !== undefined && data.final_status !== null && !finalStatus) return undefined;
    return {
      type: "agent_detected",
      paneId,
      workspaceId,
      agent: optionalString(data.agent),
      finalStatus,
      released: data.released,
    };
  }
  return undefined;
}
