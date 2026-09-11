import type { UsageMetric, UsageReport, VercelAIGatewayCreditsPayload } from "../types.js";

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function normalizeVercelAIGatewayCreditsPayload(
  payload: VercelAIGatewayCreditsPayload,
  capturedAt: number,
): UsageReport {
  const balance = decimalAmount(payload.balance, "balance");
  const totalUsed = decimalAmount(payload.total_used, "total used");
  const metrics: UsageMetric[] = [
    {
      id: "credit-balance",
      label: "Credit balance",
      value: balance,
      unit: "currency",
      currency: "USD",
    },
    {
      id: "lifetime-spend",
      label: "Lifetime spend",
      value: totalUsed,
      unit: "currency",
      currency: "USD",
    },
  ];
  return {
    providerId: "vercel-ai-gateway",
    providerName: "Vercel AI Gateway",
    capturedAt,
    source: "vercel-ai-gateway-credits",
    semantics: { kind: "api-key", label: "AI Gateway credits and lifetime spend" },
    buckets: [],
    metrics,
  };
}

function decimalAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !DECIMAL_AMOUNT.test(value)) {
    throw new Error(`Vercel AI Gateway ${label} was not a valid nonnegative amount.`);
  }
  return value;
}
