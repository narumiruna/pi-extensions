import { sanitizeDisplayText } from "../core.js";
import type {
  FireworksAccountsPayload,
  FireworksBillingSummaryPayload,
  ResolvedUsageAuth,
  UsageMetric,
  UsageProviderAdapter,
  UsageReport,
} from "../types.js";

const NANOS_PER_UNIT = 1_000_000_000n;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const INTEGER_PATTERN = /^-?\d+$/u;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MAX_UNITS_CHARS = 20;
const MAX_NANOS_CHARS = 11;
const FIREWORKS_BILLING_SUMMARY_ORIGIN = "https://api.fireworks.ai";
const FIREWORKS_SPEND_WINDOW_DAYS = 30;
const FIREWORKS_MAX_ACCOUNT_PAGES = 5;

const SERIES_KEYS = ["serverless", "dedicated", "training", "other"] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

const SERIES_LABELS: Readonly<Record<SeriesKey, string>> = {
  serverless: "Serverless",
  dedicated: "Dedicated deployments",
  training: "Training",
  other: "Other",
};

export function isFireworksAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

export function normalizeFireworksAccountsPayload(payload: FireworksAccountsPayload): string[] {
  if (!Array.isArray(payload.accounts)) {
    throw new Error("Fireworks accounts response did not contain an accounts array.");
  }
  const accounts: string[] = [];
  for (const raw of payload.accounts) {
    const account = asObject(raw);
    if (!account) throw new Error("Fireworks accounts response row was not an object.");
    if (typeof account.name !== "string") {
      throw new Error("Fireworks accounts response omitted the account resource name.");
    }
    const match = /^accounts\/([^/]+)$/u.exec(account.name);
    if (!match || !isFireworksAccountId(match[1])) {
      throw new Error("Fireworks accounts response returned an unsafe account resource name.");
    }
    const accountId = match[1];
    if (accounts.includes(accountId)) {
      throw new Error(`Fireworks accounts response repeated ${accountId}.`);
    }
    accounts.push(accountId);
  }
  return accounts;
}

type FetchProviderJson = (
  url: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
  request?: { redirect?: RequestRedirect },
) => Promise<Record<string, unknown>>;

export function createFireworksAdapter(fetchProviderJson: FetchProviderJson): UsageProviderAdapter {
  return {
    id: "fireworks",
    displayName: "Fireworks",
    semantics: { kind: "api-key", label: "Fireworks API spend" },
    targets: {
      singularLabel: "account",
      pluralLabel: "accounts",
      async list(auth, signal, timeoutMs, guard) {
        const startedAt = Date.now();
        const accounts: string[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < FIREWORKS_MAX_ACCOUNT_PAGES; page += 1) {
          await guard();
          const payload = (await fetchProviderJson(
            fireworksAccountsUrl(pageToken),
            auth,
            signal,
            remainingTimeout(timeoutMs, startedAt, "fetching Fireworks accounts"),
            "Fireworks accounts endpoint",
            { redirect: "error" },
          )) as FireworksAccountsPayload;
          await guard();
          for (const accountId of normalizeFireworksAccountsPayload(payload)) {
            if (accounts.includes(accountId)) {
              throw new Error(`Fireworks accounts listing repeated ${accountId}.`);
            }
            accounts.push(accountId);
          }
          pageToken = fireworksNextPageToken(payload.nextPageToken);
          if (!pageToken) break;
        }
        if (pageToken) {
          throw new Error(`Fireworks account listing exceeded ${FIREWORKS_MAX_ACCOUNT_PAGES} pages.`);
        }
        return accounts.map((id) => ({ id, label: id }));
      },
    },
    async query(auth, signal, timeoutMs, guard, targetId) {
      if (!guard) throw new Error("Fireworks API spend requires request-boundary revalidation.");
      if (!isFireworksAccountId(targetId)) {
        throw new Error("Fireworks billing requires a safe selected account slug.");
      }
      const startedAt = Date.now();
      await guard();
      const billingWindowAt = Date.now();
      const payload = (await fetchProviderJson(
        fireworksBillingSummaryUrl(targetId, billingWindowAt),
        auth,
        signal,
        remainingTimeout(timeoutMs, startedAt, "fetching Fireworks rated spend"),
        "Fireworks billing summary endpoint",
        { redirect: "error" },
      )) as FireworksBillingSummaryPayload;
      await guard();
      return normalizeFireworksBillingSummaryPayload(payload, targetId, Date.now());
    },
  };
}

export function normalizeFireworksBillingSummaryPayload(
  payload: FireworksBillingSummaryPayload,
  accountId: string,
  capturedAt: number,
): UsageReport {
  if (!isFireworksAccountId(accountId)) {
    throw new Error("Fireworks billing summary received an unsafe account identifier.");
  }
  if (payload.lineItems !== undefined && !Array.isArray(payload.lineItems)) {
    throw new Error("Fireworks billing summary lineItems was not an array.");
  }

  const totals = new Map<string, Map<SeriesKey, bigint>>();
  for (const raw of payload.lineItems ?? []) {
    const lineItem = asObject(raw);
    if (!lineItem) throw new Error("Fireworks billing line item was not an object.");
    const cost = moneyAmount(lineItem.totalCost, "line item total cost");
    const series = seriesKey(lineItem.series);
    let amounts = totals.get(cost.currency);
    if (!amounts) {
      amounts = new Map<SeriesKey, bigint>();
      totals.set(cost.currency, amounts);
    }
    amounts.set(series, (amounts.get(series) ?? 0n) + cost.amount);
  }

  const metrics: UsageMetric[] = [];
  for (const [currency, amounts] of totals) {
    metrics.push({
      id: `${currency.toLowerCase()}-total`,
      label: "Total spend",
      value: formatMoneyAmount(sumSeries(amounts)),
      unit: "currency",
      currency,
    });
    for (const series of SERIES_KEYS) {
      const amount = amounts.get(series);
      if (amount === undefined) continue;
      metrics.push({
        id: `${currency.toLowerCase()}-${series}`,
        label: SERIES_LABELS[series],
        value: formatMoneyAmount(amount),
        unit: "currency",
        currency,
      });
    }
  }

  const notes = ["Rated line items may differ from the final invoice once credits or adjustments are applied."];
  if (metrics.length === 0) {
    notes.push("Fireworks returned no rated line items for the last 30 days.");
  }

  return {
    providerId: "fireworks",
    providerName: "Fireworks",
    capturedAt,
    source: "fireworks-billing-summary",
    semantics: { kind: "api-key", label: "Fireworks API spend" },
    accountLabel: sanitizeDisplayText(accountId, 80),
    buckets: [],
    metrics,
    notes,
  };
}

type RatedMoney = { currency: string; amount: bigint };

function moneyAmount(value: unknown, description: string): RatedMoney {
  const money = asObject(value);
  if (!money) throw new Error(`Fireworks billing ${description} was not a money object.`);
  const currency = typeof money.currencyCode === "string" ? money.currencyCode : undefined;
  if (!currency || !CURRENCY_PATTERN.test(currency)) {
    throw new Error(`Fireworks billing ${description} currency was not an ISO 4217 code.`);
  }
  // proto3 JSON omits zero-valued money fields, so absent components default to zero.
  const units =
    money.units === undefined ? 0n : integerComponent(money.units, description, "whole units", MAX_UNITS_CHARS);
  if (units < INT64_MIN || units > INT64_MAX) {
    throw new Error(`Fireworks billing ${description} whole units exceeded the int64 range.`);
  }
  const nanos =
    money.nanos === undefined ? 0n : integerComponent(money.nanos, description, "nano units", MAX_NANOS_CHARS);
  if (nanos <= -NANOS_PER_UNIT || nanos >= NANOS_PER_UNIT) {
    throw new Error(`Fireworks billing ${description} nano units exceeded the Money range.`);
  }
  if ((units > 0n && nanos < 0n) || (units < 0n && nanos > 0n)) {
    throw new Error(`Fireworks billing ${description} mixed unit and nano signs.`);
  }
  return { currency, amount: units * NANOS_PER_UNIT + nanos };
}

function integerComponent(value: unknown, description: string, component: string, maxChars: number): bigint {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string" && INTEGER_PATTERN.test(value)
        ? value
        : undefined;
  if (text === undefined || text.length > maxChars) {
    throw new Error(`Fireworks billing ${description} ${component} was not a bounded integer.`);
  }
  return BigInt(text);
}

function seriesKey(value: unknown): SeriesKey {
  if (value === undefined || value === null) return "other";
  if (typeof value !== "string") throw new Error("Fireworks billing line item series was invalid.");
  if (value === "SERVERLESS") return "serverless";
  if (value === "DEDICATED_DEPLOYMENT") return "dedicated";
  if (value === "TRAINING") return "training";
  return "other";
}

function sumSeries(amounts: ReadonlyMap<SeriesKey, bigint>): bigint {
  let total = 0n;
  for (const amount of amounts.values()) total += amount;
  return total;
}

function formatMoneyAmount(amount: bigint): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const units = magnitude / NANOS_PER_UNIT;
  const nanos = (magnitude % NANOS_PER_UNIT).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${units.toString()}${nanos ? `.${nanos}` : ""}`;
}

function fireworksAccountsUrl(pageToken: string | undefined): string {
  const url = new URL("/v1/accounts", FIREWORKS_BILLING_SUMMARY_ORIGIN);
  url.searchParams.set("pageSize", "200");
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

function fireworksNextPageToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new Error("Fireworks accounts listing returned an invalid page token.");
  }
  return value;
}

function fireworksBillingSummaryUrl(accountId: string, startedAt: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const dayFloor = (time: number) => `${new Date(time).toISOString().slice(0, 10)}T00:00:00Z`;
  const url = new URL(`/v1/accounts/${accountId}/billing/summary`, FIREWORKS_BILLING_SUMMARY_ORIGIN);
  url.searchParams.set("startTime", dayFloor(startedAt - (FIREWORKS_SPEND_WINDOW_DAYS - 1) * dayMs));
  url.searchParams.set("endTime", dayFloor(startedAt + dayMs));
  return url.toString();
}

function remainingTimeout(timeoutMs: number, startedAt: number, description: string): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error(`Timed out while ${description}.`);
  return remaining;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
