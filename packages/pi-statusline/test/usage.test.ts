import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createFooterUsageReader, summarizeFooterUsage } from "../src/usage.js";

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

test("footer totals reuse stable history and refresh after append or same-count replacement", () => {
  const manager = SessionManager.inMemory();
  const append = (input: number) =>
    manager.appendMessage({ ...fauxAssistantMessage("test"), usage: usage(input, 1, 0, 0, 0) });
  const first = append(5);
  const entries = vi.spyOn(manager, "getEntries");
  const read = createFooterUsageReader(manager);
  assert.equal(read().input, 5);
  assert.equal(read().input, 5);
  assert.equal(entries.mock.calls.length, 1);
  append(15);
  assert.equal(read().input, 20);
  manager.branch(first);
  assert.equal(read().input, 20, "totals include the whole session, not just the active branch");
  const id = manager.getSessionId();
  manager.newSession({ id });
  append(10);
  append(2);
  assert.equal(manager.getEntryCount(), 2);
  assert.equal(read().input, 12);
  assert.equal(entries.mock.calls.length, 3);
});

test("footer totals use live entries on hosts without the count accessor", () => {
  const entries = vi.fn(() => []);
  const read = createFooterUsageReader({ getEntries: entries } as never);
  assert.deepEqual(read(), read());
  assert.equal(entries.mock.calls.length, 2);
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
