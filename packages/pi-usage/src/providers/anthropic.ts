import type { UsageReport } from "../types.js";

export type AnthropicUsagePayload = { extra_usage?: unknown };

const UNAVAILABLE_NOTE = "Claude extra usage is unavailable.";
const METRICS = [
  ["extra-usage-used", "Used this month"],
  ["extra-usage-limit", "Monthly limit"],
  ["extra-usage-remaining", "Remaining"],
] as const;

export function normalizeAnthropicUsagePayload(payload: AnthropicUsagePayload, capturedAt: number): UsageReport {
  const root = asObject(payload);
  if (!root) throw new Error("Claude usage response was not an object.");

  const report: UsageReport = {
    providerId: "anthropic",
    providerName: "Anthropic",
    capturedAt,
    source: "anthropic-extra-usage",
    semantics: { kind: "consumer-subscription", label: "Claude extra-usage spending limit" },
    buckets: [],
    metrics: [],
  };
  if (root.extra_usage === undefined || root.extra_usage === null) {
    report.notes = [UNAVAILABLE_NOTE];
    return report;
  }
  const extra = asObject(root.extra_usage);
  if (!extra) throw new Error("Claude extra usage was not an object.");

  const enabled = extra.is_enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Claude extra usage enabled flag was not a boolean.");
  }
  if (enabled === false) {
    report.notes = ["Claude extra usage is disabled."];
    return report;
  }

  const currency = extra.currency;
  if (
    currency !== undefined &&
    (typeof currency !== "string" || currency.length !== 3 || !/^[A-Z]{3}$/u.test(currency))
  ) {
    throw new Error("Claude extra usage currency was not an uppercase three-letter code.");
  }
  const decimalPlaces = extra.decimal_places;
  if (
    decimalPlaces !== undefined &&
    (typeof decimalPlaces !== "number" || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6)
  ) {
    throw new Error("Claude extra usage decimal places must be an integer from 0 through 6.");
  }
  const used = extra.used_credits;
  if (
    used !== undefined &&
    (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Claude extra usage used credits amount was invalid.");
  }
  const limit = extra.monthly_limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Claude extra usage monthly limit amount was invalid.");
  }

  if (enabled === undefined || currency === undefined || decimalPlaces === undefined) {
    report.notes = [UNAVAILABLE_NOTE];
    return report;
  }
  const { values, overLimit } = moneyValues(used, limit, decimalPlaces);
  for (const [index, [id, label]] of METRICS.entries()) {
    const value = values[index];
    if (value !== undefined) report.metrics.push({ id, label, value, unit: "currency", currency });
  }
  if (used === undefined || limit === undefined) report.notes = [UNAVAILABLE_NOTE];
  if (overLimit) report.notes = ["Claude extra usage exceeds the monthly limit."];
  return report;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function moneyValues(
  used: number | undefined,
  limit: number | undefined,
  decimalPlaces: number,
): { values: (string | undefined)[]; overLimit: boolean } {
  // Shift decimal text and subtract integer coefficients to retain fractional minor units.
  const amounts = [used, limit].map((value) => {
    if (value === undefined) return undefined;
    const [significand, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = significand.split(".");
    return {
      coefficient: BigInt(whole + fraction),
      places: decimalPlaces + fraction.length - Number(exponent),
    };
  });
  const [usedAmount, limitAmount] = amounts;
  let overLimit = false;
  if (usedAmount && limitAmount) {
    const places = Math.max(usedAmount.places, limitAmount.places);
    const difference =
      limitAmount.coefficient * 10n ** BigInt(places - limitAmount.places) -
      usedAmount.coefficient * 10n ** BigInt(places - usedAmount.places);
    overLimit = difference < 0n;
    amounts.push({ coefficient: overLimit ? 0n : difference, places });
  }
  const values = amounts.map((amount) => {
    if (!amount) return undefined;
    const digits = amount.coefficient.toString().padStart(amount.places + 1, "0");
    return amount.places === 0 ? digits : `${digits.slice(0, -amount.places)}.${digits.slice(-amount.places)}`;
  });
  return { values, overLimit };
}
