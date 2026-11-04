import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { normalizeConfig, validateConfigDocument } from "../src/config.js";
import { inspectStatuslineModules, renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";
import { latestTokensPerSecond, summarizeFooterUsage } from "../src/usage.js";

function fixture(rate?: number): StarshipRuntimeSnapshot {
  return {
    cwd: "/workspace",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 100, output: 85, cacheRead: 0, cacheWrite: 0, cost: 0 },
    tokensPerSecond: rate,
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(2026, 0, 1),
  };
}

// Deliberately loose fixtures exercise malformed and older persisted response data.
function assistant(overrides: Record<string, unknown> = {}): SessionEntry {
  return {
    type: "message",
    message: { role: "assistant", stopReason: "stop", durationMs: 2000, usage: { output: 85 }, ...overrides },
  } as SessionEntry;
}

function settings(module: Record<string, unknown> = {}, format = "$tokens_per_second") {
  return normalizeConfig({ format, tokens_per_second: { disabled: false, ...module } });
}

test.each(["stop", "length", "toolUse"])("the latest %s response supplies output tokens per second", (stopReason) => {
  assert.equal(latestTokensPerSecond([assistant({ stopReason })]), 42.5);
});

test.each([
  [0, 2000, 0],
  [120, 2000, 60],
  [120, 500, 240],
])("rate calculation handles output %s and duration %s", (output, durationMs, expected) => {
  assert.equal(latestTokensPerSecond([assistant({ usage: { output }, durationMs })]), expected);
});

test("large finite inputs do not overflow during unit conversion", () => {
  const rate = latestTokensPerSecond([
    assistant({ usage: { output: Number.MAX_VALUE }, durationMs: Number.MAX_VALUE }),
  ]);
  assert.equal(rate?.toFixed(1), "1000.0");
});

test.each([undefined, null, 0, -1, NaN, Infinity, -Infinity, "2000"])(
  "an invalid latest duration %s clears the older rate",
  (durationMs) => {
    assert.equal(latestTokensPerSecond([assistant(), assistant({ durationMs })]), undefined);
  },
);

test.each([undefined, null, -1, NaN, Infinity, -Infinity, "85"])(
  "an invalid latest output %s clears the older rate",
  (output) => {
    assert.equal(latestTokensPerSecond([assistant(), assistant({ usage: { output } })]), undefined);
  },
);

test.each(["error", "aborted", "pending", "deferred", undefined, "unknown"])(
  "an incomplete or unsuccessful latest response %s clears the older rate",
  (stopReason) => {
    assert.equal(latestTokensPerSecond([assistant(), assistant({ stopReason })]), undefined);
  },
);

test("missing usage and nonfinite calculated rates are unavailable", () => {
  assert.equal(latestTokensPerSecond([assistant(), assistant({ usage: undefined })]), undefined);
  assert.equal(latestTokensPerSecond([assistant({ durationMs: Number.MIN_VALUE })]), undefined);
  assert.equal(latestTokensPerSecond([assistant({ durationMs: 1, usage: { output: Number.MAX_VALUE } })]), undefined);
});

test("rate selection ignores unrelated usage and does not change cumulative accounting or persisted entries", () => {
  const entries = [
    assistant({ usage: { input: 10, output: 10 } }),
    assistant(),
    { type: "message", message: { role: "user", content: "next" } } as SessionEntry,
    { type: "message", message: { role: "toolResult", durationMs: 1, usage: { output: 1000 } } } as SessionEntry,
    { type: "compaction", usage: { output: 1000 } } as SessionEntry,
    { type: "branch_summary", usage: { output: 1000 } } as SessionEntry,
    { type: "usage", kind: "cache_warm", usage: { output: 1000 } } as SessionEntry,
  ];
  const before = structuredClone(entries);
  const totals = summarizeFooterUsage(entries);
  assert.equal(latestTokensPerSecond(entries), 42.5);
  assert.deepEqual(summarizeFooterUsage(entries), totals);
  assert.deepEqual(entries, before);
  assert.equal(latestTokensPerSecond(entries.slice(2)), undefined);
  assert.equal(latestTokensPerSecond([]), undefined);
});

test("tokens_per_second accepts the approved TOML syntax and exposes its rate in inspection", () => {
  const loaded = validateConfigDocument(
    "/reference/pi-starship.toml",
    'format = "$tokens_per_second"\n[tokens_per_second]\ndisabled = false\nformat = "[$rate tok/s ]($style)"\nstyle = "bold cyan"\n',
  );
  assert.deepEqual(loaded.diagnostics, []);
  const module = inspectStatuslineModules(loaded.config, fixture(42.5)).modules.find(
    (item) => item.name === "tokens_per_second",
  );
  assert.equal(module?.state, "Showing");
  assert.deepEqual(module?.variables, ["symbol", "rate"]);
  assert.equal(module?.preview, "42.5 tok/s ");
});

test.each([
  [0, "0.0 tok/s "],
  [42.5, "42.5 tok/s "],
  [120 / 7, "17.1 tok/s "],
])("tokens_per_second renders %s with one decimal place", (rate, expected) => {
  const { config, diagnostics } = settings();
  assert.deepEqual(diagnostics, []);
  assert.equal(stripVTControlCharacters(renderStatusline(config, fixture(rate)).ansi), expected);
});

test("tokens_per_second supports custom symbols, formats, and styles", () => {
  const { config, diagnostics } = settings({
    symbol: "speed",
    format: "[$symbol $rate TPS]($style)",
    style: "bold red",
  });
  assert.deepEqual(diagnostics, []);
  const result = renderStatusline(config, fixture(42.5));
  assert.equal(stripVTControlCharacters(result.ansi), "speed 42.5 TPS");
  assert.ok(result.ansi.includes("\u001b["));
});

test("tokens_per_second hides the complete module, including literal text, without a rate", () => {
  const { config } = settings({ symbol: "speed", format: "[$symbol $rate tok/s]($style)" });
  assert.equal(renderStatusline(config, fixture()).ansi, "");
});

test("tokens_per_second is disabled by default, including in $all", () => {
  for (const format of ["$tokens_per_second", "$all"]) {
    const { config } = normalizeConfig({ format });
    const module = inspectStatuslineModules(config, fixture(42.5)).modules.find(
      (item) => item.name === "tokens_per_second",
    );
    assert.equal(module?.state, "Disabled");
    assert.doesNotMatch(stripVTControlCharacters(renderStatusline(config, fixture(42.5)).ansi), /tok\/s/u);
  }
});

test("$all includes enabled tokens_per_second once and respects an explicit position", () => {
  for (const format of ["$all", "$tokens_per_second$all"]) {
    const { config, diagnostics } = settings({}, format);
    assert.deepEqual(diagnostics, []);
    const result = stripVTControlCharacters(renderStatusline(config, fixture(42.5)).ansi);
    assert.equal(result.split("42.5 tok/s").length - 1, 1);
    if (format.startsWith("$tokens_per_second")) assert.ok(result.startsWith("42.5 tok/s "));
  }
});
