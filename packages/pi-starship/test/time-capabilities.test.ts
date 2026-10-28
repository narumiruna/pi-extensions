import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { renderStatusline } from "../src/modules/render.js";
import { formatClockTime, isInsideTimeRange, validTimeFormat } from "../src/modules/time-format.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";

function fixture(now: Date): StarshipRuntimeSnapshot {
  return {
    cwd: "/workspace",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now,
  };
}

function render(now: Date, options: Record<string, unknown> = {}): string {
  const { config, diagnostics } = normalizeConfig({ format: "$time", time: { format: "$time", ...options } });
  assert.deepEqual(diagnostics, []);
  return stripVTControlCharacters(renderStatusline(config, fixture(now)).ansi);
}

test("time preserves the local minutes-only default and existing module format", () => {
  const now = new Date(2026, 0, 1, 9, 5, 49);
  assert.equal(render(now), "09:05");
  const { config } = normalizeConfig({ format: "$time" });
  assert.equal(stripVTControlCharacters(renderStatusline(config, fixture(now)).ansi), "🕒 09:05 ");
});

test("time use_12hr covers midnight, morning, noon, and afternoon without changing precision", () => {
  for (const [hour, expected] of [
    [0, "12:05 AM"],
    [3, "03:05 AM"],
    [12, "12:05 PM"],
    [15, "03:05 PM"],
    [23, "11:05 PM"],
  ] as const) {
    assert.equal(render(new Date(2026, 0, 1, hour, 5, 49), { use_12hr: true }), expected);
  }
});

test("time supports exactly the documented strftime token and composite branches", () => {
  const now = new Date("2014-07-08T15:36:47.123Z");
  assert.equal(
    render(now, {
      use_12hr: true,
      utc_time_offset: "UTC",
      time_format: "%%|%H|%I|%M|%S|%p|%P|%R|%T|%r|%Y|%m|%d|%F|%z|%:z",
    }),
    "%|15|03|36|47|PM|pm|15:36|15:36:47|3:36:47 PM|2014|07|08|2014-07-08|+0000|+00:00",
  );
  for (const [timestamp, expected] of [
    ["2014-07-08T00:00:00Z", "00:00:00/12:00:00 AM"],
    ["2014-07-08T12:00:00Z", "12:00:00/12:00:00 PM"],
  ]) {
    assert.equal(render(new Date(timestamp as string), { utc_time_offset: "0", time_format: "%T/%r" }), expected);
  }
  assert.equal(render(now, { utc_time_offset: "0", time_format: "literal [$time] %%" }), "literal [$time] %");
});

test("time numeric offsets support signs, half/quarter hours, seconds, and midnight rollover", () => {
  const now = new Date("2026-01-01T00:15:00Z");
  for (const [offset, expected] of [
    ["0", "2026-01-01 00:15:00 +00:00"],
    ["+0", "2026-01-01 00:15:00 +00:00"],
    ["-0", "2026-01-01 00:15:00 +00:00"],
    ["5.5", "2026-01-01 05:45:00 +05:30"],
    ["+5.75", "2026-01-01 06:00:00 +05:45"],
    ["-1.75", "2025-12-31 22:30:00 -01:45"],
    ["-23.5", "2025-12-31 00:45:00 -23:30"],
    ["23.5", "2026-01-01 23:45:00 +23:30"],
    ["0.000555", "2026-01-01 00:15:01 +00:00"],
  ]) {
    assert.equal(render(now, { utc_time_offset: offset, time_format: "%F %T %:z" }), expected, offset);
  }
  assert.equal(
    render(new Date("2025-12-31T23:45:00Z"), { utc_time_offset: "5.5", time_format: "%F %T %:z" }),
    "2026-01-01 05:15:00 +05:30",
  );
});

test("time IANA zones cover spring gaps, repeated fall hours, and fixed-offset zone names", () => {
  for (const [timestamp, zone, expected] of [
    ["2026-03-08T06:59:59Z", "America/New_York", "2026-03-08 01:59:59 -05:00"],
    ["2026-03-08T07:00:00Z", "America/New_York", "2026-03-08 03:00:00 -04:00"],
    ["2026-11-01T05:30:00Z", "America/New_York", "2026-11-01 01:30:00 -04:00"],
    ["2026-11-01T06:30:00Z", "America/New_York", "2026-11-01 01:30:00 -05:00"],
    ["2026-01-01T00:15:00Z", "Asia/Kolkata", "2026-01-01 05:45:00 +05:30"],
    ["2026-01-01T00:15:00Z", "Etc/GMT+5", "2025-12-31 19:15:00 -05:00"],
  ]) {
    assert.equal(render(new Date(timestamp as string), { utc_time_offset: zone, time_format: "%F %T %:z" }), expected);
  }
  assert.equal(
    render(new Date("0001-01-01T00:00:00Z"), { utc_time_offset: "UTC", time_format: "%F %:z" }),
    "0001-01-01 +00:00",
  );
});

test("time invalid zones and unsupported numeric syntax fall back to the local clock", () => {
  const now = new Date(2026, 0, 1, 9, 5, 49);
  const time_format = "%F %T %:z";
  const expected = render(now, { time_format, utc_time_offset: "local" });
  for (const offset of [
    "",
    "24",
    "-24",
    "+9001",
    "-4242",
    "NaN",
    "Infinity",
    "1e1",
    ".5",
    "5.",
    "05:30",
    " 5",
    "5 ",
    "0.1234567",
    "utc",
    "GMT",
    "America/Not_A_Zone",
    "Europe/",
    "x".repeat(129),
  ]) {
    assert.equal(render(now, { time_format, utc_time_offset: offset }), expected, offset);
  }
});

test("time invalid, empty, and oversized formats use the configured 12/24-hour fallback", () => {
  const now = new Date(2026, 0, 1, 15, 5, 49);
  for (const format of ["", "%", "%a", "%Z", "%Q", "%-H", "%_H", "%::z", "%3H", "x".repeat(257)]) {
    assert.equal(validTimeFormat(format), false, format);
    assert.equal(render(now, { time_format: format }), "15:05", format);
    assert.equal(render(now, { time_format: format, use_12hr: true }), "03:05 PM", format);
  }
  assert.equal(validTimeFormat("x".repeat(256)), true);
  assert.equal(validTimeFormat("%%%H"), true);
});

test("time ranges enumerate absent, open, closed, midnight-crossing, and equal endpoints", () => {
  for (const [range, hour, minute, second, millisecond, expected] of [
    ["-", 9, 0, 0, 0, true],
    ["09:00-", 8, 59, 59, 999, false],
    ["09:00-", 9, 0, 0, 0, false],
    ["09:00-", 9, 0, 0, 1, true],
    ["-18:00", 17, 59, 59, 999, true],
    ["-18:00", 18, 0, 0, 0, false],
    ["-18:00", 19, 0, 0, 0, false],
    ["09:00-18:00", 8, 0, 0, 0, false],
    ["09:00-18:00", 9, 0, 0, 0, false],
    ["09:00-18:00", 12, 0, 0, 0, true],
    ["09:00-18:00", 18, 0, 0, 0, false],
    ["09:00-18:00", 20, 0, 0, 0, false],
    ["19:00-06:00", 23, 59, 59, 999, true],
    ["19:00-06:00", 0, 0, 0, 0, true],
    ["19:00-06:00", 6, 0, 0, 0, false],
    ["19:00-06:00", 12, 0, 0, 0, false],
    ["19:00-06:00", 19, 0, 0, 0, false],
    ["09:00-09:00", 9, 0, 0, 0, false],
    ["09:00-09:00", 9, 0, 0, 1, true],
    ["09:00-09:00", 8, 0, 0, 0, true],
    ["09:00:00.1-09:00:00.120", 9, 0, 0, 100, false],
    ["09:00:00.1-09:00:00.120", 9, 0, 0, 110, true],
    ["09:00:00.1-09:00:00.120", 9, 0, 0, 120, false],
  ] as const) {
    assert.equal(isInsideTimeRange(new Date(2026, 0, 1, hour, minute, second, millisecond), range), expected, range);
  }
});

test("time invalid endpoints are ignored separately and malformed separators disable the range", () => {
  const morning = new Date(2026, 0, 1, 9, 0);
  const evening = new Date(2026, 0, 1, 21, 0);
  for (const range of ["", "invalid", "09:00", "09:00-18:00-21:00", "bad-worse", "-".repeat(65)]) {
    assert.equal(isInsideTimeRange(morning, range), true, range);
    assert.equal(isInsideTimeRange(evening, range), true, range);
  }
  for (const invalid of ["bad", "24:00", "10:60", "10:00:60", "10:00:00.1234", "9:00", " 10:00", "10:00 "]) {
    assert.equal(isInsideTimeRange(morning, `${invalid}-18:00`), true, invalid);
    assert.equal(isInsideTimeRange(evening, `${invalid}-18:00`), false, invalid);
    assert.equal(isInsideTimeRange(morning, `18:00-${invalid}`), false, invalid);
    assert.equal(isInsideTimeRange(evening, `18:00-${invalid}`), true, invalid);
  }
});

test("time range uses local wall time even with a different output zone and hides the entire module", () => {
  const now = new Date(2026, 0, 1, 9, 0);
  assert.equal(render(now, { time_range: "08:00-10:00", utc_time_offset: "23", time_format: "visible" }), "visible");
  assert.equal(render(now, { time_range: "10:00-18:00", format: "CLOCK $time" }), "");
  assert.equal(render(now, { disabled: true }), "");
  assert.equal(render(new Date(Number.NaN), { format: "CLOCK $time" }), "");
});

test("time presentation sanitizes format literals without executing inserted format variables", () => {
  assert.equal(
    render(new Date(2026, 0, 1, 9, 5), { time_format: "\x1b]8;;https://invalid.example\x07clock\x1b]8;;\x07 %H:%M\n" }),
    "clock 09:05 ",
  );
});

test("time normalization rejects wrong setting types and retains default option values", () => {
  const { config, diagnostics } = normalizeConfig({
    time: { use_12hr: "true", time_format: false, utc_time_offset: 5, time_range: [] },
  });
  assert.deepEqual(
    diagnostics.map(({ path }) => path),
    ["time.use_12hr", "time.time_format", "time.utc_time_offset", "time.time_range"],
  );
  assert.equal(formatClockTime(new Date(2026, 0, 1, 9, 5), config.modules.time.options), "09:05");
});
