import type { ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number; totalFromProvider?: boolean };
}

export interface FooterUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costTotalFromProvider: boolean;
  latestCacheHitRate?: number;
}

export function createFooterHistoryReader(
  manager: ExtensionContext["sessionManager"] & Partial<Pick<SessionManager, "getEntryCount">>,
) {
  type Header = NonNullable<ReturnType<SessionManager["getHeader"]>>;
  let usage: { header: Header; count: number; totals: FooterUsageSummary } | undefined;
  let branch: { header: Header; leaf: SessionEntry | null; values: ReturnType<typeof summarizeBranch> } | undefined;
  return {
    totals(): FooterUsageSummary {
      const count = manager.getEntryCount?.();
      const header = count === undefined ? null : manager.getHeader?.();
      if (header && usage?.header === header && usage.count === count) return usage.totals;
      const totals = summarizeFooterUsage(manager.getEntries());
      usage = header && count !== undefined ? { header, count, totals } : undefined;
      return totals;
    },
    branch() {
      const header = manager.getHeader?.();
      const leaf = header ? manager.getLeafEntry?.() : undefined;
      if (header && branch?.header === header && branch.leaf === leaf) return branch.values;
      const values = summarizeBranch(manager.getBranch());
      branch = header && leaf !== undefined ? { header, leaf, values } : undefined;
      return values;
    },
    clear() {
      usage = undefined;
      branch = undefined;
    },
  };
}

function summarizeBranch(branch: readonly SessionEntry[]) {
  let turnCount = 0;
  for (const entry of branch) if (entry.type === "message" && entry.message.role === "user") turnCount++;
  return { turnCount, tokensPerSecond: latestTokensPerSecond(branch) };
}

/** Use the latest assistant only: an untimed or incomplete response must not expose an older rate. */
export function latestTokensPerSecond(branch: readonly SessionEntry[]): number | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const { stopReason, durationMs, usage } = entry.message;
    if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") return undefined;
    const output = usage?.output;
    if (
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      typeof output !== "number" ||
      !Number.isFinite(output) ||
      output < 0
    ) {
      return undefined;
    }
    // Pi times the complete response, including request latency, not just streamed text.
    const rate = output / (durationMs / 1000);
    return Number.isFinite(rate) ? rate : undefined;
  }
  return undefined;
}

export function summarizeFooterUsage(entries: readonly SessionEntry[]): FooterUsageSummary {
  const totals: FooterUsageSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costTotalFromProvider: false,
  };
  let hasUsage = false;
  let allTotalsFromProvider = true;

  for (const entry of entries) {
    let usage: UsageLike | undefined;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      const input = usage?.input ?? 0;
      const cacheRead = usage?.cacheRead ?? 0;
      const cacheWrite = usage?.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      totals.latestCacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      usage = entry.usage;
    }
    if (!usage) continue;

    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
    hasUsage = true;
    const cost = usage.cost;
    allTotalsFromProvider &&=
      cost?.totalFromProvider === true &&
      typeof cost.total === "number" &&
      Number.isFinite(cost.total) &&
      cost.total >= 0;
  }

  // Empty or incomplete accounting cannot establish a provider-reported total.
  totals.costTotalFromProvider = hasUsage && allTotalsFromProvider && Number.isFinite(totals.cost);
  return totals;
}
