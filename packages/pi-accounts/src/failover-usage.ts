import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type QuotaDecision = { kind: "low" | "adequate" | "unknown"; resetsAt?: number; reason?: string };

type Allowance = {
  kind: "included";
  scope: { kind: "models"; modelIds: string[] };
  coverage: "complete" | "partial";
  bucketIds: string[];
  authBinding: "runtime" | "unbound";
};
type Unit = "percent" | "usd" | "currency" | "count";
type Bucket = {
  id: string;
  label: string;
  unit: Unit;
  groupId?: string;
  groupLabel?: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  period?: string;
  windowMinutes?: number;
  resetsAt?: number;
};
type Metric = { id: string; label: string; value: number | string; unit?: Unit; currency?: string };
type Ready = {
  status: "ready";
  providerId: string;
  source: "cache" | "refresh";
  expiresAt: number;
  report: {
    providerId: string;
    providerName: string;
    capturedAt: number;
    source: string;
    semantics: { kind: "consumer-subscription" | "api-key" | "project"; label: string };
    accountLabel?: string;
    buckets: Bucket[];
    metrics: Metric[];
    notes?: string[];
    allowance?: Allowance;
  };
};
type Unavailable = { status: "unavailable"; providerId?: string; reason: string };

// Read each known field once as an own data property. Accessors are not evidence.
// Descriptor traps can throw; both public entrypoints catch validation failures.
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("Accessor field");
  return descriptor?.value;
}
function object(value: unknown): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid text");
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid number");
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find((item) => item === value);
  if (found === undefined) throw new Error("Invalid discriminator");
  return found;
}
function array<T>(value: unknown, parse: (item: unknown) => T, maxLength = 2048): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid array");
  const length = finite(field(value, "length"));
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) throw new Error("Invalid array length");
  const items: T[] = [];
  for (let index = 0; index < length; index++) items.push(parse(field(value, String(index))));
  return items;
}
function unit(value: unknown): Unit {
  return choice(value, ["percent", "usd", "currency", "count"]);
}
function bucket(value: unknown): Bucket {
  const input = object(value);
  const result: Bucket = {
    id: text(field(input, "id")),
    label: text(field(input, "label")),
    unit: unit(field(input, "unit")),
  };
  for (const key of ["groupId", "groupLabel", "period"] as const) {
    const value = field(input, key);
    if (value !== undefined) result[key] = text(value);
  }
  for (const key of ["used", "remaining", "limit", "windowMinutes", "resetsAt"] as const) {
    const value = field(input, key);
    if (value !== undefined) result[key] = finite(value);
  }
  const modelKeys = field(input, "modelKeys");
  if (modelKeys !== undefined) result.modelKeys = array(modelKeys, text);
  return result;
}
function metric(value: unknown): Metric {
  const input = object(value);
  const measurement = field(input, "value");
  const result: Metric = {
    id: text(field(input, "id")),
    label: text(field(input, "label")),
    value: typeof measurement === "string" ? measurement : finite(measurement),
  };
  const measureUnit = field(input, "unit");
  const currency = field(input, "currency");
  if (measureUnit !== undefined) result.unit = unit(measureUnit);
  if (currency !== undefined) result.currency = text(currency);
  return result;
}
function ids(value: unknown): string[] {
  const result = array(value, text, 128);
  if (!result.length || result.some((id) => !id.trim() || id.length > 512) || new Set(result).size !== result.length)
    throw new Error("Invalid IDs");
  return result;
}
function allowance(value: unknown): Allowance {
  const input = object(value);
  const scope = object(field(input, "scope"));
  return {
    kind: choice(field(input, "kind"), ["included"]),
    scope: { kind: choice(field(scope, "kind"), ["models"]), modelIds: ids(field(scope, "modelIds")) },
    coverage: choice(field(input, "coverage"), ["complete", "partial"]),
    bucketIds: ids(field(input, "bucketIds")),
    authBinding: choice(field(input, "authBinding"), ["runtime", "unbound"]),
  };
}
function snapshot(value: unknown): Ready | Unavailable {
  const input = object(value);
  const status = field(input, "status");
  if (status === "unavailable") {
    const reason = choice(field(input, "reason"), [
      "not-ready",
      "no-model",
      "unsupported",
      "auth-unavailable",
      "selection-required",
      "cache-miss",
      "query-failed",
      "cancelled",
      "timeout",
      "stale-context",
    ]);
    const providerId = field(input, "providerId");
    const message = field(input, "message");
    if (message !== undefined) text(message);
    return providerId === undefined ? { status, reason } : { status, reason, providerId: text(providerId) };
  }
  if (status !== "ready") throw new Error("Invalid status");
  const report = object(field(input, "report"));
  const semantics = object(field(report, "semantics"));
  const result: Ready = {
    status,
    providerId: text(field(input, "providerId")),
    source: choice(field(input, "source"), ["cache", "refresh"]),
    expiresAt: finite(field(input, "expiresAt")),
    report: {
      providerId: text(field(report, "providerId")),
      providerName: text(field(report, "providerName")),
      capturedAt: finite(field(report, "capturedAt")),
      source: text(field(report, "source")),
      semantics: {
        kind: choice(field(semantics, "kind"), ["consumer-subscription", "api-key", "project"]),
        label: text(field(semantics, "label")),
      },
      buckets: array(field(report, "buckets"), bucket),
      metrics: array(field(report, "metrics"), metric),
    },
  };
  const accountLabel = field(report, "accountLabel");
  const notes = field(report, "notes");
  const evidence = field(report, "allowance");
  if (accountLabel !== undefined) result.report.accountLabel = text(accountLabel);
  if (notes !== undefined) result.report.notes = array(notes, text);
  if (evidence !== undefined) {
    result.report.allowance = allowance(evidence);
    includedBuckets(result.report);
  }
  return result;
}
function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}
function includedBuckets(report: Ready["report"]): (Bucket & { used: number; remaining: number })[] {
  if (!report.allowance) return [];
  const buckets = new Map(report.buckets.map((item) => [item.id, item]));
  if (buckets.size !== report.buckets.length || report.buckets.some((item) => !item.id.trim()))
    throw new Error("Invalid bucket IDs");
  return report.allowance.bucketIds.map((id) => {
    const item = buckets.get(id);
    if (item?.unit !== "percent" || (item.limit !== undefined && item.limit !== 100)) throw new Error("Invalid quota");
    const { used, remaining } = item;
    if (
      used === undefined ||
      remaining === undefined ||
      used < 0 ||
      used > 100 ||
      remaining < 0 ||
      remaining > 100 ||
      Math.abs(used + remaining - 100) > 1e-9 ||
      (used === 100 && remaining !== 0) ||
      (used === 0 && remaining !== 100) ||
      (remaining === 100 && used !== 0) ||
      (remaining === 0 && used !== 100)
    )
      throw new Error("Invalid percentage counters");
    return { ...item, used, remaining };
  });
}

/** Evaluate only fresh, exact-model, runtime-bound included percentage constraints. */
export function evaluateUsageAllowance(
  value: unknown,
  providerId: string,
  modelId: string,
  threshold: number,
  startedAt: number,
  now = Date.now(),
): QuotaDecision {
  const unknown = (reason: string): QuotaDecision => ({ kind: "unknown", reason });
  try {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 100) return unknown("invalid-threshold");
    if (!timestamp(startedAt) || !timestamp(now) || startedAt > now) return unknown("invalid-time");
    const result = snapshot(value);
    if (result.status !== "ready") return unknown("unavailable");
    if (!providerId || !modelId || result.providerId !== providerId || result.report.providerId !== providerId)
      return unknown("provider-mismatch");
    if (result.source !== "refresh") return unknown("not-refreshed");
    const { report, expiresAt } = result;
    if (
      !timestamp(expiresAt) ||
      !timestamp(report.capturedAt) ||
      expiresAt <= now ||
      report.capturedAt < startedAt ||
      report.capturedAt > now
    )
      return unknown("stale-report");
    const evidence = report.allowance;
    if (evidence?.authBinding !== "runtime" || !evidence.scope.modelIds.includes(modelId))
      return unknown("unsupported-allowance");
    const low: Bucket[] = [];
    for (const item of includedBuckets(report)) {
      const { remaining, resetsAt } = item;
      if (resetsAt !== undefined && (!timestamp(resetsAt) || resetsAt <= now)) return unknown("invalid-quota");
      if (remaining <= threshold) low.push(item);
    }
    if (low.length > 0) {
      // An unknown reset on any low constraint must not create an early revisit.
      if (low.some((item) => item.resetsAt === undefined)) return { kind: "low" };
      return { kind: "low", resetsAt: low.reduce((latest, item) => Math.max(latest, item.resetsAt ?? latest), 0) };
    }
    return evidence.coverage === "complete" ? { kind: "adequate" } : unknown("partial-coverage");
  } catch {
    return unknown("invalid-evidence");
  }
}

/** The caller owns auth/policy generations and must abort on supersession or disposal. */
export function readUsageAllowance(
  pi: Pick<ExtensionAPI, "events">,
  ctx: ExtensionContext,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<unknown> {
  const unavailable = (reason: string): Unavailable => ({ status: "unavailable", reason });
  if (signal.aborted) return Promise.resolve(unavailable("cancelled"));
  let session: ExtensionContext["sessionManager"];
  let sessionId: string;
  let model: string | undefined;
  let providerId: string;
  try {
    session = ctx.sessionManager;
    sessionId = session.getSessionId();
    providerId = ctx.model?.provider ?? "";
    model = JSON.stringify(ctx.model);
    if (!providerId) return Promise.resolve(unavailable("no-model"));
  } catch {
    return Promise.resolve(unavailable("stale-context"));
  }
  const isCurrent = () => {
    try {
      return (
        ctx.sessionManager === session &&
        session.getSessionId() === sessionId &&
        JSON.stringify(ctx.model) === model &&
        ctx.model?.provider === providerId
      );
    } catch {
      return false;
    }
  };
  const duration = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(15_000, timeoutMs)) : 15_000;
  const deadline = Date.now() + duration;
  return new Promise((resolve) => {
    const controller = new AbortController();
    let open = true;
    let offered = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: unknown) => {
      if (done) return;
      done = true;
      open = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
      controller.abort();
    };
    const cancel = () => finish(unavailable("cancelled"));
    timer = setTimeout(() => finish(unavailable("timeout")), duration);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      pi.events.emit("usage:query:v1", {
        session,
        sessionId,
        providerId,
        refresh: true,
        signal: controller.signal,
        respond(result: unknown) {
          const accepted = open && !offered && !done;
          if (accepted) offered = true;
          try {
            // Rejected duplicates, late offers, and throwing thenables are observed too.
            void Promise.resolve(result).then(
              (value) => {
                if (!accepted || done) return;
                try {
                  const detached = snapshot(value);
                  if (!isCurrent()) finish(unavailable("stale-context"));
                  else if (Date.now() >= deadline) finish(unavailable("timeout"));
                  else if (detached.providerId !== undefined && detached.providerId !== providerId)
                    finish(unavailable("protocol-error"));
                  else if (detached.status === "ready" && detached.report.providerId !== providerId)
                    finish(unavailable("protocol-error"));
                  else finish(detached);
                } catch {
                  finish(unavailable("protocol-error"));
                }
              },
              () => {
                if (accepted && !done) finish(unavailable("protocol-error"));
              },
            );
          } catch {
            if (accepted && !done) finish(unavailable("protocol-error"));
          }
          return accepted;
        },
      });
    } catch {
      finish(unavailable("protocol-error"));
    } finally {
      open = false;
    }
    if (!offered) finish(unavailable("no-service"));
  });
}
