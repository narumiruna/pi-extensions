import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { summarizeFooterUsage } from "../src/usage.js";

const kinds = ["assistant", "toolResult", "compaction", "branch_summary", "usage"] as const;
type UsageKind = (typeof kinds)[number];
const estimates = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 };

function usageEntry(kind: UsageKind, cost: unknown): SessionEntry {
  const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost };
  return (
    kind === "assistant" || kind === "toolResult"
      ? { type: "message", message: { role: kind, usage } }
      : { type: kind, usage }
  ) as SessionEntry;
}

for (const kind of kinds) {
  test.each([0, 0.125])(`${kind} retains a provider total of %s independently of component estimates`, (total) => {
    const cost = Object.freeze({ ...estimates, total, totalFromProvider: true });
    const result = summarizeFooterUsage([usageEntry(kind, cost)]);
    assert.equal(result.cost, total);
    assert.equal(result.costTotalFromProvider, true);
    assert.equal(result.input, 10);
    assert.equal(result.cacheRead, 3);
    assert.equal(cost.total, total);
  });

  test.each([false, undefined, null, "true", 1])(
    `${kind} does not confirm a total with provenance %s`,
    (totalFromProvider) => {
      const result = summarizeFooterUsage([usageEntry(kind, { ...estimates, total: 0.125, totalFromProvider })]);
      assert.equal(result.cost, 0.125);
      assert.equal(result.costTotalFromProvider, false);
    },
  );

  test.each([false, undefined])(`one ${kind} part with provenance %s makes the combined total unconfirmed`, (flag) => {
    const entries = kinds.map((includedKind) =>
      usageEntry(includedKind, {
        ...estimates,
        total: 0.125,
        totalFromProvider: includedKind === kind ? flag : true,
      }),
    );
    const result = summarizeFooterUsage(entries);
    assert.equal(result.cost, 0.625);
    assert.equal(result.costTotalFromProvider, false);
  });

  test.each([undefined, {}, { ...estimates, totalFromProvider: true }])(
    `missing ${kind} cost totals cannot confirm a combined total: %j`,
    (cost) => {
      const result = summarizeFooterUsage([
        usageEntry("assistant", { ...estimates, total: 0.25, totalFromProvider: true }),
        usageEntry(kind, cost),
      ]);
      assert.equal(result.cost, 0.25);
      assert.equal(result.costTotalFromProvider, false);
    },
  );

  test.each([null, "0", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    `invalid ${kind} total %s cannot establish provider billing`,
    (total) => {
      const result = summarizeFooterUsage([usageEntry(kind, { total, totalFromProvider: true })]);
      assert.equal(result.costTotalFromProvider, false);
    },
  );
}

test("all included entry kinds must confirm their totals, including zero-cost parts", () => {
  const entries = kinds.map((kind, index) =>
    usageEntry(kind, { ...estimates, total: index === 0 ? 0 : 0.125, totalFromProvider: true }),
  );
  const result = summarizeFooterUsage(entries);
  assert.equal(result.cost, 0.5);
  assert.equal(result.costTotalFromProvider, true);
  assert.equal(result.input, 50);
  assert.equal(result.output, 10);
  assert.equal(result.cacheRead, 15);
  assert.equal(result.cacheWrite, 5);
});

test("empty sessions and entries without usage cannot establish provider billing", () => {
  const noUsage = [
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "toolResult" } },
    { type: "compaction" },
    { type: "branch_summary" },
    { type: "usage" },
    { type: "custom", data: { usage: { cost: { total: 1, totalFromProvider: true } } } },
    { type: "message", message: { role: "user", usage: { cost: { total: 1, totalFromProvider: true } } } },
  ] as SessionEntry[];
  for (const entries of [[], noUsage]) {
    const result = summarizeFooterUsage(entries);
    assert.equal(result.cost, 0);
    assert.equal(result.costTotalFromProvider, false);
  }
  const confirmed = usageEntry("assistant", { total: 0.125, totalFromProvider: true });
  const result = summarizeFooterUsage([...noUsage, confirmed]);
  assert.equal(result.cost, 0.125);
  assert.equal(result.costTotalFromProvider, true);
});

test("an overflowing aggregate is not confirmed without changing its numeric total", () => {
  const cost = { total: Number.MAX_VALUE, totalFromProvider: true };
  const result = summarizeFooterUsage([usageEntry("assistant", cost), usageEntry("toolResult", cost)]);
  assert.equal(result.cost, Number.POSITIVE_INFINITY);
  assert.equal(result.costTotalFromProvider, false);
});
