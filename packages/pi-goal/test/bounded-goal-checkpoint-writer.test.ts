import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  type ActiveGoal,
  loadGoalStateFromSession,
  serializeBoundedGoalState,
  serializeGoalState,
} from "../src/persistence.js";

const goal: ActiveGoal = {
  id: "report-goal",
  text: "o".repeat(2000),
  status: "paused",
  startedAt: 1,
  updatedAt: 2,
  iteration: 3,
  tokensUsed: 5,
  timeUsedSeconds: 7,
  baselineTokens: 11,
  automaticModelTurns: 2,
  toolFreeRepeatCount: 1,
};

function compact(value: ActiveGoal, objectiveEntryId: string) {
  const { text: _text, ...accounting } = value;
  return { goal: accounting, objectiveEntryId };
}

function row(id: string, parentId: string | null, data: unknown, customType = "goal-state") {
  return { id, parentId, data, customType, type: "custom" };
}

function fixtureHistory(rows: ReturnType<typeof row>[]) {
  return {
    getLeafEntry: () => rows.at(-1),
    getEntry: (id: string) => rows.find((entry) => entry.id === id),
  };
}

function countedHistory(manager: SessionManager) {
  let reads = 0;
  return {
    getLeafEntry() {
      reads += 1;
      return manager.getLeafEntry();
    },
    getEntry(id: string) {
      reads += 1;
      return manager.getEntry(id);
    },
    get reads() {
      return reads;
    },
  };
}

test("the lookup counts all entries and stops before the 65th read", () => {
  const manager = SessionManager.inMemory();
  const sourceId = manager.appendCustomEntry("goal-state", serializeGoalState(goal));
  for (let i = 0; i < 63; i++) manager.appendCustomEntry("notes", { i });

  const atLimit = countedHistory(manager);
  const current = { ...goal, tokensUsed: 42 };
  assert.deepEqual(serializeBoundedGoalState(current, atLimit), compact(current, sourceId));
  assert.equal(atLimit.reads, 64);

  manager.appendCustomEntry("notes", { i: 63 });
  const outsideLimit = countedHistory(manager);
  assert.deepEqual(serializeBoundedGoalState(current, outsideLimit), { goal: current });
  assert.equal(outsideLimit.reads, 64);
});

test("the writer selects the smaller UTF-8 JSON payload and keeps full snapshots on ties", () => {
  const sourceId = "source01";
  const bytes = (data: unknown) => Buffer.byteLength(JSON.stringify(data));
  const overhead = bytes(compact(goal, sourceId)) - bytes(serializeGoalState({ ...goal, text: "" }));
  assert.ok(overhead > 3);
  const cases = [
    { label: "short", text: "o", useReference: false },
    { label: "equal", text: "o".repeat(overhead), useReference: false },
    { label: "longer", text: "o".repeat(overhead + 1), useReference: true },
    { label: "multi-byte UTF-8", text: "漢".repeat(Math.floor(overhead / 3) + 1), useReference: true },
    { label: "escaped JSON", text: '"'.repeat(Math.floor(overhead / 2) + 1), useReference: true },
  ];
  for (const { label, text, useReference } of cases) {
    const current = { ...goal, text };
    const full = serializeGoalState(current);
    const reference = compact(current, sourceId);
    const result = serializeBoundedGoalState(current, fixtureHistory([row(sourceId, null, full)]));
    assert.equal(bytes(reference) < bytes(full), useReference, label);
    assert.deepEqual(result, useReference ? reference : full, label);
    assert.equal(bytes(result), Math.min(bytes(reference), bytes(full)), label);
  }
});

test("a compact checkpoint still points to the original snapshot and detaches the current state", () => {
  const manager = SessionManager.inMemory();
  const sourceId = manager.appendCustomEntry("goal-state", serializeGoalState(goal));
  manager.appendCustomEntry("goal-state", serializeBoundedGoalState({ ...goal, tokensUsed: 30 }, manager));
  const current: ActiveGoal = {
    ...goal,
    status: "active",
    tokensUsed: 42,
    waiting: { reason: "Waiting for approval" },
  };
  const expected = compact(structuredClone(current), sourceId);
  const result = serializeBoundedGoalState(current, manager);
  assert.deepEqual(result, expected);
  assert.ok(current.waiting);
  current.waiting.reason = "Changed later";
  assert.deepEqual(result, expected);
});

test("an unavailable history or clear keeps the original format without reading the branch", () => {
  const manager = SessionManager.inMemory();
  assert.deepEqual(serializeBoundedGoalState(goal), { goal });
  assert.deepEqual(serializeBoundedGoalState(goal, manager), { goal });
  const unavailable = { getLeafEntry: () => assert.fail("both accessors are required") };
  assert.deepEqual(serializeBoundedGoalState(goal, unavailable), { goal });
  const history = {
    getLeafEntry: () => assert.fail("a clear cannot use a reference"),
    getEntry: () => assert.fail("a clear cannot use a reference"),
  };
  assert.deepEqual(serializeBoundedGoalState(undefined, history), { goal: null });
});

test("a completed checkpoint stays full without reading the branch", () => {
  const completed: ActiveGoal = { ...goal, status: "complete" };
  const history = {
    getLeafEntry: () => assert.fail("completion cannot use a reference"),
    getEntry: () => assert.fail("completion cannot use a reference"),
  };
  assert.deepEqual(serializeBoundedGoalState(completed, history), { goal: completed });
});

test("the writer falls back at missing, cyclic, malformed, or unrelated sources", () => {
  const source = row("source", null, { goal });
  const reference = row("reference", source.id, compact(goal, source.id));
  const root = row("root", null, {}, "notes");
  const otherLink = row("other-source-link", source.id, compact(goal, "other-source"));
  const cases = {
    "clear at the tip": [source, row("clear", source.id, { goal: null })],
    "reference crosses a clear": [source, row("clear", source.id, { goal: null }), { ...reference, parentId: "clear" }],
    "edited objective": [source, row("edit", source.id, { goal: { ...goal, text: "Changed objective" } })],
    "different goal with identical text": [source, row("other-goal", source.id, { goal: { ...goal, id: "other" } })],
    "missing parent": [{ ...reference, parentId: "missing" }],
    "self-reference": [row("leaf", source.id, compact(goal, "leaf"))],
    "cyclic parent": [row("a", "b", {}, "notes"), row("b", "a", compact(goal, "missing"))],
    "source stored on a sibling": [root, { ...source, parentId: root.id }, { ...reference, parentId: root.id }],
    "source is not a Goal checkpoint": [{ ...source, customType: "notes" }, reference],
    "source is a compact checkpoint": [{ ...source, data: compact(goal, "earlier") }, reference],
    "reference crosses a different source": [source, otherLink, { ...reference, parentId: otherLink.id }],
    "legacy queue metadata": [{ ...source, data: { goal, queue: [] } }, reference],
    "completed source": [{ ...source, data: { goal: { ...goal, status: "complete" } } }, reference],
    "compact link crosses completion": [
      source,
      row("complete", source.id, compact({ ...goal, status: "complete" }, source.id)),
      { ...reference, parentId: "complete" },
    ],
    "nonfinite source that would not survive JSON encoding": [
      { ...source, data: { goal: { ...goal, tokensUsed: Infinity } } },
      reference,
    ],
    "malformed intervening checkpoint": [
      source,
      row("invalid", source.id, { goal: { id: goal.id }, objectiveEntryId: source.id }),
      { ...reference, parentId: "invalid" },
    ],
  };
  for (const [label, rows] of Object.entries(cases)) {
    assert.deepEqual(serializeBoundedGoalState(goal, fixtureHistory(rows)), { goal }, label);
  }
});

for (const { gap, copies, forkIndices } of [
  { gap: 0, copies: 7, forkIndices: [64, 65] },
  { gap: 2, copies: 21, forkIndices: [21, 22] },
]) {
  test(`450 checkpoints with ${gap} intervening entries shrink the JSONL file and restore across refresh`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-goal-bounded-writes-"));
    try {
      const full = SessionManager.create(root, join(root, "full"));
      const bounded = SessionManager.create(root, join(root, "bounded"));
      for (const manager of [full, bounded]) {
        manager.appendMessage({ role: "user", content: "Start the report", timestamp: 1 });
      }
      let fullCopies = 0;
      let maxReads = 0;
      const checkpoints: string[] = [];
      for (let i = 0; i < 450; i++) {
        const current = { ...goal, tokensUsed: i, timeUsedSeconds: i * 2 };
        const history = countedHistory(bounded);
        const record = serializeBoundedGoalState(current, history);
        maxReads = Math.max(maxReads, history.reads);
        if (!("objectiveEntryId" in record)) fullCopies += 1;
        full.appendCustomEntry("goal-state", serializeGoalState(current));
        checkpoints.push(bounded.appendCustomEntry("goal-state", record));
        for (let j = 0; j < gap; j++) {
          for (const manager of [full, bounded]) manager.appendCustomEntry("notes", { j });
        }
      }
      assert.equal(fullCopies, copies);
      assert.equal(maxReads, 64);
      const fullFile = full.getSessionFile();
      const boundedFile = bounded.getSessionFile();
      assert.ok(fullFile && boundedFile);
      const fullJsonl = readFileSync(fullFile);
      const compactJsonl = readFileSync(boundedFile);
      assert.ok(compactJsonl.length < fullJsonl.length);
      assert.equal(compactJsonl.toString("utf8").split(goal.text).length - 1, copies);

      const reopened = SessionManager.open(boundedFile);
      const latest = loadGoalStateFromSession({ sessionManager: reopened }).goal;
      assert.equal(latest?.text, goal.text);
      assert.equal(latest?.tokensUsed, 449);
      assert.equal(latest?.timeUsedSeconds, 898);
      for (const index of forkIndices) {
        const entryId = checkpoints[index];
        assert.ok(entryId);
        const fork = SessionManager.open(boundedFile).createBranchedSession(entryId);
        assert.ok(fork);
        const manager = SessionManager.open(fork);
        const tip = manager.getLeafEntry();
        assert.ok(tip?.type === "custom" && tip.data && typeof tip.data === "object");
        assert.equal("objectiveEntryId" in tip.data, index === forkIndices[0]);
        const restored = loadGoalStateFromSession({ sessionManager: manager }).goal;
        assert.equal(restored?.text, goal.text);
        assert.equal(restored?.tokensUsed, index);
        assert.equal(restored?.timeUsedSeconds, index * 2);
        assert.equal(restored?.status, goal.status);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
