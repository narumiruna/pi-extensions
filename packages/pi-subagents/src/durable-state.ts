import { defineDoc } from "@earendil-works/pi-durable";

export const DURABLE_VERSION = 1;
export const DURABLE_WORK_TOOLS = ["read", "write", "edit", "bash", "powershell"] as const;
export type DurableWorkTool = (typeof DURABLE_WORK_TOOLS)[number];
export type WorkOutcome = "completed" | "failed" | "cancelled" | "timed_out";
export type DurableRequest = {
  id: string;
  fingerprint: string;
  conversationId: number;
  task: string;
  whenBusy: "steer" | "followUp";
  taskId: number;
  submissionId: number | null;
  startedAt: number | null;
  deadline: number | null;
  timeoutMs: number | null;
  outcome: WorkOutcome | null;
  result: string;
  error: string | null;
  answerId: number | null;
  reportId: string | null;
  cancelOutcome: "cancelled" | "timed_out" | null;
};
export type DurableAgent = {
  conversationId: number;
  anchorId: number;
  tools: string[];
  model: { provider: string; modelId: string };
  thinkingLevel: string;
  cwd: string;
  trusted: boolean;
  requests: string[];
  stopTaskId: number | null;
  stopTargets: string[];
  createdAt: number;
};
export type DurableReport = {
  id: string;
  conversationId: string;
  requestId: string;
  outcome: WorkOutcome;
  result: string;
  error: string | null;
  acknowledged: boolean;
  suppressed: boolean;
};
export type DurableState = {
  version: number;
  agents: Record<string, DurableAgent>;
  requests: Record<string, DurableRequest>;
  reports: Record<string, DurableReport>;
  stops: Record<string, { conversationId: number; taskId: number }>;
};
export const DurableStateDoc = defineDoc<DurableState>({
  kind: "pi-subagents.durable-state",
  version: DURABLE_VERSION,
  scope: "session",
  initial: () => ({ version: DURABLE_VERSION, agents: {}, requests: {}, reports: {}, stops: {} }),
});
export type DurableWaitResult = {
  conversationId: string;
  state: "running" | "idle";
  timedOut: boolean;
  requestId?: string;
  outcome?: WorkOutcome;
  result?: string;
  error?: string;
};
export function agentRunning(state: Readonly<DurableState>, agent: Readonly<DurableAgent>): boolean {
  return (
    agent.stopTaskId !== null ||
    agent.requests.some((id) => {
      const request = state.requests[id];
      if (request?.outcome === null) return true;
      return Object.values(state.reports).some(
        (report) => report.requestId === id && !report.acknowledged && !report.suppressed,
      );
    })
  );
}
