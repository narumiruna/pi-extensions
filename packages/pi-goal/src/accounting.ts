import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface GoalAccountingState {
  status: string;
  baselineTokens: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeStartedAt?: number;
  updatedAt: number;
}

interface AssistantUsageEntryLike {
  type?: unknown;
  message?: unknown;
}

interface UsageContext {
  sessionManager?: unknown;
}

export function checkpointGoalActiveTime(goal: GoalAccountingState, now: number, continueClock: boolean) {
  const accumulated = nonNegativeFiniteNumber(goal.timeUsedSeconds);
  const startedAt = goal.activeStartedAt;
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    goal.timeUsedSeconds = accumulated + Math.max(0, now - startedAt) / 1000;
  } else {
    goal.timeUsedSeconds = accumulated;
  }
  goal.activeStartedAt = continueClock ? now : undefined;
}

export function updateGoalUsage(
  goal: GoalAccountingState,
  ctx: UsageContext,
  continueClock = goal.status === "active",
) {
  const now = Date.now();
  const baselineTokens = nonNegativeFiniteNumber(goal.baselineTokens);
  goal.baselineTokens = baselineTokens;
  goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - baselineTokens);
  checkpointGoalActiveTime(goal, now, continueClock);
  goal.updatedAt = now;
}

export function formatDuration(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(nonNegativeFiniteNumber(seconds)));
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number) {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) {
    return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
  }
  return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function nonNegativeFiniteNumber(value: unknown) {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}

export function normalizeTokenBudget(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function assistantUsageTokens(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const usage = value as Partial<Usage>;
  if (isNonNegativeFiniteNumber(usage.totalTokens)) return usage.totalTokens;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    nonNegativeFiniteNumber(usage.input) +
      nonNegativeFiniteNumber(usage.output) +
      nonNegativeFiniteNumber(usage.cacheRead) +
      nonNegativeFiniteNumber(usage.cacheWrite),
  );
}

export function cumulativeAssistantTokens(entries: unknown[]) {
  let total = 0;
  for (const entry of entries) {
    const candidate = entry as AssistantUsageEntryLike;
    if (candidate?.type !== "message") continue;
    const message = candidate.message as { role?: unknown; usage?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + assistantUsageTokens(message.usage));
  }
  return total;
}

function entryAssistantTokens(entry: SessionEntry): number {
  return entry.type === "message" && entry.message?.role === "assistant"
    ? assistantUsageTokens(entry.message.usage)
    : 0;
}

type UsageSessionManager = Partial<Pick<ExtensionContext["sessionManager"], "getBranch" | "getLeafId" | "getEntry">>;

// Pi entries are append-only: retain just the last leaf and its cumulative total.
// Object identity detects reloads with reused IDs; divergent branches recount.
// Weak manager keys release checkpoints when their sessions are discarded.
const tokenTotals = new WeakMap<UsageSessionManager, { entry: SessionEntry; total: number }>();

export function currentTokenTotal(ctx: UsageContext): number {
  const sessionManager = ctx.sessionManager as UsageSessionManager | undefined;
  if (typeof sessionManager?.getLeafId !== "function" || typeof sessionManager.getEntry !== "function") {
    // Compatibility with branch-only contexts; never cache their mutable arrays.
    return cumulativeAssistantTokens(sessionManager?.getBranch?.() ?? []);
  }

  const id = sessionManager.getLeafId();
  const leaf = id ? sessionManager.getEntry(id) : undefined;
  if (!leaf) {
    tokenTotals.delete(sessionManager);
    return 0;
  }
  const checkpoint = tokenTotals.get(sessionManager);
  if (leaf === checkpoint?.entry) return checkpoint.total;

  const pending: SessionEntry[] = [];
  let total = 0;
  let entry: SessionEntry | undefined = leaf;
  while (entry) {
    if (entry === checkpoint?.entry) {
      total = checkpoint.total;
      break;
    }
    pending.push(entry);
    entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
  }

  // Sum root-to-leaf to preserve full-recount rounding and saturation semantics.
  for (let index = pending.length - 1; index >= 0; index--) {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + entryAssistantTokens(pending[index]));
  }
  tokenTotals.set(sessionManager, { entry: leaf, total });
  return total;
}
