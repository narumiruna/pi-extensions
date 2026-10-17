import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { cacheHistory } from "../src/cache-history.js";
import { Collector } from "../src/collector.js";
import { EntryIndex } from "../src/entry-index.js";
import { SessionFeed } from "../src/feed.js";
import { snapshot } from "../src/projection.js";
import { cacheAssistant, cacheModel, cacheUsage } from "./cache-fixtures.js";

function report(manager: SessionManager, priced = true) {
  return cacheHistory(manager, new EntryIndex(manager.getEntries()), () => (priced ? cacheModel : undefined));
}
function manager() {
  return SessionManager.inMemory("/cache-fixture");
}

describe("recorded cache usage contract", () => {
  it("keeps empty sessions and older snapshots compatible", () => {
    expect(report(manager())).toMatchObject({
      complete: true,
      leafId: null,
      records: [],
      totals: { count: 0, hitRatePercent: null },
    });
  });
  it.each([
    ["known read", cacheUsage(200, 800), 80],
    ["write only", cacheUsage(0, 0, 1000), 0],
    ["unknown zero cache", cacheUsage(1000, 0), null],
    ["all zero", cacheUsage(0, 0), null],
    ["missing read", { ...cacheUsage(), cacheRead: undefined }, null],
    ["negative input", { ...cacheUsage(), input: -1 }, null],
    ["nonfinite", { ...cacheUsage(), input: Number.POSITIVE_INFINITY }, null],
    ["overflow", { ...cacheUsage(), input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE }, null],
  ])("classifies %s without inventing a miss", (_name, usage, hit) => {
    const m = manager();
    const id = m.appendMessage(cacheAssistant(usage as Usage));
    const result = report(m);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ entryId: id, hitRatePercent: hit, comparison: null });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
  it("preserves unknown rows and compares adjacent known requests, including complete misses", () => {
    const m = manager();
    m.appendMessage(cacheAssistant(cacheUsage(1000, 0)));
    const first = m.appendMessage(cacheAssistant(cacheUsage(200, 800)));
    const miss = m.appendMessage(cacheAssistant(cacheUsage(1000, 0), { timestamp: 3500 }));
    const rows = report(m).records;
    expect(rows.map((r) => r.hitRatePercent)).toEqual([null, 80, 0]);
    expect(rows[1]?.comparison).toBeNull();
    expect(rows[2]).toMatchObject({
      entryId: miss,
      comparison: {
        previousEntryId: first,
        hitRateDeltaPercent: -80,
        hitRateLossPercent: 80,
        eligibleTokens: 1000,
        rebilledTokens: 1000,
        requestStartGapMs: 2500,
      },
    });
    expect(rows[2]?.comparison?.estimatedMissPremium).toBeCloseTo(0.009);
    expect(report(m).totals.hitRatePercent).toBeNull();
  });
  it("computes weighted totals before clipping rows, not an average of percentages", () => {
    const m = manager();
    m.appendMessage(cacheAssistant(cacheUsage(200, 800)));
    m.appendMessage(cacheAssistant(cacheUsage(90, 10)));
    expect(report(m).totals.hitRatePercent).toBeCloseTo((810 / 1100) * 100);
    for (let i = 0; i < 220; i++) m.appendMessage(cacheAssistant());
    const result = report(m);
    expect(result).toMatchObject({ totalRecords: 222, omittedRecords: 22, complete: true });
    expect(result.records).toHaveLength(200);
    expect(result.trend).toHaveLength(32);
    expect(result.totals).toMatchObject({ count: 222, promptTokens: 221100, cacheRead: 176810 });
  });
  it("includes summary and all generic usage records but excludes them from conversational comparisons", () => {
    const m = manager();
    const a = m.appendMessage(cacheAssistant());
    m.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
    m.appendUsage("nested-job", cacheModel.provider, cacheModel.id, cacheUsage());
    m.appendMessage(cacheAssistant(cacheUsage(400, 600)));
    m.appendCompaction("summary", a, 1000, undefined, undefined, cacheUsage());
    m.appendMessage(cacheAssistant());
    m.branchWithSummary(m.getLeafId(), "branch summary", undefined, undefined, cacheUsage());
    m.appendMessage(cacheAssistant());
    const result = report(m);
    expect(result.records.map((r) => r.kind)).toEqual([
      "assistant",
      "cache_warm",
      "usage",
      "assistant",
      "compaction",
      "assistant",
      "branch_summary",
      "assistant",
    ]);
    expect(result.totals.count).toBe(8);
    expect(result.trend).toHaveLength(4);
    expect(result.records[3]?.comparison?.previousEntryId).toBe(a);
    expect(result.records[5]?.comparison).toBeNull();
    expect(result.records[7]?.comparison).toBeNull();
  });
  it.each(["stop", "error", "aborted"] as const)(
    "retains metered %s responses and flags model changes",
    (stopReason) => {
      const m = manager();
      m.appendMessage(cacheAssistant());
      m.appendMessage(
        cacheAssistant(cacheUsage(400, 600), { model: "changed", provider: "changed-provider", stopReason }),
      );
      const row = report(m).records[1];
      expect(row?.comparison?.modelChanged).toBe(true);
      expect(row?.status).toBe(stopReason === "error" ? "error" : stopReason === "aborted" ? "cancelled" : "recorded");
    },
  );
  it("breaks comparison on unknown or invalid assistant usage, but not unrelated events", () => {
    const m = manager();
    m.appendMessage(cacheAssistant());
    m.appendMessage(cacheAssistant(cacheUsage(1000, 0), { provider: "unknown" }));
    m.appendMessage(cacheAssistant());
    expect(report(m).records[2]?.comparison).toBeNull();
    m.appendCustomEntry("other", {});
    m.appendMessage(cacheAssistant());
    expect(report(m).records[3]?.comparison).not.toBeNull();
    m.appendMessage(cacheAssistant(undefined, { usage: undefined as unknown as Usage }));
    expect(report(m)).toMatchObject({ complete: false, totals: { input: null, hitRatePercent: null } });
  });
  it("uses copied effective tier/retention pricing, and keeps unpriced costs unavailable", () => {
    const m = manager();
    const usage = cacheUsage(0, 2500, 100);
    usage.cacheWrite1h = 100;
    usage.cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
    m.appendMessage(cacheAssistant(usage));
    const saved = structuredClone(m.getEntries());
    const row = report(m).records[0];
    expect(row?.promptCost).toBeCloseTo(0.009);
    expect(row?.estimatedSavings).toBeCloseTo(0.045);
    expect(row?.costSource).toBe("model-estimate");
    expect(m.getEntries()).toEqual(saved);
    expect(report(m, false).records[0]?.promptCost).toBeNull();
    const mixed = cacheUsage();
    mixed.cost.cacheRead = 0;
    m.appendMessage(cacheAssistant(mixed));
    expect(report(m).records[1]?.costSource).toBe("mixed");
  });
  it("reconstructs identical usage from persisted sessions on resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspect-cache-resume-"));
    try {
      const m = SessionManager.create(dir, dir);
      m.appendMessage({ role: "user", content: "request", timestamp: 1 });
      m.appendMessage(cacheAssistant());
      m.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
      const file = m.getSessionFile();
      if (!file) throw Error("Missing persisted session");
      expect(report(SessionManager.open(file))).toEqual(report(m));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("resets epochs even without summary usage and never uses auxiliary zero fields as a miss", () => {
    const m = manager();
    const a = m.appendMessage(cacheAssistant());
    m.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage(1000, 0));
    m.appendCompaction("no metering", a, 1000);
    m.appendMessage(cacheAssistant());
    const result = report(m);
    expect(result.records).toHaveLength(3);
    expect(result.records[1]?.hitRatePercent).toBeNull();
    expect(result.records[2]).toMatchObject({ epoch: 1, comparison: null });
  });
  it.each([null, false, 0])("retains explicitly malformed summary usage (%s) as unavailable", (usage) => {
    const m = manager();
    const a = m.appendMessage(cacheAssistant());
    m.appendCompaction("invalid metering", a, 1000, undefined, undefined, usage as unknown as Usage);
    const result = report(m);
    expect(result.records).toHaveLength(2);
    expect(result).toMatchObject({ complete: false, totals: { promptTokens: null } });
    expect(result.records[1]).toMatchObject({ kind: "compaction", hitRatePercent: null, promptCost: null });
  });
  it.each([2000, 2001])("uses strict tier boundaries at %s prompt tokens", (tokens) => {
    const m = manager();
    const usage = cacheUsage(0, tokens);
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    m.appendMessage(cacheAssistant(usage));
    expect(report(m).records[0]?.promptCost).toBeCloseTo((tokens * (tokens > 2000 ? 2 : 1)) / 1000000, 8);
  });
  it.each(["", "x".repeat(10000), "missing"])(
    "rejects invalid leaves without exposing an unbounded identity",
    (leaf) => {
      const m = manager();
      m.appendMessage(cacheAssistant());
      const source = { getLeafId: () => leaf } as unknown as SessionManager;
      const result = cacheHistory(source, new EntryIndex(m.getEntries()));
      expect(result.complete).toBe(false);
      expect(result.unavailable).toBeTruthy();
      expect((result.leafId ?? "").length).toBeLessThanOrEqual(512);
    },
  );
  it("does not mix alternative branches, including after snapshot reconstruction", () => {
    const m = manager();
    const root = m.appendMessage(cacheAssistant());
    const alternate = m.appendMessage(cacheAssistant(cacheUsage(900, 100)));
    m.branch(root);
    const active = m.appendMessage(cacheAssistant(cacheUsage(400, 600)));
    const snap = snapshot(m, new Collector(), "cache", 0, "", [], [], []);
    expect(snap.cache?.leafId).toBe(active);
    expect(snap.cache?.totals.cacheRead).toBe(1400);
    expect(snap.cache?.records.some((r) => r.entryId === alternate)).toBe(false);
    m.branch(alternate);
    expect(report(m).totals.cacheRead).toBe(900);
    expect(report(m)).toEqual(report(m));
  });
  it.each(["missing", "cycle", "duplicate", "over-budget"])(
    "labels %s ancestry unavailable instead of complete totals",
    (kind) => {
      const m = manager();
      const id = m.appendMessage(cacheAssistant());
      const entries = structuredClone(m.getEntries());
      const entry = entries[0];
      if (!entry) throw Error("Missing entry");
      if (kind === "missing") entry.parentId = "missing";
      if (kind === "cycle") entry.parentId = id;
      if (kind === "duplicate") entries.push({ ...entry });
      if (kind === "over-budget") {
        for (let i = 0; i < 10000; i++) entries.push({ ...entry, id: `e${i}`, parentId: i ? `e${i - 1}` : id });
      }
      const source = { ...m, getLeafId: () => (kind === "over-budget" ? "e9999" : id) } as unknown as SessionManager;
      const result = cacheHistory(source, new EntryIndex(entries));
      expect(result.complete).toBe(false);
      expect(result.unavailable).toBeTruthy();
      expect(result.records).toEqual([]);
    },
  );
  it("bounds/redacts labels without using sanitized labels to compare model identity", () => {
    const m = manager();
    const provider = `${"x".repeat(200)}<script>\u001b[31m Bearer private`;
    m.appendMessage(cacheAssistant(undefined, { provider, model: `${"m".repeat(200)}a` }));
    m.appendMessage(cacheAssistant(undefined, { provider, model: `${"m".repeat(200)}b` }));
    const result = report(m);
    expect(result.records[1]?.comparison?.modelChanged).toBe(true);
    expect(result.records[0]?.provider.length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("\\u001b");
  });
});

it("feed rebuilds recorded cache usage after structural boundaries and idle warm polling, then releases it", () => {
  vi.useFakeTimers();
  const m = manager();
  m.appendMessage(cacheAssistant());
  const controller = new AbortController();
  const feed = new SessionFeed({
    pi: { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI,
    context: () =>
      ({
        sessionManager: m,
        getSystemPrompt: () => "",
        modelRegistry: { find: () => cacheModel },
      }) as unknown as ExtensionContext,
    collector: new Collector(),
    skills: [],
    generation: "cache",
    signal: controller.signal,
    invalidate: vi.fn(),
  });
  try {
    feed.start();
    expect(feed.snapshot().cache?.totals.count).toBe(1);
    m.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
    vi.advanceTimersByTime(1000);
    expect(feed.snapshot().cache?.totals.count).toBe(2);
    feed.changed(true);
    expect(feed.snapshot().cache?.totals.count).toBe(2);
    m.appendMessage(cacheAssistant());
    feed.changed(true);
    expect(feed.snapshot().cache?.totals.count).toBe(3);
    controller.abort();
    expect(() => feed.snapshot()).toThrow("stopped");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    feed.close();
    vi.useRealTimers();
  }
});
