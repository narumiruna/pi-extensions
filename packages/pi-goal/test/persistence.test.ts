import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { type ActiveGoal, loadGoalStateFromSession, serializeGoalState } from "../src/persistence.js";

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
