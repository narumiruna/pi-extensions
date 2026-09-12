import type { ProviderErrorCategory, SettledRun } from "../types.js";

export type TimeRangeId = "today" | "7d" | "30d" | "all";
export interface TimeRange {
  id?: TimeRangeId;
  fromMs: number;
  toMs: number;
}

export interface OverviewStats {
  responseCycles: number;
  llmCalls: number;
  callsPerResponse: number;
  p95CallsPerResponse: number;
  toolCalls: number;
  toolErrors: number;
  skillActivations: number;
  providerErrors: number;
  recoveredErrors: number;
}

export interface ModelCount {
  provider?: string;
  model?: string;
  count: number;
}

export interface SkillStats {
  name: string;
  count: number;
  modelInitiated: number;
  userInitiated: number;
  lastOccurredAtMs: number;
  models: ModelCount[];
}

export interface ToolStats {
  name: string;
  count: number;
  errors: number;
  averageDurationMs: number;
  lastOccurredAtMs: number;
  models: ModelCount[];
}

export interface ReliabilityStats {
  http429: number;
  http5xx: number;
  recovered: number;
  terminal: number;
  categories: Record<ProviderErrorCategory, number>;
}

export interface ResponseStats {
  count: number;
  llmCalls: number;
  average: number;
  median: number;
  p95: number;
  maximum: number;
  distribution: { one: number; twoToThree: number; fourToSix: number; sevenPlus: number };
}

export interface AnalyticsSnapshot {
  overview: OverviewStats;
  skills: SkillStats[];
  tools: ToolStats[];
  reliability: ReliabilityStats;
  responses: ResponseStats;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const ERROR_CATEGORIES: readonly ProviderErrorCategory[] = [
  "dns",
  "timeout",
  "connection_refused",
  "connection_reset",
  "tls",
  "network_other",
  "provider_other",
];

export function resolveTimeRange(id: TimeRangeId, now = Date.now()): TimeRange {
  let fromMs = 0;
  if (id === "today") {
    const date = new Date(now);
    fromMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  } else if (id === "7d") fromMs = now - 7 * DAY_MS;
  else if (id === "30d") fromMs = now - 30 * DAY_MS;
  return { id, fromMs, toMs: now + 1 };
}

export async function querySnapshot(
  runs: AsyncIterable<SettledRun> | Iterable<SettledRun>,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<AnalyticsSnapshot> {
  const generationCounts: number[] = [];
  const seenRunIds = new Set<string>();
  const skills = new Map<string, SkillStats>();
  const tools = new Map<string, ToolStats & { totalDurationMs: number }>();
  const categories = Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, 0])) as Record<
    ProviderErrorCategory,
    number
  >;
  let toolErrors = 0;
  let providerErrors = 0;
  let recoveredErrors = 0;
  let http429 = 0;
  let http5xx = 0;
  let terminal = 0;

  for await (const run of runs) {
    throwIfAborted(signal);
    if (seenRunIds.has(run.id)) continue;
    seenRunIds.add(run.id);
    if (run.startedAtMs < range.fromMs || run.startedAtMs >= range.toMs) continue;
    generationCounts.push(run.generations.length);
    toolErrors += run.toolErrorCount;
    providerErrors += run.providerErrorCount;
    recoveredErrors += run.recoveredErrorCount;

    for (const skill of run.skills) {
      const item = skills.get(skill.name) ?? {
        name: skill.name,
        count: 0,
        modelInitiated: 0,
        userInitiated: 0,
        lastOccurredAtMs: 0,
        models: [],
      };
      item.count += 1;
      if (skill.initiatedBy === "user") item.userInitiated += 1;
      else item.modelInitiated += 1;
      item.lastOccurredAtMs = Math.max(item.lastOccurredAtMs, skill.occurredAtMs);
      mergeModelCount(item.models, {
        provider: skill.provider,
        model: skill.model,
        count: 1,
      });
      skills.set(skill.name, item);
    }

    for (const tool of run.tools) {
      const item = tools.get(tool.name) ?? {
        name: tool.name,
        count: 0,
        errors: 0,
        averageDurationMs: 0,
        totalDurationMs: 0,
        lastOccurredAtMs: 0,
        models: [],
      };
      item.count += 1;
      item.errors += tool.isError ? 1 : 0;
      item.totalDurationMs += tool.durationMs ?? 0;
      item.averageDurationMs = item.totalDurationMs / item.count;
      item.lastOccurredAtMs = Math.max(item.lastOccurredAtMs, tool.startedAtMs);
      mergeModelCount(item.models, {
        provider: tool.provider,
        model: tool.model,
        count: 1,
      });
      tools.set(tool.name, item);
    }

    for (const error of run.providerErrors) {
      categories[error.category] += 1;
      terminal += error.terminal ? 1 : 0;
    }
    for (const generation of run.generations) {
      for (const response of generation.responses) {
        if (response.status === 429) http429 += 1;
        if (response.status >= 500 && response.status < 600) http5xx += 1;
      }
    }
  }

  const responses = responseStatistics(generationCounts);
  return {
    overview: {
      responseCycles: responses.count,
      llmCalls: responses.llmCalls,
      callsPerResponse: responses.average,
      p95CallsPerResponse: responses.p95,
      toolCalls: sum([...tools.values()].map(({ count }) => count)),
      toolErrors,
      skillActivations: sum([...skills.values()].map(({ count }) => count)),
      providerErrors,
      recoveredErrors,
    },
    skills: [...skills.values()]
      .map((item) => ({ ...item, models: sortModels(item.models) }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    tools: [...tools.values()]
      .map(({ totalDurationMs: _, ...item }) => ({ ...item, models: sortModels(item.models) }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    reliability: {
      http429,
      http5xx,
      recovered: recoveredErrors,
      terminal,
      categories,
    },
    responses,
  };
}

function responseStatistics(generationCounts: number[]): ResponseStats {
  const sorted = [...generationCounts].sort((left, right) => left - right);
  const count = sorted.length;
  const llmCalls = sum(sorted);
  const nearestRank = (percentile: number) =>
    count === 0 ? 0 : (sorted[Math.max(0, Math.ceil(percentile * count) - 1)] ?? 0);
  const median =
    count === 0
      ? 0
      : count % 2 === 1
        ? (sorted[Math.floor(count / 2)] ?? 0)
        : ((sorted[count / 2 - 1] ?? 0) + (sorted[count / 2] ?? 0)) / 2;
  return {
    count,
    llmCalls,
    average: count > 0 ? llmCalls / count : 0,
    median,
    p95: nearestRank(0.95),
    maximum: sorted.at(-1) ?? 0,
    distribution: {
      one: sorted.filter((value) => value === 1).length,
      twoToThree: sorted.filter((value) => value >= 2 && value <= 3).length,
      fourToSix: sorted.filter((value) => value >= 4 && value <= 6).length,
      sevenPlus: sorted.filter((value) => value >= 7).length,
    },
  };
}

function mergeModelCount(models: ModelCount[], next: ModelCount): void {
  const existing = models.find(({ provider, model }) => provider === next.provider && model === next.model);
  if (existing) existing.count += next.count;
  else models.push(next);
}

function sortModels(models: ModelCount[]): ModelCount[] {
  return models.sort(
    (left, right) =>
      right.count - left.count ||
      `${left.provider ?? ""}/${left.model ?? ""}`.localeCompare(`${right.provider ?? ""}/${right.model ?? ""}`),
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Analytics query aborted", "AbortError");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
