import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Independent test fixture, not a published client. These types describe only the public v1 protocol.
export type UsageUnavailableReasonV1 =
  | "not-ready"
  | "no-model"
  | "unsupported"
  | "auth-unavailable"
  | "selection-required"
  | "cache-miss"
  | "query-failed"
  | "cancelled"
  | "timeout"
  | "stale-context";

export type UsageUnitV1 = "percent" | "usd" | "currency" | "count";

export type UsageBucketV1 = {
  id: string;
  label: string;
  groupId?: string;
  groupLabel?: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnitV1;
  period?: string;
  windowMinutes?: number;
  resetsAt?: number;
};

export type UsageMetricV1 = {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnitV1;
  currency?: string;
};

export type UsageReportV1 = {
  providerId: string;
  providerName: string;
  capturedAt: number;
  source: string;
  semantics: { kind: "consumer-subscription" | "api-key" | "project"; label: string };
  accountLabel?: string;
  buckets: UsageBucketV1[];
  metrics: UsageMetricV1[];
  notes?: string[];
};

export type UsageUnavailableV1 = {
  status: "unavailable";
  providerId?: string;
  reason: UsageUnavailableReasonV1;
  message?: string;
};

export type UsageQueryResultV1 =
  | {
      status: "ready";
      providerId: string;
      source: "cache" | "refresh";
      expiresAt: number;
      report: UsageReportV1;
    }
  | UsageUnavailableV1;

export type UsageClientResult =
  | UsageQueryResultV1
  | { status: "unavailable"; providerId?: string; reason: "no-service" | "protocol-error" };

export type UsageQueryRequestV1 = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
  providerId?: string;
  refresh?: boolean;
  signal: AbortSignal;
  respond(result: UsageQueryResultV1 | Promise<UsageQueryResultV1>): boolean;
};

export type UsageChangedV1 = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
  providerId: string;
  changedAt: number;
  reason: "updated" | "invalidated" | "query-failed";
};

export type UsageQueryOptions = {
  providerId?: string;
  refresh?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isUnit = (value: unknown) => ["percent", "usd", "currency", "count"].includes(value as string);
const optional = (object: RecordValue, key: string, check: (value: unknown) => boolean) =>
  object[key] === undefined || check(object[key]);
const arrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => {
  if (!Array.isArray(value)) return false;
  // Iteration also checks sparse elements, unlike Array.every().
  for (const item of value) if (!check(item)) return false;
  return true;
};

function isBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    isUnit(value.unit) &&
    ["groupId", "groupLabel", "period"].every((key) => optional(value, key, isString)) &&
    ["used", "remaining", "limit", "windowMinutes", "resetsAt"].every((key) => optional(value, key, isFiniteNumber)) &&
    optional(value, "modelKeys", (items) => arrayOf(items, isString))
  );
}

function isMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    (isString(value.value) || isFiniteNumber(value.value)) &&
    optional(value, "unit", isUnit) &&
    optional(value, "currency", isString)
  );
}

function isReport(value: unknown): value is UsageReportV1 {
  return (
    isRecord(value) &&
    ["providerId", "providerName", "source"].every((key) => isString(value[key])) &&
    isFiniteNumber(value.capturedAt) &&
    isRecord(value.semantics) &&
    ["consumer-subscription", "api-key", "project"].includes(value.semantics.kind as string) &&
    isString(value.semantics.label) &&
    optional(value, "accountLabel", isString) &&
    arrayOf(value.buckets, isBucket) &&
    arrayOf(value.metrics, isMetric) &&
    optional(value, "notes", (items) => arrayOf(items, isString))
  );
}

function isResult(value: unknown, providerId: string | undefined, refresh: boolean): value is UsageQueryResultV1 {
  if (!isRecord(value) || !optional(value, "providerId", isString)) return false;
  if (value.providerId !== undefined && providerId !== undefined && value.providerId !== providerId) return false;
  if (value.status === "unavailable") {
    return (
      [
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
      ].includes(value.reason as string) && optional(value, "message", isString)
    );
  }
  return (
    value.status === "ready" &&
    isString(value.providerId) &&
    value.source === (refresh ? "refresh" : "cache") &&
    isFiniteNumber(value.expiresAt) &&
    isReport(value.report) &&
    value.providerId === value.report.providerId
  );
}

/** Call from session_start or later. The caller owns subscriptions and request generations.
 * Abort on disposal, lifecycle events, or supersession: captured Pi contexts can be snapshots,
 * so field comparisons alone cannot detect every replacement or a change away and back.
 */
export function queryUsage(
  pi: Pick<ExtensionAPI, "events">,
  ctx: ExtensionContext,
  options: UsageQueryOptions = {},
): Promise<UsageClientResult> {
  const session = ctx.sessionManager;
  const sessionId = session.getSessionId();
  const modelProvider = ctx.model?.provider;
  const modelId = ctx.model?.id;
  const providerId = options.providerId ?? modelProvider;
  const refresh = options.refresh ?? false;
  const callerSignal = options.signal;
  const unavailable = (reason: UsageUnavailableReasonV1 | "no-service" | "protocol-error"): UsageClientResult => ({
    status: "unavailable",
    ...(providerId === undefined ? {} : { providerId }),
    reason,
  });
  if (callerSignal?.aborted) return Promise.resolve(unavailable("cancelled"));

  return new Promise((resolve) => {
    const controller = new AbortController();
    let open = true;
    let offered = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: UsageClientResult, abort = false) => {
      if (settled) return;
      settled = true;
      open = false;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
      resolve(result);
      if (abort) controller.abort();
    };
    const onAbort = () => finish(unavailable("cancelled"), true);
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? 15_000;
    timer = setTimeout(
      () => finish(unavailable("timeout"), true),
      Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 15_000,
    );
    const current = () =>
      ctx.sessionManager === session &&
      session.getSessionId() === sessionId &&
      ctx.model?.provider === modelProvider &&
      ctx.model?.id === modelId;
    const request: UsageQueryRequestV1 = {
      session,
      sessionId,
      ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
      refresh,
      signal: controller.signal,
      respond(value) {
        const accepted = open && !offered && !settled;
        if (accepted) offered = true;
        // Observe every offer, including duplicates and promises offered after dispatch.
        void Promise.resolve(value).then(
          (result) => {
            if (!accepted || settled) return;
            try {
              if (!current()) return finish(unavailable("stale-context"), true);
              if (!isResult(result, providerId, refresh)) return finish(unavailable("protocol-error"), true);
              if (result.status === "ready" && Date.now() >= result.expiresAt) {
                return finish(unavailable("cache-miss"));
              }
              finish(result);
            } catch {
              finish(unavailable("protocol-error"), true);
            }
          },
          () => {
            if (accepted && !settled) {
              finish(unavailable(current() ? "protocol-error" : "stale-context"), true);
            }
          },
        );
        return accepted;
      },
    };
    try {
      pi.events.emit("usage:query:v1", request);
    } catch {
      finish(unavailable("protocol-error"), true);
    } finally {
      open = false;
    }
    if (!offered) finish(unavailable("no-service"), true);
  });
}
