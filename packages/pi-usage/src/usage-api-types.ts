import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Structural protocol types, not extension entrypoint exports.
export type UsageScopeV1 = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
};

export type UsageRequestV1<T> = UsageScopeV1 & {
  providerId?: string;
  signal: AbortSignal;
  respond(result: T | Promise<T>): boolean;
};

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

export type UsageUnavailableV1 = {
  status: "unavailable";
  providerId?: string;
  reason: UsageUnavailableReasonV1;
  message?: string;
};

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
export type UsageQueryResultV1 =
  | {
      status: "ready";
      providerId: string;
      source: "cache" | "refresh";
      expiresAt: number;
      report: UsageReportV1;
    }
  | UsageUnavailableV1;
export type UsageQueryRequestV1 = UsageRequestV1<UsageQueryResultV1> & { refresh?: boolean };
export type UsageMeasurementV1 = "quota" | "balance" | "spend" | "reset-time";
export type UsageCapabilitiesResultV1 =
  | {
      status: "ready";
      providerId: string;
      supported: boolean;
      measurements: UsageMeasurementV1[];
      supportsRefresh: boolean;
    }
  | UsageUnavailableV1;
export type UsageCapabilitiesRequestV1 = UsageRequestV1<UsageCapabilitiesResultV1>;
export type UsageChangedV1 = UsageScopeV1 & {
  providerId: string;
  changedAt: number;
  reason: "updated" | "invalidated" | "query-failed";
};

export type UsageApiCallbacks = {
  refresh(
    ctx: ExtensionContext,
    providerId: string,
    signal: AbortSignal,
    deadlineAt: number,
    checkCurrent: () => void,
  ): Promise<UsageQueryResultV1>;
  policyIdentity(): string;
};

export type UsageApi = {
  start(ctx: ExtensionContext): void;
  ready(ctx: ExtensionContext): void;
  observe(ctx: ExtensionContext): void;
  stop(ctx: ExtensionContext): void;
  changed(providerId: string, reason: UsageChangedV1["reason"]): void;
};
