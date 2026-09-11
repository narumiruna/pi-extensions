import type { MoonshotBalancePayload, UsageMetric, UsageReport } from "../types.js";

export type MoonshotProviderId = "moonshotai" | "moonshotai-cn";

const PROVIDERS = {
  moonshotai: { name: "Moonshot AI", currency: "USD" },
  "moonshotai-cn": { name: "Moonshot AI CN", currency: "CNY" },
} as const;

export function normalizeMoonshotBalancePayload(
  providerId: MoonshotProviderId,
  payload: MoonshotBalancePayload,
  capturedAt: number,
): UsageReport {
  if (payload.code !== 0 || payload.status !== true) {
    throw new Error("Moonshot AI balance response did not report success.");
  }
  const data = asObject(payload.data);
  if (!data) throw new Error("Moonshot AI balance response data was not an object.");
  const provider = PROVIDERS[providerId];
  const available = amount(data.available_balance, "available balance", false);
  const voucher = amount(data.voucher_balance, "voucher balance", false);
  const cash = amount(data.cash_balance, "cash balance", true);
  const metrics: UsageMetric[] = [
    currencyMetric("available-balance", "Available balance", available, provider.currency),
    currencyMetric("voucher-balance", "Voucher balance", voucher, provider.currency),
    currencyMetric("cash-balance", "Cash balance", cash, provider.currency),
  ];
  return {
    providerId,
    providerName: provider.name,
    capturedAt,
    source: "moonshot-balance",
    semantics: { kind: "api-key", label: "Moonshot API account balance" },
    buckets: [],
    metrics,
  };
}

function currencyMetric(id: string, label: string, value: string, currency: "CNY" | "USD"): UsageMetric {
  return { id, label, value, unit: "currency", currency };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function amount(value: unknown, label: string, allowNegative: boolean): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (!allowNegative && value < 0) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`Moonshot AI ${label} was not a valid amount.`);
  }
  return String(value);
}
