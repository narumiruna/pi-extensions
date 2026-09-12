import type { BasetenBillingUsagePayload, UsageMetric, UsageReport } from "../types.js";

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function normalizeBasetenBillingUsagePayload(
  payload: BasetenBillingUsagePayload,
  capturedAt: number,
): UsageReport {
  if (payload.model_apis_usage === undefined || payload.model_apis_usage === null) {
    return report(capturedAt, [], ["Baseten returned no Model APIs usage for the last 30 days."]);
  }
  const usage = asObject(payload.model_apis_usage);
  if (!usage) throw new Error("Baseten Model APIs usage was not an object.");
  const metrics: UsageMetric[] = [
    metric("gross-usage", "Gross usage", usage.total),
    metric("credits-used", "Credits used", usage.credits_used),
    metric("net-subtotal", "Net subtotal", usage.subtotal),
  ];
  return report(capturedAt, metrics);
}

function report(capturedAt: number, metrics: UsageMetric[], notes?: string[]): UsageReport {
  return {
    providerId: "baseten",
    providerName: "Baseten",
    capturedAt,
    source: "baseten-billing-usage-summary",
    semantics: { kind: "api-key", label: "Organization Model APIs spend" },
    buckets: [],
    metrics,
    ...(notes ? { notes } : {}),
  };
}

function metric(id: string, label: string, value: unknown): UsageMetric {
  const amount = decimalAmount(value, label);
  return { id, label, value: amount, unit: "currency", currency: "USD" };
}

function decimalAmount(value: unknown, label: string): string {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof normalized !== "string" || normalized.length > 64 || !DECIMAL_AMOUNT.test(normalized)) {
    throw new Error(`Baseten ${label.toLowerCase()} was not a valid nonnegative amount.`);
  }
  return normalized;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
