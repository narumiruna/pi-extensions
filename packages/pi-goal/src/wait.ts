export interface GoalWait {
  reason: string;
  resumeAt?: number;
}

export const MAX_GOAL_WAIT_REASON_LENGTH = 1_000;
export const MIN_GOAL_WAIT_DELAY_MS = 10_000;
export const MAX_GOAL_WAIT_DELAY_MS = 2_147_483_647;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export function resolveGoalWaitDelay(resumeAfterMs: number | undefined): {
  requestedMs?: number;
  effectiveMs?: number;
} {
  if (resumeAfterMs === undefined) return {};
  return {
    requestedMs: resumeAfterMs,
    effectiveMs: Math.max(MIN_GOAL_WAIT_DELAY_MS, resumeAfterMs),
  };
}

export function createGoalWait(reason: string, resumeAfterMs: number | undefined, now = Date.now()): GoalWait {
  const { effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
  return {
    reason,
    ...(effectiveMs === undefined ? {} : { resumeAt: now + effectiveMs }),
  };
}

export function normalizeGoalWait(value: unknown): GoalWait | undefined {
  if (!isRecord(value)) return undefined;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason || reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return undefined;
  if (!Object.hasOwn(value, "resumeAt")) return { reason };
  if (
    typeof value.resumeAt !== "number" ||
    !Number.isSafeInteger(value.resumeAt) ||
    value.resumeAt < 0 ||
    value.resumeAt > MAX_DATE_TIMESTAMP_MS
  ) {
    return undefined;
  }
  return { reason, resumeAt: value.resumeAt };
}

export class GoalWaitTimer {
  private generation = 0;
  private timer?: NodeJS.Timeout;

  clear() {
    this.generation += 1;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(resumeAt: number, onDue: () => void) {
    this.clear();
    const generation = this.generation;
    const delay = Math.max(0, Math.min(MAX_GOAL_WAIT_DELAY_MS, resumeAt - Date.now()));
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      onDue();
    }, delay);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
