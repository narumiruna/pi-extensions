import { createHmac } from "node:crypto";
import type { UsageReport } from "./types.js";

type UsageCacheChangeReason = "updated" | "invalidated";

export class UsageCache {
  private readonly entries = new Map<string, { providerId: string; createdAt: number; report: UsageReport }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private notificationBatch?: {
    changes: { providerId: string; reason: UsageCacheChangeReason }[];
    seen: Record<UsageCacheChangeReason, Set<string>>;
  };

  constructor(
    ttlMs: number,
    maxEntries = 32,
    private readonly onChange?: (providerId: string, reason: UsageCacheChangeReason) => void,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Cache TTL must be positive.");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Cache entry limit must be a positive integer.");
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(providerId: string, fingerprint: string, now = Date.now()): UsageReport | undefined {
    return this.getEntry(providerId, fingerprint, now)?.report;
  }

  getEntry(
    providerId: string,
    fingerprint: string,
    now = Date.now(),
  ): { report: UsageReport; expiresAt: number } | undefined {
    this.notifyChanges(this.sweepExpired(now));
    const entry = this.entries.get(cacheKey(providerId, fingerprint));
    return entry ? { report: entry.report, expiresAt: entry.createdAt + this.ttlMs } : undefined;
  }

  set(providerId: string, fingerprint: string, report: UsageReport, now = Date.now()): void {
    const invalidated = this.sweepExpired(now);
    const key = cacheKey(providerId, fingerprint);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      invalidated.add(oldest[1].providerId);
    }
    this.entries.set(key, { providerId, createdAt: now, report });
    this.notifyChanges(invalidated, providerId);
  }

  delete(providerId: string, fingerprint: string): void {
    if (this.entries.delete(cacheKey(providerId, fingerprint))) {
      this.notifyChanges(new Set([providerId]));
    }
  }

  clearProvider(providerId: string): void {
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (entry.providerId !== providerId) continue;
      this.entries.delete(key);
      removed = true;
    }
    if (removed) this.notifyChanges(new Set([providerId]));
  }

  clear(): void {
    const invalidated = new Set([...this.entries.values()].map((entry) => entry.providerId));
    this.entries.clear();
    this.notifyChanges(invalidated);
  }

  private sweepExpired(now: number): Set<string> {
    const invalidated = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) {
        this.entries.delete(key);
        invalidated.add(entry.providerId);
      }
    }
    return invalidated;
  }

  private notifyChanges(invalidated: ReadonlySet<string>, updated?: string): void {
    if (!this.onChange || (invalidated.size === 0 && updated === undefined)) return;
    const batch = this.notificationBatch ?? {
      changes: [],
      seen: { updated: new Set<string>(), invalidated: new Set<string>() },
    };
    const enqueue = (providerId: string, reason: UsageCacheChangeReason) => {
      if (batch.seen[reason].has(providerId)) return;
      batch.seen[reason].add(providerId);
      batch.changes.push({ providerId, reason });
    };
    for (const providerId of invalidated) enqueue(providerId, "invalidated");
    if (updated !== undefined) enqueue(updated, "updated");
    if (this.notificationBatch) return;

    // Coalesce each provider/reason across synchronous reentry to prevent notification loops.
    this.notificationBatch = batch;
    try {
      for (const { providerId, reason } of batch.changes) {
        try {
          this.onChange(providerId, reason);
        } catch {
          // An observer failure must not interrupt cache operations or other notifications.
        }
      }
    } finally {
      this.notificationBatch = undefined;
    }
  }
}

export function fingerprintResolvedAuth(
  auth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
    env?: Record<string, string>;
    source?: string;
    providerAuth?: {
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
    };
  },
  salt: Uint8Array,
): string {
  const headers = Object.entries(auth.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const env = Object.entries(auth.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const providerHeaders = Object.entries(auth.providerAuth?.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = JSON.stringify({
    apiKey: auth.apiKey ?? "",
    headers,
    baseUrl: auth.baseUrl ?? "",
    env,
    source: auth.source ?? "",
    providerAuth: {
      apiKey: auth.providerAuth?.apiKey ?? "",
      headers: providerHeaders,
      baseUrl: auth.providerAuth?.baseUrl ?? "",
    },
  });
  return createHmac("sha256", salt).update(canonical).digest("hex");
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (signal.aborted) throw abortError();
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency limit must be positive.");

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      if (signal.aborted) throw abortError();
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index] as T, index, signal),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(runners);
  if (signal.aborted) throw abortError();
  return results;
}

export async function awaitWithDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
): Promise<T> {
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.aborted
                ? abortError()
                : Object.assign(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s ${description}.`), {
                    name: "TimeoutError",
                  }),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

export function sanitizeDisplayText(value: string, maxChars = 160): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    if (codePoint === 0x1b || codePoint === 0x9b || codePoint === 0x9d) {
      index = skipTerminalEscape(value, index, codePoint);
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) result += " ";
      index += character.length;
      continue;
    }
    result += character;
    index += character.length;
  }
  return truncate(result.replace(/\s+/gu, " ").trim(), maxChars);
}

export function redactUsageError(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<redacted>");
  }
  redacted = redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/"(?:access_token|refresh_token|api_key)"\s*:\s*"[^"]+"/gi, (match) => {
      const separator = match.indexOf(":");
      return `${match.slice(0, separator + 1)}"<redacted>"`;
    });
  return sanitizeDisplayText(redacted, 600);
}

export function errorMessage(error: unknown): string {
  return sanitizeDisplayText(error instanceof Error ? error.message : String(error), 600);
}

export function abortError(): Error {
  return Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
}

function skipTerminalEscape(value: string, start: number, codePoint: number): number {
  let index = start + 1;
  const next = value.charCodeAt(index);
  const isOsc = codePoint === 0x9d || (codePoint === 0x1b && next === 0x5d);
  if (isOsc) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      if (current === 0x07) return index + 1;
      if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
      index += 1;
    }
    return index;
  }
  const isCsi = codePoint === 0x9b || (codePoint === 0x1b && next === 0x5b);
  if (isCsi) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      index += 1;
      if (current >= 0x40 && current <= 0x7e) break;
    }
    return index;
  }
  return Math.min(value.length, start + (codePoint === 0x1b ? 2 : 1));
}

function cacheKey(providerId: string, fingerprint: string): string {
  return `${providerId}:${fingerprint}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
