import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  cumulativeAssistantTokens,
  currentTokenTotal,
  type GoalAccountingState,
  updateGoalUsage,
} from "../src/accounting.js";
import { lastGoalStatus, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function assistant(id: string, parentId: string | null, usage: unknown): SessionEntry {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", usage } as never };
}

function custom(id: string, parentId: string | null): SessionEntry {
  return { type: "custom", customType: "goal-state", id, parentId, timestamp, data: {} };
}

function indexedSession() {
  const entries = new Map<string, SessionEntry>();
  let leaf: string | null = null;
  const reads = { entry: 0, branch: 0 };
  const manager = {
    getLeafId: () => leaf,
    getEntry(id: string) {
      reads.entry++;
      return entries.get(id);
    },
    getBranch() {
      reads.branch++;
      const branch: SessionEntry[] = [];
      let entry = leaf ? entries.get(leaf) : undefined;
      while (entry) {
        branch.push(entry);
        entry = entry.parentId ? entries.get(entry.parentId) : undefined;
      }
      return branch.reverse();
    },
  };
  return {
    manager,
    reads,
    append(entry: SessionEntry) {
      entries.set(entry.id, entry);
      leaf = entry.id;
    },
    branch(id: string | null) {
      leaf = id;
    },
  };
}

function message(tokens: number) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses" as const,
    provider: "test",
    model: "test",
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("cached totals preserve usage fallback, rounding, and safe-integer saturation", () => {
  const values: unknown[] = [
    undefined,
    null,
    {},
    { totalTokens: 0, input: 100 },
    { totalTokens: 17, input: 100 },
    { totalTokens: -1, input: 3, output: 2, cacheRead: 4, cacheWrite: 5 },
    { totalTokens: Number.NaN, input: 1, output: -4, cacheRead: Number.POSITIVE_INFINITY },
    { totalTokens: Number.POSITIVE_INFINITY, input: 7, output: 3 },
    { totalTokens: 0.1 },
    { totalTokens: 0.2 },
    { input: "10", output: null, cacheRead: 5 },
    { totalTokens: Number.MAX_SAFE_INTEGER },
    { totalTokens: 100 },
  ];
  const session = indexedSession();
  const ctx = { sessionManager: session.manager };
  assert.equal(currentTokenTotal(ctx), 0);
  for (const [index, usage] of values.entries()) {
    session.append(assistant(`a${index}`, session.manager.getLeafId(), usage));
    assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(session.manager.getBranch()));
    assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(session.manager.getBranch()));
  }
  assert.equal(currentTokenTotal(ctx), Number.MAX_SAFE_INTEGER);
  session.branch("a1");
  assert.equal(currentTokenTotal(ctx), 0);
});

test("cold and warm traversal costs depend on uncached entries, not session length", () => {
  const session = indexedSession();
  for (let index = 0; index < 60_000; index++) {
    session.append(assistant(`a${index}`, session.manager.getLeafId(), { totalTokens: 2 }));
  }
  const ctx = { sessionManager: session.manager };
  assert.equal(currentTokenTotal(ctx), 120_000);
  assert.deepEqual(session.reads, { entry: 60_000, branch: 0 });
  assert.equal(currentTokenTotal(ctx), 120_000);
  assert.deepEqual(session.reads, { entry: 60_001, branch: 0 });
  session.append(custom("checkpoint", session.manager.getLeafId()));
  session.append(assistant("next", "checkpoint", { totalTokens: 7 }));
  assert.equal(currentTokenTotal(ctx), 120_007);
  assert.deepEqual(session.reads, { entry: 60_004, branch: 0 });
});

test("ancestor revisits, divergent branches, and empty leaves preserve branch-local totals", () => {
  const session = indexedSession();
  const ctx = { sessionManager: session.manager };
  session.append(assistant("root", null, { totalTokens: 10 }));
  session.append(assistant("left", "root", { totalTokens: 20 }));
  assert.equal(currentTokenTotal(ctx), 30);
  session.branch("root");
  assert.equal(currentTokenTotal(ctx), 10);
  session.append(assistant("right", "root", { totalTokens: 40 }));
  assert.equal(currentTokenTotal(ctx), 50);
  session.branch("left");
  assert.equal(currentTokenTotal(ctx), 30);
  session.branch(null);
  assert.equal(currentTokenTotal(ctx), 0);
  session.branch("right");
  assert.equal(currentTokenTotal(ctx), 50);
  assert.deepEqual(session.reads, { entry: 7, branch: 0 });
});

test("mixed appends and repeated branch changes remain equivalent to a full recount", () => {
  const session = indexedSession();
  const ids: string[] = [];
  const ctx = { sessionManager: session.manager };
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let index = 0; index < 2000; index++) {
    if (index % 3 === 0) session.branch(ids[next() % (ids.length + 1)] ?? null);
    const id = `entry-${index}`;
    const parent = session.manager.getLeafId();
    session.append(
      index % 4 === 0
        ? custom(id, parent)
        : assistant(id, parent, { input: next() % 100, output: next() % 20, cacheRead: next() % 200 }),
    );
    ids.push(id);
    assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(session.manager.getBranch()));
  }
});

test("missing leaf or parent entries match the public branch walk", () => {
  const session = indexedSession();
  const ctx = { sessionManager: session.manager };
  session.append(assistant("orphan", "missing-parent", { totalTokens: 5 }));
  assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(session.manager.getBranch()));
  assert.equal(currentTokenTotal(ctx), 5);
  session.branch("missing-leaf");
  assert.equal(currentTokenTotal(ctx), 0);
});

test("sessions with identical IDs do not share totals, even when they share a UI", () => {
  const first = indexedSession();
  const second = indexedSession();
  first.append(assistant("same-id", null, { totalTokens: 10 }));
  second.append(assistant("same-id", null, { totalTokens: 90 }));
  const ui = {};
  assert.equal(currentTokenTotal({ sessionManager: first.manager, ...{ ui } }), 10);
  assert.equal(currentTokenTotal({ sessionManager: second.manager, ...{ ui } }), 90);
  assert.equal(currentTokenTotal({ sessionManager: first.manager, ...{ ui } }), 10);
});

test("replaced entry objects with reused IDs trigger a recount on the same manager", () => {
  const session = indexedSession();
  const ctx = { sessionManager: session.manager };
  session.append(assistant("root", null, { totalTokens: 5 }));
  session.append(custom("leaf", "root"));
  assert.equal(currentTokenTotal(ctx), 5);
  session.append(assistant("root", null, { totalTokens: 80 }));
  session.append(custom("leaf", "root"));
  assert.equal(currentTokenTotal(ctx), 80);
  assert.equal(session.reads.entry, 4);
});

test("branch-only contexts recount changed arrays instead of caching them", () => {
  const entries = [assistant("a", null, { totalTokens: 5 })];
  const sessionManager = { getBranch: () => entries };
  assert.equal(currentTokenTotal({ sessionManager }), 5);
  entries.push(assistant("b", "a", { totalTokens: 7 }));
  assert.equal(currentTokenTotal({ sessionManager }), 12);
  entries[0] = assistant("a", null, { totalTokens: 20 });
  assert.equal(currentTokenTotal({ sessionManager }), 27);
  assert.equal(currentTokenTotal({}), 0);
  assert.equal(currentTokenTotal({ sessionManager: {} }), 0);
  assert.equal(currentTokenTotal({ sessionManager: { ...sessionManager, getLeafId: () => "b" } }), 27);
  assert.equal(currentTokenTotal({ sessionManager: { ...sessionManager, getEntry: () => entries[0] } }), 27);
});

test("real SessionManager branches, compaction, forks, and resets match a full recount", () => {
  const sessionManager = SessionManager.inMemory();
  const ctx = { sessionManager };
  const root = sessionManager.appendMessage(message(5));
  assert.equal(currentTokenTotal(ctx), 5);
  const left = sessionManager.appendMessage(message(10));
  assert.equal(currentTokenTotal(ctx), 15);
  sessionManager.branch(root);
  const right = sessionManager.appendMessage(message(20));
  sessionManager.appendCompaction("summary", right, 1234);
  sessionManager.appendUsage("compaction", "test", "test", message(100).usage);
  sessionManager.appendCustomEntry("goal-state", { tokensUsed: 999 });
  sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
  assert.equal(currentTokenTotal(ctx), 25);
  assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(sessionManager.getBranch()));
  sessionManager.branch(left);
  assert.equal(currentTokenTotal(ctx), 15);
  sessionManager.resetLeaf();
  assert.equal(currentTokenTotal(ctx), 0);
  sessionManager.branch(right);
  assert.equal(currentTokenTotal(ctx), 25);
  sessionManager.branchWithSummary(root, "abandoned path", {}, false, message(100).usage);
  assert.equal(currentTokenTotal(ctx), 5);
  sessionManager.branch(right);
  sessionManager.appendLabelChange(root, "root label");
  assert.equal(currentTokenTotal(ctx), 25);
  const forkLeaf = sessionManager.getLeafId();
  assert.ok(forkLeaf);
  sessionManager.createBranchedSession(forkLeaf);
  assert.equal(currentTokenTotal(ctx), 25);
  assert.equal(currentTokenTotal(ctx), cumulativeAssistantTokens(sessionManager.getBranch()));
  sessionManager.newSession();
  assert.equal(currentTokenTotal(ctx), 0);
  sessionManager.appendMessage(message(3));
  assert.equal(currentTokenTotal(ctx), 3);
});

test("real file resume and same-manager reload invalidate totals even with identical session and entry IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-accounting-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.appendMessage(message(5));
    manager.appendCustomEntry("goal-state", {});
    const path = manager.getSessionFile();
    assert.ok(path);
    assert.equal(currentTokenTotal({ sessionManager: manager }), 5);
    const resumed = SessionManager.open(path);
    assert.equal(currentTokenTotal({ sessionManager: resumed }), 5);
    const entries = manager
      .getEntries()
      .map((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? { ...entry, message: { ...entry.message, usage: message(80).usage } }
          : entry,
      );
    writeFileSync(path, `${[manager.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    manager.setSessionFile(path);
    assert.equal(currentTokenTotal({ sessionManager: manager }), 80);
    resumed.setSessionFile(path);
    assert.equal(currentTokenTotal({ sessionManager: resumed }), 80);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached accounting preserves baseline subtraction and elapsed-time checkpoints", () => {
  vi.useFakeTimers();
  vi.setSystemTime(2000);
  const manager = SessionManager.inMemory();
  manager.appendMessage(message(100));
  const goal: GoalAccountingState = {
    status: "active",
    baselineTokens: currentTokenTotal({ sessionManager: manager }),
    tokensUsed: 0,
    timeUsedSeconds: 2,
    activeStartedAt: 1000,
    updatedAt: 1000,
  };
  manager.appendMessage(message(25));
  updateGoalUsage(goal, { sessionManager: manager });
  assert.equal(goal.tokensUsed, 25);
  assert.equal(goal.timeUsedSeconds, 3);
  vi.setSystemTime(3000);
  updateGoalUsage(goal, { sessionManager: manager });
  assert.equal(goal.tokensUsed, 25);
  assert.equal(goal.timeUsedSeconds, 4);
  assert.equal(goal.updatedAt, 3000);
  manager.resetLeaf();
  updateGoalUsage(goal, { sessionManager: manager });
  assert.equal(goal.tokensUsed, 0);
});

test("incremental accounting enforces the budget at tool completion without skipping goal snapshots", async () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(message(100));
  let aborts = 0;
  const active = await startGoalForTest({ sessionManager, abort: () => aborts++ }, "--tokens 10 finish");
  assert.equal(requireLastGoal(active.mock).baselineTokens, 100);
  const toolEnd = active.mock.events.get("tool_execution_end")?.[0];
  const event = { toolCallId: "tool", toolName: "bash", result: {}, isError: false };
  sessionManager.appendMessage(message(3));
  await toolEnd?.(event, active.ctx);
  assert.equal(requireLastGoal(active.mock).tokensUsed, 3);
  assert.equal(lastGoalStatus(active.mock), "active");
  const before = active.mock.entries.filter((entry) => entry.customType === "goal-state").length;
  await toolEnd?.(event, active.ctx);
  assert.equal(requireLastGoal(active.mock).tokensUsed, 3);
  assert.equal(active.mock.entries.filter((entry) => entry.customType === "goal-state").length, before + 1);
  sessionManager.appendMessage(message(8));
  await toolEnd?.(event, active.ctx);
  assert.equal(requireLastGoal(active.mock).tokensUsed, 11);
  assert.equal(lastGoalStatus(active.mock), "budget_limited");
  assert.equal(aborts, 1);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});
