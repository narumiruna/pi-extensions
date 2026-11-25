import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { checkpointGoalActiveTime } from "../src/accounting.js";
import {
  type ActiveGoal,
  type GoalStateEntryData,
  loadGoalStateFromSession,
  serializeGoalState,
} from "../src/persistence.js";

const active = storedGoal("active", "active");
const queued = { ...storedGoal("queued", "active"), status: "queued" as const };

function branch(...entries: Array<{ customType: string; data: unknown }>) {
  return {
    sessionManager: {
      getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
    },
  };
}

test("canonical persistence keeps the single-goal shape", () => {
  assert.deepEqual(serializeGoalState(active), { goal: active });
  assert.deepEqual(serializeGoalState(undefined), { goal: null });
});

for (const [name, waiting] of [
  ["without waiting", undefined],
  ["with a reason-only wait", { reason: "Waiting for approval" }],
  ["with a deadline wait", { reason: "  Waiting for approval  ", resumeAt: 60_000 }],
  ["with an explicitly undefined deadline", { reason: "Waiting for approval", resumeAt: undefined }],
] as const) {
  test(`canonical persistence makes independent snapshots ${name}`, () => {
    const goal: ActiveGoal = { ...storedGoal("snapshot", "active"), tokenBudget: undefined };
    if (waiting) goal.waiting = { ...waiting };
    const original = structuredClone(goal);
    const first = serializeGoalState(goal);
    const second = serializeGoalState(goal);
    assert.ok(first.goal);
    assert.ok(second.goal);
    assert.deepEqual(first, { goal: original });
    assert.notStrictEqual(first.goal, goal);
    assert.notStrictEqual(first.goal, second.goal);
    if (goal.waiting) {
      assert.notStrictEqual(first.goal.waiting, goal.waiting);
      assert.notStrictEqual(first.goal.waiting, second.goal.waiting);
    }

    goal.tokensUsed = 42;
    goal.timeUsedSeconds = 5;
    goal.activeStartedAt = 10;
    goal.updatedAt = 20;
    goal.automaticModelTurns = 2;
    goal.toolFreeRepeatCount = 2;
    goal.lastToolFreeOutputFingerprint = "a".repeat(64);
    if (goal.waiting) {
      goal.waiting.reason = "Changed live reason";
      goal.waiting.resumeAt = 120_000;
    }
    assert.deepEqual(first, { goal: original });
    assert.deepEqual(second, { goal: original });

    const changedLiveGoal = structuredClone(goal);
    first.goal.tokensUsed = 99;
    if (first.goal.waiting) {
      first.goal.waiting.reason = "Changed first snapshot";
      first.goal.waiting.resumeAt = 180_000;
    }
    assert.deepEqual(goal, changedLiveGoal);
    assert.deepEqual(second, { goal: original });

    goal.waiting = { reason: "Replacement wait" };
    assert.deepEqual(second, { goal: original });
    delete goal.waiting;
    assert.deepEqual(second, { goal: original });
  });
}

test("in-memory session branches restore the goal captured at each append", () => {
  const sessionManager = SessionManager.inMemory();
  const goal: ActiveGoal = { ...storedGoal("history", "active"), activeStartedAt: 1_000 };
  const initial = structuredClone(goal);
  const firstId = sessionManager.appendCustomEntry("goal-state", serializeGoalState(goal));

  checkpointGoalActiveTime(goal, 3_000, false);
  goal.tokensUsed = 42;
  goal.updatedAt = 3_000;
  goal.automaticModelTurns = 2;
  goal.toolFreeRepeatCount = 1;
  goal.waiting = { reason: "Waiting for approval", resumeAt: 60_000 };
  const middle = structuredClone(goal);
  const middleId = sessionManager.appendCustomEntry("goal-state", serializeGoalState(goal));
  goal.waiting.reason = "Waiting for a different event";
  goal.waiting.resumeAt = 120_000;
  goal.tokensUsed = 99;
  sessionManager.appendCustomEntry("goal-state", serializeGoalState(goal));

  assert.deepEqual(goalHistory(sessionManager)[0]?.data, { goal: initial });
  assert.deepEqual(goalHistory(sessionManager)[1]?.data, { goal: middle });
  sessionManager.branch(firstId);
  assert.equal(sessionManager.getBranch().at(-1)?.id, firstId);
  const firstRestored = loadGoalStateFromSession({ sessionManager }).goal;
  assert.ok(firstRestored);
  assert.equal(firstRestored.tokensUsed, 0);
  assert.equal(firstRestored.timeUsedSeconds, 0);
  assert.equal(firstRestored.automaticModelTurns, 0);
  assert.equal(firstRestored.waiting, undefined);

  sessionManager.branch(middleId);
  const middleRestored = loadGoalStateFromSession({ sessionManager }).goal;
  assert.ok(middleRestored?.waiting);
  assert.equal(middleRestored.tokensUsed, 42);
  assert.equal(middleRestored.timeUsedSeconds, 2);
  assert.equal(middleRestored.automaticModelTurns, 2);
  assert.equal(middleRestored.activeStartedAt, undefined);
  assert.deepEqual(middleRestored.waiting, middle.waiting);
  middleRestored.tokensUsed = 200;
  middleRestored.waiting.reason = "Changed restored goal";
  assert.deepEqual(goalHistory(sessionManager)[1]?.data, { goal: middle });

  sessionManager.appendCustomEntry("goal-state", serializeGoalState(undefined));
  assert.equal(loadGoalStateFromSession({ sessionManager }).goal, undefined);
  sessionManager.branch(middleId);
  sessionManager.appendCustomEntry("goal-state", serializeGoalState({ ...goal, status: "complete" }));
  assert.equal(loadGoalStateFromSession({ sessionManager }).goal, undefined);
});

for (const flushBeforeGoal of [true, false]) {
  test(`session history keeps append-time snapshots ${flushBeforeGoal ? "after" : "before"} the first flush`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-goal-history-"));
    try {
      const sessionManager = SessionManager.create(root, join(root, "sessions"));
      const startConversation = () =>
        sessionManager.appendMessage({ role: "user", content: "Start persistence", timestamp: 1 });
      if (flushBeforeGoal) startConversation();
      const goal: ActiveGoal = {
        ...storedGoal("file history", "active"),
        waiting: { reason: "Waiting for approval", resumeAt: 60_000 },
      };
      const first = structuredClone(goal);
      const firstId = sessionManager.appendCustomEntry("goal-state", serializeGoalState(goal));
      goal.tokensUsed = 42;
      goal.updatedAt = 2;
      goal.automaticModelTurns = 2;
      assert.ok(goal.waiting);
      goal.waiting.reason = "Waiting for a different event";
      goal.waiting.resumeAt = 120_000;
      const second = structuredClone(goal);
      sessionManager.appendCustomEntry("goal-state", serializeGoalState(goal));
      goal.tokensUsed = 99;
      goal.status = "paused";
      delete goal.waiting;
      sessionManager.appendCustomEntry("goal-state", serializeGoalState(undefined));
      if (!flushBeforeGoal) startConversation();

      const expected = [{ goal: first }, { goal: second }, { goal: null }];
      assert.deepEqual(
        goalHistory(sessionManager).map((entry) => entry.data),
        expected,
      );
      const file = sessionManager.getSessionFile();
      assert.ok(file);
      const fileEntries = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line));
      assert.equal(JSON.stringify(sessionManager.getEntries()), JSON.stringify(fileEntries));

      const reopened = SessionManager.open(file);
      assert.deepEqual(
        goalHistory(reopened).map((entry) => entry.data),
        expected,
      );
      assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal, undefined);
      reopened.branch(firstId);
      const restored = loadGoalStateFromSession({ sessionManager: reopened }).goal;
      assert.equal(restored?.tokensUsed, 0);
      assert.equal(restored?.automaticModelTurns, 0);
      assert.deepEqual(restored?.waiting, first.waiting);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical persistence restores ordinary single goals", () => {
  const loaded = loadGoalStateFromSession(branch({ customType: "goal-state", data: serializeGoalState(active) }));

  assert.equal(loaded.goal?.text, "active");
  assert.equal(loaded.legacyQueueState, undefined);
});

test("canonical queue metadata is inert legacy state", () => {
  const pendingAction = {
    kind: "prioritize" as const,
    objective: "urgent",
    tokenBudget: 2_000,
    displacedUsageFinalized: true,
  };
  const loaded = loadGoalStateFromSession(
    branch({
      customType: "goal-state",
      data: { goal: active, queue: [queued], pendingAction },
    }),
  );

  assert.equal(loaded.goal, undefined);
  assert.deepEqual(loaded.legacyQueueState, { retainedGoals: 3 });
});

test("queued canonical heads are inert legacy queue state", () => {
  const loaded = loadGoalStateFromSession(branch({ customType: "goal-state", data: { goal: queued } }));

  assert.equal(loaded.goal, undefined);
  assert.deepEqual(loaded.legacyQueueState, { retainedGoals: 1 });
});

test("canonical entries take precedence over older plural state, including explicit clear", () => {
  const plural = { goals: [storedGoal("legacy", "active"), queued] };
  const loaded = loadGoalStateFromSession(
    branch({ customType: "goals-state", data: plural }, { customType: "goal-state", data: { goal: null } }),
  );

  assert.equal(loaded.goal, undefined);
  assert.equal(loaded.legacyQueueState, undefined);
});

test("legacy plural state is inert unless it contains exactly one ordinary goal", () => {
  const pendingUnshift = { objective: "urgent", tokenBudget: 3_000 };
  const loaded = loadGoalStateFromSession(
    branch({
      customType: "goals-state",
      data: { goals: [active, queued], pendingUnshift },
    }),
  );

  assert.equal(loaded.goal, undefined);
  assert.deepEqual(loaded.legacyQueueState, { retainedGoals: 3 });
});

test("a legacy single goal becomes ordinary singular state", () => {
  const legacyGoal = {
    ...active,
    automaticModelTurns: undefined,
    toolFreeRepeatCount: undefined,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
  };
  const loaded = loadGoalStateFromSession(branch({ customType: "goals-state", data: { goals: [legacyGoal] } }));

  assert.equal(loaded.goal?.text, "active");
  assert.equal(loaded.goal?.automaticModelTurns, 0);
  assert.equal(loaded.goal?.toolFreeRepeatCount, 0);
  assert.equal(loaded.goal?.lastToolFreeOutputFingerprint, undefined);
  assert.equal(loaded.goal?.safetyPauseCause, undefined);
  assert.equal(loaded.legacyQueueState, undefined);
});

test("a pending active reactivation retains its safety cause until prompt start", () => {
  const loaded = loadGoalStateFromSession(
    branch({
      customType: "goal-state",
      data: {
        goal: {
          ...active,
          automaticModelTurns: 2,
          toolFreeRepeatCount: 3,
          lastToolFreeOutputFingerprint: "c".repeat(64),
          safetyPauseCause: "no_progress",
        },
      },
    }),
  );

  assert.equal(loaded.goal?.status, "active");
  assert.equal(loaded.goal?.safetyPauseCause, "no_progress");
  assert.equal(loaded.goal?.toolFreeRepeatCount, 3);
});

test("malformed persisted safety fields reset without discarding the goal", () => {
  const loaded = loadGoalStateFromSession(
    branch({
      customType: "goal-state",
      data: {
        goal: {
          ...active,
          automaticModelTurns: -2,
          toolFreeRepeatCount: Number.MAX_SAFE_INTEGER + 1,
          lastToolFreeOutputFingerprint: "not-a-fingerprint",
          safetyPauseCause: "other",
        },
      },
    }),
  );

  assert.equal(loaded.goal?.automaticModelTurns, 0);
  assert.equal(loaded.goal?.toolFreeRepeatCount, 0);
  assert.equal(loaded.goal?.lastToolFreeOutputFingerprint, undefined);
  assert.equal(loaded.goal?.safetyPauseCause, undefined);
});

test("canonical persistence restores valid waiting and excludes waiting wall time", () => {
  const resumeAt = Date.now() + 60_000;
  const loaded = loadGoalStateFromSession(
    branch({
      customType: "goal-state",
      data: {
        goal: {
          ...active,
          activeStartedAt: Date.now() - 10_000,
          waiting: { reason: "  Waiting for review  ", resumeAt },
        },
      },
    }),
  );

  assert.deepEqual(loaded.goal?.waiting, { reason: "Waiting for review", resumeAt });
  assert.equal(loaded.goal?.activeStartedAt, undefined);
});

test("malformed waiting metadata is dropped without discarding the goal", () => {
  for (const waiting of [
    null,
    {},
    { reason: "   " },
    { reason: "Wait", resumeAt: -1 },
    { reason: "Wait", resumeAt: 1.5 },
    { reason: "Wait", resumeAt: Number.MAX_SAFE_INTEGER },
    { reason: "x".repeat(1_001) },
  ]) {
    const loaded = loadGoalStateFromSession(
      branch({
        customType: "goal-state",
        data: { goal: { ...active, waiting } },
      }),
    );
    assert.equal(loaded.goal?.text, "active");
    assert.equal(loaded.goal?.waiting, undefined);
  }
});

test("malformed canonical or plural state fails closed", () => {
  for (const [customType, data] of [
    ["goal-state", { goal: { ...active, id: "" } }],
    ["goal-state", { goal: { ...active, text: "   " } }],
    ["goal-state", { goal: active, queue: [{ nope: true }] }],
    ["goals-state", { goals: [active, { nope: true }] }],
  ] as const) {
    const loaded = loadGoalStateFromSession(branch({ customType, data }));
    assert.equal(loaded.goal, undefined);
    assert.equal(loaded.legacyQueueState, undefined);
  }
});

test("legacy cleanup uses Pi agent directory tilde expansion", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-agent-dir-"));
  const home = join(root, "home");
  const agentDir = join(home, "custom-agent");
  const stateFile = join(agentDir, "pi-goal-state.json");
  const cwd = join(root, "workspace");
  const untouchedCwd = join(root, "other-workspace");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ [cwd]: { stale: true }, [untouchedCwd]: { keep: true } }));

  try {
    const persistenceUrl = pathToFileURL(
      join(process.cwd(), "node_modules/.cache/pi-extensions-test/packages/pi-goal/src/persistence.js"),
    ).href;
    const script = `const { clearLegacyPersistedGoal } = await import(${JSON.stringify(persistenceUrl)}); clearLegacyPersistedGoal(${JSON.stringify(cwd)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: "~/custom-agent",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
      [untouchedCwd]: { keep: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounting-only checkpoints store the objective once and every branch point restores it", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-objective-"));
  try {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    sessionManager.appendMessage({ role: "user", content: "Start persistence", timestamp: 1 });
    const objective = `Ship the report. ${"Keep every requirement. ".repeat(80)}`;
    const goal: ActiveGoal = { ...storedGoal("long objective", "active"), text: objective };
    const persist = (value: ActiveGoal | undefined) =>
      sessionManager.appendCustomEntry("goal-state", serializeGoalState(value, sessionManager.getBranch()));

    const firstId = persist(goal);
    goal.tokensUsed = 10;
    const middleId = persist(goal);
    goal.tokensUsed = 20;
    goal.status = "paused";
    persist(goal);

    const stored = goalHistory(sessionManager).map((entry) => entry.data?.goal);
    assert.equal(stored[0] && "text" in stored[0] ? stored[0].text : undefined, objective);
    assert.ok(stored.slice(1).every((entry) => entry && !("text" in entry)));
    assert.ok(
      goalHistory(sessionManager)
        .slice(1)
        .every((entry) => entry.data?.objectiveEntryId === firstId),
    );
    const file = sessionManager.getSessionFile();
    assert.ok(file);
    assert.equal(readFileSync(file, "utf8").split("Keep every requirement.").length - 1, 80);

    const reopened = SessionManager.open(file);
    const latest = loadGoalStateFromSession({ sessionManager: reopened }).goal;
    assert.equal(latest?.text, objective);
    assert.equal(latest?.status, "paused");
    assert.equal(latest?.tokensUsed, 20);
    reopened.branch(middleId);
    assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal?.text, objective);
    assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal?.tokensUsed, 10);

    // A branch whose latest Goal entry belongs to another goal stores the objective again.
    reopened.branch(firstId);
    const other = storedGoal("other objective", "active");
    reopened.appendCustomEntry("goal-state", serializeGoalState(other, reopened.getBranch()));
    reopened.appendCustomEntry("goal-state", serializeGoalState(goal, reopened.getBranch()));
    assert.deepEqual(goalHistory(reopened).at(-1)?.data, { goal });
    assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal?.text, objective);

    // A cleared goal ends the chain, so the same goal persisted later carries its objective.
    const fullId = goalHistory(reopened).at(-1)?.id;
    reopened.appendCustomEntry("goal-state", serializeGoalState(undefined, reopened.getBranch()));
    assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal, undefined);
    const { text: _text, ...accounting } = goal;
    const acrossClear = { goal: accounting, objectiveEntryId: fullId };
    reopened.appendCustomEntry("goal-state", acrossClear);
    assert.equal(loadGoalStateFromSession({ sessionManager: reopened }).goal, undefined);
    assert.equal(
      loadGoalStateFromSession({ sessionManager: { getEntries: () => reopened.getEntries() } }).goal,
      undefined,
    );
    reopened.appendCustomEntry("goal-state", serializeGoalState(undefined, reopened.getBranch()));
    reopened.appendCustomEntry("goal-state", serializeGoalState(goal, reopened.getBranch()));
    assert.deepEqual(goalHistory(reopened).at(-1)?.data, { goal });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader without a branch resolves the objective from an ancestor despite interleaved sibling entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-objective-entries-"));
  try {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    sessionManager.appendMessage({ role: "user", content: "Start persistence", timestamp: 1 });
    const goal: ActiveGoal = { ...storedGoal("objective on the main branch", "active") };
    const persist = (value: ActiveGoal) =>
      sessionManager.appendCustomEntry("goal-state", serializeGoalState(value, sessionManager.getBranch()));

    const firstId = persist(goal);
    goal.tokensUsed = 10;
    const accountingId = persist(goal);
    // A sibling branch appends another goal between the two checkpoints of the first one.
    sessionManager.branch(firstId);
    persist(storedGoal("objective on a sibling branch", "active"));
    sessionManager.branch(accountingId);
    goal.tokensUsed = 20;
    persist(goal);
    assert.ok(!("text" in (goalHistory(sessionManager).at(-1)?.data?.goal ?? {})));

    const restored = loadGoalStateFromSession({ sessionManager: { getEntries: () => sessionManager.getEntries() } });
    assert.equal(restored.goal?.text, "objective on the main branch");
    assert.equal(restored.goal?.tokensUsed, 20);
    // Without a branch to compare against, the writer keeps the full snapshot.
    assert.deepEqual(serializeGoalState(goal), { goal });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader without a branch ignores an objective stored only on a sibling branch", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-objective-sibling-"));
  try {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    const startId = sessionManager.appendMessage({ role: "user", content: "Start persistence", timestamp: 1 });
    const siblingId = sessionManager.appendCustomEntry("goal-state", { goal: active });
    sessionManager.branch(startId);
    const { text: _objective, ...accounting } = active;
    sessionManager.appendCustomEntry("goal-state", { goal: accounting, objectiveEntryId: siblingId });

    const fromEntries = loadGoalStateFromSession({ sessionManager: { getEntries: () => sessionManager.getEntries() } });
    assert.equal(fromEntries.goal, undefined);
    const fromBranch = loadGoalStateFromSession({ sessionManager: { getBranch: () => sessionManager.getBranch() } });
    assert.equal(fromBranch.goal, undefined);
    const withoutBranch = loadGoalStateFromSession({
      sessionManager: { getBranch: () => null as never, getEntries: () => sessionManager.getEntries() },
    });
    assert.equal(withoutBranch.goal, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader without a branch restores no goal when the named entry ID is shared by siblings", () => {
  const { text: _objective, ...accounting } = active;
  const entries = [
    { type: "custom", id: "start", parentId: null, customType: "other", data: {} },
    { type: "custom", id: "source", parentId: "start", customType: "goal-state", data: { goal: active } },
    {
      type: "custom",
      id: "source",
      parentId: "start",
      customType: "goal-state",
      data: { goal: { ...active, text: "a sibling objective" } },
    },
    {
      type: "custom",
      id: "checkpoint",
      parentId: "source",
      customType: "goal-state",
      data: { goal: accounting, objectiveEntryId: "source" },
    },
  ];

  assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => entries } }).goal, undefined);
});

test("a branch whose named entry ID is shared restores no goal and is written in full", () => {
  const { text: _objective, ...accounting } = active;
  const branch = [
    { type: "custom", id: "source", customType: "goal-state", data: { goal: active } },
    {
      type: "custom",
      id: "source",
      customType: "goal-state",
      data: { goal: { ...active, text: "a second objective" } },
    },
    {
      type: "custom",
      id: "checkpoint",
      customType: "goal-state",
      data: { goal: accounting, objectiveEntryId: "source" },
    },
  ];

  const restore = (entries: Record<string, unknown>[]) =>
    loadGoalStateFromSession({ sessionManager: { getBranch: () => entries } }).goal;
  assert.equal(restore(branch), undefined);
  assert.deepEqual(serializeGoalState(active, [branch[0], { ...branch[0] }]), { goal: active });

  // An entry of another type under the same ID makes the reference just as ambiguous.
  const other = { type: "custom", id: "source", customType: "other", data: {} };
  assert.equal(restore([branch[0], other, branch[2]]), undefined);
  assert.deepEqual(serializeGoalState(active, [branch[0], other]), { goal: active });
});

test("a checkpoint whose objective cannot be resolved restores no goal", () => {
  const { text: _objective, ...accounting } = active;
  const full = { id: "full", customType: "goal-state", data: { goal: active } };
  const restore = (...entries: Record<string, unknown>[]) =>
    loadGoalStateFromSession({
      sessionManager: { getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })) },
    }).goal;

  // Without the reference, a goal missing its objective stays malformed even after a full entry.
  assert.equal(restore(full, { customType: "goal-state", data: { goal: accounting } }), undefined);
  assert.equal(
    restore(full, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "missing" } }),
    undefined,
  );
  const other = { id: "other", customType: "goal-state", data: { goal: storedGoal("another", "active") } };
  assert.equal(
    restore(other, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "other" } }),
    undefined,
  );
  // A checkpoint that stores its own objective restores it, as on main, despite a stray reference.
  assert.equal(
    restore(full, { customType: "goal-state", data: { goal: active, objectiveEntryId: "full" } })?.text,
    active.text,
  );
  assert.equal(
    restore(full, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "full" } })?.text,
    active.text,
  );
  // An entry rejected as malformed never supplies the objective, to the loader or to the writer.
  const mixed = { id: "mixed", customType: "goal-state", data: { goal: active, objectiveEntryId: "full" } };
  assert.equal(
    restore(full, mixed, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "mixed" } }),
    undefined,
  );
  const mixedBranch = [full, mixed].map((entry) => ({ type: "custom", ...entry }));
  assert.deepEqual(serializeGoalState(active, mixedBranch), { goal: active });
  const partial = { id: "partial", customType: "goal-state", data: { goal: { id: active.id, text: active.text } } };
  assert.equal(
    restore(partial, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "partial" } }),
    undefined,
  );
  assert.deepEqual(serializeGoalState(active, [{ type: "custom", ...partial }]), { goal: active });
  // A malformed Goal entry between the source and the reference breaks the chain for either reader.
  const reference = { id: "reference", customType: "goal-state", data: { goal: accounting, objectiveEntryId: "full" } };
  const mixedLink = { goal: { ...active, text: "other" }, objectiveEntryId: "full" };
  const incompleteLink = { goal: { id: active.id }, objectiveEntryId: "full" };
  for (const data of [mixedLink, incompleteLink, "not an object"]) {
    const chain = [full, { id: "between", customType: "goal-state", data }, reference];
    assert.equal(restore(...chain), undefined);
    const linked = chain.map((entry, index) => ({ type: "custom", parentId: chain[index - 1]?.id ?? null, ...entry }));
    assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => linked } }).goal, undefined);
  }
  // A parent appended after its child is not a lineage the runtime writes, so it resolves nothing.
  const lateParent = [
    { type: "custom", id: "full", parentId: null, customType: "goal-state", data: { goal: active } },
    { type: "custom", id: "late", parentId: "late-parent", customType: "goal-state", data: reference.data },
    { type: "custom", id: "late-parent", parentId: "full", customType: "other", data: {} },
  ];
  assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => lateParent } }).goal, undefined);

  // An empty reference names no entry, even one stored under an empty ID.
  const emptyId = { id: "", customType: "goal-state", data: { goal: active } };
  assert.equal(
    restore(emptyId, { customType: "goal-state", data: { goal: accounting, objectiveEntryId: "" } }),
    undefined,
  );

  // A parent cycle is not a lineage, so a getEntries reader resolves nothing through it.
  const cycle = [
    { ...full, type: "custom", parentId: "reference" },
    { ...reference, type: "custom", parentId: "full" },
  ];
  assert.equal(loadGoalStateFromSession({ sessionManager: { getEntries: () => cycle } }).goal, undefined);
  // A source whose status cannot be read as a string restores no goal and is not referenced, without throwing.
  const unreadable = {
    id: "full",
    customType: "goal-state",
    data: { goal: { ...active, status: { toString: null } } },
  };
  assert.equal(restore(unreadable, reference), undefined);
  assert.deepEqual(serializeGoalState(active, [{ type: "custom", ...unreadable }]), { goal: active });
  const incompleteBranch = [full, { id: "between", customType: "goal-state", data: incompleteLink }];
  assert.deepEqual(
    serializeGoalState(
      active,
      incompleteBranch.map((entry) => ({ type: "custom", ...entry })),
    ),
    {
      goal: active,
    },
  );
});

test("an objective changed under the same goal ID is written in full and restored", () => {
  const first = { id: "first", type: "custom", customType: "goal-state", data: { goal: active } };
  const edited: ActiveGoal = { ...active, text: "edited objective" };
  const data = serializeGoalState(edited, [first]);
  assert.deepEqual(data, { goal: edited });
  const restored = loadGoalStateFromSession({
    sessionManager: { getBranch: () => [first, { id: "second", type: "custom", customType: "goal-state", data }] },
  });
  assert.equal(restored.goal?.text, "edited objective");
});

function goalHistory(sessionManager: SessionManager) {
  return sessionManager
    .getEntries()
    .filter(
      (entry): entry is CustomEntry<GoalStateEntryData> => entry.type === "custom" && entry.customType === "goal-state",
    );
}

function storedGoal(text: string, status: ActiveGoal["status"]): ActiveGoal {
  return {
    id: `${text}-id`,
    text,
    status,
    startedAt: 1,
    updatedAt: 1,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
}
