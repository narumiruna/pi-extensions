import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createFooterHistoryReader, summarizeFooterUsage } from "../src/usage.js";

function entry(value: unknown): SessionEntry {
  return value as SessionEntry;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("branch and whole-session usage have separate cache boundaries", () => {
  const manager = SessionManager.inMemory();
  const append = () => manager.appendMessage({ role: "user", content: "prompt", timestamp: 0 });
  const root = append();
  const reply = manager.appendMessage({
    ...fauxAssistantMessage("reply"),
    durationMs: 1000,
    usage: usage(4, 9, 0, 0, 0),
  });
  const getEntries = vi.spyOn(manager, "getEntries");
  const getBranch = vi.spyOn(manager, "getBranch");
  const history = createFooterHistoryReader(manager);
  const full = { turnCount: 1, tokensPerSecond: 9 };
  assert.deepEqual(history.branch(), full);
  assert.deepEqual(history.branch(), full);
  assert.equal(getBranch.mock.calls.length, 1);
  assert.equal(history.totals().output, 9);
  manager.branch(root);
  assert.deepEqual(history.branch(), { turnCount: 1, tokensPerSecond: undefined });
  assert.equal(history.totals().output, 9);
  assert.equal(getEntries.mock.calls.length, 1);
  manager.branch(reply);
  assert.deepEqual(history.branch(), full);
  manager.appendCompaction("summary", reply, 100);
  const scansAfterCompaction = getEntries.mock.calls.length;
  assert.deepEqual(history.branch(), full);
  assert.equal(getBranch.mock.calls.length, 4);
  assert.equal(history.totals().output, 9);
  assert.equal(getEntries.mock.calls.length, scansAfterCompaction + 1);
  manager.newSession({ id: manager.getSessionId() });
  append();
  append();
  append();
  assert.equal(manager.getEntryCount(), 3);
  assert.deepEqual(history.branch(), { turnCount: 3, tokensPerSecond: undefined });
  assert.equal(history.totals().output, 0);
  history.clear();
  assert.equal(history.totals().output, 0);
  assert.equal(getEntries.mock.calls.length, scansAfterCompaction + 3);
});

test("footer usage includes every usage-bearing session entry and uses the latest assistant rate", () => {
  const entries = [
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
    }),
    entry({
      type: "message",
      message: { role: "toolResult", usage: usage(3, 1, 4, 1, 0.02) },
    }),
    entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
    entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
    entry({
      type: "usage",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude",
      usage: usage(4, 1, 6, 1, 0.05),
    }),
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) },
    }),
  ];

  const result = summarizeFooterUsage(entries);
  assert.deepEqual(
    { ...result, cost: undefined },
    {
      input: 100,
      output: 10,
      cacheRead: 61,
      cacheWrite: 9,
      cost: undefined,
      costTotalFromProvider: false,
      latestCacheHitRate: 20,
    },
  );
  assert.ok(Math.abs(result.cost - 0.25) < Number.EPSILON);
});

test("a latest zero-prompt assistant clears the rate without clearing cumulative cache totals", () => {
  const result = summarizeFooterUsage([
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
    }),
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(0, 0, 0, 0, 0) },
    }),
  ]);

  assert.equal(result.cacheRead, 30);
  assert.equal(result.cacheWrite, 5);
  assert.equal(result.latestCacheHitRate, undefined);
});

test("sessions without cache activity retain zero cache totals and a zero latest rate", () => {
  assert.deepEqual(
    summarizeFooterUsage([
      entry({
        type: "message",
        message: { role: "assistant", usage: usage(25, 5, 0, 0, 0.01) },
      }),
    ]),
    {
      input: 25,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      costTotalFromProvider: false,
      latestCacheHitRate: 0,
    },
  );
});
