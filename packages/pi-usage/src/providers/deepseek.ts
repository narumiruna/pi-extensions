import type { DeepSeekBalancePayload, UsageMetric, UsageReport } from "../types.js";

const CURRENCIES = ["CNY", "USD"] as const;
type DeepSeekCurrency = (typeof CURRENCIES)[number];

const BALANCE_FIELDS = [
  ["total", "Total balance", "total_balance"],
  ["granted", "Granted balance", "granted_balance"],
  ["topped-up", "Topped-up balance", "topped_up_balance"],
] as const;

export function normalizeDeepSeekBalancePayload(payload: DeepSeekBalancePayload, capturedAt: number): UsageReport {
  if (typeof payload.is_available !== "boolean") {
    throw new Error("DeepSeek API balance response availability was not a boolean.");
  }
  if (!Array.isArray(payload.balance_infos) || payload.balance_infos.length === 0) {
    throw new Error("DeepSeek API balance response returned no balance information.");
  }

  const balances = new Map<DeepSeekCurrency, Record<string, unknown>>();
  for (const raw of payload.balance_infos) {
    const balance = asObject(raw);
    if (!balance) throw new Error("DeepSeek API balance row was not an object.");
    const currency = deepSeekCurrency(balance.currency);
    if (!currency) throw new Error("DeepSeek API balance row returned an unsupported currency.");
    if (balances.has(currency)) {
      throw new Error(`DeepSeek API balance response repeated ${currency}.`);
    }
    for (const [, label, field] of BALANCE_FIELDS) {
      if (!decimalAmount(balance[field])) {
        throw new Error(`DeepSeek API balance ${label.toLowerCase()} was not a valid amount.`);
      }
    }
    balances.set(currency, balance);
  }

  const metrics: UsageMetric[] = [
    {
      id: "api-availability",
      label: "API calls",
      value: payload.is_available ? "available" : "unavailable",
    },
  ];
  for (const currency of CURRENCIES) {
    const balance = balances.get(currency);
    if (!balance) continue;
    for (const [id, label, field] of BALANCE_FIELDS) {
      metrics.push({
        id: `${currency.toLowerCase()}-${id}`,
        label,
        value: balance[field] as string,
        unit: "currency",
        currency,
      });
    }
  }

  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    capturedAt,
    source: "deepseek-balance",
    semantics: { kind: "api-key", label: "DeepSeek API balance" },
    buckets: [],
    metrics,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function deepSeekCurrency(value: unknown): DeepSeekCurrency | undefined {
  return CURRENCIES.find((currency) => currency === value);
}

function decimalAmount(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}
