import assert from "node:assert/strict";
import { test } from "vitest";
import { type AnthropicUsagePayload, normalizeAnthropicUsagePayload } from "../src/providers/anthropic.js";

const CAPTURED_AT = 1_234_567_890;
const UNAVAILABLE_NOTE = "Claude extra usage is unavailable.";
const OVER_LIMIT_NOTE = "Claude extra usage exceeds the monthly limit.";
const VALID_EXTRA_USAGE = Object.freeze({
  is_enabled: true,
  monthly_limit: 10000,
  used_credits: 8000.0,
  utilization: 80,
  currency: "USD",
  decimal_places: 2,
});

test("Anthropic extra usage normalizes the issue fixture without counting duplicate spend or plan windows", () => {
  const payload = Object.freeze({
    five_hour: null,
    seven_day: null,
    extra_usage: {
      ...VALID_EXTRA_USAGE,
      disabled_reason: null,
      user_disabled: false,
      spend_limit_reached: false,
      credits_ever_enabled: true,
      daily: null,
      weekly: null,
    },
    limits: [],
    spend: {
      used: { amount_minor: 8000, currency: "USD", exponent: 2 },
      limit: { amount_minor: 10000, currency: "USD", exponent: 2 },
      percent: 80,
      severity: "warning",
      enabled: true,
    },
  });

  assert.deepEqual(normalizeAnthropicUsagePayload(payload, CAPTURED_AT), {
    providerId: "anthropic",
    providerName: "Anthropic",
    capturedAt: CAPTURED_AT,
    source: "anthropic-extra-usage",
    semantics: { kind: "consumer-subscription", label: "Claude extra-usage spending limit" },
    buckets: [],
    metrics: [
      { id: "extra-usage-used", label: "Used this month", value: "80.00", unit: "currency", currency: "USD" },
      { id: "extra-usage-limit", label: "Monthly limit", value: "100.00", unit: "currency", currency: "USD" },
      { id: "extra-usage-remaining", label: "Remaining", value: "20.00", unit: "currency", currency: "USD" },
    ],
  });
});

test.each([
  { name: "scale zero", used: 80, limit: 100, scale: 0, expected: ["80", "100", "20"] },
  { name: "scale one", used: 80, limit: 100, scale: 1, expected: ["8.0", "10.0", "2.0"] },
  { name: "scale two", used: 80, limit: 100, scale: 2, expected: ["0.80", "1.00", "0.20"] },
  { name: "scale three", used: 80, limit: 100, scale: 3, expected: ["0.080", "0.100", "0.020"] },
  { name: "scale four", used: 80, limit: 100, scale: 4, expected: ["0.0080", "0.0100", "0.0020"] },
  { name: "scale five", used: 80, limit: 100, scale: 5, expected: ["0.00080", "0.00100", "0.00020"] },
  { name: "scale six", used: 80, limit: 100, scale: 6, expected: ["0.000080", "0.000100", "0.000020"] },
  { name: "fractional minor units", used: 2.5, limit: 10, scale: 2, expected: ["0.025", "0.10", "0.075"] },
  { name: "decimal subtraction", used: 0.1, limit: 0.3, scale: 2, expected: ["0.001", "0.003", "0.002"] },
  { name: "fractional scale zero", used: 0.1, limit: 0.3, scale: 0, expected: ["0.1", "0.3", "0.2"] },
  {
    name: "exponent notation",
    used: 1e-7,
    limit: 3e-7,
    scale: 2,
    expected: ["0.000000001", "0.000000003", "0.000000002"],
  },
  {
    name: "smallest finite amounts",
    used: Number.MIN_VALUE,
    limit: 1e-323,
    scale: 6,
    expected: [`0.${"0".repeat(329)}5`, `0.${"0".repeat(328)}1`, `0.${"0".repeat(329)}5`],
  },
  {
    name: "largest safe amounts",
    used: Number.MAX_SAFE_INTEGER - 1,
    limit: Number.MAX_SAFE_INTEGER,
    scale: 6,
    expected: ["9007199254.740990", "9007199254.740991", "0.000001"],
  },
  { name: "zero usage", used: 0, limit: 10000, scale: 2, expected: ["0.00", "100.00", "100.00"] },
  { name: "real zero limit", used: 0, limit: 0, scale: 2, expected: ["0.00", "0.00", "0.00"] },
  { name: "negative zero", used: -0, limit: -0, scale: 2, expected: ["0.00", "0.00", "0.00"] },
  { name: "exhausted limit", used: 10000, limit: 10000, scale: 2, expected: ["100.00", "100.00", "0.00"] },
])("Anthropic extra usage preserves exact decimal amounts: $name", ({ used, limit, scale, expected }) => {
  const report = normalizeAnthropicUsagePayload(
    { extra_usage: { ...VALID_EXTRA_USAGE, used_credits: used, monthly_limit: limit, decimal_places: scale } },
    CAPTURED_AT,
  );
  assert.deepEqual(
    report.metrics.map((metric) => metric.value),
    expected,
  );
  assert.ok(report.metrics.every((metric) => metric.unit === "currency" && metric.currency === "USD"));
  assert.deepEqual(report.buckets, []);
  assert.equal(report.notes, undefined);
});

test.each([
  { name: "over limit", used: 10001, limit: 10000, expected: ["100.01", "100.00", "0.00"] },
  { name: "over zero limit", used: 1, limit: 0, expected: ["0.01", "0.00", "0.00"] },
  { name: "fractional overage", used: 0.3, limit: 0.1, expected: ["0.003", "0.001", "0.000"] },
])("Anthropic extra usage keeps usage visible and clamps remaining: $name", ({ used, limit, expected }) => {
  const report = normalizeAnthropicUsagePayload(
    { extra_usage: { ...VALID_EXTRA_USAGE, used_credits: used, monthly_limit: limit } },
    CAPTURED_AT,
  );
  assert.deepEqual(
    report.metrics.map((metric) => metric.value),
    expected,
  );
  assert.deepEqual(report.notes, [OVER_LIMIT_NOTE]);
});

test.each(["USD", "EUR", "JPY", "KWD", "ZZZ"])(
  "Anthropic extra usage keeps explicit currency %s and does not infer its scale",
  (currency) => {
    const report = normalizeAnthropicUsagePayload({ extra_usage: { ...VALID_EXTRA_USAGE, currency } }, CAPTURED_AT);
    assert.deepEqual(
      report.metrics.map((metric) => metric.value),
      ["80.00", "100.00", "20.00"],
    );
    assert.ok(report.metrics.every((metric) => metric.unit === "currency" && metric.currency === currency));
  },
);

test.each([
  { name: "missing extra_usage", payload: {} },
  { name: "undefined extra_usage", payload: { extra_usage: undefined } },
  { name: "null extra_usage", payload: { extra_usage: null } },
  {
    name: "only alternate spend and plan data",
    payload: { spend: VALID_EXTRA_USAGE, five_hour: { utilization: 80 }, seven_day: { utilization: 80 } },
  },
])("Anthropic extra usage stays unavailable for $name", ({ payload }) => {
  const report = normalizeAnthropicUsagePayload(payload as AnthropicUsagePayload, CAPTURED_AT);
  assert.deepEqual(report.metrics, []);
  assert.deepEqual(report.buckets, []);
  assert.deepEqual(report.notes, [UNAVAILABLE_NOTE]);
});

test.each([
  { name: "only the disabled flag", extra: { is_enabled: false } },
  { name: "valid monetary fields", extra: { ...VALID_EXTRA_USAGE, is_enabled: false } },
  {
    name: "unused malformed monetary fields and a hostile disabled reason",
    extra: {
      is_enabled: false,
      monthly_limit: "unlimited",
      used_credits: Number.NaN,
      currency: "USD\u001b[31m",
      decimal_places: -1,
      disabled_reason: "must-not-reflect\u001b[2J\r\n",
    },
  },
])("Anthropic extra usage reports disabled without monetary metrics: $name", ({ extra }) => {
  const report = normalizeAnthropicUsagePayload({ extra_usage: extra }, CAPTURED_AT);
  assert.deepEqual(report.metrics, []);
  assert.deepEqual(report.buckets, []);
  assert.deepEqual(report.notes, ["Claude extra usage is disabled."]);
  assert.doesNotMatch(JSON.stringify(report), /must-not-reflect|unlimited/u);
});

test.each([
  { name: "empty object", extra: {}, expected: [] },
  { name: "only enabled flag", extra: { is_enabled: true }, expected: [] },
  {
    name: "absent enabled flag",
    extra: { used_credits: 8000, monthly_limit: 10000, currency: "USD", decimal_places: 2 },
    expected: [],
  },
  { name: "undefined enabled flag", extra: { ...VALID_EXTRA_USAGE, is_enabled: undefined }, expected: [] },
  {
    name: "absent currency",
    extra: { is_enabled: true, used_credits: 8000, monthly_limit: 10000, decimal_places: 2 },
    expected: [],
  },
  { name: "undefined currency", extra: { ...VALID_EXTRA_USAGE, currency: undefined }, expected: [] },
  {
    name: "absent scale",
    extra: { is_enabled: true, used_credits: 8000, monthly_limit: 10000, currency: "USD" },
    expected: [],
  },
  { name: "undefined scale", extra: { ...VALID_EXTRA_USAGE, decimal_places: undefined }, expected: [] },
  {
    name: "missing currency and scale",
    extra: { is_enabled: true, used_credits: 8000, monthly_limit: 10000 },
    expected: [],
  },
  {
    name: "absent used counter despite utilization",
    extra: { is_enabled: true, monthly_limit: 10000, utilization: 80, currency: "USD", decimal_places: 2 },
    expected: [["extra-usage-limit", "100.00"]],
  },
  {
    name: "undefined used counter",
    extra: { ...VALID_EXTRA_USAGE, used_credits: undefined },
    expected: [["extra-usage-limit", "100.00"]],
  },
  {
    name: "absent limit counter",
    extra: { is_enabled: true, used_credits: 8000, currency: "USD", decimal_places: 2 },
    expected: [["extra-usage-used", "80.00"]],
  },
  {
    name: "undefined limit counter",
    extra: { ...VALID_EXTRA_USAGE, monthly_limit: undefined },
    expected: [["extra-usage-used", "80.00"]],
  },
  {
    name: "both absent counters",
    extra: { is_enabled: true, currency: "USD", decimal_places: 2 },
    expected: [],
  },
  {
    name: "zero limit with absent usage",
    extra: { is_enabled: true, monthly_limit: 0, currency: "USD", decimal_places: 2 },
    expected: [["extra-usage-limit", "0.00"]],
  },
  {
    name: "zero usage with absent limit",
    extra: { is_enabled: true, used_credits: 0, currency: "USD", decimal_places: 2 },
    expected: [["extra-usage-used", "0.00"]],
  },
  {
    name: "alternate nested spend schema",
    extra: { is_enabled: true, monthly_spend: 8000, spend_limit: 10000, currency: "USD", decimal_places: 2 },
    expected: [],
  },
])("Anthropic extra usage does not invent missing values: $name", ({ extra, expected }) => {
  const payload = { extra_usage: extra, currency: "USD", decimal_places: 2, spend: VALID_EXTRA_USAGE };
  const report = normalizeAnthropicUsagePayload(payload, CAPTURED_AT);
  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    expected,
  );
  assert.ok(report.metrics.every((metric) => metric.unit === "currency" && metric.currency === "USD"));
  assert.deepEqual(report.buckets, []);
  assert.deepEqual(report.notes, [UNAVAILABLE_NOTE]);
});

const INVALID_AMOUNTS: [string, unknown][] = [
  ["null", null],
  ["numeric string", "8000"],
  ["exponent string", "8e3"],
  ["unlimited string", "unlimited"],
  ["hostile string", "must-not-reflect\u001b[31m\n"],
  ["negative number", -1],
  ["negative fraction", -Number.MIN_VALUE],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["unsafe number", Number.MAX_SAFE_INTEGER + 1],
  ["large exponent", 1e100],
  ["boolean", false],
  ["bigint", 8000n],
  ["object", {}],
  ["array", []],
];

test.each(
  INVALID_AMOUNTS.flatMap(([name, value]) =>
    (["used_credits", "monthly_limit"] as const).map((field) => ({ name, value, field })),
  ),
)("Anthropic extra usage rejects present $name in $field", ({ value, field }) => {
  const payload = { extra_usage: { ...VALID_EXTRA_USAGE, [field]: value } };
  assert.throws(() => normalizeAnthropicUsagePayload(payload, CAPTURED_AT), {
    name: "Error",
    message:
      field === "used_credits"
        ? "Claude extra usage used credits amount was invalid."
        : "Claude extra usage monthly limit amount was invalid.",
  });
});

test.each([
  { name: "null", value: null },
  { name: "negative", value: -1 },
  { name: "above bound", value: 7 },
  { name: "fractional", value: 2.5 },
  { name: "numeric string", value: "2" },
  { name: "hostile string", value: "must-not-reflect\u001b[2J" },
  { name: "NaN", value: Number.NaN },
  { name: "infinity", value: Number.POSITIVE_INFINITY },
  { name: "boolean", value: true },
  { name: "object", value: {} },
  { name: "array", value: [] },
])("Anthropic extra usage rejects present invalid scale: $name", ({ value }) => {
  const payload = { extra_usage: { ...VALID_EXTRA_USAGE, decimal_places: value } };
  assert.throws(() => normalizeAnthropicUsagePayload(payload, CAPTURED_AT), {
    name: "Error",
    message: "Claude extra usage decimal places must be an integer from 0 through 6.",
  });
});

test.each([
  { name: "null", value: null },
  { name: "empty", value: "" },
  { name: "lowercase", value: "usd" },
  { name: "mixed case", value: "Usd" },
  { name: "short", value: "US" },
  { name: "long", value: "USDD" },
  { name: "leading space", value: " USD" },
  { name: "trailing space", value: "USD " },
  { name: "trailing newline", value: "USD\n" },
  { name: "terminal controls", value: "USD\u001b[31m" },
  { name: "Unicode lookalike", value: "UＳD" },
  { name: "number", value: 840 },
  { name: "boolean", value: true },
  { name: "object", value: {} },
  { name: "array", value: ["USD"] },
])("Anthropic extra usage rejects present invalid currency: $name", ({ value }) => {
  const payload = { extra_usage: { ...VALID_EXTRA_USAGE, currency: value } };
  assert.throws(() => normalizeAnthropicUsagePayload(payload, CAPTURED_AT), {
    name: "Error",
    message: "Claude extra usage currency was not an uppercase three-letter code.",
  });
});

test.each([
  { name: "null", value: null },
  { name: "zero", value: 0 },
  { name: "one", value: 1 },
  { name: "true string", value: "true" },
  { name: "false string", value: "false" },
  { name: "hostile string", value: "must-not-reflect\u001b[2J" },
  { name: "NaN", value: Number.NaN },
  { name: "object", value: {} },
  { name: "array", value: [] },
])("Anthropic extra usage rejects present invalid enabled flag: $name", ({ value }) => {
  const payload = { extra_usage: { ...VALID_EXTRA_USAGE, is_enabled: value } };
  assert.throws(() => normalizeAnthropicUsagePayload(payload, CAPTURED_AT), {
    name: "Error",
    message: "Claude extra usage enabled flag was not a boolean.",
  });
});

test.each([
  { name: "null root", payload: null, message: "Claude usage response was not an object." },
  { name: "undefined root", payload: undefined, message: "Claude usage response was not an object." },
  { name: "array root", payload: [], message: "Claude usage response was not an object." },
  { name: "number root", payload: 0, message: "Claude usage response was not an object." },
  { name: "string root", payload: "must-not-reflect\u001b[2J", message: "Claude usage response was not an object." },
  { name: "date root", payload: new Date(0), message: "Claude usage response was not an object." },
  { name: "array extra usage", payload: { extra_usage: [] }, message: "Claude extra usage was not an object." },
  { name: "boolean extra usage", payload: { extra_usage: false }, message: "Claude extra usage was not an object." },
  { name: "number extra usage", payload: { extra_usage: 0 }, message: "Claude extra usage was not an object." },
  {
    name: "string extra usage",
    payload: { extra_usage: "must-not-reflect\u001b[2J" },
    message: "Claude extra usage was not an object.",
  },
  { name: "date extra usage", payload: { extra_usage: new Date(0) }, message: "Claude extra usage was not an object." },
  {
    name: "inherited extra usage fields",
    payload: { extra_usage: Object.create(VALID_EXTRA_USAGE) },
    message: "Claude extra usage was not an object.",
  },
])("Anthropic extra usage rejects malformed object shape: $name", ({ payload, message }) => {
  assert.throws(() => normalizeAnthropicUsagePayload(payload as AnthropicUsagePayload, CAPTURED_AT), {
    name: "Error",
    message,
  });
});

test.each([
  {
    name: "used credits without metadata",
    extra: { is_enabled: true, used_credits: "must-not-reflect\u001b[2J" },
    message: "Claude extra usage used credits amount was invalid.",
  },
  {
    name: "monthly limit without metadata",
    extra: { is_enabled: true, monthly_limit: null },
    message: "Claude extra usage monthly limit amount was invalid.",
  },
  {
    name: "currency without scale or counters",
    extra: { is_enabled: true, currency: null },
    message: "Claude extra usage currency was not an uppercase three-letter code.",
  },
  {
    name: "scale without currency or counters",
    extra: { is_enabled: true, decimal_places: null },
    message: "Claude extra usage decimal places must be an integer from 0 through 6.",
  },
  {
    name: "used credits without an enabled flag",
    extra: { used_credits: -1 },
    message: "Claude extra usage used credits amount was invalid.",
  },
])("Anthropic extra usage validates present $name even when required fields are missing", ({ extra, message }) => {
  assert.throws(() => normalizeAnthropicUsagePayload({ extra_usage: extra }, CAPTURED_AT), {
    name: "Error",
    message,
  });
});

test("Anthropic extra usage ignores hostile unknown fields without changing the input or reflecting their contents", () => {
  const raw = "must-not-reflect\u001b[2J\r\n";
  const extra = Object.freeze({
    ...VALID_EXTRA_USAGE,
    utilization: raw,
    resets_at: raw,
    reset_at: raw,
    disabled_reason: raw,
    spend: { used_credits: -1, monthly_limit: "unlimited" },
  });
  const payload = Object.freeze({
    extra_usage: extra,
    spend: raw,
    monthly_limit: -1,
    used_credits: -1,
    currency: raw,
    decimal_places: -1,
    five_hour: raw,
    seven_day: raw,
    resets_at: raw,
  });
  const before = JSON.stringify(payload);
  const report = normalizeAnthropicUsagePayload(payload, CAPTURED_AT);
  assert.deepEqual(report, normalizeAnthropicUsagePayload({ extra_usage: VALID_EXTRA_USAGE }, CAPTURED_AT));
  assert.equal(JSON.stringify(payload), before);
  assert.doesNotMatch(JSON.stringify(report), /must-not-reflect|unlimited/u);
});

test("Anthropic extra usage accepts plain objects with null prototypes", () => {
  const extra = Object.assign(Object.create(null), VALID_EXTRA_USAGE);
  const payload = Object.assign(Object.create(null), { extra_usage: extra });
  assert.deepEqual(
    normalizeAnthropicUsagePayload(payload, CAPTURED_AT),
    normalizeAnthropicUsagePayload({ extra_usage: VALID_EXTRA_USAGE }, CAPTURED_AT),
  );
});
