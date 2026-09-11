import { sanitizeDisplayText } from "../core.js";
import type { OpenCodeZenPayload, UsageBucket, UsageReport } from "../types.js";

const ZEN_WINDOWS = [
  { key: "rolling", label: "Rolling" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
] as const;

export function normalizeOpenCodeZenPayload(payload: OpenCodeZenPayload, capturedAt: number): UsageReport {
  const usage = asObject(payload.usage);
  if (!usage) throw new Error("OpenCode Zen usage response was not an object.");

  const buckets: UsageBucket[] = [];
  const notes: string[] = [];
  for (const window of ZEN_WINDOWS) {
    const raw = asObject(usage[window.key]);
    if (!raw) continue;
    const status = asString(raw.status);
    if (status !== "ok" && status !== "rate-limited") {
      notes.push(`${window.label} window unavailable (${status ?? "unknown status"}).`);
      continue;
    }
    const used = asNonnegativeNumber(raw.percent);
    if (used === undefined) continue;
    const resetsAt = asEpochSeconds(raw.resetsAt);
    buckets.push({
      id: window.key,
      label: `${window.label} window`,
      used,
      remaining: 100 - clampPercent(used),
      limit: 100,
      unit: "percent",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (buckets.length === 0) {
    throw new Error("OpenCode Zen usage endpoint returned no displayable usage data.");
  }

  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    capturedAt,
    source: "opencode-zen-usage",
    semantics: {
      kind: "consumer-subscription",
      label: "OpenCode Zen plan usage",
    },
    buckets,
    metrics: [],
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 80) || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
