import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ancestry } from "./ancestry.js";
import type { EntryIndex } from "./entry-index.js";
import type { CacheHistory, CacheRecord, CacheTotals } from "./model.js";
import { displayText } from "./privacy.js";

export type CostModelResolver = (provider: string, model: string) => Model<Api> | undefined;
const ROW_LIMIT = 200;
const TREND_LIMIT = 32;
const metricKeys = ["input", "cacheRead", "cacheWrite", "promptTokens", "promptCost", "estimatedSavings"] as const;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function sum(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return number(values.reduce<number>((total, value) => total + (value ?? 0), 0));
}
function label(value: unknown): string {
  return typeof value === "string" ? displayText(value).slice(0, 128) : "unavailable";
}
function emptyTotals(): CacheTotals {
  return {
    count: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    promptTokens: 0,
    hitRatePercent: null,
    promptCost: 0,
    estimatedSavings: 0,
  };
}

// calculateCost mutates its Usage argument. Always use a fresh, normalized copy.
function pricedUsage(usage: Usage, input: number, read: number, write: number): Usage {
  return {
    ...usage,
    input,
    cacheRead: read,
    cacheWrite: write,
    cacheWrite1h: Math.min(write, number(usage.cacheWrite1h) ?? 0),
    output: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function costs(usage: Usage, model: Model<Api> | undefined, input: number, read: number, write: number) {
  const fallback = model ? calculateCost(model, pricedUsage(usage, input, read, write)) : undefined;
  let reported = false;
  let estimated = false;
  function component(tokens: number, actual: unknown, estimate: unknown): number | null {
    if (tokens === 0) return 0;
    const value = number(actual);
    if (value !== null && value > 0) {
      reported = true;
      return value;
    }
    const candidate = number(estimate);
    if (candidate !== null) estimated = true;
    return candidate;
  }
  const inputCost = component(input, usage.cost?.input, fallback?.input);
  const readCost = component(read, usage.cost?.cacheRead, fallback?.cacheRead);
  const writeCost = component(write, usage.cost?.cacheWrite, fallback?.cacheWrite);
  // Shift one token between buckets without changing the tier's prompt-token total.
  const inputRate =
    input > 0
      ? inputCost === null
        ? null
        : inputCost / input
      : model && read > 0
        ? number(
            calculateCost(model, pricedUsage(usage, Math.min(1, read), read - Math.min(1, read), write)).input /
              Math.min(1, read),
          )
        : null;
  const probe = Math.min(1, input + write);
  const fromInput = Math.min(input, probe);
  const readRate =
    read > 0
      ? readCost === null
        ? null
        : readCost / read
      : model && probe > 0
        ? number(
            calculateCost(model, pricedUsage(usage, input - fromInput, probe, write - (probe - fromInput))).cacheRead /
              probe,
          )
        : null;
  const promptCost = sum([inputCost, readCost, writeCost]);
  return {
    promptCost,
    inputRate,
    readRate,
    paidRate: input + write > 0 ? divide(sum([inputCost, writeCost]), input + write) : null,
    source:
      promptCost === null
        ? ("unavailable" as const)
        : reported && estimated
          ? ("mixed" as const)
          : estimated
            ? ("model-estimate" as const)
            : ("reported" as const),
  };
}
function divide(value: number | null, denominator: number): number | null {
  return value === null || denominator <= 0 ? null : number(value / denominator);
}

export function cacheHistory(
  manager: ExtensionContext["sessionManager"],
  index: EntryIndex,
  resolveModel: CostModelResolver = () => undefined,
): CacheHistory {
  const rawLeaf = manager.getLeafId();
  const leaf = typeof rawLeaf === "string" && rawLeaf.length > 0 && rawLeaf.length <= 512 ? rawLeaf : null;
  const walked = leaf === null ? { path: [] as SessionEntry[] } : ancestry(manager, leaf, index);
  const report: CacheHistory = {
    leafId: leaf,
    records: [],
    totalRecords: 0,
    omittedRecords: 0,
    totals: emptyTotals(),
    trend: [],
    complete: !walked.issue,
    unavailable: walked.issue,
  };
  if (walked.issue || (rawLeaf !== null && (leaf === null || !index.get(leaf)))) {
    report.complete = false;
    report.unavailable ??= "Missing or invalid active leaf";
    return report;
  }
  const providers = new Set<string>();
  let epoch = 0;
  let previous: { record: CacheRecord; startedAt: number | null; provider: unknown; model: unknown } | undefined;
  let accountingComplete = true;
  for (const entry of walked.path) {
    const boundary = entry.type === "compaction" || entry.type === "branch_summary";
    if (boundary) {
      epoch++;
      previous = undefined;
    }
    const message = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
    const usage = message?.usage ?? (entry.type === "usage" || boundary ? entry.usage : undefined);
    if (!message && entry.type !== "usage" && !(boundary && entry.usage !== undefined)) continue;
    const provider = message?.provider ?? (entry.type === "usage" ? entry.provider : undefined);
    const model = message?.model ?? (entry.type === "usage" ? entry.model : undefined);
    const record: CacheRecord = {
      entryId: entry.id,
      epoch,
      kind: message
        ? "assistant"
        : entry.type === "usage"
          ? entry.kind === "cache_warm"
            ? "cache_warm"
            : "usage"
          : (entry.type as "compaction" | "branch_summary"),
      provider: label(provider),
      model: label(model),
      timestamp: label(entry.timestamp),
      status: message?.stopReason === "error" ? "error" : message?.stopReason === "aborted" ? "cancelled" : "recorded",
      input: null,
      cacheRead: null,
      cacheWrite: null,
      promptTokens: null,
      hitRatePercent: null,
      promptCost: null,
      estimatedSavings: null,
      costSource: "unavailable",
      comparison: null,
    };
    const input = number(usage?.input);
    const read = number(usage?.cacheRead);
    const write = number(usage?.cacheWrite);
    const promptTokens = sum([input, read, write]);
    const valid = usage && input !== null && read !== null && write !== null && promptTokens !== null;
    const startedAt = number(message?.timestamp);
    if (valid) {
      Object.assign(record, { input, cacheRead: read, cacheWrite: write, promptTokens });
      // Only prior conversational evidence establishes support for all-zero cache fields.
      const known = promptTokens > 0 && (read + write > 0 || (message && providers.has(provider ?? "")));
      if (message && read + write > 0 && typeof provider === "string") providers.add(provider);
      record.hitRatePercent = known ? (read / promptTokens) * 100 : null;
      const pricing = costs(
        usage,
        typeof provider === "string" && typeof model === "string" ? resolveModel(provider, model) : undefined,
        input,
        read,
        write,
      );
      record.promptCost = pricing.promptCost;
      record.costSource = pricing.source;
      record.estimatedSavings = !known
        ? null
        : read === 0
          ? 0
          : pricing.inputRate !== null && pricing.readRate !== null
            ? number(read * Math.max(0, pricing.inputRate - pricing.readRate))
            : null;
      const prior = previous?.record;
      if (message && record.hitRatePercent !== null && prior?.hitRatePercent != null && prior.promptTokens !== null) {
        const eligible = Math.min(prior.promptTokens, promptTokens);
        const rebilled = Math.max(0, eligible - read);
        const delta = record.hitRatePercent - prior.hitRatePercent;
        record.comparison = {
          previousEntryId: prior.entryId,
          hitRateDeltaPercent: delta,
          hitRateLossPercent: Math.max(0, -delta),
          promptTokenDelta: promptTokens - prior.promptTokens,
          cacheReadDelta: read - (prior.cacheRead ?? 0),
          eligibleTokens: eligible,
          rebilledTokens: rebilled,
          estimatedMissPremium:
            pricing.paidRate !== null && pricing.readRate !== null
              ? number(rebilled * Math.max(0, pricing.paidRate - pricing.readRate))
              : null,
          modelChanged: previous?.provider !== provider || previous?.model !== model,
          requestStartGapMs:
            startedAt !== null && previous?.startedAt != null
              ? number(Math.max(0, startedAt - previous.startedAt))
              : null,
        };
      }
    } else report.complete = false;
    if (message) {
      previous = { record, startedAt, provider, model };
      report.trend.push({ entryId: record.entryId, hitRatePercent: record.hitRatePercent });
      if (report.trend.length > TREND_LIMIT) report.trend.shift();
    }
    report.totalRecords++;
    report.totals.count++;
    for (const key of metricKeys) report.totals[key] = sum([report.totals[key], record[key]]);
    if (record.hitRatePercent === null) accountingComplete = false;
    report.records.push(record);
    if (report.records.length > ROW_LIMIT) report.records.shift();
  }
  report.omittedRecords = report.totalRecords - report.records.length;
  report.totals.hitRatePercent =
    accountingComplete && (report.totals.promptTokens ?? 0) > 0 && report.totals.cacheRead !== null
      ? (report.totals.cacheRead / (report.totals.promptTokens as number)) * 100
      : null;
  return report;
}
