export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Capture {
  value: Json;
  truncated: boolean;
}
export interface EntrySummary {
  id: string;
  parentId: string | null;
  kind: string;
  label: string;
  summary?: string;
  summaryTruncated?: boolean;
  internal?: true;
  timestamp: string;
  name?: string;
  nameTruncated?: boolean;
  tokens?: number;
  status?: "success" | "error" | "cancelled";
  toolCallId?: string;
  toolAnchor?: string;
}
export interface Call {
  id: string;
  occurrenceId: string;
  parentOccurrenceId?: string;
  parentUnavailable?: string;
  correlationUnavailable?: boolean;
  parentId?: string;
  name: string;
  status: "running" | "ok" | "error" | "unfinished";
  args: Capture;
  result?: Capture;
  durationMs?: number;
  observedStartedAt?: number;
  observedEndedAt?: number;
  branchAnchor: string | null;
}
export interface ToolGroup {
  id: string;
  label: string;
  kind: "namespace" | "builtin" | "package" | "extension" | "unknown";
  truncated?: boolean;
}
export interface ToolView {
  catalogId?: string;
  sourceGroup?: ToolGroup;
  namespaceGroup?: ToolGroup;
  name: string;
  description: string;
  exposure: string;
  active: boolean;
  callable: boolean;
  namespace?: string;
  schema: Capture;
  source?: Capture;
  metadataTruncated?: boolean;
}
export interface SkillView {
  name: string;
  path: string;
  description: string;
  pathTruncated?: boolean;
  metadataTruncated?: boolean;
}
export interface ContextSegment {
  id: string;
  position: number;
  messageIndex: number;
  blockIndex?: number;
  role: string;
  kind: string;
  category: "system" | "user" | "assistant" | "toolCall" | "toolResult" | "other";
  preview: string;
  timestamp?: string;
}
export interface ContextComposition {
  source: "observed-pi-context" | "session-derived";
  leafId: string | null;
  observedAt?: number;
  totalMessages: number;
  messages: Capture[];
  segments: ContextSegment[];
  incomplete: boolean;
  unavailable?: string;
}
export interface CacheTotals {
  count: number;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  promptTokens: number | null;
  hitRatePercent: number | null;
  promptCost: number | null;
  estimatedSavings: number | null;
}
export interface CacheRecord extends Omit<CacheTotals, "count"> {
  entryId: string;
  epoch: number;
  kind: "assistant" | "compaction" | "branch_summary" | "cache_warm" | "usage";
  provider: string;
  model: string;
  timestamp: string;
  status: "recorded" | "error" | "cancelled";
  costSource: "reported" | "model-estimate" | "mixed" | "unavailable";
  comparison: {
    previousEntryId: string;
    hitRateDeltaPercent: number;
    hitRateLossPercent: number;
    promptTokenDelta: number;
    cacheReadDelta: number;
    eligibleTokens: number;
    rebilledTokens: number;
    estimatedMissPremium: number | null;
    modelChanged: boolean;
    requestStartGapMs: number | null;
  } | null;
}
export interface CacheHistory {
  leafId: string | null;
  records: CacheRecord[];
  totalRecords: number;
  omittedRecords: number;
  totals: CacheTotals;
  trend: { entryId: string; hitRatePercent: number | null; epoch?: number }[];
  complete: boolean;
  unavailable?: string;
}
export interface Snapshot {
  protocol: 1;
  generation: string;
  revision: number;
  sessionId: string;
  name: string;
  nameTruncated?: boolean;
  leafId: string | null;
  totalEntries: number;
  nodes: EntrySummary[];
  incomplete: boolean;
  invalidEntryCount?: number;
  invalidEntries?: { index: number; reason: string; raw: Capture }[];
  context?: ContextComposition;
  providerObservation?: { observedAt: number; data: Capture };
  cache?: CacheHistory;
  currentPrompt: Capture;
  tools: ToolView[];
  skills: SkillView[];
  mcp?: { servers: { name: string; truncated: boolean }[]; truncated: boolean; unavailable?: true };
  calls: Call[];
  droppedCalls: number;
  invalidCallEvents?: number;
  captureStartedAt: number;
}
export interface BranchView {
  ancestryIssue?: string;
  leafId: string;
  entries: EntrySummary[];
  total: number;
  offset: number;
  prompt: Capture;
  previousPrompt: Capture;
  sections: Capture;
  declaredTools: Capture;
  promptUpdates: Capture;
  projection: Capture;
  context?: ContextComposition;
  skillEvidence: Capture;
}
export interface DetailView {
  ancestryIssue?: string;
  toolAnchor?: string;
  raw: Capture;
  projected: Capture;
  calls: Call[];
}
