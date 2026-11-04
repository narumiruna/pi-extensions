import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { normalizeConfig, validateConfigDocument } from "../src/config.js";
import { inspectStatuslineModules, renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";
import { summarizeFooterUsage } from "../src/usage.js";

function fixture(cost: number, costTotalFromProvider?: boolean, usingSubscription = false): StarshipRuntimeSnapshot {
  return {
    cwd: "/workspace",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, costTotalFromProvider },
    usingSubscription,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(2026, 0, 1),
  };
}

const cases = [
  { provenance: true, source: "provider" },
  { provenance: false, source: "unconfirmed" },
  { provenance: undefined, source: "unconfirmed" },
];

for (const { provenance, source } of cases) {
  test.each([0, 0.125, 1.25])(`cost source ${String(provenance)} keeps numeric formatting for %s`, (cost) => {
    const normalized = normalizeConfig({
      format: "$cost",
      cost: {
        format: "$cost $source( $subscription)",
        display: [{ threshold: 0, style: "none", hidden: false }],
      },
    });
    assert.deepEqual(normalized.diagnostics, []);
    const formatted = cost.toFixed(cost >= 1 ? 2 : 3);
    assert.equal(renderStatusline(normalized.config, fixture(cost, provenance)).ansi, `${formatted} ${source}`);
    assert.equal(
      renderStatusline(normalized.config, fixture(cost, provenance, true)).ansi,
      `${formatted} ${source} (sub)`,
    );
  });

  test(`the existing cost format does not change for provenance ${String(provenance)}`, () => {
    const { config } = normalizeConfig({ format: "$cost" });
    const result = renderStatusline(config, fixture(1.25, provenance, true));
    assert.equal(stripVTControlCharacters(result.ansi), " 💸 $1.25 (sub) ");
    assert.equal(renderStatusline(config, fixture(0, provenance)).ansi, "");
  });
}

test("cost source is validated and discoverable through module inspection", () => {
  const result = validateConfigDocument(
    "/tmp/pi-starship-cost.toml",
    'format = "$cost"\n[cost]\nformat = "$cost $source"\n[[cost.display]]\nthreshold = 0\nstyle = "none"\nhidden = false\n',
  );
  assert.deepEqual(result.diagnostics, []);
  const inspection = inspectStatuslineModules(result.config, fixture(0.125, true));
  const cost = inspection.modules.find((module) => module.name === "cost");
  assert.ok(cost?.variables.includes("source"));
  assert.equal(cost?.preview, "0.125 provider");
});

test("cost source renders an aggregate as unconfirmed when one persisted usage part is estimated", () => {
  const { config } = normalizeConfig({
    format: "$cost",
    cost: { format: "$cost $source", display: [{ threshold: 0, style: "none", hidden: false }] },
  });
  const baseEntry = { parentId: null, timestamp: new Date(2026, 0, 1).toISOString() };
  const usage = (totalFromProvider: boolean) => ({
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 0.125, totalFromProvider },
  });
  const tokenTotals = summarizeFooterUsage([
    {
      ...baseEntry,
      id: "cache-warm",
      type: "usage",
      kind: "cache_warm",
      provider: "openrouter",
      model: "model",
      usage: usage(true),
    },
    {
      ...baseEntry,
      id: "summary",
      type: "compaction",
      summary: "compacted",
      firstKeptEntryId: "cache-warm",
      tokensBefore: 2,
      usage: usage(false),
    },
  ]);
  assert.equal(renderStatusline(config, { ...fixture(0), tokenTotals }).ansi, "0.250 unconfirmed");
});
