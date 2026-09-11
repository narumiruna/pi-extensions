import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalizeLocale,
  canonicalizeTimeZone,
  DEFAULT_STAMP_SETTINGS,
  formatExactTimelineLine,
  formatMessageStampLabel,
  formatResponseElapsed,
  formatStampLabel,
  RESPONSE_TIMING_MODES,
} from "../src/format.js";

const BEFORE_MIDNIGHT_UTC = Date.UTC(2026, 6, 29, 23, 59, 58);
const AFTER_MIDNIGHT_UTC = Date.UTC(2026, 6, 30, 0, 1, 2);
const UTC_ENV = { localTimeZone: "UTC" } as const;

test("formatStampLabel preserves the invariant Phase 1 default", () => {
  assert.equal(formatStampLabel(AFTER_MIDNIGHT_UTC, undefined, DEFAULT_STAMP_SETTINGS, UTC_ENV), "00:01:02");
  assert.equal(
    formatStampLabel(AFTER_MIDNIGHT_UTC, BEFORE_MIDNIGHT_UTC, DEFAULT_STAMP_SETTINGS, UTC_ENV),
    "2026-07-30 · 00:01:02",
  );
});

test("formatStampLabel supports hour cycle, seconds, and date context", () => {
  assert.equal(
    formatStampLabel(
      AFTER_MIDNIGHT_UTC,
      undefined,
      {
        ...DEFAULT_STAMP_SETTINGS,
        hourCycle: "12h",
        showSeconds: false,
      },
      UTC_ENV,
    ),
    "12:01 AM",
  );
  assert.equal(
    formatStampLabel(
      AFTER_MIDNIGHT_UTC,
      undefined,
      {
        ...DEFAULT_STAMP_SETTINGS,
        dateContext: "always",
      },
      UTC_ENV,
    ),
    "2026-07-30 · 00:01:02",
  );
  assert.equal(
    formatStampLabel(
      AFTER_MIDNIGHT_UTC,
      BEFORE_MIDNIGHT_UTC,
      {
        ...DEFAULT_STAMP_SETTINGS,
        dateContext: "never",
      },
      UTC_ENV,
    ),
    "00:01:02",
  );
});

test("day changes use the selected time zone rather than elapsed duration", () => {
  const taipei = { ...DEFAULT_STAMP_SETTINGS, timeZone: "Asia/Taipei" } as const;
  assert.equal(formatStampLabel(AFTER_MIDNIGHT_UTC, BEFORE_MIDNIGHT_UTC, taipei), "08:01:02");

  const losAngeles = { ...DEFAULT_STAMP_SETTINGS, timeZone: "America/Los_Angeles" } as const;
  assert.equal(formatStampLabel(AFTER_MIDNIGHT_UTC, BEFORE_MIDNIGHT_UTC, losAngeles), "17:01:02");

  const dateLineBefore = Date.UTC(2026, 6, 29, 9, 59, 58);
  const dateLineAfter = Date.UTC(2026, 6, 29, 10, 0, 2);
  const kiritimati = { ...DEFAULT_STAMP_SETTINGS, timeZone: "Pacific/Kiritimati" } as const;
  assert.equal(formatStampLabel(dateLineAfter, dateLineBefore, kiritimati), "2026-07-30 · 00:00:02");
});

test("system and explicit locales use Intl formatting with bounded semantic options", () => {
  const settings = {
    ...DEFAULT_STAMP_SETTINGS,
    hourCycle: "12h" as const,
    locale: "system",
    timeZone: "UTC",
  };
  assert.equal(formatStampLabel(AFTER_MIDNIGHT_UTC, undefined, settings, { systemLocale: "en-US" }), "12:01:02 AM");
  const localized = formatStampLabel(
    AFTER_MIDNIGHT_UTC,
    undefined,
    { ...settings, locale: "fr-FR", dateContext: "always" },
    { systemLocale: "en-US" },
  );
  assert.ok(localized);
  assert.match(localized, /2026.*12:01:02\sAM/u);
});

test("locale and time-zone values canonicalize or reject exactly", () => {
  assert.equal(canonicalizeLocale("invariant"), "invariant");
  assert.equal(canonicalizeLocale("system"), "system");
  assert.equal(canonicalizeLocale("EN-us"), "en-US");
  assert.equal(canonicalizeLocale("not_a_locale"), undefined);
  assert.equal(canonicalizeTimeZone("local"), "local");
  assert.equal(canonicalizeTimeZone("utc"), "UTC");
  assert.equal(canonicalizeTimeZone("Asia/Taipei"), "Asia/Taipei");
  assert.equal(canonicalizeTimeZone("Moon/Base"), undefined);
});

test("formatStampLabel rejects invalid timestamps", () => {
  assert.equal(formatStampLabel(Number.NaN, undefined, DEFAULT_STAMP_SETTINGS, UTC_ENV), undefined);
  assert.equal(formatStampLabel(Number.POSITIVE_INFINITY, undefined, DEFAULT_STAMP_SETTINGS, UTC_ENV), undefined);
  assert.equal(formatStampLabel(10 ** 20, undefined, DEFAULT_STAMP_SETTINGS, UTC_ENV), undefined);
});

test("response timing modes preserve the default and compose with date context", () => {
  assert.deepEqual(RESPONSE_TIMING_MODES, ["off", "duration", "detailed"]);
  const input = {
    timestamp: AFTER_MIDNIGHT_UTC,
    previousTimestamp: BEFORE_MIDNIGHT_UTC,
    completedAt: AFTER_MIDNIGHT_UTC + 3_200,
    firstContentAt: AFTER_MIDNIGHT_UTC + 800,
  };
  assert.equal(formatMessageStampLabel(input, DEFAULT_STAMP_SETTINGS, UTC_ENV), "2026-07-30 · 00:01:02");
  assert.equal(
    formatMessageStampLabel(input, { ...DEFAULT_STAMP_SETTINGS, responseTiming: "duration" }, UTC_ENV),
    "2026-07-30 · 00:01:02 · 3.2s",
  );
  assert.equal(
    formatMessageStampLabel(input, { ...DEFAULT_STAMP_SETTINGS, responseTiming: "detailed" }, UTC_ENV),
    "2026-07-30 · 00:01:02 · first 0.8s · total 3.2s",
  );
});

test("response timing labels unavailable first content without fabricating legacy timing", () => {
  const detailed = { ...DEFAULT_STAMP_SETTINGS, responseTiming: "detailed" } as const;
  assert.equal(
    formatMessageStampLabel(
      { timestamp: AFTER_MIDNIGHT_UTC, completedAt: AFTER_MIDNIGHT_UTC + 1_500 },
      detailed,
      UTC_ENV,
    ),
    "00:01:02 · first n/a · total 1.5s",
  );
  assert.equal(formatMessageStampLabel({ timestamp: AFTER_MIDNIGHT_UTC }, detailed, UTC_ENV), "00:01:02");
  assert.equal(
    formatMessageStampLabel(
      {
        timestamp: AFTER_MIDNIGHT_UTC,
        completedAt: AFTER_MIDNIGHT_UTC + 1_500,
        firstContentAt: AFTER_MIDNIGHT_UTC - 1,
      },
      detailed,
      UTC_ENV,
    ),
    "00:01:02 · first n/a · total 1.5s",
  );
});

test("exact timeline formatting preserves UTC milliseconds and rejects invalid values", () => {
  const timestamp = Date.UTC(2026, 6, 30, 0, 1, 2, 345);
  assert.equal(
    formatExactTimelineLine("created", timestamp),
    `timeline · created 2026-07-30T00:01:02.345Z · unix-ms ${timestamp}`,
  );
  assert.equal(formatExactTimelineLine("completed", Number.NaN), undefined);
  assert.equal(formatExactTimelineLine("created", Number.POSITIVE_INFINITY), undefined);
  assert.equal(formatExactTimelineLine("future" as never, timestamp), undefined);
});

test("response elapsed formatting is exact at boundaries and rejects invalid values", () => {
  assert.equal(formatResponseElapsed(0), "0.0s");
  assert.equal(formatResponseElapsed(1), "<0.1s");
  assert.equal(formatResponseElapsed(99), "<0.1s");
  assert.equal(formatResponseElapsed(100), "0.1s");
  assert.equal(formatResponseElapsed(3_249), "3.2s");
  assert.equal(formatResponseElapsed(3_250), "3.3s");
  assert.equal(formatResponseElapsed(-1), undefined);
  assert.equal(formatResponseElapsed(Number.NaN), undefined);
  assert.equal(formatResponseElapsed(Number.POSITIVE_INFINITY), undefined);
});
