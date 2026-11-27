import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type ActiveGoal, loadGoalStateFromSession, serializeBoundedGoalState } from "../src/persistence.js";

const goal: ActiveGoal = {
  id: "goal-id",
  text: "Finish the report with all requirements intact.",
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

function entry(id: string, parentId: string | null, data: unknown) {
  return { id, parentId, data, type: "custom", customType: "goal-state" };
}

test("compact checkpoints restore their own accounting on the selected branch", () => {
  const sessionManager = SessionManager.inMemory();
  const sourceId = sessionManager.appendCustomEntry("goal-state", { goal });
  const waiting = { reason: "Waiting for approval" };
  const middleId = sessionManager.appendCustomEntry(
    "goal-state",
    compact({ ...goal, status: "active", waiting, tokensUsed: 17 }, sourceId),
  );
  sessionManager.branch(sourceId);
  sessionManager.appendCustomEntry("goal-state", { goal: { ...goal, text: "Sibling objective" } });
  sessionManager.branch(middleId);
  sessionManager.appendCustomEntry("goal-state", compact({ ...goal, tokensUsed: 42 }, sourceId));

  for (const manager of [sessionManager, { getEntries: () => sessionManager.getEntries() }]) {
    const restored = loadGoalStateFromSession({ sessionManager: manager }).goal;
    assert.equal(restored?.text, goal.text);
    assert.equal(restored?.tokensUsed, 42);
    assert.equal(restored?.status, "paused");
  }
  sessionManager.branch(middleId);
  const middle = loadGoalStateFromSession({ sessionManager }).goal;
  assert.equal(middle?.text, goal.text);
  assert.equal(middle?.tokensUsed, 17);
  assert.equal(middle?.status, "active");
  assert.deepEqual(middle?.waiting, waiting);
});

test("invalid compact references do not restore an older Goal", () => {
  const source = entry("source", null, { goal });
  const leaf = entry("leaf", source.id, compact(goal, source.id));
  const cases = {
    "missing source": [leaf],
    "empty reference": [source, { ...leaf, data: compact(goal, "") }],
    "source without full state": [{ ...source, data: { goal: { id: goal.id, text: goal.text } } }, leaf],
    "source is a reference": [{ ...source, data: compact(goal, "earlier") }, leaf],
    "reference to another Goal": [source, { ...leaf, data: compact({ ...goal, id: "other" }, source.id) }],
    "non-string status": [{ ...source, data: { goal: { ...goal, status: { toString: null } } } }, leaf],
    "checkpoint after a clear": [source, entry("clear", source.id, { goal: null }), { ...leaf, parentId: "clear" }],
    "checkpoint after an edit": [
      source,
      entry("edit", source.id, { goal: { ...goal, text: "New objective" } }),
      { ...leaf, parentId: "edit" },
    ],
    "checkpoint after a malformed link": [
      source,
      entry("invalid", source.id, { goal: { id: goal.id }, objectiveEntryId: source.id }),
      { ...leaf, parentId: "invalid" },
    ],
    "ambiguous source": [source, { ...source, parentId: source.id }, leaf],
  };
  for (const [name, entries] of Object.entries(cases)) {
    assert.equal(loadGoalStateFromSession({ sessionManager: { getBranch: () => entries } }).goal, undefined, name);
    assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => entries } }).goal, undefined, name);
  }
});

test("without getBranch the reader rejects siblings, ambiguous parents, and invalid parent order", () => {
  const root = { id: "root", parentId: null, type: "message" };
  const source = entry("source", root.id, { goal });
  const leaf = entry("leaf", source.id, compact(goal, source.id));
  const cases = {
    "source on a sibling": [root, source, { ...leaf, parentId: root.id }],
    "same source ID on sibling branches": [root, source, { ...source }, leaf],
    "parent after child": [
      root,
      source,
      { ...leaf, parentId: "late" },
      { id: "late", parentId: source.id, type: "message" },
    ],
    "parent cycle": [root, { ...source, parentId: leaf.id }, leaf],
  };
  for (const [name, entries] of Object.entries(cases)) {
    assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => entries } }).goal, undefined, name);
  }
});

test("a full checkpoint wins over a stray reference, and compact completion does not restore a Goal", () => {
  const source = entry("source", null, { goal });
  const full = entry("full", source.id, { goal: { ...goal, text: "New objective" }, objectiveEntryId: "missing" });
  const complete = entry("complete", source.id, compact({ ...goal, status: "complete" }, source.id));
  assert.equal(
    loadGoalStateFromSession({ sessionManager: { getBranch: () => [source, full] } }).goal?.text,
    "New objective",
  );
  const reference = entry("reference", full.id, compact({ ...goal, tokensUsed: 42 }, full.id));
  const restored = loadGoalStateFromSession({ sessionManager: { getBranch: () => [source, full, reference] } }).goal;
  assert.equal(restored?.text, "New objective");
  assert.equal(restored?.tokensUsed, 42);
  assert.equal(loadGoalStateFromSession({ sessionManager: { getBranch: () => [source, complete] } }).goal, undefined);
});

test("reopening a compact branch through Pi appends a full checkpoint for rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-compact-restore-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: AgentSession | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Start the report", timestamp: 1 });
    const sourceId = manager.appendCustomEntry("goal-state", { goal });
    const current = { ...goal, tokensUsed: 42, timeUsedSeconds: 22, automaticModelTurns: 4 };
    const checkpoint = serializeBoundedGoalState(current, manager);
    assert.deepEqual(checkpoint, compact(current, sourceId));
    const compactId = manager.appendCustomEntry("goal-state", checkpoint);
    const file = manager.getSessionFile();
    assert.ok(file);
    const fork = SessionManager.open(file).createBranchedSession(compactId);
    assert.ok(fork);
    const forkedGoal = loadGoalStateFromSession({ sessionManager: SessionManager.open(fork) }).goal;
    assert.equal(forkedGoal?.text, goal.text);
    assert.equal(forkedGoal?.tokensUsed, current.tokensUsed);

    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [resolve("packages/pi-goal")],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.open(file),
      noTools: "builtin",
    });
    session = result.session;
    assert.deepEqual(result.extensionsResult.errors, []);
    await session.bindExtensions({});

    const persisted = SessionManager.open(file)
      .getBranch()
      .findLast((row) => row.type === "custom" && row.customType === "goal-state");
    assert.ok(persisted?.type === "custom");
    assert.notEqual(persisted.id, compactId);
    assert.deepEqual(persisted.data, { goal: current });
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
