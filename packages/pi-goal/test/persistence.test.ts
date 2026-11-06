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
