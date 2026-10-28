import { describe, expect, it } from "vitest";
import type { CacheHistory } from "../src/model.js";
import { formatHitRate, hitRateBand, summarizeTrend } from "../src/web/cache-trend.js";

function points(...values: (number | null)[]): CacheHistory["trend"] {
  return values.map((hitRatePercent, index) => ({ entryId: `response-${index}`, hitRatePercent }));
}

describe("cache trend presentation", () => {
  it.each([
    [null, "Unavailable", "unavailable"],
    [0, "Low", "0%"],
    [0.0001, "Low", "<0.01%"],
    [49.99, "Low", "49.99%"],
    [49.995, "Low", "49.99%"],
    [49.9999, "Low", "<50%"],
    [50, "Moderate", "50%"],
    [50.01, "Moderate", "50.01%"],
    [89.99, "Moderate", "89.99%"],
    [89.995, "Moderate", "<90%"],
    [89.9999, "Moderate", "<90%"],
    [90, "High", "90%"],
    [90.01, "High", "90.01%"],
    [99.995, "High", "<100%"],
    [99.9999, "High", "<100%"],
    [100, "High", "100%"],
    [-1, "Unavailable", "unavailable"],
    [101, "Unavailable", "unavailable"],
    [Number.NaN, "Unavailable", "unavailable"],
    [Number.POSITIVE_INFINITY, "Unavailable", "unavailable"],
  ] as const)("classifies and formats %s without crossing a threshold", (value, band, formatted) => {
    expect(hitRateBand(value)).toBe(band);
    expect(formatHitRate(value)).toBe(formatted);
  });

  it.each([
    [[], { latest: null, minimum: null }],
    [[null, null], { latest: null, minimum: null }],
    [[80], { latest: 80, minimum: 80 }],
    [[80, 0, 100], { latest: 100, minimum: 0 }],
    [[null, 80, null], { latest: null, minimum: 80 }],
    [[80, null, 90], { latest: 90, minimum: 80 }],
    [[Number.NaN, 90, Number.POSITIVE_INFINITY], { latest: null, minimum: 90 }],
  ] as const)("summarizes only the displayed values %j", (values, expected) => {
    const trend = points(...values);
    const original = structuredClone(trend);
    expect(summarizeTrend(trend)).toEqual(expected);
    expect(trend).toEqual(original);
  });

  it("does not calculate a branch-weighted total or compare across epochs", () => {
    const trend = points(10, 90);
    trend[0].epoch = 0;
    trend[1].epoch = 1;
    expect(summarizeTrend(trend)).toEqual({ latest: 90, minimum: 10 });
  });
});
